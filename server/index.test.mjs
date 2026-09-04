import assert from 'node:assert/strict';
import test from 'node:test';
import { activate, createControllerService, createOperationCorrelationStore, createProcessController } from './index.mjs';

function harness() {
  const routes = new Map(); const api = {};
  for (const method of ['get', 'post', 'put', 'delete']) api[method] = (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler);
  const values = new Map(); const secretValues = new Map();
  const settings = { get: async (name, fallback = null) => values.has(name) ? structuredClone(values.get(name)) : fallback, set: async (name, value) => (values.set(name, structuredClone(value)), value), delete: async (name) => values.delete(name) };
  const secrets = { get: async (name) => secretValues.get(name) ?? null, set: async (name, value) => secretValues.set(name, String(value)), clear: async (name) => secretValues.delete(name), has: async (name) => secretValues.has(name) };
  return { routes, api, settings, secrets, values, secretValues };
}
async function readyHarness(options = {}) { const value = harness(); await activate({ ...value, ...options }); return value; }
const target = { id: 'aap-host', name: 'AAP Host', baseUrl: 'http://127.0.0.1:42817', enabled: true };

test('retains legacy target registry API while adding controller operational routes', async () => {
  const value = await readyHarness({ controllerService: { state: () => ({ enabled: false, host: '127.0.0.1', port: 7443, running: false }), listLiveGateways: () => [], close() {} } });
  assert.deepEqual([...value.routes.keys()], ['GET /targets', 'POST /targets', 'PUT /targets/:id', 'DELETE /targets/:id', 'GET /controller', 'PUT /controller', 'PUT /controller/tls', 'DELETE /controller/tls', 'GET /pairings', 'POST /pairings/:gatewayId/approve', 'POST /pairings/:gatewayId/reject', 'GET /gateway-trust', 'PUT /gateway-trust/:gatewayId', 'DELETE /gateway-trust/:gatewayId', 'GET /gateways', 'GET /operations', 'POST /gateways/:gatewayId/processes', 'POST /gateways/:gatewayId/operations/:operationId/cancel']);
  const created = await value.routes.get('POST /targets')({ body: target });
  assert.equal(created.status, 201); assert.deepEqual(created.body, { ok: true, target }); assert.deepEqual(value.values.get('targets'), [target]);
  assert.deepEqual(await value.routes.get('GET /targets')({}), { ok: true, targets: [target] });
  const updatedTarget = { ...target, name: 'TaskMaster', baseUrl: 'https://aap.example.test', enabled: false };
  assert.deepEqual(await value.routes.get('PUT /targets/:id')({ params: { id: target.id }, body: updatedTarget }), { ok: true, target: updatedTarget });
  assert.deepEqual(await value.routes.get('DELETE /targets/:id')({ params: { id: target.id } }), { ok: true });
});

test('validates target identity and URL without adding credentials or health state', async () => {
  const value = await readyHarness();
  await assert.rejects(value.routes.get('POST /targets')({ body: { ...target, id: 'local' } }), /target_id_invalid/);
  await assert.rejects(value.routes.get('POST /targets')({ body: { ...target, name: '' } }), /target_name_required/);
  await assert.rejects(value.routes.get('POST /targets')({ body: { ...target, baseUrl: 'file:///tmp/nope' } }), /target_base_url_invalid/);
  await assert.rejects(value.routes.get('POST /targets')({ body: { ...target, baseUrl: 'https://user:pass@node.test' } }), /target_base_url_invalid/);
  await value.routes.get('POST /targets')({ body: target }); await assert.rejects(value.routes.get('POST /targets')({ body: target }), /api_target_exists/);
  assert.equal(JSON.stringify(value.values.get('targets')).includes('credential'), false); assert.equal(JSON.stringify(value.values.get('targets')).includes('status'), false);
});

