import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGatewayTelemetry } from './lib/otel-runtime.mjs';
import { GatewayDaemon } from './lib/daemon.mjs';
import { OperationJournal } from './lib/journal.mjs';
import { OutboundGatewayTransport } from './lib/network-transport.mjs';

const silent = { warn() {} };
const destination = (id, url, extra = {}) => ({ id, enabled: true, endpoint: url, protocol: 'http/json', tracesEnabled: true, tls: { verify: true }, ...extra });
const execute = (telemetry, operationId = 'op-1') => telemetry.execute({ kind: 'process', tool: 'shell_exec', targetId: 'host-a', operationId, operation: async () => ({ exitCode: 0 }) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function receiver(handler, tls = null) {
  const records = [];
  const sockets = new Set();
  const handle = (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const record = { url: req.url, headers: req.headers, body: Buffer.concat(chunks),
        ...(tls ? { authorized: req.socket.authorized, peer: req.socket.getPeerCertificate() } : {}) };
      records.push(record);
      handler?.(record, res);
      if (!handler) { res.statusCode = 200; res.end(); }
    });
  };
  const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { records, url: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}

// Independent wire reader: validates actual protobuf field numbers, wire types,
// lengths and byte encodings instead of importing the production encoder.
function fields(buffer) {
  let pos = 0;
  const result = [];
  const readVarint = () => {
    let value = 0n; let shift = 0n;
    for (;;) {
      assert.ok(pos < buffer.length, 'truncated varint');
      const byte = buffer[pos++];
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
      shift += 7n; assert.ok(shift <= 63n, 'oversized varint');
    }
  };
  while (pos < buffer.length) {
    const tag = Number(readVarint());
    const field = tag >>> 3; const wire = tag & 7;
    assert.ok(field > 0);
    let value;
    if (wire === 0) value = readVarint();
    else if (wire === 1) { assert.ok(pos + 8 <= buffer.length); value = buffer.readBigUInt64LE(pos); pos += 8; }
    else if (wire === 2) { const size = Number(readVarint()); assert.ok(pos + size <= buffer.length); value = buffer.subarray(pos, pos + size); pos += size; }
    else if (wire === 5) { assert.ok(pos + 4 <= buffer.length); value = buffer.readUInt32LE(pos); pos += 4; }
    else assert.fail(`unexpected protobuf wire type ${wire}`);
    result.push({ field, wire, value });
  }
  return result;
}
function one(message, field, wire) {
  const matching = fields(message).filter((item) => item.field === field);
  assert.equal(matching.length, 1, `field ${field}`);
  assert.equal(matching[0].wire, wire, `wire for ${field}`);
  return matching[0].value;
}
function repeated(message, field, wire) {
  const matching = fields(message).filter((item) => item.field === field);
  for (const item of matching) assert.equal(item.wire, wire);
  return matching.map((item) => item.value);
}
function decodedAttributes(message, field) {
  return Object.fromEntries(repeated(message, field, 2).map((entry) => [one(entry, 1, 2).toString(), one(one(entry, 2, 2), 1, 2).toString()]));
}
function decodeTrace(message) {
  const resourceSpan = one(message, 1, 2);
  const resource = one(resourceSpan, 1, 2);
  const scopeSpans = one(resourceSpan, 2, 2);
  const scope = one(scopeSpans, 1, 2);
  const span = one(scopeSpans, 2, 2);
  const status = one(span, 15, 2);
  return { resource: decodedAttributes(resource, 1), scope: one(scope, 1, 2).toString(),
    traceId: one(span, 1, 2).toString('hex'), spanId: one(span, 2, 2).toString('hex'),
    traceState: one(span, 3, 2).toString(), parentSpanId: one(span, 4, 2).toString('hex'),
    name: one(span, 5, 2).toString(), kind: Number(one(span, 6, 0)),
    start: one(span, 7, 1), end: one(span, 8, 1), attributes: decodedAttributes(span, 9),
    code: Number(one(status, 3, 0)), flags: one(span, 16, 5) };
}

test('loopback JSON and protobuf fan out the same span, with private exact URLs and auth', async (t) => {
  const json = await receiver(); const proto = await receiver(); const disabled = await receiver();
  t.after(async () => Promise.all([json.close(), proto.close(), disabled.close()]));
  const telemetry = createGatewayTelemetry({ env: {}, version: 'test', logger: silent, randomSpanId: () => 'b'.repeat(16) });
  await telemetry.configure({ enabled: true, endpoint: '', destinations: [
    destination('json', `${json.url}/ignored`, { tracesEndpoint: `${json.url}/custom/trace/`, headers: 'Authorization=Bearer%20json-secret', tracesHeaders: 'x-json=trace-secret' }),
    destination('proto', `${proto.url}/base/`, { protocol: 'http/protobuf', headers: 'authorization=proto-secret' }),
    destination('disabled', disabled.url, { enabled: false, headers: 'authorization=disabled-secret' }),
    destination('metrics-only', disabled.url, { tracesEnabled: false }),
  ] });
  await telemetry.execute({ kind: 'process', tool: 'shell_exec', targetId: 'host-a', operationId: 'op-1',
    traceContext: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-03', tracestate: 'vendor=value' },
    operation: async () => ({ exitCode: 0, stdout: 'private-process-output' }) });
  await telemetry.flush();
  assert.equal(json.records.length, 1); assert.equal(proto.records.length, 1); assert.equal(disabled.records.length, 0);
  const j = json.records[0]; const p = proto.records[0];
  assert.equal(j.url, '/custom/trace/'); assert.equal(p.url, '/base/v1/traces');
  assert.equal(j.headers['content-type'], 'application/json'); assert.equal(p.headers['content-type'], 'application/x-protobuf');
  assert.equal(j.headers['x-json'], 'trace-secret'); assert.equal(j.headers.authorization, undefined);
  assert.equal(p.headers.authorization, 'proto-secret'); assert.equal(p.headers['x-json'], undefined);
  const jsonSpan = JSON.parse(j.body).resourceSpans[0].scopeSpans[0].spans[0];
  const decoded = decodeTrace(p.body);
  assert.equal(decoded.traceId, jsonSpan.traceId); assert.equal(decoded.spanId, jsonSpan.spanId);
  assert.equal(decoded.parentSpanId, jsonSpan.parentSpanId); assert.equal(decoded.traceState, 'vendor=value');
  assert.equal(decoded.flags, 3); assert.equal(decoded.kind, 2); assert.equal(decoded.name, 'node-goblin.process');
  assert.equal(decoded.code, 1); assert.ok(decoded.start > 0n && decoded.end >= decoded.start);
  assert.equal(decoded.resource['service.name'], 'node-goblin'); assert.equal(decoded.resource['service.version'], 'test');
  assert.equal(decoded.scope, 'node-goblin.gateway'); assert.equal(decoded.attributes['burrow.operation.id'], 'op-1');
  assert.equal(Buffer.concat([j.body, p.body]).includes(Buffer.from('private-process-output')), false);
  const status = JSON.stringify(telemetry.status());
  for (const forbidden of ['secret', json.url, proto.url, '/custom/trace']) assert.equal(status.includes(forbidden), false);
  await telemetry.shutdown();
});

test('loopback rejection and hanging collector cannot delay healthy peer; queues and shutdown remain bounded', async (t) => {
  const reject = await receiver((_record, res) => { res.statusCode = 403; res.end('collector-private'); });
  const hung = await receiver(() => {}); const healthy = await receiver();
  t.after(async () => Promise.all([reject.close(), hung.close(), healthy.close()]));
  const logs = [];
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_TIMEOUT: '1000', OTEL_BSP_MAX_QUEUE_SIZE: '2', OTEL_BSP_SCHEDULE_DELAY: '1' }, logger: { warn: (line) => logs.push(line) } });
  await telemetry.configure({ enabled: true, destinations: [destination('reject', reject.url), destination('hung', hung.url), destination('healthy', healthy.url)] });
  await execute(telemetry);
  await sleep(35);
  assert.equal(healthy.records.length, 1);
  for (let i = 0; i < 5; i++) { await execute(telemetry, `extra-${i}`); await sleep(3); }
  assert.ok(healthy.records.length >= 2);
  const started = Date.now();
  await telemetry.shutdown({ timeout: 35 });
  assert.ok(Date.now() - started < 600);
  const statuses = Object.fromEntries(telemetry.status().destinations.map((item) => [item.id, item]));
  assert.ok(statuses.reject.failures.export >= 1);
  assert.equal(statuses.reject.lastExportFailure.statusCode, 403);
  assert.equal(statuses.hung.failures.shutdown, 1);
  assert.ok(statuses.hung.failures.dropped >= 4);
  assert.equal(statuses.healthy.failures.export, 0);
  assert.equal(JSON.stringify(logs).includes('collector-private'), false);
});

