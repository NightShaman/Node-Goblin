import assert from 'node:assert/strict';
import test from 'node:test';
import { activate } from './index.mjs';

function harness() {
  const routes = new Map();
  const api = {};
  for (const method of ['get', 'post', 'put', 'delete']) api[method] = (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler);
  const values = new Map();
  const settings = {
    get: (name, fallback = null) => values.has(name) ? structuredClone(values.get(name)) : fallback,
    set: (name, value) => (values.set(name, structuredClone(value)), value),
    delete: (name) => values.delete(name),
  };
  return { routes, api, settings, values };
}

async function readyHarness() {
  const value = harness();
  await activate(value);
  return value;
}

const target = { id: 'aap-host', name: 'AAP Host', baseUrl: 'http://127.0.0.1:42817', enabled: true };

test('owns only the namespaced API target registry', async () => {
  const value = await readyHarness();
  assert.deepEqual([...value.routes.keys()], ['GET /targets', 'POST /targets', 'PUT /targets/:id', 'DELETE /targets/:id']);

  const created = value.routes.get('POST /targets')({ body: target });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { ok: true, target });
  assert.deepEqual(value.values.get('targets'), [target]);
  assert.deepEqual(value.routes.get('GET /targets')({}), { ok: true, targets: [target] });

  const updatedTarget = { ...target, name: 'TaskMaster', baseUrl: 'https://aap.example.test', enabled: false };
  assert.deepEqual(value.routes.get('PUT /targets/:id')({ params: { id: target.id }, body: updatedTarget }), { ok: true, target: updatedTarget });
  assert.deepEqual(value.routes.get('DELETE /targets/:id')({ params: { id: target.id } }), { ok: true });
  assert.deepEqual(value.routes.get('GET /targets')({}), { ok: true, targets: [] });
});

test('validates target identity and URL without adding credentials or health state', async () => {
  const value = await readyHarness();
  assert.throws(() => value.routes.get('POST /targets')({ body: { ...target, id: 'local' } }), /target_id_invalid/);
  assert.throws(() => value.routes.get('POST /targets')({ body: { ...target, name: '' } }), /target_name_required/);
  assert.throws(() => value.routes.get('POST /targets')({ body: { ...target, baseUrl: 'file:///tmp/nope' } }), /target_base_url_invalid/);
  assert.throws(() => value.routes.get('POST /targets')({ body: { ...target, baseUrl: 'https://user:pass@node.test' } }), /target_base_url_invalid/);

  value.routes.get('POST /targets')({ body: target });
  assert.throws(() => value.routes.get('POST /targets')({ body: target }), /api_target_exists/);
  assert.throws(() => value.routes.get('PUT /targets/:id')({ params: { id: target.id }, body: { ...target, id: 'other' } }), /target_id_immutable/);
  assert.equal(JSON.stringify(value.values.get('targets')).includes('credential'), false);
  assert.equal(JSON.stringify(value.values.get('targets')).includes('status'), false);
});