test('exposes live inventory and preserves gateway operation correlation for dispatch and cancel', async () => {
  const calls = []; const service = {
    state: () => ({ enabled: true, host: '127.0.0.1', port: 7443, running: true }),
    listLiveGateways: () => [{ gatewayId: 'host-1', status: 'ok', activeOperations: ['op-1'] }],
    listGateways: () => [{ gatewayId: 'host-1', status: 'ok', connected: true, version: '1.0.0', lastSeenAt: '2025-01-01T00:00:00.000Z', activeOperations: ['op-1'] }],
    listOperationActivity: ({ limit }) => [{ gatewayId: 'host-1', operationId: 'op-1', kind: 'process', state: 'running', replay: false, reconnectRequired: false, terminalOutcome: null, durationMs: null }].slice(0, limit),
    dispatchProcessExec: async (gatewayId, body) => (calls.push(['exec', gatewayId, body]), { accepted: { operationId: body.operationId }, response: { result: { operationId: body.operationId } } }),
    dispatchCancel: async (gatewayId, operationId) => (calls.push(['cancel', gatewayId, operationId]), { response: { result: { operationId, cancelling: true } } }), close() {},
  };
  const value = await readyHarness({ controllerService: service });
  assert.deepEqual(await value.routes.get('GET /controller')({}), { ok: true, controller: service.state() });
  assert.deepEqual(await value.routes.get('GET /gateways')({}), { ok: true, gateways: service.listGateways() });
  assert.deepEqual(await value.routes.get('GET /operations')({ query: { limit: '999' } }), { ok: true, operations: service.listOperationActivity({ gatewayId: null, limit: 256 }), limit: 256 });
  const dispatched = await value.routes.get('POST /gateways/:gatewayId/processes')({ params: { gatewayId: 'host-1' }, body: { operationId: 'op-1', executable: '/bin/echo', args: ['hi'] } });
  assert.equal(dispatched.operationId, 'op-1'); assert.deepEqual(calls[0], ['exec', 'host-1', { operationId: 'op-1', executable: '/bin/echo', args: ['hi'] }]);
  await assert.rejects(value.routes.get('POST /gateways/:gatewayId/processes')({ params: { gatewayId: 'host-1' }, body: { operationId: 'both', command: 'echo hi', executable: '/bin/echo' } }), /command_and_executable_mutually_exclusive/);
  await assert.rejects(value.routes.get('POST /gateways/:gatewayId/processes')({ params: { gatewayId: 'host-1' }, body: { operationId: 'bad-args', executable: '/bin/echo', args: ['hi', 1] } }), /args_invalid/);
  await value.routes.get('POST /gateways/:gatewayId/operations/:operationId/cancel')({ params: { gatewayId: 'host-1', operationId: 'op-1' } });
  assert.deepEqual(calls[1], ['cancel', 'host-1', 'op-1']);
  await assert.rejects(value.routes.get('POST /gateways/:gatewayId/processes')({ params: { gatewayId: 'host-1' }, body: { executable: '/bin/echo' } }), /operation_id_invalid/);
});