test('old admission retains destinations over reconfigure and disable; fresh work sees only its generation', async (t) => {
  const old = await receiver(); const newer = await receiver();
  t.after(async () => Promise.all([old.close(), newer.close()]));
  const telemetry = createGatewayTelemetry({ env: {}, logger: silent });
  const config = (url, headers) => ({ enabled: true, destinations: [destination('same-id', url, { headers })] });
  await telemetry.configure(config(old.url, 'authorization=old-secret'));
  let finishOld;
  const runningOld = telemetry.execute({ kind: 'process', operationId: 'old-op', operation: () => new Promise((resolve) => { finishOld = () => resolve({ exitCode: 0 }); }) });
  await telemetry.configure(config(newer.url, 'authorization=new-secret'));
  await execute(telemetry, 'new-op');
  let finishNew;
  const runningNew = telemetry.execute({ kind: 'process', operationId: 'new-running', operation: () => new Promise((resolve) => { finishNew = () => resolve({ exitCode: 0 }); }) });
  await telemetry.configure({ enabled: false, destinations: [] });
  await execute(telemetry, 'disabled-op');
  finishOld(); finishNew(); await Promise.all([runningOld, runningNew]);
  await telemetry.flush();
  const unpack = (receiver) => receiver.records.flatMap((record) => JSON.parse(record.body).resourceSpans[0].scopeSpans[0].spans.map((span) => span.attributes.find((a) => a.key === 'burrow.operation.id').value.stringValue));
  assert.deepEqual(unpack(old), ['old-op']); assert.deepEqual(unpack(newer).sort(), ['new-op', 'new-running']);
  assert.ok(old.records.every((record) => record.headers.authorization === 'old-secret'));
  assert.ok(newer.records.every((record) => record.headers.authorization === 'new-secret'));
  await telemetry.shutdown();
});

