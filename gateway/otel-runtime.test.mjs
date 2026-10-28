import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayTelemetry } from './lib/otel-runtime.mjs';

const spanFrom = (request) => request.body.resourceSpans[0].scopeSpans[0].spans[0];

test('gateway remote span joins the Core trace, preserves state and exports no content fields', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url, options, body: JSON.parse(options.body) }); return { ok: true }; };
  const telemetry = createGatewayTelemetry({
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_BSP_SCHEDULE_DELAY: '1' }, fetchImpl, version: 'test',
    randomTraceId: () => 'a'.repeat(32), randomSpanId: () => 'b'.repeat(16),
  });
  const parent = { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-03', tracestate: 'vendor=value' };
  const result = await telemetry.execute({ kind: 'process', tool: 'shell_exec', targetId: 'host-a', operationId: 'shell-1', traceContext: parent, operation: async () => ({ type: 'process.result', exitCode: 0, command: 'secret command', stdout: 'secret output' }) });
  assert.equal(result.exitCode, 0);
  await telemetry.shutdown();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://collector:4318/v1/traces');
  const span = spanFrom(requests[0]);
  assert.equal(span.traceId, '0123456789abcdef0123456789abcdef');
  assert.equal(span.parentSpanId, '0123456789abcdef');
  assert.equal(span.flags, 3);
  assert.equal(span.traceState, 'vendor=value');
  assert.equal(span.status.code, 1);
  const serialized = JSON.stringify(requests[0].body);
  for (const forbidden of ['secret command', 'secret output']) assert.equal(serialized.includes(forbidden), false);
  assert.match(serialized, /node-goblin\.process/);
});

test('unsampled remote parent executes without exporting a span', async () => {
  let exports = 0;
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' }, fetchImpl: async () => { exports++; return { ok: true }; } });
  const result = await telemetry.execute({ kind: 'process', traceContext: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-00' }, operation: async () => ({ exitCode: 0 }) });
  await telemetry.shutdown();
  assert.equal(result.exitCode, 0);
  assert.equal(exports, 0);
});

test('gateway telemetry reports process and filesystem failures with fixed safe status', async () => {
  const requests = [];
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector/v1/traces' }, fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true }; } });
  await telemetry.execute({ kind: 'process', operation: async () => ({ type: 'process.result', exitCode: 7, stderr: 'private failure' }) });
  await telemetry.execute({ kind: 'filesystem', tool: 'files_read', operation: async () => ({ ok: false, error: 'private path failure' }) });
  await telemetry.shutdown();
  const spans = requests.flatMap((body) => body.resourceSpans[0].scopeSpans[0].spans);
  assert.deepEqual(spans.map((span) => span.status), [
    { code: 2, message: 'remote_process_failed' },
    { code: 2, message: 'remote_filesystem_failed' },
  ]);
  const serialized = JSON.stringify(spans);
  for (const forbidden of ['private failure', 'private path failure']) assert.equal(serialized.includes(forbidden), false);
});

test('gateway telemetry is a no-op when no OTLP endpoint is configured', async () => {
  const telemetry = createGatewayTelemetry({ env: {}, fetchImpl: async () => assert.fail('export called') });
  assert.equal(telemetry.status().configured, false);
  assert.deepEqual(await telemetry.execute({ kind: 'filesystem', operation: async () => ({ ok: true }) }), { ok: true });
  await telemetry.shutdown();
});

test('controller configuration enables and disables telemetry live while host environment remains authoritative', async () => {
  const requests = [];
  const telemetry = createGatewayTelemetry({ env: {}, fetchImpl: async (url, options) => { requests.push({ url, headers: options.headers }); return { ok: true }; } });
  assert.equal(telemetry.status().configured, false);
  await telemetry.configure({ enabled: true, endpoint: 'https://collector.example/base', headers: 'authorization=Bearer%20private' });
  assert.equal(telemetry.status().source, 'controller');
  await telemetry.execute({ kind: 'process', operation: async () => ({ exitCode: 0 }) });
  await telemetry.flush();
  assert.equal(requests[0].url, 'https://collector.example/base/v1/traces');
  assert.equal(requests[0].headers.authorization, 'Bearer private');
  assert.equal(JSON.stringify(telemetry.status()).includes('private'), false);
  await telemetry.configure({ enabled: false, endpoint: '', headers: '' });
  assert.equal(telemetry.status().configured, false);

  const overridden = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://host.example' }, fetchImpl: async () => ({ ok: true }) });
  await overridden.configure({ enabled: true, endpoint: 'https://controller.example', headers: 'authorization=Bearer%20central' });
  assert.equal(overridden.status().configured, true);
  assert.equal(overridden.status().headersConfigured, false, 'controller auth must not go to a different host endpoint');
  await overridden.configure({ enabled: false, endpoint: '', headers: '' });
  assert.equal(overridden.status().configured, true);
  assert.equal(overridden.status().source, 'environment');
  await overridden.shutdown();
  await telemetry.shutdown();
});

test('reconfiguration never exports spans queued under an old collector to the new destination', async () => {
  const requests = [];
  const telemetry = createGatewayTelemetry({ env: {}, fetchImpl: async (url, options) => { requests.push({ url, body: options.body }); return { ok: true }; } });
  await telemetry.configure({ enabled: true, endpoint: 'https://old.example', headers: '' });
  for (let i = 0; i < 130; i += 1) await telemetry.execute({ kind: 'process', operationId: `op-${i}`, operation: async () => ({ exitCode: 0 }) });
  await telemetry.configure({ enabled: true, endpoint: 'https://new.example', headers: '' });
  assert.equal(requests.every((request) => request.url === 'https://old.example/v1/traces'), true);
  await telemetry.shutdown();
  assert.equal(requests.every((request) => request.url === 'https://old.example/v1/traces'), true);
  assert.equal(requests.reduce((count, request) => count + JSON.parse(request.body).resourceSpans[0].scopeSpans[0].spans.length, 0), 130);
  assert.equal(telemetry.status().failures.dropped, 0);
});

test('malformed unused host headers do not prevent gateway telemetry construction', async () => {
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_HEADERS: 'bad%ZZ' }, fetchImpl: async () => ({ ok: true }) });
  assert.equal(telemetry.status().configured, false);
  await telemetry.shutdown();
});

