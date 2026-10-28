// Cross-repository contract: this test uses an explicitly supplied Core source
// checkout, not a hard-coded sibling path or a simulated mod-host bridge.
// Example: BURROW_CORE_SOURCE_ROOT=/absolute/path/to/Burrow-Backend node --test gateway/otel-core.integration.test.mjs
// Core dependencies must already be installed there. All listeners are loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { GatewayDaemon } from './lib/daemon.mjs';
import { OperationJournal } from './lib/journal.mjs';
import { OutboundGatewayTransport } from './lib/network-transport.mjs';
import { createGatewayTelemetry } from './lib/otel-runtime.mjs';

const nodeRoot = fileURLToPath(new URL('..', import.meta.url));
const coreRoot = process.env.BURROW_CORE_SOURCE_ROOT;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(20);
  }
  assert.fail(`timed out waiting for ${label}`);
}
async function exists(file) {
  try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function receiver(key, cert) {
  const requests = [];
  const server = https.createServer({ key, cert }, (req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200); res.end();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { requests, base: `https://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

// Independent protobuf wire reader. Checking a MIME type is not evidence that
// the receiver got OTLP protobuf. Decode trace/span IDs and attributes on wire.
function fields(buffer) {
  let offset = 0;
  const readVarint = () => {
    let value = 0n, shift = 0n;
    for (;;) {
      assert.ok(offset < buffer.length, 'truncated protobuf varint');
      const byte = buffer[offset++]; value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
      shift += 7n; assert.ok(shift <= 70n, 'oversized protobuf varint');
    }
  };
  const result = [];
  while (offset < buffer.length) {
    const tag = Number(readVarint()), number = tag >>> 3, wire = tag & 7;
    assert.ok(number > 0);
    let value;
    if (wire === 0) value = readVarint();
    else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      assert.ok(offset + length <= buffer.length);
      value = buffer.subarray(offset, offset + length); offset += length;
    } else if (wire === 2) {
      const length = Number(readVarint()); assert.ok(offset + length <= buffer.length);
      value = buffer.subarray(offset, offset + length); offset += length;
    } else assert.fail(`unexpected protobuf wire type ${wire}`);
    result.push({ number, wire, value });
  }
  return result;
}
const messages = (buffer, number) => fields(buffer).filter(field => field.number === number && field.wire === 2).map(field => field.value);
const scalar = (buffer, number) => fields(buffer).find(field => field.number === number)?.value;
function protoSpans(requests) {
  return requests.flatMap(request => messages(request.body, 1)).flatMap(resource => messages(resource, 2))
    .flatMap(scope => messages(scope, 2)).map(span => ({
      traceId: scalar(span, 1).toString('hex'), spanId: scalar(span, 2).toString('hex'),
      parentSpanId: scalar(span, 4)?.toString('hex'), name: scalar(span, 5).toString(),
      attributes: Object.fromEntries(messages(span, 9).map(attribute => [scalar(attribute, 1).toString(), scalar(scalar(attribute, 2), 1)?.toString()])),
    }));
}
function jsonSpans(requests) {
  return requests.flatMap(request => JSON.parse(request.body).resourceSpans || [])
    .flatMap(resource => resource.scopeSpans).flatMap(scope => scope.spans).map(span => ({
      ...span, attributes: Object.fromEntries((span.attributes || []).map(attribute => [attribute.key, attribute.value.stringValue])),
    }));
}
const nodeSpans = spans => spans.filter(span => span.name === 'node-goblin.process');
const filesystemSpans = spans => spans.filter(span => span.name === 'node-goblin.filesystem');
const ids = spans => spans.map(span => span.attributes['burrow.operation.id']).sort();
function noSecrets(value, secrets, where) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, `${where} leaked private material`);
}

function memoryStore(initial = {}) {
  const settings = new Map(Object.entries(initial.settings || {}));
  const secrets = new Map(Object.entries(initial.secrets || {}));
  const clone = value => value === undefined ? undefined : structuredClone(value);
  return { settings,
    get: async (name, fallback) => settings.has(name) ? clone(settings.get(name)) : clone(fallback),
    set: async (name, value) => { settings.set(name, clone(value)); return value; },
    delete: async name => settings.delete(name),
    getSecret: async name => secrets.get(name) ?? null,
    hasSecret: async name => secrets.has(name),
    setSecret: async (name, value) => { secrets.set(name, value); return true; },
    clearSecret: async name => secrets.delete(name), close: async () => {},
  };
}

test('Core settings and registry -> installed child mod -> authenticated TLS gateway -> independent JSON/protobuf destinations',
  { skip: !coreRoot ? 'set BURROW_CORE_SOURCE_ROOT to an absolute Core source checkout with dependencies installed' : false, timeout: 75_000 }, async t => {
    assert.ok(path.isAbsolute(coreRoot), 'BURROW_CORE_SOURCE_ROOT must be an absolute source path');
    for (const file of ['src/mod-runtime.mjs', 'src/process-execution-router.mjs', 'src/otel-settings.mjs', 'src/otel-runtime.mjs']) {
      assert.ok(await exists(path.join(coreRoot, file)), `Core source missing ${file}`);
    }
    const coreImport = file => import(pathToFileURL(path.join(coreRoot, file)).href);
    const [{ loadMods, cleanupMods }, { createExecutionProviderRegistry, createProcessExecutionRouter },
      { saveOtelSettings, readOtelRuntimeConfig }, { createReconfigurableOtelRuntime }, { createNativeFilesystemExecutionRouter }] = await Promise.all([
      coreImport('src/mod-runtime.mjs'), coreImport('src/process-execution-router.mjs'),
      coreImport('src/otel-settings.mjs'), coreImport('src/otel-runtime.mjs'), coreImport('src/native-filesystem-execution-router.mjs'),
    ]);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-goblin-core-otel-'));
    const resources = { receivers: [], hosts: [], operations: [], releases: [], transport: null, telemetry: null, runtime: null };
    // Do not let the invoking host's OTel endpoints or credentials select an
    // owner; the real forked mod inherits the same clean environment.
    const removedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('OTEL_') || key === 'BURROW_OTEL_ENABLED'));
    for (const key of Object.keys(removedEnv)) delete process.env[key];
    t.after(async () => {
      for (const release of resources.releases) await fs.writeFile(release, 'release').catch(() => {});
      await Promise.allSettled(resources.operations);
      await resources.transport?.stop();
      await resources.telemetry?.shutdown();
      await resources.runtime?.shutdown({ timeoutMs: 2_000 });
      await cleanupMods(resources.hosts, { logger: { info() {}, warn() {}, error() {} } });
      await Promise.all(resources.receivers.map(item => item.close()));
      await fs.rm(root, { recursive: true, force: true });
      Object.assign(process.env, removedEnv);
    });

    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem')], { stdio: 'ignore' });
    const key = await fs.readFile(path.join(root, 'key.pem'), 'utf8');
    const cert = await fs.readFile(path.join(root, 'cert.pem'), 'utf8');
    const json = await receiver(key, cert); resources.receivers.push(json);
    const proto = await receiver(key, cert); resources.receivers.push(proto);
    const next = await receiver(key, cert); resources.receivers.push(next);
    const port = await reservePort();

    // Install the actual mod manifest and code, rather than importing activate
    // or injecting a listener. loadMods forks Core's real mod-host-child.
    const install = path.join(root, 'runtime', 'mods', 'node-goblin');
    await fs.mkdir(path.join(install, 'gateway'), { recursive: true });
    await fs.copyFile(path.join(nodeRoot, 'burrow.mod.json'), path.join(install, 'burrow.mod.json'));
    await fs.cp(path.join(nodeRoot, 'server'), path.join(install, 'server'), { recursive: true });
    await fs.copyFile(path.join(nodeRoot, 'gateway', 'index.mjs'), path.join(install, 'gateway', 'index.mjs'));
    await fs.copyFile(path.join(nodeRoot, 'gateway', 'VERSION'), path.join(install, 'gateway', 'VERSION'));
    await fs.cp(path.join(nodeRoot, 'gateway', 'lib'), path.join(install, 'gateway', 'lib'), { recursive: true });
    await fs.mkdir(path.join(install, 'ui'), { recursive: true });
    await fs.copyFile(path.join(nodeRoot, 'ui', 'settings.js'), path.join(install, 'ui', 'settings.js'));

    const privateValues = ['fake-shared-enrollment-secret-645', 'fake-json-token-274', 'fake-json-header-519',
      'fake-proto-token-168', 'fake-proto-header-834', 'fake-new-header-902', 'fake-protected-output-761', cert, key];
    const [shared, jsonToken, jsonHeader, protoToken, protoHeader, nextHeader, protectedOutput] = privateValues;
    const modStore = memoryStore({ settings: { controller: { enabled: true, host: '127.0.0.1', port },
      controllerGateways: [{ gatewayId: 'gateway-1', controllerId: 'controller' }] },
    secrets: { 'controller.gateway.gateway-1': shared, 'controller.tls.key': key, 'controller.tls.cert': cert } });
    const logs = [];
    const logger = { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args),
      event: (...args) => logs.push(args) };
    const registry = createExecutionProviderRegistry();
    const hosts = await loadMods({ runtimeRoot: path.join(root, 'runtime'), executionProviders: registry,
      enabledModIds: async () => ['node-goblin'], modStoreFactory: async id => { assert.equal(id, 'node-goblin'); return modStore; },
      modCatalogWriter: async () => {}, modAuthority: { read: async () => ({ grants: ['execution-provider-v1'] }),
        assertAllowed: async (id, capability) => { assert.equal(id, 'node-goblin'); assert.equal(capability, 'execution-provider-v1'); } }, logger });
    resources.hosts.push(...hosts);
    assert.equal(hosts.length, 1); assert.equal(hosts[0].status, 'loaded', hosts[0].error);
    assert.ok(hosts[0].host.child.connected); assert.notEqual(hosts[0].host.child.pid, process.pid);
    const provider = registry.get('node-goblin'); assert.ok(provider);
    const controllerRoute = hosts[0].routes.find(route => route.method === 'GET' && route.path === '/controller');
    assert.ok(controllerRoute);
    await until(async () => (await controllerRoute.handler({})).controller?.running, 'child controller TLS listener');

    const telemetry = resources.telemetry = createGatewayTelemetry({ env: { OTEL_BSP_SCHEDULE_DELAY: '20', OTEL_EXPORTER_OTLP_TIMEOUT: '1000' }, logger });
    const journalPath = path.join(root, 'journal.json');
    const daemon = new GatewayDaemon({ telemetry, journal: new OperationJournal({ filePath: journalPath }) });
    const transport = resources.transport = new OutboundGatewayTransport({ host: '127.0.0.1', port, gatewayId: 'gateway-1',
      stateDir: path.join(root, 'trust'), enrollmentToken: shared, ca: cert, daemon });
    const authenticated = once(transport, 'authenticated', { signal: AbortSignal.timeout(10_000) });
    transport.start();
    await authenticated;
    assert.equal(transport.socket.authorized, true, 'self-signed listener was authenticated using the supplied CA');
    assert.equal(transport.authenticated, true);

    let saved = { enabled: false, destinations: [] };
    const settingsStore = { read: async () => structuredClone(saved), write: async value => (saved = structuredClone(value)) };
    const options = { store: settingsStore, env: {} };
    const runtime = resources.runtime = createReconfigurableOtelRuntime({ tuningEnv: { OTEL_BSP_SCHEDULE_DELAY: '20', OTEL_EXPORTER_OTLP_TIMEOUT: '1000' }, logger });
    const initialDestinations = [
      { id: 'json', name: 'JSON', provider: 'openobserve', enabled: true, endpoint: `${json.base}/unused`, tracesEndpoint: `${json.base}/exact/traces`,
        protocol: 'http/json', metricsEnabled: false, connection: { organization: 'org' }, headers: `x-json=${jsonHeader}`,
        credentials: { token: `Bearer ${jsonToken}`, caCertificate: cert } },
      { id: 'proto', name: 'Protobuf', provider: 'signoz', enabled: true, endpoint: `${proto.base}/receiver`, protocol: 'http/protobuf',
        metricsEnabled: false, headers: `x-proto=${protoHeader}`, credentials: { token: protoToken, caCertificate: cert } },
    ];
    const update = async (enabled, destinations) => {
      const response = await saveOtelSettings({ enabled, destinations }, options);
      assert.equal(response.ok, true, response.error);
      noSecrets(response, privateValues, 'public Core settings');
      await runtime.apply(await readOtelRuntimeConfig(options));
      const remote = runtime.remoteConfiguration();
      const result = await registry.configure('node-goblin', remote);
      assert.deepEqual(result, { configured: 1, succeeded: 1, failed: 0, failures: [] });
      noSecrets(result, privateValues, 'Core configuration result');
      noSecrets([runtime.status(), telemetry.status(), logs], privateValues, 'runtime status or logs');
      return remote;
    };
    const firstConfig = await update(true, initialDestinations);
    assert.deepEqual(firstConfig.destinations.map(item => item.id), ['json', 'proto']);
    assert.equal(firstConfig.destinations[0].tls.caCertificate, cert);
    assert.equal(firstConfig.destinations[1].tls.caCertificate, cert);
    assert.match(firstConfig.destinations[0].headers, /Authorization=/);
    assert.match(firstConfig.destinations[1].headers, /signoz-ingestion-key=/);

    const router = createProcessExecutionRouter({ localExecute: () => assert.fail('remote operation must not run in Core'), remoteController: provider });
    const execute = (operationId, traceContext, processSpec, protectedValues, parentRunId = `run-${operationId}`) => router({ target: { kind: 'remote', providerId: 'node-goblin', targetId: 'gateway-1' },
      process: processSpec, ...(protectedValues ? { protectedValues, protectedBindingMetadata: [{ name: 'TOKEN', ref: 'protected://fixture' }] } : {}) },
    { operationId, parentRunId, toolCallId: `call-${operationId}`, traceContext, telemetry: traceContext ? runtime : null });
    const fsRouter = createNativeFilesystemExecutionRouter({ localExecute: () => assert.fail('remote filesystem must not run in Core'), remoteController: provider });
    const executeFilesystem = (operationId, runId, traceContext) => fsRouter({ target: { kind: 'remote', providerId: 'node-goblin', targetId: 'gateway-1' },
      operation: { tool: 'files_inspect', arguments: { path: root } } },
    { operationId, parentRunId: runId, toolCallId: `call-${operationId}`, traceContext, telemetry: runtime });
    const fast = { executable: process.execPath, args: ['-e', 'process.stdout.write(process.env.TOKEN || "ok")'], timeoutMs: 15_000 };
    const coreRun = runtime.startRun({ runId: 'run-initial' }); assert.ok(coreRun?.traceContext);
    const initial = await execute('initial-op', coreRun.traceContext, fast, { TOKEN: protectedOutput }, 'run-initial');
    assert.equal(initial.ok, true); assert.equal(initial.stdout, '[redacted]');
    // End the Core run so its SDK processor can send the root span; manually
    // flush the gateway so both collectors see the matching real child span.
    runtime.endRun('run-initial', { ok: true });
    await telemetry.flush();
    await until(() => jsonSpans(json.requests).some(span => span.name === 'burrow.run' && span.traceId === coreRun.traceContext.traceparent.split('-')[1])
      && protoSpans(proto.requests).some(span => span.name === 'burrow.run' && span.traceId === coreRun.traceContext.traceparent.split('-')[1]), 'Core root span on both receivers');
    const initialJson = nodeSpans(jsonSpans(json.requests));
    const initialProto = nodeSpans(protoSpans(proto.requests));
    assert.deepEqual(ids(initialJson), ['initial-op']); assert.deepEqual(ids(initialProto), ['initial-op']);
    const j = initialJson[0], p = initialProto[0];
    assert.equal(j.traceId, coreRun.traceContext.traceparent.split('-')[1]);
    assert.equal(j.parentSpanId, coreRun.traceContext.traceparent.split('-')[2]);
    assert.deepEqual({ traceId: p.traceId, spanId: p.spanId, parentSpanId: p.parentSpanId },
      { traceId: j.traceId, spanId: j.spanId, parentSpanId: j.parentSpanId });
    const coreRootJson = jsonSpans(json.requests).find(span => span.name === 'burrow.run' && span.traceId === j.traceId);
    const coreRootProto = protoSpans(proto.requests).find(span => span.name === 'burrow.run' && span.traceId === j.traceId);
    assert.equal(coreRootJson.spanId, j.parentSpanId); assert.equal(coreRootProto.spanId, coreRootJson.spanId);

    const makeHeld = async (operationId, traceContext, parentRunId = `run-${operationId}`) => {
      const marker = path.join(root, `${operationId}.ready`), release = path.join(root, `${operationId}.release`);
      resources.releases.push(release);
      const script = `const fs=require('node:fs');fs.writeFileSync(process.argv[1],'ready');const t=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(t);process.stdout.write('done')}},10);`;
      const pending = execute(operationId, traceContext, { executable: process.execPath, args: ['-e', script, marker, release], timeoutMs: 15_000 }, null, parentRunId);
      pending.catch(() => {}); resources.operations.push(pending);
      await until(() => exists(marker), `${operationId} process admitted`);
      return { pending, release };
    };
    const oldRun = runtime.startRun({ runId: 'run-old-op' }); assert.ok(oldRun?.traceContext);
    const old = await makeHeld('old-op', oldRun.traceContext);
    const replacement = [{ id: 'json', name: 'Replacement', provider: 'custom', enabled: true, endpoint: `${next.base}/new`,
      protocol: 'http/json', metricsEnabled: false, headers: `x-new=${nextHeader}`, credentials: { caCertificate: cert } }];
    const newConfig = await update(true, replacement);
    assert.deepEqual(newConfig.destinations.map(item => item.id), ['json']);
    const oldConfig = runtime.remoteConfiguration('run-old-op');
    assert.deepEqual(oldConfig.destinations.map(item => item.id), ['json', 'proto'], 'Core retains the old run owner');
    assert.equal(oldConfig.destinations[0].tls.caCertificate, cert);
    assert.equal(oldConfig.destinations[1].tls.caCertificate, cert);
    // Both operations are admitted AFTER the replacement, not merely held
    // across it. Their trusted owner is the still-running old Core run.
    const lateOld = await execute('old-after-change', oldRun.traceContext, fast, null, 'run-old-op');
    const lateOldFs = await executeFilesystem('old-fs-after-change', 'run-old-op', oldRun.traceContext);
    assert.equal(lateOld.ok, true); assert.equal(lateOldFs.ok, true);
    const newRun = runtime.startRun({ runId: 'run-new-op' }); assert.ok(newRun?.traceContext);
    assert.equal((await execute('new-op', newRun.traceContext, fast)).ok, true);
    const newer = await makeHeld('new-held-op', newRun.traceContext, 'run-new-op');
    const disabledConfig = await update(false, []);
    assert.equal(disabledConfig.enabled, false); assert.deepEqual(disabledConfig.destinations, []);
    assert.deepEqual(runtime.remoteConfiguration('run-new-op').destinations.map(item => item.id), ['json'], 'Core retains the new run owner after disable');
    const lateOldDisabled = await execute('old-after-disable', oldRun.traceContext, fast, null, 'run-old-op');
    const lateNewDisabled = await execute('new-after-disable', newRun.traceContext, fast, null, 'run-new-op');
    const oldFsDisabled = await executeFilesystem('old-fs-after-disable', 'run-old-op', oldRun.traceContext);
    const newFsDisabled = await executeFilesystem('new-fs-after-disable', 'run-new-op', newRun.traceContext);
    assert.equal(lateOldDisabled.ok, true); assert.equal(lateNewDisabled.ok, true);
    assert.equal(oldFsDisabled.ok, true); assert.equal(newFsDisabled.ok, true);
    assert.equal((await execute('disabled-op', null, fast)).ok, true);
    await fs.writeFile(old.release, 'release'); await fs.writeFile(newer.release, 'release');
    assert.equal((await old.pending).ok, true); assert.equal((await newer.pending).ok, true);
    runtime.endRun('run-old-op', { ok: true }); runtime.endRun('run-new-op', { ok: true });
    await telemetry.flush();
    await runtime.shutdown({ timeoutMs: 2_000 });
    await until(() => ids(nodeSpans(jsonSpans(json.requests))).includes('old-op')
      && ids(nodeSpans(protoSpans(proto.requests))).includes('old-op')
      && ids(nodeSpans(jsonSpans(next.requests))).includes('new-held-op'), 'retired gateway generations export');
    assert.deepEqual(ids(nodeSpans(jsonSpans(json.requests))), ['initial-op', 'old-after-change', 'old-after-disable', 'old-op']);
    assert.deepEqual(ids(nodeSpans(protoSpans(proto.requests))), ['initial-op', 'old-after-change', 'old-after-disable', 'old-op']);
    assert.deepEqual(ids(nodeSpans(jsonSpans(next.requests))), ['new-after-disable', 'new-held-op', 'new-op']);
    assert.deepEqual(ids(filesystemSpans(jsonSpans(json.requests))), ['old-fs-after-change', 'old-fs-after-disable']);
    assert.deepEqual(ids(filesystemSpans(protoSpans(proto.requests))), ['old-fs-after-change', 'old-fs-after-disable']);
    assert.deepEqual(ids(filesystemSpans(jsonSpans(next.requests))), ['new-fs-after-disable']);
    for (const span of [...nodeSpans(jsonSpans(json.requests)), ...filesystemSpans(jsonSpans(json.requests))]) {
      if (!span.attributes['burrow.operation.id'].startsWith('old-')) continue;
      assert.equal(span.traceId, oldRun.traceContext.traceparent.split('-')[1]);
      assert.equal(span.parentSpanId, oldRun.traceContext.traceparent.split('-')[2]);
    }
    for (const receiver of [json, proto, next]) assert.ok(receiver.requests.length > 0, 'destination received actual HTTPS requests');
    const oldJson = nodeSpans(jsonSpans(json.requests)).find(span => span.attributes['burrow.operation.id'] === 'old-op');
    const oldProto = nodeSpans(protoSpans(proto.requests)).find(span => span.attributes['burrow.operation.id'] === 'old-op');
    assert.equal(oldJson.traceId, oldRun.traceContext.traceparent.split('-')[1]);
    assert.deepEqual([oldProto.traceId, oldProto.spanId, oldProto.parentSpanId], [oldJson.traceId, oldJson.spanId, oldJson.parentSpanId]);

    for (const request of json.requests) {
      assert.equal(request.path, '/exact/traces'); assert.match(request.headers['content-type'], /^application\/json/);
      assert.equal(request.headers.authorization, `Bearer ${jsonToken}`); assert.equal(request.headers['x-json'], jsonHeader);
      assert.equal(request.headers['signoz-ingestion-key'], undefined); assert.equal(request.headers['x-proto'], undefined); assert.equal(request.headers['x-new'], undefined);
    }
    for (const request of proto.requests) {
      assert.equal(request.path, '/receiver/v1/traces'); assert.match(request.headers['content-type'], /^application\/x-protobuf/);
      assert.equal(request.headers['signoz-ingestion-key'], protoToken); assert.equal(request.headers['x-proto'], protoHeader);
      assert.equal(request.headers.authorization, undefined); assert.equal(request.headers['x-json'], undefined); assert.equal(request.headers['x-new'], undefined);
    }
    for (const request of next.requests) {
      assert.equal(request.path, '/new/v1/traces'); assert.equal(request.headers['x-new'], nextHeader);
      assert.equal(request.headers.authorization, undefined); assert.equal(request.headers['signoz-ingestion-key'], undefined);
      assert.equal(request.headers['x-json'], undefined); assert.equal(request.headers['x-proto'], undefined);
    }
    for (const request of [...json.requests, ...proto.requests, ...next.requests]) noSecrets(request.body.toString('utf8'), privateValues, 'OTLP body');
    const gatewayRoute = hosts[0].routes.find(route => route.method === 'GET' && route.path === '/gateways');
    const operationsRoute = hosts[0].routes.find(route => route.method === 'GET' && route.path === '/operations');
    assert.ok(gatewayRoute); assert.ok(operationsRoute);
    const publicGateway = await gatewayRoute.handler({});
    const publicOperations = await operationsRoute.handler({ query: {} });
    noSecrets([initial, lateOld, lateOldFs, lateOldDisabled, lateNewDisabled, oldFsDisabled, newFsDisabled, runtime.status(), telemetry.status(), logs, publicGateway, publicOperations, [...modStore.settings], await fs.readFile(journalPath, 'utf8')], privateValues, 'results, activity, status, logs, correlation or gateway journal');
    for (const url of [json.base, proto.base, next.base]) noSecrets([runtime.status(), telemetry.status(), logs], [url], 'status or logs');
  });