test('host endpoint or headers choose one environment owner without leaking controller credentials', async (t) => {
  const host = await receiver(); const first = await receiver(); const second = await receiver();
  t.after(async () => Promise.all([host.close(), first.close(), second.close()]));
  const config = { enabled: true, endpoint: '', destinations: [destination('first', first.url, { headers: 'authorization=first-secret' }), destination('second', second.url, { headers: 'authorization=second-secret' })] };
  const overridden = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${host.url}/exact`, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=host-secret' }, logger: silent });
  await overridden.configure(config); await execute(overridden); await overridden.flush();
  assert.equal(host.records.length, 1); assert.equal(host.records[0].url, '/exact'); assert.equal(host.records[0].headers.authorization, 'host-secret');
  assert.equal(first.records.length, 0); assert.equal(second.records.length, 0);
  await overridden.configure({ enabled: false, endpoint: '', destinations: [] }); await execute(overridden); await overridden.flush();
  assert.equal(host.records.length, 2); assert.equal(host.records[1].headers.authorization, 'host-secret');
  assert.equal(overridden.status().configured, true); assert.equal(overridden.status().source, 'environment');
  const headerOnly = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_HEADERS: 'authorization=host-only' }, logger: silent });
  await headerOnly.configure(config); await execute(headerOnly); await headerOnly.flush();
  assert.equal(first.records.length, 1); assert.equal(first.records[0].headers.authorization, 'host-only'); assert.equal(second.records.length, 0);
  const endpointOnly = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: host.url }, logger: silent });
  await endpointOnly.configure(config); await execute(endpointOnly); await endpointOnly.flush();
  assert.equal(host.records[2].headers.authorization, undefined);
  // Preserve controller credentials when the configured trace URL is exactly
  // the same endpoint, but never carry them to a different host.
  await endpointOnly.configure({ enabled: true, destinations: [destination('same', host.url, { headers: 'authorization=same-owner-secret' })] });
  await execute(endpointOnly); await endpointOnly.flush();
  assert.equal(host.records[3].headers.authorization, 'same-owner-secret');
  await Promise.all([overridden.shutdown(), headerOnly.shutdown(), endpointOnly.shutdown()]);
});

test('TLS custom CA and per-destination verify policy on a self-signed HTTPS loopback', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-goblin-otel-tls-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  const key = await fs.readFile(path.join(dir, 'key.pem')); const cert = await fs.readFile(path.join(dir, 'cert.pem'));
  const target = await receiver(null, { key, cert }); t.after(() => target.close());
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_TIMEOUT: '1000' }, logger: silent });
  await telemetry.configure({ enabled: true, destinations: [
    destination('trusted', target.url, { headers: 'x-owner=ca', tls: { verify: true, caCertificate: cert.toString() } }),
    destination('untrusted', target.url, { headers: 'x-owner=untrusted', tls: { verify: true } }),
    destination('no-verify', target.url, { headers: 'x-owner=skip', tls: { verify: false } }),
  ] });
  await execute(telemetry); await telemetry.flush();
  assert.deepEqual(target.records.map((record) => record.headers['x-owner']).sort(), ['ca', 'skip']);
  const statuses = Object.fromEntries(telemetry.status().destinations.map((item) => [item.id, item]));
  assert.equal(statuses.trusted.failures.export, 0); assert.equal(statuses.untrusted.failures.export, 1); assert.equal(statuses['no-verify'].failures.export, 0);
  assert.equal(JSON.stringify(telemetry.status()).includes('BEGIN CERTIFICATE'), false);
  await telemetry.shutdown();
});

test('late resolution of a forcibly stopped export cannot mutate a new generation or increment failures twice', async () => {
  let resolveOld;
  const logs = [];
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_TIMEOUT: '500' }, logger: { warn: (line) => logs.push(line) }, fetchImpl: async (url) => url.includes('old.example') ? new Promise((resolve) => { resolveOld = resolve; }) : { ok: true } });
  await telemetry.configure({ enabled: true, destinations: [destination('old', 'https://old.example')] });
  await execute(telemetry); void telemetry.flush(); await sleep(5);
  await telemetry.configure({ enabled: true, destinations: [destination('new', 'https://new.example')] });
  await execute(telemetry); await sleep(2);
  await telemetry.shutdown({ timeout: 10 });
  await sleep(0);
  const before = JSON.stringify(telemetry.status());
  resolveOld({ ok: false, status: 401 }); await sleep(5);
  assert.equal(JSON.stringify(telemetry.status()), before);
  assert.equal(logs.length, 0);
});

test('metrics-only host override never sends traces to saved collectors or copies metric auth', async (t) => {
  const first = await receiver(); const second = await receiver();
  t.after(async () => Promise.all([first.close(), second.close()]));
  const config = { enabled: true, destinations: [destination('first', first.url, { headers: 'authorization=private-first' }), destination('second', second.url, { headers: 'authorization=private-second' })] };
  const endpointOnly = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://host-metrics.example/metrics' }, logger: silent });
  await endpointOnly.configure(config); await execute(endpointOnly); await endpointOnly.flush();
  assert.equal(endpointOnly.status().configured, false); assert.equal(endpointOnly.status().source, 'environment');
  assert.equal(first.records.length, 0); assert.equal(second.records.length, 0);
  const headersOnly = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_METRICS_HEADERS: 'authorization=metrics-private' }, logger: silent });
  await headersOnly.configure(config); await execute(headersOnly); await headersOnly.flush();
  assert.equal(first.records.length, 1); assert.equal(first.records[0].headers.authorization, undefined); assert.equal(second.records.length, 0);
  await Promise.all([endpointOnly.shutdown(), headersOnly.shutdown()]);
});

test('unsafe URL and header configurations fail atomically without exposing secrets', async (t) => {
  const target = await receiver(); t.after(() => target.close());
  const telemetry = createGatewayTelemetry({ env: {}, logger: silent });
  await telemetry.configure({ enabled: true, destinations: [destination('valid', target.url, { headers: 'authorization=valid-secret' })] });
  for (const invalid of [
    destination('bad', 'https://user:private@example.test'),
    destination('bad', 'https://example.test/path?private=secret'),
    destination('bad', 'https://example.test', { tracesEndpoint: 'https://example.test/#private' }),
    destination('bad', 'https://example.test', { headers: 'authorization=private%0D%0Asecret' }),
    destination('bad', 'https://example.test', { headers: { authorization: 'private' } }),
  ]) {
    await assert.rejects(telemetry.configure({ enabled: true, destinations: [invalid] }), (error) => {
      assert.match(error.message, /^telemetry_(endpoint|headers|configuration)_invalid$/);
      assert.equal(error.message.includes('private'), false); return true;
    });
  }
  await execute(telemetry); await telemetry.flush();
  assert.equal(target.records.length, 1); assert.equal(target.records[0].headers.authorization, 'valid-secret');
  await telemetry.shutdown();
});

test('late private owners join old traces after replacement and disable without changing active configuration', async (t) => {
  const oldJson = await receiver(); const oldProto = await receiver(); const newer = await receiver();
  t.after(async () => Promise.all([oldJson.close(), oldProto.close(), newer.close()]));
  const logs = [];
  const telemetry = createGatewayTelemetry({ env: {}, logger: { warn: line => logs.push(line) }, randomSpanId: () => 'c'.repeat(16) });
  const first = { enabled: true, destinations: [destination('old-json', oldJson.url, { headers: 'authorization=old-json-private' }), destination('old-proto', oldProto.url, { protocol: 'http/protobuf', headers: 'x-token=old-proto-private' })] };
  const next = { enabled: true, destinations: [destination('new', newer.url, { headers: 'authorization=new-private' })] };
  const context = (traceId, spanId) => ({ traceparent: `00-${traceId}-${spanId}-01`, tracestate: 'vendor=value' });
  const run = (id, traceId, owner) => telemetry.execute({ kind: 'process', tool: 'shell_exec', targetId: 'host-a', operationId: id,
    traceContext: context(traceId, 'd'.repeat(16)), ...(owner === undefined ? {} : { telemetryConfiguration: owner }), operation: () => ({ exitCode: 0 }) });
  await telemetry.configure(first);
  await telemetry.configure(next);
  await run('late-old', '1'.repeat(32), first);
  await run('new-active', '2'.repeat(32));
  await telemetry.flush();
  assert.equal(telemetry.status().source, 'controller'); assert.equal(telemetry.status().configured, true);
  await telemetry.configure({ enabled: false, destinations: [] });
  await run('late-after-disable', '3'.repeat(32), first);
  await run('new-after-disable', '4'.repeat(32), next);
  await run('disabled', '5'.repeat(32));
  await run('private-disabled', '6'.repeat(32), { enabled: false, destinations: [] });
  await telemetry.flush();
  const jsonSpans = receiver => receiver.records.flatMap(record => JSON.parse(record.body).resourceSpans[0].scopeSpans[0].spans);
  const operation = span => span.attributes.find(a => a.key === 'burrow.operation.id').value.stringValue;
  const oldSpans = jsonSpans(oldJson); const newSpans = jsonSpans(newer);
  assert.deepEqual(oldSpans.map(operation).sort(), ['late-after-disable', 'late-old']);
  assert.deepEqual(newSpans.map(operation).sort(), ['new-active', 'new-after-disable']);
  const oldProtos = oldProto.records.map(record => decodeTrace(record.body));
  assert.deepEqual(oldProtos.map(span => span.attributes['burrow.operation.id']).sort(), ['late-after-disable', 'late-old']);
  for (const old of oldSpans) {
    const proto = oldProtos.find(span => span.attributes['burrow.operation.id'] === operation(old));
    assert.deepEqual([proto.traceId, proto.spanId, proto.parentSpanId], [old.traceId, old.spanId, old.parentSpanId]);
    assert.equal(old.traceId, operation(old) === 'late-old' ? '1'.repeat(32) : '3'.repeat(32));
  }
  assert.equal(newSpans.find(span => operation(span) === 'new-active').traceId, '2'.repeat(32));
  assert.equal(newSpans.find(span => operation(span) === 'new-after-disable').traceId, '4'.repeat(32));
  assert.ok(oldJson.records.every(record => record.headers.authorization === 'old-json-private'));
  assert.ok(oldProto.records.every(record => record.headers['x-token'] === 'old-proto-private'));
  assert.ok(newer.records.every(record => record.headers.authorization === 'new-private'));
  assert.equal(telemetry.status().configured, false);
  assert.doesNotMatch(JSON.stringify([telemetry.status(), logs]), /private|127\.0\.0\.1/);
  await telemetry.shutdown();
});

test('host override wins for private owners even if global and private configs are disabled', async (t) => {
  const host = await receiver(); const controlled = await receiver();
  t.after(async () => Promise.all([host.close(), controlled.close()]));
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: host.url, OTEL_EXPORTER_OTLP_HEADERS: 'authorization=host-secret' }, logger: silent });
  const privateConfig = { enabled: true, destinations: [destination('old', controlled.url, { headers: 'authorization=controller-secret' })] };
  await telemetry.configure({ enabled: false, destinations: [] });
  for (const config of [privateConfig, { enabled: false, destinations: [] }, undefined]) {
    await telemetry.execute({ kind: 'process', telemetryConfiguration: config, operation: () => ({ exitCode: 0 }) });
    await telemetry.flush();
  }
  assert.equal(host.records.length, 3); assert.equal(controlled.records.length, 0);
  assert.ok(host.records.every(record => record.headers.authorization === 'host-secret'));
  assert.equal(telemetry.status().configured, true);
  await telemetry.shutdown();
});

function responseVarint(input) {
  let value = BigInt(input); const result = [];
  do { let byte = Number(value & 127n); value >>= 7n; if (value) byte |= 128; result.push(byte); } while (value);
  return Buffer.from(result);
}
function protoPartial(count, warning = '') {
  const text = Buffer.from(warning);
  const nested = Buffer.concat([Buffer.from([8]), responseVarint(count), ...(text.length ? [Buffer.from([18]), responseVarint(text.length), text] : [])]);
  return Buffer.concat([Buffer.from([10]), responseVarint(nested.length), nested]);
}

test('JSON and protobuf partial rejections are counted independently, sanitized and never retried', async (t) => {
  const json = await receiver((_record, res) => {
    res.statusMessage = 'private-json-status'; res.writeHead(200, { 'content-type': 'application/json' });
    const body = JSON.stringify({ partialSuccess: { rejectedSpans: '2', errorMessage: 'private-json-message' }, secret: 'other-private' });
    res.write(body.slice(0, 12)); setImmediate(() => res.end(body.slice(12)));
  });
  const proto = await receiver((_record, res) => {
    res.statusMessage = 'private-proto-status'; res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    const body = protoPartial(3, 'private-proto-message');
    res.write(body.subarray(0, 2)); setImmediate(() => res.end(body.subarray(2)));
  });
  const healthy = await receiver();
  t.after(async () => Promise.all([json.close(), proto.close(), healthy.close()]));
  const logs = [];
  const telemetry = createGatewayTelemetry({ env: {}, logger: { warn: line => logs.push(line) } });
  await telemetry.configure({ enabled: true, destinations: [destination('json', json.url), destination('proto', proto.url, { protocol: 'http/protobuf' }), destination('healthy', healthy.url)] });
  for (let i = 0; i < 4; i++) await execute(telemetry, `batch-${i}`);
  await telemetry.flush();
  const status = telemetry.status(); const destinations = Object.fromEntries(status.destinations.map(item => [item.id, item]));
  assert.deepEqual(destinations.json.lastExportFailure, { reason: 'partial_success', statusCode: 200, rejectedSpans: 2 });
  assert.deepEqual(destinations.proto.lastExportFailure, { reason: 'partial_success', statusCode: 200, rejectedSpans: 3 });
  assert.equal(destinations.json.failures.dropped, 2); assert.equal(destinations.proto.failures.dropped, 3);
  assert.equal(destinations.healthy.failures.export, 0);
  assert.equal(status.failures.export, 2); assert.equal(status.failures.dropped, 5);
  assert.equal(json.records.length, 1); assert.equal(proto.records.length, 1); assert.equal(healthy.records.length, 1);
  assert.ok(logs.some(line => line.includes('partial_success') && line.includes('destination=json') && line.includes('rejectedSpans=2')));
  assert.ok(logs.some(line => line.includes('partial_success') && line.includes('destination=proto') && line.includes('rejectedSpans=3')));
  assert.doesNotMatch(JSON.stringify([status, logs]), /private|127\.0\.0\.1/);
  await telemetry.shutdown();
});

test('warning-only, malformed, oversized and maximum-size responses are bounded and safe', async (t) => {
  const fixtures = [
    ['warning', 'http/json', Buffer.from('{"partialSuccess":{"rejectedSpans":"0","errorMessage":"private-warning"}}')],
    ['malformed', 'http/json', Buffer.from('{"secret":"private-invalid"')],
    ['proto-invalid', 'http/protobuf', Buffer.from([10, 2, 8, 128])],
    ['oversized', 'http/json', Buffer.alloc(4 * 1024 * 1024 + 1, 32)],
    ['boundary', 'http/json', Buffer.concat([Buffer.from('{}'), Buffer.alloc(4 * 1024 * 1024 - 2, 32)])],
  ];
  const servers = await Promise.all(fixtures.map(([, , body]) => receiver((_record, res) => { res.statusMessage = 'private-status'; res.end(body); })));
  t.after(async () => Promise.all(servers.map(server => server.close())));
  const logs = [];
  const telemetry = createGatewayTelemetry({ env: {}, logger: { warn: line => logs.push(line) } });
  await telemetry.configure({ enabled: true, destinations: fixtures.map(([id, protocol], index) => destination(id, servers[index].url, { protocol })) });
  await execute(telemetry); await telemetry.flush();
  assert.equal(servers.every(server => server.records.length === 1), true);
  assert.equal(telemetry.status().failures.export, 0); assert.equal(telemetry.status().failures.dropped, 0);
  assert.ok(logs.some(line => line.includes('collector_warning destination=warning')));
  assert.ok(logs.some(line => line.includes('response_invalid destination=malformed')));
  assert.ok(logs.some(line => line.includes('response_invalid destination=proto-invalid')));
  assert.ok(logs.some(line => line.includes('response_too_large destination=oversized')));
  assert.equal(logs.some(line => line.includes('destination=boundary')), false);
  assert.doesNotMatch(JSON.stringify([telemetry.status(), logs]), /private|127\.0\.0\.1/);
  await telemetry.shutdown();
});

test('host exact trace override remains active with an empty enabled list and disabled scalar or list config', async (t) => {
  const host = await receiver(); t.after(() => host.close());
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${host.url}/exact`, OTEL_EXPORTER_OTLP_HEADERS: 'x-token=host-private' }, logger: silent });
  for (const configuration of [{ enabled: true, destinations: [] }, { enabled: false, destinations: [] }, { enabled: false, endpoint: '', headers: '' }]) {
    await telemetry.configure(configuration);
    assert.equal(telemetry.status().configured, true); assert.equal(telemetry.status().source, 'environment');
    await execute(telemetry); await telemetry.flush();
  }
  assert.equal(host.records.length, 3);
  assert.ok(host.records.every(record => record.url === '/exact' && record.headers['x-token'] === 'host-private'));
  await telemetry.shutdown();
});

