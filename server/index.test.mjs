import assert from 'node:assert/strict';
import test from 'node:test';
import { activate, createControllerService, createOperationCorrelationStore, createProcessController } from './index.mjs';

function harness() {
  const routes = new Map(); const api = {};
  for (const method of ['get', 'post', 'put', 'delete']) api[method] = (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler);
  const values = new Map(); const secretValues = new Map();
  const settings = { get: (name, fallback = null) => values.has(name) ? structuredClone(values.get(name)) : fallback, set: (name, value) => (values.set(name, structuredClone(value)), value), delete: (name) => values.delete(name) };
  const secrets = { get: (name) => secretValues.get(name) ?? null, set: (name, value) => secretValues.set(name, String(value)), clear: (name) => secretValues.delete(name), has: (name) => secretValues.has(name) };
  return { routes, api, settings, secrets, values, secretValues };
}
async function readyHarness(options = {}) { const value = harness(); await activate({ ...value, ...options }); return value; }
const target = { id: 'aap-host', name: 'AAP Host', baseUrl: 'http://127.0.0.1:42817', enabled: true };

test('retains legacy target registry API while adding controller operational routes', async () => {
  const value = await readyHarness({ controllerService: { state: () => ({ enabled: false, host: '127.0.0.1', port: 7443, running: false }), listLiveGateways: () => [], close() {} } });
  assert.deepEqual([...value.routes.keys()], ['GET /targets', 'POST /targets', 'PUT /targets/:id', 'DELETE /targets/:id', 'GET /controller', 'PUT /controller', 'PUT /controller/tls', 'DELETE /controller/tls', 'GET /gateway-trust', 'PUT /gateway-trust/:gatewayId', 'DELETE /gateway-trust/:gatewayId', 'GET /gateways', 'POST /gateways/:gatewayId/processes', 'POST /gateways/:gatewayId/operations/:operationId/cancel']);
  const created = value.routes.get('POST /targets')({ body: target });
  assert.equal(created.status, 201); assert.deepEqual(created.body, { ok: true, target }); assert.deepEqual(value.values.get('targets'), [target]);
  assert.deepEqual(value.routes.get('GET /targets')({}), { ok: true, targets: [target] });
  const updatedTarget = { ...target, name: 'TaskMaster', baseUrl: 'https://aap.example.test', enabled: false };
  assert.deepEqual(value.routes.get('PUT /targets/:id')({ params: { id: target.id }, body: updatedTarget }), { ok: true, target: updatedTarget });
  assert.deepEqual(value.routes.get('DELETE /targets/:id')({ params: { id: target.id } }), { ok: true });
});

test('validates target identity and URL without adding credentials or health state', async () => {
  const value = await readyHarness();
  assert.throws(() => value.routes.get('POST /targets')({ body: { ...target, id: 'local' } }), /target_id_invalid/);
  assert.throws(() => value.routes.get('POST /targets')({ body: { ...target, name: '' } }), /target_name_required/);
  assert.throws(() => value.routes.get('POST /targets')({ body: { ...target, baseUrl: 'file:///tmp/nope' } }), /target_base_url_invalid/);
  assert.throws(() => value.routes.get('POST /targets')({ body: { ...target, baseUrl: 'https://user:pass@node.test' } }), /target_base_url_invalid/);
  value.routes.get('POST /targets')({ body: target }); assert.throws(() => value.routes.get('POST /targets')({ body: target }), /api_target_exists/);
  assert.equal(JSON.stringify(value.values.get('targets')).includes('credential'), false); assert.equal(JSON.stringify(value.values.get('targets')).includes('status'), false);
});

test('exposes live inventory and preserves gateway operation correlation for dispatch and cancel', async () => {
  const calls = []; const service = {
    state: () => ({ enabled: true, host: '127.0.0.1', port: 7443, running: true }),
    listLiveGateways: () => [{ gatewayId: 'host-1', status: 'ok', activeOperations: ['op-1'] }],
    dispatchProcessExec: async (gatewayId, body) => (calls.push(['exec', gatewayId, body]), { accepted: { operationId: body.operationId }, response: { result: { operationId: body.operationId } } }),
    dispatchCancel: async (gatewayId, operationId) => (calls.push(['cancel', gatewayId, operationId]), { response: { result: { operationId, cancelling: true } } }), close() {},
  };
  const value = await readyHarness({ controllerService: service });
  assert.deepEqual(value.routes.get('GET /controller')({}), { ok: true, controller: service.state() });
  assert.deepEqual(value.routes.get('GET /gateways')({}), { ok: true, gateways: service.listLiveGateways() });
  const dispatched = await value.routes.get('POST /gateways/:gatewayId/processes')({ params: { gatewayId: 'host-1' }, body: { operationId: 'op-1', executable: '/bin/echo', args: ['hi'] } });
  assert.equal(dispatched.operationId, 'op-1'); assert.deepEqual(calls[0], ['exec', 'host-1', { operationId: 'op-1', executable: '/bin/echo', args: ['hi'] }]);
  await value.routes.get('POST /gateways/:gatewayId/operations/:operationId/cancel')({ params: { gatewayId: 'host-1', operationId: 'op-1' } });
  assert.deepEqual(calls[1], ['cancel', 'host-1', 'op-1']);
  await assert.rejects(value.routes.get('POST /gateways/:gatewayId/processes')({ params: { gatewayId: 'host-1' }, body: { executable: '/bin/echo' } }), /operation_id_invalid/);
});

