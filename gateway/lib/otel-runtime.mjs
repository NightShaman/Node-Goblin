import crypto from 'node:crypto';
import { parseTraceContext, safeTelemetryOperationId, safeTelemetryTargetId, safeTelemetryTool } from './protocol.mjs';

const DEFAULT_QUEUE_SIZE = 512;
const DEFAULT_TIMEOUT_MS = 3_000;

function hex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }
function nanos() { return String(BigInt(Date.now()) * 1_000_000n); }
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
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
function headers(env) { return parseHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS); }
function controlledEndpoint(value) {
  const source = String(value || '').trim();
  if (!source) return null;
  let url;
  try { url = new URL(source); } catch { throw new Error('telemetry_endpoint_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('telemetry_endpoint_invalid');
  const normalized = url.toString().replace(/\/$/, '');
  return normalized.endsWith('/v1/traces') ? normalized : `${normalized}/v1/traces`;
}
function controlledHeaders(value) {
  const source = String(value || '').trim();
  if (!source) return {};
  if (source.length > 8_192 || /[\r\n]/.test(source)) throw new Error('telemetry_headers_invalid');
  const parsed = parseHeaders(source);
  if (!Object.keys(parsed).length) throw new Error('telemetry_headers_invalid');
  return parsed;
}
function attributes(values = {}) {
  return Object.entries(values).filter(([, value]) => value != null && value !== '').map(([key, value]) => ({ key, value: { stringValue: String(value).slice(0, 256) } }));
}
function processSucceeded(result = {}) {
  return result?.exitCode === 0 && result?.timedOut !== true && result?.cancelled !== true && result?.signal == null;
}
function outcomeStatus(kind, result) {
  const succeeded = kind === 'process' ? processSucceeded(result) : result?.ok !== false;
  return succeeded ? { code: 1 } : { code: 2, message: kind === 'process' ? 'remote_process_failed' : 'remote_filesystem_failed' };
}
function boundedWait(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

export function createGatewayTelemetry({ env = process.env, version = null, fetchImpl = globalThis.fetch, randomTraceId = () => hex(16), randomSpanId = () => hex(8), logger = console } = {}) {
  const environmentUrl = endpoint(env);
  let environmentHeaders = {};
  if (environmentUrl) {
    try { environmentHeaders = headers(env); } catch { environmentHeaders = {}; }
  }
  let url = environmentUrl;
  let requestHeaders = environmentHeaders;
  let source = environmentUrl ? 'environment' : 'default';
  const queueLimit = positiveInteger(env.OTEL_BSP_MAX_QUEUE_SIZE, DEFAULT_QUEUE_SIZE);
  const timeoutMs = positiveInteger(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT || env.OTEL_BSP_EXPORT_TIMEOUT, DEFAULT_TIMEOUT_MS);
  const scheduleDelayMs = positiveInteger(env.OTEL_BSP_SCHEDULE_DELAY, 1_000);
  const shutdownTimeoutMs = positiveInteger(env.OTEL_BSP_SHUTDOWN_TIMEOUT || env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT, timeoutMs);
  const queue = [];
  const failures = { export: 0, dropped: 0, shutdown: 0 };
  let lastExportFailure = null;
  let flushing = null;
  let timer = null;
  let closed = false;

  async function flush() {
    if (!url || !queue.length || closed) return flushing;
    if (flushing) { await flushing; return flush(); }
    const batch = queue.splice(0, Math.min(queue.length, 64));
    const targetUrl = url;
    const targetHeaders = { ...requestHeaders };
    flushing = (async () => {
      try {
        const response = await fetchImpl(targetUrl, {
          method: 'POST', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json', ...targetHeaders },
          body: JSON.stringify({ resourceSpans: [{ resource: { attributes: attributes({ 'service.name': 'node-goblin', ...(version ? { 'service.version': version } : {}) }) }, scopeSpans: [{ scope: { name: 'node-goblin.gateway', ...(version ? { version } : {}) }, spans: batch }] }] }),
        });
        if (!response.ok) {
          const statusCode = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : null;
          lastExportFailure = { reason: 'http_status', ...(statusCode ? { statusCode } : {}) };
        } else lastExportFailure = null;
      } catch { lastExportFailure = { reason: 'transport_error' }; }
      finally {
        if (lastExportFailure) {
          failures.export += 1; failures.dropped += batch.length;
          try { logger.warn?.(`Node Goblin telemetry export failed: ${lastExportFailure.reason}${lastExportFailure.statusCode ? ` status=${lastExportFailure.statusCode}` : ''}`); } catch { /* Logging must not affect remote operations. */ }
        }
        flushing = null;
      }
    })();
    return flushing;
  }

  function enqueue(span) {
    if (!url || closed) return;
    if (queue.length >= queueLimit) { queue.shift(); failures.dropped += 1; }
    queue.push(span);
    if (!timer) timer = setTimeout(() => { timer = null; void flush(); }, scheduleDelayMs).unref();
  }

  async function configure(configuration = {}) {
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
      || typeof configuration.enabled !== 'boolean' || typeof configuration.endpoint !== 'string'
      || (configuration.headers !== undefined && typeof configuration.headers !== 'string')) throw new Error('telemetry_configuration_invalid');
    const controlledUrl = configuration.enabled ? controlledEndpoint(configuration.endpoint) : null;
    const nextUrl = environmentUrl || controlledUrl;
    const nextHeaders = Object.keys(environmentHeaders).length ? environmentHeaders : controlledHeaders(configuration.headers);
    if (timer) { clearTimeout(timer); timer = null; }
    // An in-flight export already owns its URL and headers. Do not hold a
    // configuration response hostage to a collector that ignores abort signals.
    if (queue.length) { failures.dropped += queue.length; queue.length = 0; }
    url = nextUrl;
    requestHeaders = nextHeaders;
    source = environmentUrl ? 'environment' : nextUrl ? 'controller' : 'default';
    return status();
  }

  async function execute({ kind, tool = null, targetId = null, operationId = null, traceContext = null, operation }) {
    if (!url) return operation();
    const parent = parseTraceContext(traceContext);
    if (parent && !parent.sampled) return operation();
    const traceId = parent?.traceId || randomTraceId();
    const spanId = randomSpanId();
    const startTimeUnixNano = nanos();
    let statusValue = { code: 0 };
    try {
      const result = await operation();
      statusValue = outcomeStatus(kind, result);
      return result;
    } catch (error) {
      statusValue = { code: 2, message: kind === 'process' ? 'remote_process_failed' : 'remote_filesystem_failed' };
      throw error;
    } finally {
      enqueue({
        traceId, spanId, ...(parent ? { parentSpanId: parent.spanId } : {}),
        ...(parent?.tracestate ? { traceState: parent.tracestate } : {}),
        flags: parent ? parent.traceFlags : 1,
        name: `node-goblin.${kind}`, kind: 2, startTimeUnixNano, endTimeUnixNano: nanos(),
        attributes: attributes({
          'node_goblin.operation.kind': kind,
          'node_goblin.tool.name': safeTelemetryTool(tool),
          'node_goblin.target.id': safeTelemetryTargetId(targetId),
          'burrow.operation.id': safeTelemetryOperationId(operationId),
        }),
        status: statusValue,
      });
    }
  }

  function status() { return { configured: Boolean(url), source, headersConfigured: Object.keys(requestHeaders).length > 0, queued: queue.length, failures: { ...failures, ...(lastExportFailure ? { lastExportFailure: { ...lastExportFailure } } : {}) } }; }

  async function shutdown({ timeout = shutdownTimeoutMs } = {}) {
    if (closed) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const pending = flush();
    await boundedWait(Promise.resolve(pending).then(() => flushing), positiveInteger(timeout, shutdownTimeoutMs));
    if (flushing || queue.length) { failures.shutdown += 1; failures.dropped += queue.length; queue.length = 0; }
    closed = true;
  }

  return Object.freeze({ configure, execute, flush, shutdown, status });
}