test('collector count parsing handles int64 strings, unknown protobuf fields and bounded overflow', async (t) => {
  const json = await receiver((_record, res) => res.end(JSON.stringify({ partial_success: { rejected_spans: '9223372036854775807', error_message: 'private-json' } })));
  const proto = await receiver((_record, res) => {
    const extra = Buffer.from([0x20, 0x01, 0x2d, 1, 2, 3, 4, 0x31, 1, 2, 3, 4, 5, 6, 7, 8]);
    res.end(Buffer.concat([extra, protoPartial(9223372036854775807n, 'private-proto')]));
  });
  t.after(async () => Promise.all([json.close(), proto.close()]));
  const telemetry = createGatewayTelemetry({ env: {}, logger: silent });
  await telemetry.configure({ enabled: true, destinations: [destination('json', json.url), destination('proto', proto.url, { protocol: 'http/protobuf' })] });
  await execute(telemetry); await telemetry.flush();
  const status = telemetry.status(); const byId = Object.fromEntries(status.destinations.map(item => [item.id, item]));
  assert.equal(byId.json.lastExportFailure.rejectedSpans, Number.MAX_SAFE_INTEGER);
  assert.equal(byId.proto.lastExportFailure.rejectedSpans, Number.MAX_SAFE_INTEGER);
  assert.equal(byId.json.failures.dropped, Number.MAX_SAFE_INTEGER);
  assert.equal(byId.proto.failures.dropped, Number.MAX_SAFE_INTEGER);
  assert.equal(status.failures.dropped, Number.MAX_SAFE_INTEGER);
  assert.doesNotMatch(JSON.stringify(status), /private/);
  await telemetry.shutdown();
});

