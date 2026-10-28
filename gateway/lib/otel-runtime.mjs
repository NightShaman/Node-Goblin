import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { decodeTraceResponse, encodeTraceRequest } from './otlp-trace-protobuf.mjs';
import { parseTraceContext, safeTelemetryOperationId, safeTelemetryTargetId, safeTelemetryTool } from './protocol.mjs';

const DEFAULT_QUEUE_SIZE = 512;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_QUEUE_SIZE = 4_096;
const MAX_TIMEOUT_MS = 30_000;
const MAX_COMPLETED_DESTINATIONS = 128;
const MAX_OTLP_RESPONSE_BYTES = 4 * 1024 * 1024;
const BATCH_SIZE = 64;
const DESTINATION_ID = /^[A-Za-z0-9_-]{1,80}$/;

function hex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }
function nanos() { return String(BigInt(Date.now()) * 1_000_000n); }
function positiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(max, Math.floor(number)) : fallback;
}
function endpoint(env) {
  const exact = String(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || '').trim();
  if (exact) return exact;
  const base = String(env.OTEL_EXPORTER_OTLP_ENDPOINT || '').trim().replace(/\/$/, '');
  return base ? `${base}/v1/traces` : null;
}
function parseHeaders(source) {
  if (!source) return {};
  try { return Object.fromEntries(String(source).split(',').map((entry) => {
    const separator = entry.indexOf('=');
    return [decodeURIComponent((separator < 0 ? entry : entry.slice(0, separator)).trim()),
      separator < 0 ? undefined : decodeURIComponent(entry.slice(separator + 1).trim())];
  }).filter(([key, value]) => key && value)); }
  catch { throw new Error('telemetry_headers_invalid'); }
}
function validateUrl(value, { exact = false, legacy = false } = {}) {
  const source = String(value || '').trim();
  if (!source) return null;
  let url;
  try { url = new URL(source); } catch { throw new Error('telemetry_endpoint_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || /[\x00-\x20\x7f]/.test(source) || source.includes('?') || source.includes('#')
    || /@/.test(source.slice(source.indexOf('://') + 3).split('/')[0])) throw new Error('telemetry_endpoint_invalid');
  if (exact) return source;
  const normalized = url.toString().replace(legacy ? /\/$/ : /\/+$/, '');
  return legacy && normalized.endsWith('/v1/traces') ? normalized : `${normalized}/v1/traces`;
}
function controlledHeaders(value) {
  const source = String(value || '').trim();
  if (!source) return {};
  if (source.length > 8_192 || /[\r\n]/.test(source)) throw new Error('telemetry_headers_invalid');
  const parsed = parseHeaders(source);
  if (!Object.keys(parsed).length || Object.entries(parsed).some(([key, val]) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /[\x00-\x1f\x7f]/.test(val))) throw new Error('telemetry_headers_invalid');
  return parsed;
}
// Environment generic and per-signal headers are a union. On a collision,
// the trace-specific spelling and value win regardless of header-name casing.
function environmentTraceHeaders(generic, specific) {
  const headers = new Map();
  for (const source of [generic, specific]) {
    for (const [key, value] of Object.entries(controlledHeaders(source))) headers.set(key.toLowerCase(), [key, value]);
  }
  return Object.fromEntries(headers.values());
}
const ENVIRONMENT_TLS_FIELDS = [
  ['CERTIFICATE', 'caCertificate'], ['CLIENT_CERTIFICATE', 'clientCertificate'], ['CLIENT_KEY', 'clientKey'],
];
function privateEnvironmentTraceTls(source) {
  // These are trusted Core snapshots, never paths, and only interpreted for an
  // environment-owned destination (or a legacy scalar environment snapshot).
  if (source.environmentTlsErrors !== undefined && (!Array.isArray(source.environmentTlsErrors)
    || source.environmentTlsErrors.some(signal => !['traces', 'metrics'].includes(signal)))) throw new Error('telemetry_configuration_invalid');
  const snapshot = source.environmentTls;
  if (snapshot !== undefined && (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))) throw new Error('telemetry_configuration_invalid');
  const tls = snapshot?.traces;
  if (tls !== undefined && (!tls || typeof tls !== 'object' || Array.isArray(tls))) throw new Error('telemetry_configuration_invalid');
  const result = { verify: true };
  for (const [, field] of ENVIRONMENT_TLS_FIELDS) {
    if (tls?.[field] !== undefined && typeof tls[field] !== 'string') throw new Error('telemetry_configuration_invalid');
    if (tls?.[field]) result[field] = tls[field];
  }
  return { tls: result, unavailable: Boolean(source.environmentTlsErrors?.includes('traces')) };
}
function hostEnvironmentTraceTls(env, url) {
  // Only a host-selected HTTPS endpoint may resolve the host's private files.
  // A header-only override of a controller URL does not make it a host owner.
  if (!url) return { tls: { verify: true }, unavailable: false };
  try {
    validateUrl(url, { exact: true });
    if (new URL(url).protocol !== 'https:') return { tls: { verify: true }, unavailable: false };
    const tls = { verify: true };
    for (const [suffix, field] of ENVIRONMENT_TLS_FIELDS) {
      const file = env[`OTEL_EXPORTER_OTLP_TRACES_${suffix}`] || env[`OTEL_EXPORTER_OTLP_${suffix}`];
      if (file) tls[field] = readFileSync(String(file), 'utf8');
    }
    return { tls, unavailable: false };
  } catch {
    // Never reveal a path and never fall back to a less secure transport.
    return { tls: { verify: true }, unavailable: true };
  }
}
function attributes(values = {}) {
  return Object.entries(values).filter(([, value]) => value != null && value !== '').map(([key, value]) => ({ key, value: { stringValue: String(value).slice(0, 256) } }));
}
function outcomeStatus(kind, result) {
  const succeeded = kind === 'process'
    ? result?.exitCode === 0 && result?.timedOut !== true && result?.cancelled !== true && result?.signal == null
    : result?.ok !== false;
  return succeeded ? { code: 1 } : { code: 2, message: kind === 'process' ? 'remote_process_failed' : 'remote_filesystem_failed' };
}
function requestHeaders(protocol, supplied) {
  // Transport framing and content type belong to the exporter, not a collector
  // credential. No redirects or implicit forwarding to a second origin.
  const result = {};
  for (const [key, value] of Object.entries(supplied)) {
    if (!['content-type', 'content-length', 'host', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) result[key] = value;
  }
  result['content-type'] = protocol === 'http/protobuf' ? 'application/x-protobuf' : 'application/json';
  return result;
}
function sameEndpoint(left, right) {
  if (!left || !right) return false;
  try { return new URL(left).href === new URL(right).href; } catch { return false; }
}
function boundedRejectedSpans(value) {
  if (typeof value === 'string') {
    if (!/^[0-9]+$/.test(value)) return null;
    const significant = value.replace(/^0+/, '');
    if (significant.length > 16) return Number.MAX_SAFE_INTEGER;
    value = Number(significant || '0');
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return Math.min(value, Number.MAX_SAFE_INTEGER);
}
function parseTraceResponse(body, protocol) {
  if (!body?.length) return { rejectedSpans: 0, warning: false };
  try {
    if (protocol === 'http/protobuf') return decodeTraceResponse(body);
    const response = JSON.parse(body.toString('utf8'));
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('invalid_response');
    const partial = response.partialSuccess ?? response.partial_success;
    if (partial === undefined) return { rejectedSpans: 0, warning: false };
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw new Error('invalid_response');
    const rawCount = partial.rejectedSpans ?? partial.rejected_spans;
    const rejectedSpans = rawCount === undefined ? 0 : boundedRejectedSpans(rawCount);
    const message = partial.errorMessage ?? partial.error_message;
    if (rejectedSpans === null || (message !== undefined && typeof message !== 'string')) throw new Error('invalid_response');
    return { rejectedSpans, warning: Boolean(message) };
  } catch { return { invalid: true }; }
}
function nodeRequest(url, options, tls) {
  return new Promise((resolve, reject) => {
    const isTls = new URL(url).protocol === 'https:';
    const request = (isTls ? https : http).request(url, {
      method: 'POST', headers: options.headers, signal: options.signal,
      ...(isTls ? { rejectUnauthorized: tls.verify !== false, ...(tls.caCertificate ? { ca: tls.caCertificate } : {}),
        ...(tls.clientCertificate ? { cert: tls.clientCertificate } : {}), ...(tls.clientKey ? { key: tls.clientKey } : {}) } : {}),
    }, (response) => {
      // Only retain numeric status, never statusMessage or error response text.
      const status = response.statusCode;
      const ok = status >= 200 && status < 300;
      response.on('error', reject);
      if (!ok) { response.destroy(); resolve({ ok, status }); return; }
      const chunks = []; let size = 0; let overflow = false;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_OTLP_RESPONSE_BYTES) {
          overflow = true; chunks.length = 0;
          resolve({ ok, status, responseError: 'response_too_large' });
          response.destroy();
        } else chunks.push(chunk);
      });
      response.on('aborted', () => { if (!overflow) reject(new Error('telemetry_response_aborted')); });
      response.on('end', () => { if (!overflow) resolve({ ok, status, body: Buffer.concat(chunks, size) }); });
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

// The optional fetch transport is principally a test seam, but if a real fetch
// response is supplied it must obey the same streaming limit and timeout.
async function fetchResponse(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const ok = response?.ok; const status = response?.status; const body = response?.body;
  if (!ok) {
    try { if (typeof body?.cancel === 'function') await body.cancel(); else body?.destroy?.(); } catch { /* Ignore untrusted body errors. */ }
    return { ok, status };
  }
  if (body == null) return { ok, status };
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    const size = typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength;
    return size > MAX_OTLP_RESPONSE_BYTES ? { ok, status, responseError: 'response_too_large' } : { ok, status, body: Buffer.from(body) };
  }
  if (typeof body[Symbol.asyncIterator] !== 'function') return { ok, status, responseError: 'response_invalid' };
  const chunks = []; let size = 0;
  for await (const chunk of body) {
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) return { ok, status, responseError: 'response_invalid' };
    size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (size > MAX_OTLP_RESPONSE_BYTES) return { ok, status, responseError: 'response_too_large' };
    chunks.push(Buffer.from(chunk));
  }
  return { ok, status, body: Buffer.concat(chunks, size) };
}

export function createGatewayTelemetry({ env = process.env, version = null, fetchImpl = null, randomTraceId = () => hex(16), randomSpanId = () => hex(8), logger = console } = {}) {
  const environmentUrl = endpoint(env);
  const environmentHasEndpoint = Boolean(environmentUrl || String(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT || '').trim());
  const environmentHasHeaders = Boolean(String(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || '').trim() || String(env.OTEL_EXPORTER_OTLP_HEADERS || '').trim());
  const environmentHasAnyHeaders = environmentHasHeaders || Boolean(String(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS || '').trim());
  let environmentHeaders = {};
  if (environmentUrl || environmentHasHeaders) {
    try { environmentHeaders = environmentTraceHeaders(env.OTEL_EXPORTER_OTLP_HEADERS, env.OTEL_EXPORTER_OTLP_TRACES_HEADERS); } catch { environmentHeaders = {}; }
  }
  let hostTls = hostEnvironmentTraceTls(env, environmentUrl);
  // Do not retain the caller's environment (including PEM paths) after the
  // selected host transport is snapshotted. Tuning is read below first.
  const queueLimit = positiveInteger(env.OTEL_BSP_MAX_QUEUE_SIZE, DEFAULT_QUEUE_SIZE, MAX_QUEUE_SIZE);
  const timeoutMs = positiveInteger(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT || env.OTEL_BSP_EXPORT_TIMEOUT, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const scheduleDelayMs = positiveInteger(env.OTEL_BSP_SCHEDULE_DELAY, 1_000, MAX_TIMEOUT_MS);
  const shutdownTimeoutMs = positiveInteger(env.OTEL_BSP_SHUTDOWN_TIMEOUT || env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT, timeoutMs, MAX_TIMEOUT_MS);
  env = undefined;
  const generations = new Set();
  // Share each transport's budget across its temporary owners, including
  // in-flight work. A hung owner cannot bypass its bound or block a healthy
  // different transport; the keys retain only digests, not credentials.
  const privatePending = new Map();
  const completed = { failures: { export: 0, dropped: 0, shutdown: 0 }, lastExportFailure: null, destinations: new Map() };
  let closed = false;
  let shuttingDown = null;
  let configurationFailures = 0;

  function itemFor(config, temporary) {
    const privateBudgetKey = temporary ? crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex') : null;
    return { ...config, privateBudgetKey, queue: [], failures: { export: 0, dropped: 0, shutdown: 0 }, lastExportFailure: null,
      flushing: null, flight: null, timer: null, abandoned: false };
  }
  function releasePrivate(item, count) {
    if (!item.privateBudgetKey || !count) return;
    const remaining = (privatePending.get(item.privateBudgetKey) || 0) - count;
    if (remaining > 0) privatePending.set(item.privateBudgetKey, remaining);
    else privatePending.delete(item.privateBudgetKey);
  }
  function createGeneration(configs, source, temporary = false) {
    const generation = { items: configs.map((config) => itemFor(config, temporary)), source, temporary, owners: 0, retired: false, collected: false };
    generations.add(generation);
    return generation;
  }
  function accumulateItem(total, item) {
    for (const key of Object.keys(total.failures)) total.failures[key] = Math.min(Number.MAX_SAFE_INTEGER, total.failures[key] + (item.failures[key] || 0));
    if (item.lastExportFailure) total.lastExportFailure = { ...item.lastExportFailure };
  }
  function collect(generation) {
    if (!generation.retired || generation.collected || generation.owners || generation.items.some((item) => item.queue.length || item.flushing || item.timer)) return;
    generation.collected = true;
    generations.delete(generation);
    for (const item of generation.items) {
      accumulateItem(completed, item);
      let dest = completed.destinations.get(item.id);
      if (!dest) {
        if (completed.destinations.size >= MAX_COMPLETED_DESTINATIONS) completed.destinations.delete(completed.destinations.keys().next().value);
        dest = { id: item.id, enabled: false, tracesEnabled: false, queued: 0, headersConfigured: false, failures: { export: 0, dropped: 0, shutdown: 0 } };
        completed.destinations.set(item.id, dest);
      }
      accumulateItem(dest, item);
    }
  }
  function buildBody(batch) {
    return { resourceSpans: [{ resource: { attributes: attributes({ 'service.name': 'node-goblin', ...(version ? { 'service.version': version } : {}) }) },
      scopeSpans: [{ scope: { name: 'node-goblin.gateway', ...(version ? { version } : {}) }, spans: batch }] }] };
  }
  function schedule(generation, item) {
    if (closed || item.abandoned || item.timer || item.flushing || !item.queue.length) return;
    item.timer = setTimeout(() => { item.timer = null; void flushItem(generation, item); }, scheduleDelayMs);
    item.timer.unref?.();
  }
  async function exportBatch(item, batch) {
    const controller = new AbortController();
    const flight = { controller, count: batch.length, cancelled: false, cancel: null };
    item.flight = flight;
    let timer;
    let failure = null;
    let responseWarning = null;
    try {
      const envelope = buildBody(batch);
      const body = item.protocol === 'http/protobuf' ? encodeTraceRequest(envelope) : JSON.stringify(envelope);
      const options = { method: 'POST', headers: requestHeaders(item.protocol, item.headers), body, signal: controller.signal };
      const result = await Promise.race([
        Promise.resolve().then(() => fetchImpl ? fetchResponse(fetchImpl, item.url, options) : nodeRequest(item.url, options, item.tls)),
        new Promise((_, reject) => {
          flight.cancel = () => reject(new Error('telemetry_cancelled'));
          timer = setTimeout(() => { controller.abort(); reject(new Error('telemetry_timeout')); }, timeoutMs);
        }),
      ]);
      const code = Number.isInteger(result?.status) && result.status >= 100 && result.status <= 599 ? result.status : null;
      if (!result?.ok) failure = { reason: 'http_status', ...(code ? { statusCode: code } : {}) };
      else if (result.responseError) responseWarning = result.responseError;
      else {
        const partial = parseTraceResponse(result.body, item.protocol);
        if (partial.invalid) responseWarning = 'response_invalid';
        else if (partial.rejectedSpans > 0) failure = { reason: 'partial_success', ...(code ? { statusCode: code } : {}), rejectedSpans: partial.rejectedSpans };
        else if (partial.warning) responseWarning = 'collector_warning';
      }
    } catch { failure = { reason: 'transport_error' }; }
    finally {
      clearTimeout(timer);
      if (item.flight === flight) item.flight = null;
      // A forced shutdown already accounted for this batch; a late callback
      // from an abort-ignoring transport cannot mutate any owner or status.
      if (!flight.cancelled && !item.abandoned) {
        item.lastExportFailure = failure;
        if (failure) {
          item.failures.export += 1;
          item.failures.dropped = Math.min(Number.MAX_SAFE_INTEGER, item.failures.dropped + (failure.rejectedSpans ?? batch.length));
          const partial = failure.reason === 'partial_success' ? ` destination=${item.id} rejectedSpans=${failure.rejectedSpans}` : '';
          try { logger.warn?.(`Node Goblin telemetry export failed: ${failure.reason}${failure.statusCode ? ` status=${failure.statusCode}` : ''}${partial}`); } catch { /* Telemetry must not affect remote work. */ }
        } else if (responseWarning) {
          try { logger.warn?.(`Node Goblin telemetry export warning: ${responseWarning} destination=${item.id}`); } catch { /* Telemetry must not affect remote work. */ }
        }
      }
    }
  }
  function flushItem(generation, item) {
    if (item.abandoned) return Promise.resolve();
    if (item.timer) { clearTimeout(item.timer); item.timer = null; }
    if (item.flushing) return item.flushing;
    if (!item.queue.length) { collect(generation); return Promise.resolve(); }
    item.flushing = (async () => {
      while (item.queue.length && !item.abandoned) {
        const batch = item.queue.splice(0, BATCH_SIZE);
        await exportBatch(item, batch);
        releasePrivate(item, batch.length);
      }
    })().finally(() => { item.flushing = null; if (item.queue.length) schedule(generation, item); collect(generation); });
    return item.flushing;
  }
  function retire(generation) {
    generation.retired = true;
    // Never block the configuration RPC on a failed or hung old collector.
    for (const item of generation.items) void flushItem(generation, item);
    collect(generation);
  }
  function enqueue(generation, span) {
    for (const item of generation.items) {
      if (!item.url || item.abandoned || closed) continue;
      if (item.privateBudgetKey && (privatePending.get(item.privateBudgetKey) || 0) >= queueLimit) { item.failures.dropped += 1; continue; }
      if (item.queue.length >= queueLimit) { item.queue.shift(); item.failures.dropped += 1; }
      item.queue.push(span);
      if (item.privateBudgetKey) privatePending.set(item.privateBudgetKey, (privatePending.get(item.privateBudgetKey) || 0) + 1);
      schedule(generation, item);
    }
  }
  function resolvedDestination(destination) {
    if (!destination || typeof destination !== 'object' || Array.isArray(destination) || (typeof destination.id !== 'string' || !DESTINATION_ID.test(destination.id))
      || typeof destination.enabled !== 'boolean' || destination.tracesEnabled !== undefined && typeof destination.tracesEnabled !== 'boolean'
      || destination.environmentOwned !== undefined && typeof destination.environmentOwned !== 'boolean'
      || ['endpoint', 'tracesEndpoint', 'headers', 'tracesHeaders'].some((key) => destination[key] != null && typeof destination[key] !== 'string')) throw new Error('telemetry_configuration_invalid');
    const enabled = destination.enabled;
    const tracesEnabled = destination.tracesEnabled !== false;
    const protocol = destination.protocol || 'http/json';
    if (!['http/json', 'http/protobuf'].includes(protocol)) throw new Error('telemetry_configuration_invalid');
    const tls = destination.tls || {};
    if (typeof tls !== 'object' || Array.isArray(tls) || tls.verify !== undefined && typeof tls.verify !== 'boolean'
      || tls.caCertificate !== undefined && typeof tls.caCertificate !== 'string') throw new Error('telemetry_configuration_invalid');
    const environmentOwned = destination.environmentOwned === true;
    const privateTls = environmentOwned ? privateEnvironmentTraceTls(destination) : null;
    const url = enabled && tracesEnabled && !privateTls?.unavailable
      ? (destination.tracesEndpoint ? validateUrl(destination.tracesEndpoint, { exact: true }) : validateUrl(destination.endpoint)) : null;
    const destHeaders = url ? (environmentOwned ? environmentTraceHeaders(destination.headers, destination.tracesHeaders)
      : controlledHeaders(destination.tracesHeaders || destination.headers)) : {};
    return { id: destination.id, enabled, tracesEnabled, url, headers: destHeaders, protocol,
      tls: environmentOwned ? privateTls.tls : { verify: tls.verify !== false, ...(tls.caCertificate ? { caCertificate: tls.caCertificate } : {}) } };
  }
  // Host endpoint historically enables a single exporter even before the
  // controller connects; the legacy scalar path preserves that behavior.
  let active = createGeneration(environmentUrl ? [{ id: 'environment', enabled: true, tracesEnabled: true, url: hostTls.unavailable ? null : environmentUrl,
    headers: environmentHeaders, protocol: 'http/json', tls: hostTls.tls }] : [], environmentUrl ? 'environment' : 'default');
  // Store a digest rather than another long-lived copy of secrets or CA text.
  let activeKey = null;

  // Used both by the global control-plane update and an admitted operation's
  // trusted, private owner. Resolution is atomic and never mutates active.
  function resolveConfiguration(configuration) {
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || typeof configuration.enabled !== 'boolean') throw new Error('telemetry_configuration_invalid');
    const isList = Object.hasOwn(configuration, 'destinations');
    let configs;
    let source;
    if (isList) {
      if (!Array.isArray(configuration.destinations)) throw new Error('telemetry_configuration_invalid');
      const resolved = configuration.destinations.map(resolvedDestination);
      if (new Set(resolved.map((item) => item.id)).size !== resolved.length) throw new Error('telemetry_configuration_invalid');
      if (environmentHasEndpoint || environmentHasAnyHeaders) {
        // Host transport overrides select ONE owner; never fan out host auth to
        // controller destinations. A controller credential may only follow its
        // own exact trace URL, including when a host endpoint selects that URL.
        const first = configuration.enabled ? resolved.find((item) => item.enabled && item.tracesEnabled && item.url) : null;
        const matching = configuration.enabled && environmentUrl ? resolved.find((item) => sameEndpoint(item.url, environmentUrl)) : null;
        // A metrics-only host endpoint must not fall back to a saved trace URL.
        const url = environmentHasEndpoint ? (hostTls.unavailable ? null : environmentUrl) : first?.url || null;
        const enabled = Boolean(environmentUrl || (configuration.enabled && url));
        configs = [{ id: 'environment', enabled, tracesEnabled: Boolean(url), url,
          headers: environmentHasHeaders ? environmentHeaders : matching?.headers || {}, protocol: environmentHasEndpoint ? 'http/json' : first?.protocol || 'http/json',
          tls: environmentHasEndpoint ? hostTls.tls : first?.tls || { verify: true } }];
        source = 'environment';
      } else {
        configs = resolved.map((item) => ({ ...item, enabled: configuration.enabled && item.enabled, url: configuration.enabled ? item.url : null }));
        source = configs.some((item) => item.url) ? 'controller' : 'default';
      }
    } else {
      if (typeof configuration.endpoint !== 'string' || (configuration.headers != null && typeof configuration.headers !== 'string')) throw new Error('telemetry_configuration_invalid');
      // Legacy Core scalar snapshots have no destination marker; the presence
      // of these private snapshot fields itself identifies the environment owner.
      const scalarEnvironment = Object.hasOwn(configuration, 'environmentTls') || Object.hasOwn(configuration, 'environmentTlsErrors');
      if (scalarEnvironment && ((configuration.tracesEndpoint != null && typeof configuration.tracesEndpoint !== 'string')
        || (configuration.tracesHeaders != null && typeof configuration.tracesHeaders !== 'string'))) throw new Error('telemetry_configuration_invalid');
      const privateTls = scalarEnvironment ? privateEnvironmentTraceTls(configuration) : null;
      const controlledUrl = configuration.enabled && !privateTls?.unavailable
        ? (scalarEnvironment && configuration.tracesEndpoint ? validateUrl(configuration.tracesEndpoint, { exact: true }) : validateUrl(configuration.endpoint, { legacy: true })) : null;
      const url = environmentUrl ? (hostTls.unavailable ? null : environmentUrl) : controlledUrl;
      const suppliedHeaders = scalarEnvironment ? environmentTraceHeaders(configuration.headers, configuration.tracesHeaders) : controlledHeaders(configuration.headers);
      const destHeaders = environmentHasHeaders ? environmentHeaders : environmentUrl && !sameEndpoint(environmentUrl, controlledUrl) ? {} : suppliedHeaders;
      configs = url ? [{ id: environmentUrl ? 'environment' : 'default', enabled: true, tracesEnabled: true, url, headers: destHeaders, protocol: 'http/json',
        tls: environmentUrl ? hostTls.tls : privateTls?.tls || { verify: true } }] : [];
      source = environmentUrl ? 'environment' : url ? 'controller' : 'default';
    }
    return { configs, source };
  }
  async function configure(configuration = {}) {
    if (closed) throw new Error('telemetry_configuration_invalid');
    const { configs, source } = resolveConfiguration(configuration);
    const key = crypto.createHash('sha256').update(JSON.stringify([source, configs])).digest('hex');
    if (key === activeKey) return status();
    const previous = active;
    active = createGeneration(configs, source);
    activeKey = key;
    retire(previous);
    return status();
  }
  async function execute({ kind, tool = null, targetId = null, operationId = null, traceContext = null, telemetryConfiguration = undefined, operation }) {
    if (closed) return operation();
    let privateConfiguration;
    if (telemetryConfiguration !== undefined) {
      try { privateConfiguration = resolveConfiguration(telemetryConfiguration); telemetryConfiguration = undefined; }
      catch {
        configurationFailures = Math.min(Number.MAX_SAFE_INTEGER, configurationFailures + 1);
        try { logger.warn?.('Node Goblin telemetry configuration failed: telemetry_configuration_invalid'); } catch { /* Safe diagnostic only. */ }
        // Never fall back to a different active owner for an invalid config.
        return operation();
      }
    }
    let generation = active;
    if (privateConfiguration ? !privateConfiguration.configs.some((item) => item.url) : !generation.items.some((item) => item.url)) return operation();
    let parent; let traceId; let spanId; let startTimeUnixNano;
    try { parent = parseTraceContext(traceContext); } catch { return operation(); }
    if (parent && !parent.sampled) return operation();
    try {
      traceId = parent?.traceId || randomTraceId();
      spanId = randomSpanId();
      startTimeUnixNano = nanos();
      if (privateConfiguration) {
        generation = createGeneration(privateConfiguration.configs, privateConfiguration.source, true);
        privateConfiguration = undefined;
        // Private generations have no global owner and drain immediately on
        // completion, including when the active generation has been disabled.
        generation.retired = true;
      }
      generation.owners += 1;
    } catch { return operation(); }
    let statusValue = { code: 0 };
    try {
      const result = await operation();
      try { statusValue = outcomeStatus(kind, result); } catch { /* Outcome remains authoritative. */ }
      return result;
    } catch (error) {
      statusValue = { code: 2, message: kind === 'process' ? 'remote_process_failed' : 'remote_filesystem_failed' };
      throw error;
    } finally {
      try {
        enqueue(generation, {
          traceId, spanId, ...(parent ? { parentSpanId: parent.spanId } : {}),
          ...(parent?.tracestate ? { traceState: parent.tracestate } : {}),
          flags: parent ? parent.traceFlags : 1,
          name: `node-goblin.${kind}`, kind: 2, startTimeUnixNano, endTimeUnixNano: nanos(),
          attributes: attributes({ 'node_goblin.operation.kind': kind, 'node_goblin.tool.name': safeTelemetryTool(tool),
            'node_goblin.target.id': safeTelemetryTargetId(targetId), 'burrow.operation.id': safeTelemetryOperationId(operationId) }),
          status: statusValue,
        });
      } catch { /* Telemetry must never replace the operation outcome. */ }
      generation.owners -= 1;
      if (generation.retired) {
        for (const item of generation.items) void flushItem(generation, item);
        collect(generation);
      }
    }
  }
  function status() {
    const failures = { ...completed.failures };
    let lastExportFailure = completed.lastExportFailure;
    const destinations = new Map([...completed.destinations].map(([id, item]) => [id, { ...item, failures: { ...item.failures } }]));
    for (const generation of generations) for (const item of generation.items) {
      for (const key of Object.keys(failures)) failures[key] = Math.min(Number.MAX_SAFE_INTEGER, failures[key] + item.failures[key]);
      if (item.lastExportFailure) lastExportFailure = item.lastExportFailure;
      let entry = destinations.get(item.id);
      if (!entry) { entry = { id: item.id, enabled: false, tracesEnabled: false, queued: 0, headersConfigured: false, failures: { export: 0, dropped: 0, shutdown: 0 } }; destinations.set(item.id, entry); }
      accumulateItem(entry, item);
      entry.queued += item.queue.length;
      if (generation === active && !closed) Object.assign(entry, { enabled: item.enabled, tracesEnabled: item.tracesEnabled, headersConfigured: Object.keys(item.headers).length > 0 });
    }
    return { configured: !closed && active.items.some((item) => item.url), source: active.source,
      headersConfigured: !closed && active.items.some((item) => item.url && Object.keys(item.headers).length),
      queued: [...generations].reduce((sum, generation) => sum + generation.items.reduce((n, item) => n + item.queue.length, 0), 0),
      failures: { ...failures, configure: configurationFailures, ...(lastExportFailure ? { lastExportFailure: { ...lastExportFailure } } : {}) }, destinations: [...destinations.values()] };
  }
  async function flush() {
    await Promise.all([...generations].flatMap((generation) => generation.items.map((item) => flushItem(generation, item))));
  }
  function shutdown({ timeout = shutdownTimeoutMs } = {}) {
    if (shuttingDown) return shuttingDown;
    closed = true;
    // At shutdown active operations can outlive the exporter. Their eventual
    // completion must not send telemetry or retain private transport state.
    for (const generation of generations) generation.retired = true;
    const waitMs = positiveInteger(timeout, shutdownTimeoutMs, MAX_TIMEOUT_MS);
    shuttingDown = (async () => {
      let timer;
      const drained = await Promise.race([
        flush().then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); }),
      ]);
      clearTimeout(timer);
      if (!drained) {
        for (const generation of generations) for (const item of generation.items) {
          if (!item.flushing && !item.queue.length) continue;
          item.failures.shutdown += 1;
          item.failures.dropped += item.queue.length;
          releasePrivate(item, item.queue.length);
          item.queue.length = 0;
          item.abandoned = true;
          if (item.flight) { item.failures.dropped += item.flight.count; item.flight.cancelled = true; item.flight.controller.abort(); item.flight.cancel?.(); }
          if (item.timer) { clearTimeout(item.timer); item.timer = null; }
        }
      }
      // Long-running operations may outlive shutdown. Once no future export is
      // allowed, erase transport secrets even while their owners are running.
      for (const generation of generations) for (const item of generation.items) {
        item.url = null; item.headers = {}; item.tls = { verify: true };
      }
      environmentHeaders = {};
      hostTls = { tls: { verify: true }, unavailable: true };
    })();
    return shuttingDown;
  }
  return Object.freeze({ configure, execute, flush, shutdown, status });
}