test('administers controller trust and TLS through secrets without returning material and declares restart lifecycle', async () => {
  const value = await readyHarness();
  assert.deepEqual((await value.routes.get('GET /controller')({})).controller.tls, { configured: false, ready: false, keyConfigured: false, certConfigured: false, caConfigured: false });
  assert.deepEqual(await value.routes.get('PUT /controller')({ body: { enabled: true, host: '0.0.0.0', port: 8443 } }), { ok: true, controller: { enabled: true, host: '0.0.0.0', port: 8443 }, restartRequired: true });
  const tlsResult = await value.routes.get('PUT /controller/tls')({ body: { key: 'PRIVATE', cert: 'CERT', ca: 'CA' } });
  assert.deepEqual(tlsResult, { ok: true, restartRequired: true }); assert.equal(JSON.stringify(tlsResult).includes('PRIVATE'), false);
  const enrolled = await value.routes.get('PUT /gateway-trust/:gatewayId')({ params: { gatewayId: 'host-1' }, body: { controllerId: 'controller-a', secret: 'shared-secret' } });
  assert.deepEqual(enrolled, { ok: true, gateway: { gatewayId: 'host-1', controllerId: 'controller-a', status: 'approved', approved: true, revoked: false, trusted: true, method: 'hmac' }, restartRequired: true });
  assert.equal(value.secretValues.get('controller.gateway.host-1'), 'shared-secret');
  const listed = await value.routes.get('GET /gateway-trust')({}); assert.deepEqual(listed.gateways, [{ gatewayId: 'host-1', controllerId: 'controller-a', status: 'approved', approved: true, revoked: false, trusted: true, method: 'hmac' }]); assert.equal(JSON.stringify(listed).includes('shared-secret'), false);
  assert.deepEqual(await value.routes.get('DELETE /gateway-trust/:gatewayId')({ params: { gatewayId: 'host-1' } }), { ok: true, gateway: { gatewayId: 'host-1', controllerId: 'controller-a', status: 'revoked', approved: false, revoked: true, trusted: false, method: 'hmac' }, restartRequired: true }); assert.equal(value.secretValues.has('controller.gateway.host-1'), false);
  assert.deepEqual((await value.routes.get('GET /gateway-trust')({})).gateways, []);
  value.values.set('controllerGateways', [{ gatewayId: 'paired-node', controllerId: 'controller-a' }]);
  value.secretValues.set('controller.gateway.publicKey.paired-node', 'PUBLIC-KEY');
  assert.deepEqual((await value.routes.get('GET /gateway-trust')({})).gateways, [{ gatewayId: 'paired-node', controllerId: 'controller-a', status: 'approved', approved: true, revoked: false, trusted: true, method: 'ed25519' }]);
  assert.equal(JSON.stringify(await value.routes.get('GET /gateway-trust')({})).includes('PUBLIC-KEY'), false);
  await value.routes.get('DELETE /controller/tls')({}); assert.equal(value.secretValues.has('controller.tls.key'), false);
  await assert.rejects(value.routes.get('PUT /gateway-trust/:gatewayId')({ params: { gatewayId: 'bad/id' }, body: { secret: 'x' } }), /target_id_invalid/);
  await assert.rejects(value.routes.get('PUT /controller/tls')({ body: { key: '', cert: 'CERT' } }), /controller_tls_credentials_required/);
});

test('registers a process controller without changing legacy routes and unregisters it on close', async () => {
  const value = harness();
  const service = { state: () => ({}), listLiveGateways: () => [], dispatchProcessExec() {}, dispatchCancel() {}, close() { service.closed = true; } };
  let controller; let unregistered = false;
  const lifecycle = await activate({ ...value, controllerService: service, processExecution: { registerController(candidate) { controller = candidate; return () => { unregistered = true; }; } } });
  assert.equal(typeof controller.executeProcess, 'function');
  assert.equal(value.routes.has('GET /targets'), true);
  lifecycle.close();
  assert.equal(unregistered, true);
  assert.equal(service.closed, true);
});

test('process controller dispatches correlated shell command and maps terminal evidence', async () => {
  const calls = [];
  const evidence = { type: 'process.result', cwd: '/repo', exitCode: 0, signal: null, timedOut: false, cancelled: false, truncated: false, durationMs: 12, stdout: 'ok\n', stderr: '' };
  const service = {
    async dispatchProcessExec(gatewayId, params) {
      calls.push(['exec', gatewayId, params]);
      return { accepted: { operationId: params.operationId }, events: [{ type: 'process.terminal', operationId: params.operationId, evidence }], response: { ok: true, result: { operationId: params.operationId, outcome: evidence } } };
    },
    async dispatchCancel(gatewayId, operationId) { calls.push(['cancel', gatewayId, operationId]); },
  };
  const result = await createProcessController(service).executeProcess({ operationId: 'shell-abc', gatewayId: 'host-1', parentRunId: 'run-1', toolCallId: 'call-1', process: { command: 'printf ok', cwd: '/repo', env: { A: 'b' }, timeoutMs: 42 } });
  assert.deepEqual(calls, [['exec', 'host-1', { operationId: 'shell-abc', command: 'printf ok', cwd: '/repo', env: { A: 'b' }, timeoutMs: 42 }]]);
  assert.deepEqual(result, { tool: 'shell_exec', ok: true, command: 'printf ok', reason: null, cwd: '/repo', exitCode: 0, signal: null, timedOut: false, cancelled: false, killed: false, durationMs: 12, stdout: 'ok\n', stderr: '', stdoutTruncated: false, stderrTruncated: false, stdoutOriginalChars: 3, stderrOriginalChars: 0, error: null, artifacts: null, operationId: 'shell-abc', gatewayId: 'host-1' });
});