test('fetch seam consumes bounded streamed response with the same safe projection', async (t) => {
  const target = await receiver((_record, res) => {
    res.statusMessage = 'private-status';
    res.end(JSON.stringify({ partialSuccess: { rejectedSpans: 1, errorMessage: 'private-message' } }));
  });
  t.after(() => target.close());
  const logs = [];
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: target.url }, fetchImpl: fetch, logger: { warn: line => logs.push(line) } });
  await execute(telemetry); await telemetry.flush();
  assert.equal(target.records.length, 1);
  assert.equal(telemetry.status().failures.dropped, 1);
  assert.equal(telemetry.status().destinations[0].lastExportFailure.reason, 'partial_success');
  assert.doesNotMatch(JSON.stringify([telemetry.status(), logs]), /private|127\.0\.0\.1/);
  await telemetry.shutdown();
});


async function makeMtlsCredentials(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-goblin-environment-mtls-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const openssl = (...args) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=environment-test-ca', '-keyout', 'ca.key', '-out', 'ca.pem');
  openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr');
  openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1',
    '-copy_extensions', 'copy', '-out', 'server.pem');
  for (const client of ['generic', 'trace', 'metric']) {
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${client}-client`, '-keyout', `${client}.key`, '-out', `${client}.csr`);
    openssl('x509', '-req', '-in', `${client}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-out', `${client}.pem`);
  }
  const read = name => fs.readFile(path.join(dir, name), 'utf8');
  return { dir, file: name => path.join(dir, name), ca: await read('ca.pem'), key: await read('server.key'), cert: await read('server.pem'),
    genericCert: await read('generic.pem'), genericKey: await read('generic.key'), traceCert: await read('trace.pem'), traceKey: await read('trace.key'),
    metricCert: await read('metric.pem'), metricKey: await read('metric.key') };
}
function loopbackHostname(target) { return target.url.replace('127.0.0.1', 'localhost'); }
function coreEnvironmentOwner(base, fixture, extra = {}) {
  return { enabled: true, destinations: [{ id: 'environment', enabled: true, tracesEnabled: true, metricsEnabled: true,
    endpoint: base, protocol: 'http/json', tls: { verify: true }, environmentOwned: true,
    headers: 'Authorization=generic-private,x-common=common-private,X-Conflict=generic',
    tracesHeaders: 'authorization=trace-private,x-trace=trace-only,x-conflict=trace',
    metricsHeaders: 'x-metric=metric-private',
    environmentTls: { traces: { caCertificate: fixture.ca, clientCertificate: fixture.traceCert, clientKey: fixture.traceKey },
      metrics: { caCertificate: fixture.ca, clientCertificate: fixture.metricCert, clientKey: fixture.metricKey } }, ...extra }] };
}
const runPrivate = (telemetry, owner, id = 'env-op') => telemetry.execute({ kind: 'process', operationId: id,
  telemetryConfiguration: owner, operation: () => ({ exitCode: 0 }) });
function assertNoPrivate(values, secrets) {
  const text = JSON.stringify(values);
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'private telemetry material escaped');
}

test('private Core environment snapshot uses trace mTLS and case-insensitive generic/specific header union', async (t) => {
  const fixture = await makeMtlsCredentials(t);
  const target = await receiver(null, { key: fixture.key, cert: fixture.cert, ca: fixture.ca, requestCert: true, rejectUnauthorized: true });
  t.after(() => target.close());
  const logs = [];
  const telemetry = createGatewayTelemetry({ env: {}, logger: { warn: line => logs.push(line) } });
  const owner = coreEnvironmentOwner(loopbackHostname(target), fixture);
  // PEM values, not local Core paths, own the transport. Deleting those files
  // before the operation proves the gateway uses the supplied snapshot.
  await fs.rm(fixture.dir, { recursive: true, force: true });
  assert.deepEqual(await runPrivate(telemetry, owner), { exitCode: 0 });
  await telemetry.flush();
  assert.equal(target.records.length, 1);
  const record = target.records[0];
  assert.equal(record.authorized, true); assert.equal(record.peer.subject.CN, 'trace-client');
  assert.equal(record.url, '/v1/traces');
  assert.equal(record.headers.authorization, 'trace-private'); assert.equal(record.headers['x-common'], 'common-private');
  assert.equal(record.headers['x-conflict'], 'trace'); assert.equal(record.headers['x-trace'], 'trace-only');
  assert.equal(record.headers['x-metric'], undefined);
  assert.equal(telemetry.status().failures.export, 0);
  assertNoPrivate([telemetry.status(), logs, record.body.toString()], [fixture.ca, fixture.traceCert, fixture.traceKey, fixture.metricKey,
    'generic-private', 'trace-private', 'common-private', 'metric-private', fixture.dir, target.url]);
  await telemetry.shutdown();
});

