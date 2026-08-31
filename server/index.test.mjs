import assert from 'node:assert/strict';
import test from 'node:test';
import { activate, createControllerService } from './index.mjs';

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