test('collector failure and hung shutdown are bounded without failing remote work', async () => {
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector/v1/traces', OTEL_BSP_MAX_QUEUE_SIZE: 'not-a-number', OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '20' }, fetchImpl: async () => new Promise(() => {}) });
  assert.deepEqual(await telemetry.execute({ kind: 'process', operation: async () => ({ exitCode: 0 }) }), { exitCode: 0 });
  const started = Date.now();
  await telemetry.shutdown({ timeout: 25 });
  assert.ok(Date.now() - started < 250);
  assert.equal(telemetry.status().failures.export, 1);
  assert.equal(telemetry.status().failures.dropped, 1);
});


test('header values retain padding and embedded equals after percent decoding', async () => {
  const requests = [];
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20abc==,x-token=abc%3D%3D' }, fetchImpl: async (_url, options) => { requests.push(options.headers); return { ok: true }; } });
  await telemetry.execute({ kind: 'process', operation: async () => ({ exitCode: 0 }) });
  await telemetry.flush();
  assert.equal(requests[0].authorization, 'Bearer abc==');
  assert.equal(requests[0]['x-token'], 'abc==');
  await telemetry.configure({ enabled: true, endpoint: 'https://other.example', headers: 'authorization=ignored==' });
  await telemetry.shutdown();
  const controller = createGatewayTelemetry({ env: {}, fetchImpl: async (_url, options) => { requests.push(options.headers); return { ok: true }; } });
  await controller.configure({ enabled: true, endpoint: 'https://collector.example', headers: 'authorization=Bearer%20def==' });
  await controller.execute({ kind: 'process', operation: async () => ({ exitCode: 0 }) });
  await controller.shutdown();
  assert.equal(requests[1].authorization, 'Bearer def==');
});