test('traces snapshot errors fail closed, but metric-only errors preserve healthy trace and saved peers', async (t) => {
  const environment = await receiver(); const saved = await receiver();
  t.after(async () => Promise.all([environment.close(), saved.close()]));
  const logs = [];
  const telemetry = createGatewayTelemetry({ env: {}, logger: { warn: line => logs.push(line) } });
  const envDestination = { id: 'environment', enabled: true, endpoint: environment.url, environmentOwned: true,
    headers: 'x-common=private-common', tracesHeaders: 'x-trace=private-trace', environmentTls: { traces: {} }, environmentTlsErrors: ['traces'] };
  const peer = destination('saved', saved.url, { headers: 'x-owner=saved-private' });
  const result = await runPrivate(telemetry, { enabled: true, destinations: [envDestination, peer] });
  assert.deepEqual(result, { exitCode: 0 }); await telemetry.flush();
  assert.equal(environment.records.length, 0, 'even HTTP must not bypass a Core trace TLS error');
  assert.equal(saved.records.length, 1);
  await runPrivate(telemetry, { enabled: true, destinations: [{ ...envDestination, environmentTlsErrors: ['metrics'] }] });
  await telemetry.flush();
  assert.equal(environment.records.length, 1);
  assert.equal(environment.records[0].headers['x-common'], 'private-common');
  assert.equal(environment.records[0].headers['x-trace'], 'private-trace');
  assertNoPrivate([telemetry.status(), logs], ['private-common', 'private-trace', 'saved-private', environment.url, saved.url]);
  await telemetry.shutdown();
});

test('saved id environment never adopts private environment snapshot or ambient host client identity', async (t) => {
  const fixture = await makeMtlsCredentials(t);
  const target = await receiver(null, { key: fixture.key, cert: fixture.cert, ca: fixture.ca, requestCert: true, rejectUnauthorized: false });
  t.after(() => target.close());
  const logs = [];
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_CERTIFICATE: fixture.file('does-not-exist'),
    OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: fixture.file('trace.pem'), OTEL_EXPORTER_OTLP_CLIENT_KEY: fixture.file('trace.key') },
  logger: { warn: line => logs.push(line) } });
  const saved = destination('environment', loopbackHostname(target), { tls: { verify: false },
    headers: 'x-common=must-not-merge', tracesHeaders: 'x-saved=saved-private',
    environmentTls: { traces: { caCertificate: fixture.ca, clientCertificate: fixture.traceCert, clientKey: fixture.traceKey } }, environmentTlsErrors: ['traces'] });
  await runPrivate(telemetry, { enabled: true, destinations: [saved] }); await telemetry.flush();
  assert.equal(target.records.length, 1);
  assert.equal(target.records[0].authorized, false); assert.deepEqual(target.records[0].peer, {});
  assert.equal(target.records[0].headers['x-common'], undefined); assert.equal(target.records[0].headers['x-saved'], 'saved-private');
  assert.equal(telemetry.status().failures.export, 0);
  assertNoPrivate([telemetry.status(), logs], [fixture.dir, fixture.ca, fixture.traceCert, fixture.traceKey, 'must-not-merge', 'saved-private']);
  await telemetry.shutdown();
});

test('selected host HTTPS environment resolves TLS paths by trace-over-generic precedence and fails closed on unreadable PEM', async (t) => {
  const fixture = await makeMtlsCredentials(t);
  const target = await receiver(null, { key: fixture.key, cert: fixture.cert, ca: fixture.ca, requestCert: true, rejectUnauthorized: true });
  const other = await receiver();
  t.after(async () => Promise.all([target.close(), other.close()]));
  const logs = [];
  const env = { OTEL_EXPORTER_OTLP_ENDPOINT: loopbackHostname(target), OTEL_EXPORTER_OTLP_CERTIFICATE: fixture.file('ca.pem'),
    OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: fixture.file('generic.pem'), OTEL_EXPORTER_OTLP_CLIENT_KEY: fixture.file('generic.key'),
    OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE: fixture.file('trace.pem'), OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY: fixture.file('trace.key'),
    OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=generic-private,x-common=common-private,X-Conflict=generic',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'authorization=host-trace-private,x-conflict=trace' };
  const telemetry = createGatewayTelemetry({ env, logger: { warn: line => logs.push(line) } });
  await execute(telemetry); await telemetry.flush();
  await telemetry.configure({ enabled: true, destinations: [destination('controller', other.url, { headers: 'x-owner=controller-private' })] });
  await execute(telemetry); await telemetry.flush();
  assert.equal(target.records.length, 2); assert.equal(other.records.length, 0);
  for (const record of target.records) {
    assert.equal(record.authorized, true); assert.equal(record.peer.subject.CN, 'trace-client');
    assert.equal(record.headers.authorization, 'host-trace-private'); assert.equal(record.headers['x-common'], 'common-private');
    assert.equal(record.headers['x-conflict'], 'trace'); assert.equal(record.headers['x-owner'], undefined);
  }
  await telemetry.shutdown();
  // An unauthenticated permissive listener ensures an unreadable selected file
  // cannot accidentally downgrade to an otherwise viable TLS connection.
  const permissive = await receiver(null, { key: fixture.key, cert: fixture.cert, ca: fixture.ca, requestCert: true, rejectUnauthorized: false });
  t.after(() => permissive.close());
  const failed = createGatewayTelemetry({ env: { ...env, OTEL_EXPORTER_OTLP_ENDPOINT: loopbackHostname(permissive),
    OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY: fixture.file('missing-private.key') }, logger: { warn: line => logs.push(line) } });
  await failed.configure({ enabled: true, destinations: [destination('controller', other.url)] });
  await execute(failed); await failed.flush();
  assert.equal(failed.status().configured, false); assert.equal(permissive.records.length, 0); assert.equal(other.records.length, 0);
  assertNoPrivate([telemetry.status(), failed.status(), logs], [fixture.dir, fixture.ca, fixture.traceKey, 'host-trace-private', 'common-private', 'controller-private', target.url, other.url]);
  await failed.shutdown();
});

test('header-only host selection never imports host TLS paths into a controller-owned HTTPS peer', async (t) => {
  const fixture = await makeMtlsCredentials(t);
  const target = await receiver(null, { key: fixture.key, cert: fixture.cert, ca: fixture.ca, requestCert: true, rejectUnauthorized: false });
  t.after(() => target.close());
  const telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_HEADERS: 'x-host=host-private',
    OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: fixture.file('trace.pem'), OTEL_EXPORTER_OTLP_CLIENT_KEY: fixture.file('trace.key') }, logger: silent });
  await telemetry.configure({ enabled: true, destinations: [destination('controller', loopbackHostname(target), { tls: { verify: true, caCertificate: fixture.ca } })] });
  await execute(telemetry); await telemetry.flush();
  assert.equal(target.records.length, 1); assert.deepEqual(target.records[0].peer, {});
  assert.equal(target.records[0].headers['x-host'], 'host-private');
  assert.equal(telemetry.status().failures.export, 0);
  await telemetry.shutdown();
});

