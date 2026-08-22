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

test('stores and exposes only API target records', async () => {
  const value = await readyHarness();
  const created = value.routes.get('POST /targets')({ body: target });
  assert.deepEqual(created, { status: 201, body: { ok: true, target } });
  assert.deepEqual(value.values.get('targets'), [target]);
  assert.deepEqual(value.routes.get('GET /targets')({}), { ok: true, targets: [target] });

  const updatedTarget = { ...target, name: 'TaskMaster', baseUrl: 'https://aap.example.test', enabled: false };
  assert.deepEqual(value.routes.get('PUT /targets/:id')({ params: { id: target.id }, body: updatedTarget }), { ok: true, target: updatedTarget });
  assert.deepEqual(value.values.get('targets'), [updatedTarget]);

  assert.deepEqual(value.routes.get('DELETE /targets/:id')({ params: { id: target.id } }), { ok: true });
  assert.deepEqual(value.routes.get('GET /targets')({}), { ok: true, targets: [] });
});

test('validates IDs, names, and direct http or https API URLs', async () => {
  const value = await readyHarness();
  const create = value.routes.get('POST /targets');
  assert.throws(() => create({ body: { ...target, id: 'local' } }), /target_id_invalid/);
  assert.throws(() => create({ body: { ...target, id: 'bad id' } }), /target_id_invalid/);
  assert.throws(() => create({ body: { ...target, name: '' } }), /name_required/);
  assert.throws(() => create({ body: { ...target, baseUrl: 'file:\/\/\/tmp/nope' } }), /base_url_invalid/);
  assert.throws(() => create({ body: { ...target, baseUrl: 'https://user:pass@node.test' } }), /base_url_invalid/);
});

test('rejects duplicate IDs, ID mutation, and unknown records', async () => {
  const value = await readyHarness();
  value.routes.get('POST /targets')({ body: target });
  assert.throws(() => value.routes.get('POST /targets')({ body: target }), /api_target_exists/);
  assert.throws(() => value.routes.get('PUT /targets/:id')({ params: { id: target.id }, body: { ...target, id: 'other' } }), /target_id_immutable/);
  assert.throws(() => value.routes.get('DELETE /targets/:id')({ params: { id: 'missing' } }), /api_target_not_found/);
});

test('drops malformed legacy values instead of publishing unsafe targets', async () => {
  const value = await readyHarness();
  value.values.set('targets', [target, { id: 'bad id', name: 'Bad', baseUrl: 'javascript:alert(1)', enabled: true }]);
  assert.deepEqual(value.routes.get('GET /targets')({}), { ok: true, targets: [target] });
});