test('collector failures expose only safe reason and numeric HTTP status', async () => {
  const logs = [];
  let response = { ok: false, status: 401, body: 'collector-secret' };
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=secret-token' }, logger: { warn: (message) => logs.push(message) }, fetchImpl: async () => {
    if (response instanceof Error) throw response;
    return response;
  } });
  for (const outcome of [response, new Error('secret-token'), { ok: false, status: 'secret-token' }]) {
    response = outcome;
    await telemetry.execute({ kind: 'process', operation: async () => ({ exitCode: 0 }) });
    await telemetry.flush();
  }
  assert.deepEqual(logs, [
    'Node Goblin telemetry export failed: http_status status=401',
    'Node Goblin telemetry export failed: transport_error',
    'Node Goblin telemetry export failed: http_status',
  ]);
  assert.equal(telemetry.status().failures.export, 3);
  assert.equal(JSON.stringify(telemetry.status()).includes('secret-token'), false);
  await telemetry.shutdown();
});

test('reconfiguration responds while an old collector export is hung', async () => {
  let oldRequestStarted;
  const started = new Promise((resolve) => { oldRequestStarted = resolve; });
  const telemetry = createGatewayTelemetry({ env: {}, fetchImpl: async (url) => {
    if (url.includes('old.example')) { oldRequestStarted(); return new Promise(() => {}); }
    return { ok: true };
  } });
  await telemetry.configure({ enabled: true, endpoint: 'https://old.example', headers: '' });
  await telemetry.execute({ kind: 'process', operation: async () => ({ exitCode: 0 }) });
  void telemetry.flush();
  await started;
  await Promise.race([
    telemetry.configure({ enabled: true, endpoint: 'https://new.example', headers: '' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('configuration_blocked')), 100)),
  ]);
  assert.equal(telemetry.status().source, 'controller');
  await telemetry.shutdown({ timeout: 20 });
});

test('scalar override keeps headers at their own endpoint without leaking to a different host', async () => {
  const requests = [];
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://host.example/base' }, fetchImpl: async (url, { headers }) => { requests.push({ url, headers }); return { ok: true }; } });
  await telemetry.configure({ enabled: true, endpoint: 'https://elsewhere.example/base', headers: 'authorization=wrong-owner-secret' });
  await telemetry.execute({ kind: 'process', operation: () => ({ exitCode: 0 }) }); await telemetry.flush();
  assert.equal(requests[0].url, 'https://host.example/base/v1/traces');
  assert.equal(requests[0].headers.authorization, undefined);
  await telemetry.configure({ enabled: true, endpoint: 'https://host.example/base', headers: 'authorization=same-owner-secret' });
  await telemetry.execute({ kind: 'process', operation: () => ({ exitCode: 0 }) }); await telemetry.flush();
  assert.equal(requests[1].headers.authorization, 'same-owner-secret');
  await telemetry.configure({ enabled: false, endpoint: '', headers: '' });
  assert.equal(telemetry.status().configured, true);
  await telemetry.execute({ kind: 'process', operation: () => ({ exitCode: 0 }) }); await telemetry.flush();
  assert.equal(requests[2].headers.authorization, undefined);
  await telemetry.shutdown();
});

test('invalid private owner cannot fall back to active configuration or change operation outcome', async () => {
  const requests = []; const logs = [];
  const telemetry = createGatewayTelemetry({ env: {}, logger: { warn: (message) => logs.push(message) }, fetchImpl: async (url) => { requests.push(url); return { ok: true }; } });
  await telemetry.configure({ enabled: true, destinations: [{ id: 'active', enabled: true, endpoint: 'https://active.example', headers: 'authorization=active-private' }] });
  const bad = { enabled: true, destinations: [{ id: 'old', enabled: true, endpoint: 'https://wrong.example?secret=private' }] };
  const result = { exitCode: 0, stdout: 'unmodified' };
  assert.equal(await telemetry.execute({ kind: 'process', telemetryConfiguration: bad, operation: () => result }), result);
  let calls = 0; const sentinel = new Error('operation-secret');
  await assert.rejects(telemetry.execute({ kind: 'process', telemetryConfiguration: null, operation: () => { calls++; throw sentinel; } }), error => error === sentinel);
  assert.equal(calls, 1);
  await telemetry.flush(); assert.deepEqual(requests, []);
  assert.equal(telemetry.status().configured, true);
  assert.equal(telemetry.status().failures.configure, 2);
  assert.deepEqual(logs, Array(2).fill('Node Goblin telemetry configuration failed: telemetry_configuration_invalid'));
  assert.doesNotMatch(JSON.stringify([logs, telemetry.status()]), /secret|private|wrong\.example|active\.example/);
  await telemetry.execute({ kind: 'process', operation: () => result }); await telemetry.flush();
  assert.deepEqual(requests, ['https://active.example/v1/traces']);
  await telemetry.shutdown();
});