test('administers controller trust and TLS through secrets without returning material and declares restart lifecycle', async () => {
  const value = await readyHarness();
  assert.deepEqual(value.routes.get('PUT /controller')({ body: { enabled: true, host: '0.0.0.0', port: 8443 } }), { ok: true, controller: { enabled: true, host: '0.0.0.0', port: 8443 }, restartRequired: true });
  const tlsResult = value.routes.get('PUT /controller/tls')({ body: { key: 'PRIVATE', cert: 'CERT', ca: 'CA' } });
  assert.deepEqual(tlsResult, { ok: true, restartRequired: true }); assert.equal(JSON.stringify(tlsResult).includes('PRIVATE'), false);
  const enrolled = value.routes.get('PUT /gateway-trust/:gatewayId')({ params: { gatewayId: 'host-1' }, body: { controllerId: 'controller-a', secret: 'shared-secret' } });
  assert.deepEqual(enrolled, { ok: true, gateway: { gatewayId: 'host-1', controllerId: 'controller-a', trusted: true }, restartRequired: true });
  assert.equal(value.secretValues.get('controller.gateway.host-1'), 'shared-secret');
  const listed = value.routes.get('GET /gateway-trust')({}); assert.deepEqual(listed.gateways, [{ gatewayId: 'host-1', controllerId: 'controller-a', trusted: true }]); assert.equal(JSON.stringify(listed).includes('shared-secret'), false);
  assert.deepEqual(value.routes.get('DELETE /gateway-trust/:gatewayId')({ params: { gatewayId: 'host-1' } }), { ok: true, restartRequired: true }); assert.equal(value.secretValues.has('controller.gateway.host-1'), false);
  value.routes.get('DELETE /controller/tls')({}); assert.equal(value.secretValues.has('controller.tls.key'), false);
  assert.throws(() => value.routes.get('PUT /gateway-trust/:gatewayId')({ params: { gatewayId: 'bad/id' }, body: { secret: 'x' } }), /target_id_invalid/);
  assert.throws(() => value.routes.get('PUT /controller/tls')({ body: { key: '', cert: 'CERT' } }), /controller_tls_credentials_required/);
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
  const service = createControllerService({
    settings: value.settings, secrets: value.secrets,
    listenerFactory: (entry) => {
      options = entry;
      return { listen() {}, close() { closed = true; }, listLiveGateways: () => [], dispatchProcessExec: async () => ({ response: { result: { diagnostic: 'shared-secret' } } }) };
    },
  });
  assert.deepEqual(service.state(), { enabled: true, host: '127.0.0.1', port: 7443, running: true }); assert.equal(options.gateways[0].secret, 'shared-secret'); assert.equal(JSON.stringify(service.state()).includes('secret'), false);
  assert.equal(JSON.stringify(await service.dispatchProcessExec('host-1', { operationId: 'op-1' })).includes('shared-secret'), false); service.close(); assert.equal(closed, true);
});

test('operation correlation survives controller recreation and permits identical replay only', () => {
  const { settings } = harness();
  const request = { operationId: 'op-durable', parentRunId: 'run-1', toolCallId: 'call-1', gatewayId: 'gw-1' };
  const params = { operationId: 'op-durable', command: 'echo durable' };
  createOperationCorrelationStore(settings).begin(request, 'process', params);
  const recovered = createOperationCorrelationStore(settings);
  assert.equal(recovered.get('op-durable').state, 'dispatching');
  assert.equal(recovered.begin(request, 'process', params).requestDigest, recovered.get('op-durable').requestDigest);
  assert.throws(() => recovered.begin(request, 'process', { ...params, command: 'echo different' }), /operation_correlation_conflict/);
  recovered.terminal('op-durable', { response: { result: { operationId: 'op-durable', replay: true, outcome: { exitCode: 0 } } } });
  assert.deepEqual(recovered.get('op-durable').terminalReference.replay, true);
  assert.equal(recovered.get('op-durable').parentRunId, 'run-1');
});