test('process controller preserves git executable argv through gateway dispatch', async () => {
  const evidence = { type: 'process.result', cwd: '/repo', exitCode: 0, stdout: '## main\n', stderr: '', cancelled: false, timedOut: false };
  let params;
  const controller = createProcessController({
    async dispatchProcessExec(_gatewayId, value) {
      params = value;
      return { accepted: { operationId: value.operationId }, events: [{ type: 'process.terminal', operationId: value.operationId, evidence }], response: { ok: true, result: { operationId: value.operationId, outcome: evidence } } };
    },
    dispatchCancel() {},
  });
  const result = await controller.executeProcess({ operationId: 'git-status', gatewayId: 'host-1', process: { executable: 'git', args: ['status', '--short', '--branch'], cwd: '/repo' } });
  assert.deepEqual(params, { operationId: 'git-status', executable: 'git', args: ['status', '--short', '--branch'], cwd: '/repo' });
  assert.equal(result.command, 'git status --short --branch');
  assert.equal(result.stdout, '## main\n');
});

test('process controller uses response outcome for replay and rejects failed or uncorrelated evidence', async () => {
  const request = { operationId: 'shell-replay', gatewayId: 'host-1', process: { command: 'false' } };
  const evidence = { type: 'process.result', exitCode: 7, stdout: '', stderr: 'no', cancelled: false, timedOut: false };
  const replay = createProcessController({ dispatchProcessExec: async () => ({ response: { ok: true, result: { operationId: 'shell-replay', replay: true, outcome: evidence } } }), dispatchCancel() {} });
  assert.equal((await replay.executeProcess(request)).ok, false);
  const failed = createProcessController({ dispatchProcessExec: async () => ({ response: { ok: false, error: { code: 'operation_id_conflict', operationId: 'shell-replay' } } }), dispatchCancel() {} });
  await assert.rejects(failed.executeProcess(request), (error) => error.code === 'operation_id_conflict');
  const mismatch = createProcessController({ dispatchProcessExec: async () => ({ response: { ok: true, result: { operationId: 'other', outcome: evidence } } }), dispatchCancel() {} });
  await assert.rejects(mismatch.executeProcess(request), (error) => error.code === 'gateway_operation_id_mismatch');
});

test('process controller propagates AbortSignal cancellation with the same operation id', async () => {
  const calls = []; let resolveDispatch;
  const service = {
    dispatchProcessExec: (gatewayId, params) => (calls.push(['exec', gatewayId, params.operationId]), new Promise((resolve) => { resolveDispatch = resolve; })),
    dispatchCancel: async (gatewayId, operationId) => { calls.push(['cancel', gatewayId, operationId]); },
  };
  const abort = new AbortController();
  const pending = createProcessController(service).executeProcess({ operationId: 'shell-cancel', gatewayId: 'host-1', process: { command: 'sleep 10' } }, { abortSignal: abort.signal });
  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.slice(0, 2), [['exec', 'host-1', 'shell-cancel'], ['cancel', 'host-1', 'shell-cancel']]);
  const evidence = { type: 'process.result', exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '', cancelled: true, timedOut: false };
  resolveDispatch({ response: { ok: true, result: { operationId: 'shell-cancel', outcome: evidence } } });
  const result = await pending;
  assert.equal(result.cancelled, true); assert.equal(result.ok, false);
});