test('private and active telemetry setup errors never re-run or replace a synchronous operation failure', async () => {
  const sentinel = new Error('operation-failed');
  let calls = 0;
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://host.example' }, randomTraceId: () => { throw new Error('random failed'); } });
  await assert.rejects(telemetry.execute({ kind: 'process', operation: () => { calls++; throw sentinel; } }), error => error === sentinel);
  assert.equal(calls, 1);
  await assert.rejects(telemetry.execute({ kind: 'process', traceContext: { traceparent: 'invalid' }, operation: () => { calls++; throw sentinel; } }), error => error === sentinel);
  assert.equal(calls, 2);
  await telemetry.shutdown();
});

test('temporary owner exports share the configured queue budget even if collectors hang', async () => {
  let sends = 0; const logs = [];
  const telemetry = createGatewayTelemetry({ env: { OTEL_BSP_MAX_QUEUE_SIZE: '2', OTEL_EXPORTER_OTLP_TIMEOUT: '500' },
    fetchImpl: async () => { sends++; return new Promise(() => {}); }, logger: { warn: (line) => logs.push(line) } });
  const owner = { enabled: true, destinations: [{ id: 'bounded', enabled: true, endpoint: 'https://old.example', headers: 'x-token=private' }] };
  for (let i = 0; i < 6; i++) assert.deepEqual(await telemetry.execute({ kind: 'process', telemetryConfiguration: owner, operation: () => ({ exitCode: 0 }) }), { exitCode: 0 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends, 2);
  assert.equal(telemetry.status().failures.dropped, 4);
  await telemetry.shutdown({ timeout: 10 });
  assert.equal(telemetry.status().failures.dropped, 6);
  assert.doesNotMatch(JSON.stringify([logs, telemetry.status()]), /private|old\.example/);
});

test('hung temporary owner budget does not deny an independent healthy destination', async () => {
  const sends = [];
  const telemetry = createGatewayTelemetry({ env: { OTEL_BSP_MAX_QUEUE_SIZE: '2', OTEL_EXPORTER_OTLP_TIMEOUT: '500' },
    fetchImpl: async (url) => { sends.push(url); if (url.includes('hung')) return new Promise(() => {}); return { ok: true }; }, logger: { warn() {} } });
  const owner = { enabled: true, destinations: [{ id: 'hung', enabled: true, endpoint: 'https://hung.example' }, { id: 'healthy', enabled: true, endpoint: 'https://healthy.example' }] };
  for (let i = 0; i < 6; i++) {
    await telemetry.execute({ kind: 'process', telemetryConfiguration: owner, operation: () => ({ exitCode: 0 }) });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(sends.filter(url => url.includes('hung')).length, 2);
  assert.equal(sends.filter(url => url.includes('healthy')).length, 6);
  const destinations = Object.fromEntries(telemetry.status().destinations.map(item => [item.id, item]));
  assert.equal(destinations.hung.failures.dropped, 4);
  assert.equal(destinations.healthy.failures.dropped, 0);
  await telemetry.shutdown({ timeout: 10 });
});

test('running private generation cannot export after shutdown', async () => {
  let finish; let sends = 0;
  const telemetry = createGatewayTelemetry({ env: {}, fetchImpl: async () => { sends++; return { ok: true }; } });
  const owner = { enabled: true, destinations: [{ id: 'private', enabled: true, endpoint: 'https://private.example', headers: 'x-token=private' }] };
  const running = telemetry.execute({ kind: 'process', telemetryConfiguration: owner, operation: () => new Promise(resolve => { finish = resolve; }) });
  await telemetry.shutdown();
  finish({ exitCode: 0 }); assert.deepEqual(await running, { exitCode: 0 });
  await telemetry.flush(); assert.equal(sends, 0);
  assert.doesNotMatch(JSON.stringify(telemetry.status()), /private\.example|x-token/);
});
