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
function headers(env) {
  const source = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS || env.OTEL_EXPORTER_OTLP_HEADERS;
  if (!source) return {};
  return Object.fromEntries(String(source).split(',').map((entry) => entry.split('=', 2).map((item) => decodeURIComponent(item.trim()))).filter(([key, value]) => key && value));
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

export function createGatewayTelemetry({ env = process.env, version = null, fetchImpl = globalThis.fetch, randomTraceId = () => hex(16), randomSpanId = () => hex(8) } = {}) {
  const url = endpoint(env);
  const queueLimit = positiveInteger(env.OTEL_BSP_MAX_QUEUE_SIZE, DEFAULT_QUEUE_SIZE);
  const timeoutMs = positiveInteger(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT || env.OTEL_BSP_EXPORT_TIMEOUT, DEFAULT_TIMEOUT_MS);
  const scheduleDelayMs = positiveInteger(env.OTEL_BSP_SCHEDULE_DELAY, 1_000);
  const shutdownTimeoutMs = positiveInteger(env.OTEL_BSP_SHUTDOWN_TIMEOUT || env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT, timeoutMs);
  const queue = [];
  const failures = { export: 0, dropped: 0, shutdown: 0 };
  let flushing = null;
  let timer = null;
  let closed = false;

  async function flush() {
    if (!url || flushing || !queue.length || closed) return flushing;
    const batch = queue.splice(0, Math.min(queue.length, 64));
    flushing = (async () => {
      try {
        const response = await fetchImpl(url, {
          method: 'POST', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/json', ...headers(env) },
          body: JSON.stringify({ resourceSpans: [{ resource: { attributes: attributes({ 'service.name': 'node-goblin', ...(version ? { 'service.version': version } : {}) }) }, scopeSpans: [{ scope: { name: 'node-goblin.gateway', ...(version ? { version } : {}) }, spans: batch }] }] }),
        });
        if (!response.ok) throw new Error('otlp_export_failed');
      } catch { failures.export += 1; failures.dropped += batch.length; }
      finally { flushing = null; if (queue.length && !closed) void flush(); }
    })();
    return flushing;
  }

  function enqueue(span) {
    if (!url || closed) return;
    if (queue.length >= queueLimit) { queue.shift(); failures.dropped += 1; }
    queue.push(span);
    if (!timer) timer = setTimeout(() => { timer = null; void flush(); }, scheduleDelayMs).unref();
  }

  async function execute({ kind, tool = null, targetId = null, operationId = null, traceContext = null, operation }) {
    if (!url) return operation();
    const parent = parseTraceContext(traceContext);
    if (parent && !parent.sampled) return operation();
    const traceId = parent?.traceId || randomTraceId();
    const spanId = randomSpanId();
    const startTimeUnixNano = nanos();
    let status = { code: 0 };
    try {
      const result = await operation();
      status = outcomeStatus(kind, result);
      return result;
    } catch (error) {
      status = { code: 2, message: kind === 'process' ? 'remote_process_failed' : 'remote_filesystem_failed' };
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
        status,
      });
    }
  }

  async function shutdown({ timeout = shutdownTimeoutMs } = {}) {
    if (closed) return;
    if (timer) { clearTimeout(timer); timer = null; }
    const pending = flush();
    await boundedWait(Promise.resolve(pending).then(() => flushing), positiveInteger(timeout, shutdownTimeoutMs));
    if (flushing || queue.length) { failures.shutdown += 1; failures.dropped += queue.length; queue.length = 0; }
    closed = true;
  }

  return Object.freeze({ execute, flush, shutdown, status: () => ({ configured: Boolean(url), queued: queue.length, failures: { ...failures } }) });
}