test('controller service starts only from encrypted secrets, never exposes them, redacts dispatch evidence, and closes listener', async () => {
  const value = harness(); value.settings.set('controller', { enabled: true, host: '127.0.0.1', port: 7443 }); value.settings.set('controllerGateways', [{ gatewayId: 'host-1', controllerId: 'controller' }]);
  value.secrets.set('controller.gateway.host-1', 'shared-secret'); value.secrets.set('controller.tls.key', 'private-key'); value.secrets.set('controller.tls.cert', 'certificate');
  let options; let closed = false;
  const service = await createControllerService({
    settings: value.settings, secrets: value.secrets,
    listenerFactory: (entry) => {
      options = entry;
      return { listen() {}, close() { closed = true; }, listLiveGateways: () => [], dispatchProcessExec: async () => ({ response: { result: { diagnostic: 'shared-secret' } } }) };
    },
  });
  assert.deepEqual(service.state(), { enabled: true, host: '127.0.0.1', port: 7443, running: true, tls: { configured: true, ready: true, keyConfigured: true, certConfigured: true, caConfigured: false, source: 'configured', createdAt: null, expiresAt: null, rotateAfter: null, host: null } }); assert.equal(options.gateways[0].secret, 'shared-secret'); assert.equal(JSON.stringify(service.state()).includes('secret'), false);
  assert.equal(JSON.stringify(await service.dispatchProcessExec('host-1', { operationId: 'op-1' })).includes('shared-secret'), false); service.close(); assert.equal(closed, true);
});

test('operation correlation survives controller recreation and permits identical replay only', async () => {
  const { settings } = harness();
  const request = { operationId: 'op-durable', parentRunId: 'run-1', toolCallId: 'call-1', gatewayId: 'gw-1' };
  const params = { operationId: 'op-durable', command: 'echo durable' };
  await createOperationCorrelationStore(settings).begin(request, 'process', params);
  const recovered = createOperationCorrelationStore(settings);
  assert.equal((await recovered.get('op-durable')).state, 'dispatching');
  assert.equal((await recovered.begin(request, 'process', params)).requestDigest, (await recovered.get('op-durable')).requestDigest);
  await assert.rejects(recovered.begin(request, 'process', { ...params, command: 'echo different' }), /operation_correlation_conflict/);
  await recovered.terminal('op-durable', { response: { result: { operationId: 'op-durable', replay: true, outcome: { exitCode: 0 } } } });
  assert.deepEqual((await recovered.get('op-durable')).terminalReference.replay, true);
  assert.equal((await recovered.get('op-durable')).parentRunId, 'run-1');
});


test('enabled controller generates long-lived host-bound TLS into secrets and exposes metadata only', async () => {
  const value = harness(); value.settings.set('controller', { enabled: true, host: 'controller.example.test', port: 7443 });
  let options;
  const service = await createControllerService({ settings: value.settings, secrets: value.secrets, listenerFactory: (entry) => (options = entry, { listen() {}, close() {}, listLiveGateways: () => [] }) });
  const state = service.state();
  assert.equal(state.running, true); assert.equal(state.tls.source, 'generated');
  assert.equal(state.tls.host, 'controller.example.test'); assert.equal(typeof state.tls.expiresAt, 'string');
  assert.equal(state.tls.rotateAfter < state.tls.expiresAt, true);
  assert.match(value.secretValues.get('controller.tls.key'), /PRIVATE KEY/); assert.match(value.secretValues.get('controller.tls.cert'), /CERTIFICATE/);
  assert.match(options.serverOptions.cert, /CERTIFICATE/); assert.equal(JSON.stringify(state).includes('PRIVATE KEY'), false); assert.equal(JSON.stringify(state).includes('CERTIFICATE'), false);
  service.close();
});