test('legacy Core environment scalar snapshots retain exact endpoint, trace headers and mTLS', async (t) => {
  const fixture = await makeMtlsCredentials(t);
  const target = await receiver(null, { key: fixture.key, cert: fixture.cert, ca: fixture.ca, requestCert: true, rejectUnauthorized: true });
  t.after(() => target.close());
  const telemetry = createGatewayTelemetry({ env: {}, logger: silent });
  const env = { enabled: true, endpoint: '', tracesEndpoint: `${loopbackHostname(target)}/exact`, headers: 'X-Common=private-common,Authorization=generic',
    tracesHeaders: 'authorization=trace', environmentTls: { traces: { caCertificate: fixture.ca, clientCertificate: fixture.traceCert, clientKey: fixture.traceKey } } };
  await runPrivate(telemetry, env); await telemetry.flush();
  assert.equal(target.records.length, 1); assert.equal(target.records[0].url, '/exact');
  assert.equal(target.records[0].peer.subject.CN, 'trace-client'); assert.equal(target.records[0].headers.authorization, 'trace');
  assert.equal(target.records[0].headers['x-common'], 'private-common');
  await runPrivate(telemetry, { ...env, headers: null }); await telemetry.flush();
  assert.equal(target.records.length, 2); assert.equal(target.records[1].headers.authorization, 'trace');
  assert.equal(target.records[1].headers['x-common'], undefined);
  await runPrivate(telemetry, { ...env, environmentTlsErrors: ['traces'] }); await telemetry.flush();
  assert.equal(target.records.length, 2);
  await telemetry.shutdown();
});


