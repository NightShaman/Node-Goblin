import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { activate } from './index.mjs';

function harness() {
  const routes = new Map();
  const api = {};
  for (const method of ['get', 'post', 'put', 'delete']) api[method] = (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler);
  const values = new Map();
  const secretValues = new Map();
  const settings = { get: (name, fallback = null) => values.has(name) ? structuredClone(values.get(name)) : fallback, set: (name, value) => (values.set(name, structuredClone(value)), value), delete: (name) => values.delete(name) };
  const secrets = { get: (name) => secretValues.get(name) ?? null, set: (name, value) => (secretValues.set(name, String(value)), true), clear: (name) => secretValues.delete(name), has: (name) => secretValues.has(name) };
  return { routes, api, settings, secrets, values, secretValues };
}

async function readyHarness() {
  const value = harness();
  await activate(value);
  return value;
}

async function createNode(value, body = {}) {
  return value.routes.get('POST /nodes')({ body: { name: 'AAP Host', baseUrl: 'http://127.0.0.1:42817', enabled: true, credential: 'secret-token', ...body } }).body.node;
}

test('stores node configuration separately from encrypted credential API', async () => {
  const value = await readyHarness();
  const created = await createNode(value);
  assert.equal(created.credentialConfigured, true);
  assert.equal(created.status, 'unknown');
  assert.equal(value.values.get('nodes')[0].credential, undefined);
  assert.equal(value.secretValues.get(`node:${created.id}:credential`), 'secret-token');

  const listed = value.routes.get('GET /nodes')({});
  assert.deepEqual(listed.nodes, [created]);

  const updated = value.routes.get('PUT /nodes/:id')({ params: { id: created.id }, body: { name: 'TaskMaster', baseUrl: 'https://aap.example.test', enabled: false } });
  assert.equal(updated.node.name, 'TaskMaster');
  assert.equal(updated.node.credentialConfigured, true);

  const cleared = value.routes.get('PUT /nodes/:id')({ params: { id: created.id }, body: { name: 'TaskMaster', baseUrl: 'https://aap.example.test', enabled: true, credential: '' } });
  assert.equal(cleared.node.credentialConfigured, false);

  assert.deepEqual(value.routes.get('DELETE /nodes/:id')({ params: { id: created.id } }), { ok: true });
  assert.deepEqual(value.routes.get('GET /nodes')({}).nodes, []);
});

test('validates remote node names and URLs', async () => {
  const value = await readyHarness();
  assert.throws(() => value.routes.get('POST /nodes')({ body: { name: '', baseUrl: 'https://node.test' } }), /name_required/);
  assert.throws(() => value.routes.get('POST /nodes')({ body: { name: 'Node', baseUrl: 'file:\/\/\/tmp/nope' } }), /base_url_invalid/);
  assert.throws(() => value.routes.get('POST /nodes')({ body: { name: 'Node', baseUrl: 'https://user:pass@node.test' } }), /base_url_invalid/);
});

test('checks a Burrow health endpoint and persists observed status', async (t) => {
  let authorization = null;
  const server = createServer((req, res) => {
    authorization = req.headers.authorization || null;
    res.writeHead(200, { 'content-type': 'application/json', 'x-burrow-version': '0.1.0' });
    res.end(JSON.stringify({ ok: true, runtime: 'burrow' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const value = await readyHarness();
  const address = server.address();
  const created = await createNode(value, { baseUrl: `http://127.0.0.1:${address.port}`, credential: 'Bearer node-token' });
  const checked = await value.routes.get('POST /nodes/:id/check')({ params: { id: created.id } });
  assert.equal(authorization, 'Bearer node-token');
  assert.equal(checked.node.status, 'online');
  assert.equal(checked.node.version, '0.1.0');
  assert.ok(checked.node.lastCheckedAt);
  assert.equal(checked.node.lastCheckedAt, checked.node.lastSeenAt);
  assert.equal(value.values.get('nodes')[0].status, 'online');
});

test('records check failures without exposing credentials', async () => {
  const value = await readyHarness();
  const created = await createNode(value, { baseUrl: 'http://127.0.0.1:1' });
  const checked = await value.routes.get('POST /nodes/:id/check')({ params: { id: created.id } });
  assert.equal(checked.node.status, 'offline');
  assert.ok(checked.node.error);
  assert.equal(JSON.stringify(checked).includes('secret-token'), false);
});