test('async correlation serializes concurrent writes without losing records', async () => {
  const { settings } = harness();
  const store = createOperationCorrelationStore(settings);
  await Promise.all(Array.from({ length: 8 }, (_, index) => store.begin({
    operationId: `op-${index}`, parentRunId: 'run', toolCallId: `call-${index}`, gatewayId: 'host-1',
  }, 'process', { operationId: `op-${index}`, command: `echo ${index}` })));
  const records = await settings.get('controllerOperations', []);
  assert.equal(records.length, 8);
  assert.deepEqual(new Set(records.map((record) => record.operationId)), new Set(Array.from({ length: 8 }, (_, index) => `op-${index}`)));
});

test('pairing persistence failures are caught opaquely without secret or raw error logging', async () => {
  const value = harness();
  value.values.set('controller', { enabled: true, host: '127.0.0.1', port: 7443 });
  value.secretValues.set('controller.tls.key', 'private-key');
  value.secretValues.set('controller.tls.cert', 'certificate');
  let pairingHandler; const logs = [];
  value.settings.set = async (name, stored) => {
    if (name === 'pendingNodeGoblinPairings') throw new Error(`raw failure ${JSON.stringify(stored)}`);
    value.values.set(name, structuredClone(stored)); return stored;
  };
  const service = await createControllerService({
    settings: value.settings, secrets: value.secrets, logger: { error: (message) => logs.push(message) },
    listenerFactory: () => ({ listen() {}, close() {}, on(name, handler) { if (name === 'gatewayPairingPending') pairingHandler = handler; } }),
  });
  pairingHandler({ gatewayId: 'host-1', publicKey: 'DO-NOT-LOG', status: 'pending' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logs, ['Remote Nodes pairing persistence failed: pairing_persistence_failed']);
  assert.equal(JSON.stringify(logs).includes('DO-NOT-LOG'), false);
  await service.close();
});

test('controller preserves structured filesystem failures and operation arguments', async () => {
  let seen;
  const outcome = { tool: 'files_list', ok: false, dirPath: '/repo/file', error: 'ENOTDIR', diagnostic: { code: 'ENOTDIR', message: 'ENOTDIR' } };
  const service = {
    async dispatchFilesystem(gatewayId, params) { seen = { gatewayId, params }; return { accepted: { operationId: params.operationId }, response: { ok: true, result: { operationId: params.operationId, outcome } } }; },
    async dispatchProcessExec() {}, async dispatchCancel() {},
  };
  const result = await createProcessController(service).executeNativeFilesystem({ operationId: 'fs-controller-1', gatewayId: 'host-1', parentRunId: 'run-1', toolCallId: 'call-1', operation: { tool: 'files_list', arguments: { dirPath: '/repo/file', maxDepth: 2 } } });
  assert.equal(seen.params.tool, 'files_list');
  assert.deepEqual(seen.params.arguments, { dirPath: '/repo/file', maxDepth: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ENOTDIR');
  assert.equal(result.operationId, 'fs-controller-1');
});

test('pairing approval persists trust before auth.ok commit and survives controller recreation', async () => {
  const value = harness();
  await value.settings.set('controller', { enabled: true, host: '127.0.0.1', port: 7443 });
  await value.secrets.set('controller.tls.key', 'private-key');
  await value.secrets.set('controller.tls.cert', 'certificate');
  await value.settings.set('pendingControllerPairings', [{ gatewayId: 'fresh-node', controllerId: 'controller', publicKey: 'PUBLIC', pairingCode: 'AAAA-BBBB-CCCC', nonce: 'nonce', status: 'pending' }]);
  const order = [];
  const pairing = { gatewayId: 'fresh-node', controllerId: 'controller', publicKey: 'PUBLIC', pairingCode: 'AAAA-BBBB-CCCC', nonce: 'nonce', status: 'pending' };
  const listener = { on() {}, listen() {}, close() {}, listPending: () => [pairing], preparePendingApproval: () => pairing,
    commitPendingApproval() { order.push(['commit', value.secretValues.get('controller.gateway.publicKey.fresh-node'), value.values.get('controllerGateways')]); return { ...pairing, status: 'approved' }; },
    listLiveGateways: () => [] };
  const originalSet = value.settings.set;
  value.settings.set = async (name, stored) => { order.push(['settings', name]); return originalSet(name, stored); };
  const originalSecretSet = value.secrets.set;
  value.secrets.set = async (name, stored) => { order.push(['secret', name]); return originalSecretSet(name, stored); };
  const service = await createControllerService({ settings: value.settings, secrets: value.secrets, listenerFactory: () => listener });
  const approved = await service.approvePairing('fresh-node');
  assert.equal(approved.status, 'approved');
  assert.deepEqual(order.at(-1), ['commit', 'PUBLIC', [{ gatewayId: 'fresh-node', controllerId: 'controller' }]]);
  const recreated = await createControllerService({ settings: value.settings, secrets: value.secrets, listenerFactory: (options) => ({ ...listener, options }) });
  assert.deepEqual((await value.settings.get('controllerGateways'))[0], { gatewayId: 'fresh-node', controllerId: 'controller' });
  assert.equal(await value.secrets.get('controller.gateway.publicKey.fresh-node'), 'PUBLIC');
  service.close(); recreated.close();
});

test('pairing persistence failure leaves live pairing pending and sends no approval', async () => {
  const value = harness();
  await value.settings.set('controller', { enabled: true, host: '127.0.0.1', port: 7443 });
  await value.secrets.set('controller.tls.key', 'private-key'); await value.secrets.set('controller.tls.cert', 'certificate');
  const pairing = { gatewayId: 'fresh-node', controllerId: 'controller', publicKey: 'DO-NOT-LOG', pairingCode: 'AAAA-BBBB-CCCC', nonce: 'nonce', status: 'pending' };
  let committed = false;
  const listener = { on() {}, listen() {}, close() {}, listPending: () => [pairing], preparePendingApproval: () => pairing,
    commitPendingApproval() { committed = true; }, listLiveGateways: () => [] };
  const normalSet = value.settings.set;
  value.settings.set = async (name, stored) => { if (name === 'controllerGateways') throw new Error('raw private failure DO-NOT-LOG'); return normalSet(name, stored); };
  const service = await createControllerService({ settings: value.settings, secrets: value.secrets, listenerFactory: () => listener });
  await assert.rejects(service.approvePairing('fresh-node'), (error) => error.code === 'pairing_persistence_failed' && error.message === 'pairing_persistence_failed');
  assert.equal(committed, false);
  assert.deepEqual(listener.listPending(), [pairing]);
  assert.equal(await value.secrets.get('controller.gateway.publicKey.fresh-node'), null);
  service.close();
});

test('revoke clears durable trust, both credential forms, pending pairing, and live state idempotently', async () => {
  const removed = [];
  const service = { state: () => ({}), listLiveGateways: () => [], listGateways: () => [], close() {},
    revokeGateway: async (id) => { removed.push(id); } };
  const value = await readyHarness({ controllerService: service });
  value.values.set('controllerGateways', [{ gatewayId: 'node', controllerId: 'controller' }]);
  value.values.set('pendingNodeGoblinPairings', [{ gatewayId: 'node', publicKey: 'NODE-PUBLIC', status: 'pending' }, { gatewayId: 'other', publicKey: 'OTHER-PUBLIC', status: 'pending' }]);
  value.secretValues.set('controller.gateway.node', 'SECRET'); value.secretValues.set('controller.gateway.publicKey.node', 'PUBLIC');
  const revoke = value.routes.get('DELETE /gateway-trust/:gatewayId');
  await revoke({ params: { gatewayId: 'node' } });
  await revoke({ params: { gatewayId: 'node' } });
  assert.deepEqual(value.values.get('controllerGateways'), []);
  assert.deepEqual(value.values.get('pendingNodeGoblinPairings'), [{ gatewayId: 'other', publicKey: 'OTHER-PUBLIC', status: 'pending' }]);
  assert.equal(value.secretValues.has('controller.gateway.node'), false);
  assert.equal(value.secretValues.has('controller.gateway.publicKey.node'), false);
  assert.deepEqual(removed, ['node', 'node']);
});