// Opt-in cross-repository contract, without modifying the other integration
// suite. This uses the actual Core resolver, forked mod host, TLS gateway and
// private operation-owner payload rather than a constructed snapshot.
test('Core environment owner -> forked Node Goblin -> authenticated gateway -> mTLS collector',
  { skip: !process.env.BURROW_CORE_SOURCE_ROOT ? 'set BURROW_CORE_SOURCE_ROOT to a Core source checkout with dependencies' : false, timeout: 60_000 }, async (t) => {
    const coreRoot = process.env.BURROW_CORE_SOURCE_ROOT;
    assert.ok(path.isAbsolute(coreRoot));
    const coreImport = file => import(pathToFileURL(path.join(coreRoot, file)).href);
    const [{ loadMods, cleanupMods }, { createExecutionProviderRegistry, createProcessExecutionRouter },
      { otelConfig }, { createReconfigurableOtelRuntime }] = await Promise.all([
      coreImport('src/mod-runtime.mjs'), coreImport('src/process-execution-router.mjs'), coreImport('src/otel-settings.mjs'), coreImport('src/otel-runtime.mjs'),
    ]);
    const fixture = await makeMtlsCredentials(t);
    const collector = await receiver(null, { key: fixture.key, cert: fixture.cert, ca: fixture.ca, requestCert: true, rejectUnauthorized: true });
    const state = { hosts: [], transport: null, telemetry: null, runtime: null };
    t.after(async () => {
      await state.transport?.stop(); await state.telemetry?.shutdown(); await state.runtime?.shutdown({ timeoutMs: 2_000 });
      await cleanupMods(state.hosts, { logger: { info() {}, warn() {}, error() {} } });
      await collector.close();
    });
    const openssl = (...args) => execFileSync('openssl', args, { cwd: fixture.dir, stdio: 'ignore' });
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', 'controller.key', '-out', 'controller.pem');
    const controllerKey = await fs.readFile(fixture.file('controller.key'), 'utf8');
    const controllerCert = await fs.readFile(fixture.file('controller.pem'), 'utf8');
    const reserve = net.createServer();
    await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
    const port = reserve.address().port;
    await new Promise(resolve => reserve.close(resolve));

    const nodeRoot = fileURLToPath(new URL('..', import.meta.url));
    const install = path.join(fixture.dir, 'runtime', 'mods', 'node-goblin');
    await fs.mkdir(path.join(install, 'gateway'), { recursive: true });
    await fs.copyFile(path.join(nodeRoot, 'burrow.mod.json'), path.join(install, 'burrow.mod.json'));
    await fs.cp(path.join(nodeRoot, 'server'), path.join(install, 'server'), { recursive: true });
    await fs.copyFile(path.join(nodeRoot, 'gateway', 'index.mjs'), path.join(install, 'gateway', 'index.mjs'));
    await fs.copyFile(path.join(nodeRoot, 'gateway', 'VERSION'), path.join(install, 'gateway', 'VERSION'));
    await fs.cp(path.join(nodeRoot, 'gateway', 'lib'), path.join(install, 'gateway', 'lib'), { recursive: true });
    await fs.mkdir(path.join(install, 'ui'), { recursive: true });
    await fs.copyFile(path.join(nodeRoot, 'ui', 'settings.js'), path.join(install, 'ui', 'settings.js'));
    const shared = 'private-cross-core-shared-token';
    const settings = new Map(Object.entries({ controller: { enabled: true, host: '127.0.0.1', port },
      controllerGateways: [{ gatewayId: 'gateway-1', controllerId: 'controller' }] }));
    const secrets = new Map(Object.entries({ 'controller.gateway.gateway-1': shared, 'controller.tls.key': controllerKey, 'controller.tls.cert': controllerCert }));
    const clone = value => value === undefined ? undefined : structuredClone(value);
    const modStore = { get: async (name, fallback) => clone(settings.has(name) ? settings.get(name) : fallback),
      set: async (name, value) => { settings.set(name, clone(value)); return value; }, delete: async name => settings.delete(name),
      getSecret: async name => secrets.get(name) ?? null, hasSecret: async name => secrets.has(name),
      setSecret: async (name, value) => { secrets.set(name, value); return true; }, clearSecret: async name => secrets.delete(name), close: async () => {} };
    const logs = [];
    const logger = { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args), event: (...args) => logs.push(args) };
    const registry = createExecutionProviderRegistry();
    const hosts = await loadMods({ runtimeRoot: path.join(fixture.dir, 'runtime'), executionProviders: registry,
      enabledModIds: async () => ['node-goblin'], modStoreFactory: async () => modStore, modCatalogWriter: async () => {},
      modAuthority: { read: async () => ({ grants: ['execution-provider-v1'] }), assertAllowed: async () => {} }, logger });
    state.hosts.push(...hosts);
    assert.equal(hosts.length, 1); assert.equal(hosts[0].status, 'loaded', hosts[0].error);
    assert.ok(hosts[0].host.child.connected); assert.notEqual(hosts[0].host.child.pid, process.pid);
    const controllerRoute = hosts[0].routes.find(route => route.method === 'GET' && route.path === '/controller');
    assert.ok(controllerRoute);
    const waitFor = async (predicate, label) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) { if (await predicate()) return; await sleep(20); }
      assert.fail(`timed out waiting for ${label}`);
    };
    await waitFor(async () => (await controllerRoute.handler({})).controller?.running, 'controller');
    const telemetry = state.telemetry = createGatewayTelemetry({ env: { OTEL_EXPORTER_OTLP_TIMEOUT: '1000' }, logger });
    const journalPath = fixture.file('journal.json');
    const daemon = new GatewayDaemon({ telemetry, journal: new OperationJournal({ filePath: journalPath }) });
    const transport = state.transport = new OutboundGatewayTransport({ host: '127.0.0.1', port, gatewayId: 'gateway-1',
      stateDir: fixture.file('trust'), enrollmentToken: shared, ca: controllerCert, daemon });
    const authenticated = once(transport, 'authenticated', { signal: AbortSignal.timeout(10_000) });
    transport.start(); await authenticated;
    assert.equal(transport.socket.authorized, true); assert.equal(transport.authenticated, true);

    const env = { BURROW_OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: loopbackHostname(collector),
      OTEL_EXPORTER_OTLP_CERTIFICATE: fixture.file('ca.pem'), OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE: fixture.file('generic.pem'),
      OTEL_EXPORTER_OTLP_CLIENT_KEY: fixture.file('generic.key'), OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE: fixture.file('trace.pem'),
      OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY: fixture.file('trace.key'),
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=generic-core-private,x-common=common-core-private,X-Conflict=generic',
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'authorization=trace-core-private,x-conflict=trace,x-trace=trace-only',
      OTEL_BSP_SCHEDULE_DELAY: '20', OTEL_EXPORTER_OTLP_TIMEOUT: '1000', OTEL_METRIC_EXPORT_INTERVAL: '1000' };
    const runtime = state.runtime = createReconfigurableOtelRuntime({ tuningEnv: env, logger });
    await runtime.apply(otelConfig({ env }));
    const run = runtime.startRun({ runId: 'cross-core-run' }); assert.ok(run?.traceContext);
    const remote = runtime.remoteConfiguration('cross-core-run');
    assert.equal(remote.destinations[0].environmentOwned, true);
    assert.equal(remote.destinations[0].environmentTls.traces.caCertificate, fixture.ca);
    assert.equal(remote.destinations[0].environmentTls.traces.clientCertificate, fixture.traceCert);
    assert.equal(remote.destinations[0].environmentTls.traces.clientKey, fixture.traceKey);
    assert.equal(JSON.stringify(remote).includes(fixture.dir), false);
    assert.deepEqual(await registry.configure('node-goblin', remote), { configured: 1, succeeded: 1, failed: 0, failures: [] });
    // Disable the global gateway generation: operation admission must carry the
    // Core run's own private snapshot all the way across the authenticated hop.
    await registry.configure('node-goblin', { enabled: false, destinations: [] });
    assert.equal(telemetry.status().configured, false);
    await fs.rm(fixture.file('trace.key'));
    const router = createProcessExecutionRouter({ localExecute: () => assert.fail('remote only'), remoteController: registry.get('node-goblin') });
    const result = await router({ target: { kind: 'remote', providerId: 'node-goblin', targetId: 'gateway-1' },
      process: { executable: process.execPath, args: ['-e', 'process.stdout.write("done")'], timeoutMs: 10_000 } },
    { operationId: 'cross-core-op', parentRunId: 'cross-core-run', toolCallId: 'cross-core-call', traceContext: run.traceContext, telemetry: runtime });
    assert.equal(result.ok, true);
    runtime.endRun('cross-core-run', { ok: true });
    await telemetry.flush();
    await waitFor(() => collector.records.some(record => {
      if (record.url !== '/v1/traces') return false;
      const body = JSON.parse(record.body);
      return body.resourceSpans?.some(resource => resource.scopeSpans?.some(scope => scope.spans?.some(span => span.name === 'node-goblin.process')));
    }), 'gateway mTLS span');
    const spans = collector.records.filter(record => record.url === '/v1/traces').flatMap(record =>
      JSON.parse(record.body).resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
    const gatewaySpan = spans.find(span => span.name === 'node-goblin.process');
    assert.ok(gatewaySpan); assert.equal(gatewaySpan.traceId, run.traceContext.traceparent.split('-')[1]);
    assert.equal(gatewaySpan.parentSpanId, run.traceContext.traceparent.split('-')[2]);
    const gatewayRequest = collector.records.find(record => record.url === '/v1/traces' && record.body.includes(Buffer.from('node-goblin.process')));
    assert.equal(gatewayRequest.authorized, true); assert.equal(gatewayRequest.peer.subject.CN, 'trace-client');
    assert.equal(gatewayRequest.headers.authorization, 'trace-core-private'); assert.equal(gatewayRequest.headers['x-common'], 'common-core-private');
    assert.equal(gatewayRequest.headers['x-conflict'], 'trace'); assert.equal(gatewayRequest.headers['x-trace'], 'trace-only');
    const gateways = hosts[0].routes.find(route => route.method === 'GET' && route.path === '/gateways');
    const operations = hosts[0].routes.find(route => route.method === 'GET' && route.path === '/operations');
    assert.ok(gateways); assert.ok(operations);
    assertNoPrivate([result, runtime.status(), telemetry.status(), logs, await gateways.handler({}), await operations.handler({ query: {} }),
      [...settings], await fs.readFile(journalPath, 'utf8'), gatewayRequest.body.toString()],
    [fixture.dir, fixture.ca, fixture.traceCert, fixture.traceKey, shared, controllerKey,
      'generic-core-private', 'trace-core-private', 'common-core-private', loopbackHostname(collector)]);
  });
