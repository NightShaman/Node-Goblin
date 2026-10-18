import crypto from 'node:crypto';

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;
const DEFAULT_QUEUE_SIZE = 512;

function parseParent(value) {
  const traceparent = String(value?.traceparent || '').trim().toLowerCase();
  if (!TRACEPARENT.test(traceparent)) return null;
  const [, traceId, spanId, flags] = traceparent.split('-');
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) return null;
  return { traceId, spanId, flags };
}

function hex(bytes) { return crypto.randomBytes(bytes).toString('hex'); }
function nanos() { return String(BigInt(Date.now()) * 1_000_000n); }
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

export function createGatewayTelemetry({ env = process.env, version = null, fetchImpl = globalThis.fetch, randomTraceId = () => hex(16), randomSpanId = () => hex(8) } = {}) {
  const url = endpoint(env);
  const queueLimit = Math.max(1, Number(env.OTEL_BSP_MAX_QUEUE_SIZE || DEFAULT_QUEUE_SIZE));
  const timeoutMs = Math.max(1, Number(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT || env.OTEL_EXPORTER_OTLP_TIMEOUT || 3_000));
  const queue = [];
  const failures = { export: 0, dropped: 0 };
  let flushing = null;
  let timer = null;

  async function flush() {
    if (!url || flushing || !queue.length) return flushing;
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
      finally { flushing = null; if (queue.length) void flush(); }
    })();
    return flushing;
  }

  function enqueue(span) {
    if (!url) return;
    if (queue.length >= queueLimit) { queue.shift(); failures.dropped += 1; }
    queue.push(span);
    if (!timer) timer = setTimeout(() => { timer = null; void flush(); }, Math.max(1, Number(env.OTEL_BSP_SCHEDULE_DELAY || 1_000))).unref();
  }

  async function execute({ kind, tool = null, targetId = null, operationId = null, traceContext = null, operation }) {
    if (!url) return operation();
    const parent = parseParent(traceContext);
    const traceId = parent?.traceId || randomTraceId();
    const spanId = randomSpanId();
    const startTimeUnixNano = nanos();
    let status = { code: 1 };
    try {
      const result = await operation();
      status = { code: result?.ok === false ? 2 : 1 };
      return result;
    } catch (error) {
      status = { code: 2, message: String(error?.code || error?.message || 'gateway_operation_failed').slice(0, 160) };
      throw error;
    } finally {
      enqueue({ traceId, spanId, ...(parent ? { parentSpanId: parent.spanId } : {}), flags: 1, name: `node-goblin.${kind}`, kind: 2, startTimeUnixNano, endTimeUnixNano: nanos(), attributes: attributes({ 'node_goblin.operation.kind': kind, 'node_goblin.tool.name': tool, 'node_goblin.target.id': targetId, 'burrow.operation.id': operationId }), status });
    }
  }

  async function shutdown() {
    if (timer) { clearTimeout(timer); timer = null; }
    await flush();
    if (flushing) await flushing;
  }

  return Object.freeze({ execute, flush, shutdown, status: () => ({ configured: Boolean(url), queued: queue.length, failures: { ...failures } }) });
}
