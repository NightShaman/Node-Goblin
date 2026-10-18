import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayTelemetry } from './lib/otel-runtime.mjs';

test('gateway remote span joins the Core trace and exports no command or filesystem arguments', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return { ok: true }; };
  const telemetry = createGatewayTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_BSP_SCHEDULE_DELAY: '1' }, fetchImpl, version: 'test',
    randomTraceId: () => 'a'.repeat(32), randomSpanId: () => 'b'.repeat(16),
  });
  const parent = { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' };
  const result = await telemetry.execute({ kind: 'process', tool: 'shell_exec', targetId: 'host-a', operationId: 'shell-1', traceContext: parent, operation: async () => ({ ok: true, command: 'secret command' }) });
  assert.equal(result.ok, true);
  await telemetry.shutdown();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://collector:4318/v1/traces');
  const span = requests[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.traceId, '0123456789abcdef0123456789abcdef');
  assert.equal(span.parentSpanId, '0123456789abcdef');
  const serialized = JSON.stringify(requests[0].body);
  assert.equal(serialized.includes('secret command'), false);
  assert.match(serialized, /node-goblin\.process/);
});

test('gateway telemetry is a no-op when no OTLP endpoint is configured', async () => {
  const telemetry = createGatewayTelemetry({ env: {}, fetchImpl: async () => assert.fail('export called') });
  assert.equal(telemetry.status().configured, false);
  assert.deepEqual(await telemetry.execute({ kind: 'filesystem', operation: async () => ({ ok: true }) }), { ok: true });
  await telemetry.shutdown();
});

test('collector failure is bounded and recorded without failing remote work', async () => {
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector/v1/traces', OTEL_BSP_MAX_QUEUE_SIZE: '1' }, fetchImpl: async () => { throw new Error('down'); } });
  assert.deepEqual(await telemetry.execute({ kind: 'process', operation: async () => ({ ok: true }) }), { ok: true });
  await telemetry.shutdown();
  assert.equal(telemetry.status().failures.export, 1);
  assert.equal(telemetry.status().failures.dropped, 1);
});
