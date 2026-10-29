import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsContribution, formatGatewayTimestamp, handleSettingsAction, settingsContribution, settingsSections } from './settings.js';

function settingsContext(gateways) {
  return {
    agents: [{ id: 'smatchet', name: 'Smatchet', executionEnvironment: { kind: 'local', workspaceRoot: '/workspace' } }],
    api: async path => path === '/gateway-trust' ? { gateways } : {},
  };
}

test('formats gateway timestamps in the browser locale while preserving missing values', () => {
  const raw = '2026-09-05T04:47:55.495Z';
  const expected = new Date(raw).toLocaleString();
  assert.equal(formatGatewayTimestamp(raw), expected);
  assert.equal(formatGatewayTimestamp(), '—');
});

test('falls back to the raw value when a gateway timestamp is invalid', () => {
  assert.equal(formatGatewayTimestamp('not-a-date'), 'not-a-date');
});

test('legacy HMAC gateways expose clearly labelled credential forms and assignments use the form-inventory contract', async () => {
  const contribution = await createSettingsContribution(settingsContext([{ gatewayId: 'Hatchet', controllerId: 'control-a', approved: true, method: 'hmac' }]));
  const section = contribution.sections.find(section => section.id === 'gateways');
  assert.equal(section.layout, 'form-inventory');
  assert.equal(section.actions[0].label, 'Enroll legacy HMAC gateway');
  assert.equal(section.fields[2].label, 'Legacy HMAC enrollment secret');
  assert.match(section.description, /legacy HMAC/i);
  assert.equal(section.items[0].fields[0].value, 'control-a');
  assert.equal(section.items[0].fields[1].label, 'New legacy HMAC secret');
  assert.deepEqual(section.items[0].actions.map(action => action.label), ['Save legacy HMAC secret', 'Revoke']);
  assert.deepEqual(section.items[0].metadata[0], { label: 'Credential method', value: 'Legacy HMAC' });
  const assignments = contribution.sections.find(section => section.id === 'assignments');
  assert.equal(assignments.layout, 'form-inventory');
  assert.equal(assignments.items[0].fields[0].control, 'select');
  assert.equal(section.items[0].metadata[1].label, 'Implementation');

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
  try {
    await handleSettingsAction('rotate-gateway:Hatchet', { 'rotate-controller:Hatchet': 'control-a', 'rotate-secret:Hatchet': 'test-only' });
    assert.equal(calls[0].url, '/api/mods/node-goblin/gateway-trust/Hatchet');
    assert.deepEqual(JSON.parse(calls[0].options.body), { controllerId: 'control-a', secret: 'test-only' });
  } finally { globalThis.fetch = original; }
});

test('Ed25519 gateways identify their method without exposing shared-secret replacement', async () => {
  const contribution = await createSettingsContribution(settingsContext([{ gatewayId: 'KeyGoblin', controllerId: 'controller', approved: true, method: 'ed25519' }]));
  const gateway = contribution.sections.find(section => section.id === 'gateways').items[0];
  assert.match(gateway.description, /Ed25519 key-paired/);
  assert.match(gateway.meta, /Ed25519/);
  assert.deepEqual(gateway.metadata[0], { label: 'Credential method', value: 'Ed25519' });
  assert.equal('fields' in gateway, false);
  assert.equal('editLabel' in gateway, false);
  assert.deepEqual(gateway.actions.map(action => action.label), ['Revoke']);
});

test('method-specific Ed25519 conflict is displayed as a clean credential explanation', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ error: { code: 'gateway_credential_method_ed25519' } }),
  });
  try {
    await assert.rejects(
      handleSettingsAction('rotate-gateway:KeyGoblin', { 'rotate-controller:KeyGoblin': 'controller', 'rotate-secret:KeyGoblin': 'test-only' }),
      error => error.message === 'This gateway uses Ed25519 key pairing. Legacy HMAC shared-secret replacement is not available.',
    );
  } finally { globalThis.fetch = original; }
});


test('settings omit operation activity and refresh only controller configuration data', async () => {
  const expectedIds = ['controller', 'pairings', 'gateways', 'assignments'];
  assert.deepEqual(settingsSections.map(section => section.id), expectedIds);
  assert.deepEqual(settingsContribution.sections.map(section => section.id), expectedIds);
  const calls = [];
  const context = {
    ...settingsContext([]),
    api: async path => {
      calls.push(path);
      assert.ok(['/controller', '/pairings?limit=50', '/gateway-trust', '/gateways'].includes(path), `Unexpected settings request: ${path}`);
      return {};
    },
  };
  for (let refresh = 0; refresh < 2; refresh++) {
    const contribution = await createSettingsContribution(context);
    assert.deepEqual(contribution.sections.map(section => section.id), expectedIds);
    assert.equal(contribution.sections.some(section => section.layout === 'activity'), false);
  }
  assert.deepEqual(calls, Array(2).fill(['/controller', '/pairings?limit=50', '/gateway-trust', '/gateways']).flat());
});

test('controller listener and TLS fields, status, and actions remain available', async () => {
  const contribution = await createSettingsContribution({
    api: async path => path === '/controller' ? {
      controller: {
        enabled: true, host: '0.0.0.0', port: 8443, running: true, error: 'restart pending',
        tls: { keyConfigured: true, certConfigured: true, caConfigured: false },
      },
    } : {},
  });
  const controller = contribution.sections.find(section => section.id === 'controller');
  assert.equal(controller.layout, 'form');
  assert.deepEqual(controller.fields.map(({ id, control, value }) => ({ id, control, value })), [
    { id: 'enabled', control: 'boolean', value: 'true' },
    { id: 'bind-host', control: 'text', value: '0.0.0.0' },
    { id: 'bind-port', control: 'number', value: '8443' },
    { id: 'tls-key', control: 'password', value: undefined },
    { id: 'tls-cert', control: 'password', value: undefined },
    { id: 'tls-ca', control: 'password', value: undefined },
  ]);
  assert.match(controller.fields[3].description, /^Configured;/);
  assert.match(controller.fields[4].description, /^Configured;/);
  assert.match(controller.fields[5].description, /^Not configured;/);
  assert.match(controller.description, /running at 0\.0\.0\.0:8443 · restart pending/);
  assert.deepEqual(controller.actions.map(action => action.id), ['save-controller', 'save-tls', 'clear-tls']);
  assert.ok(controller.actions.every(action => action.confirm));

  const defaults = (await createSettingsContribution(settingsContext([]))).sections.find(section => section.id === 'controller');
  assert.deepEqual(defaults.fields.slice(0, 3).map(field => field.value), ['false', '127.0.0.1', '7443']);
});

test('controller and TLS save/clear actions preserve their request contracts and validation', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
  try {
    await handleSettingsAction('save-controller', { enabled: true, 'bind-host': ' 0.0.0.0 ', 'bind-port': '8443' });
    await handleSettingsAction('save-controller', { enabled: false, 'bind-port': '7443' });
    await handleSettingsAction('save-tls', { 'tls-key': ' test-key ', 'tls-cert': ' test-cert ', 'tls-ca': ' test-ca ' });
    await handleSettingsAction('save-tls', { 'tls-key': 'test-key', 'tls-cert': 'test-cert' });
    await handleSettingsAction('clear-tls', {});
    assert.deepEqual(calls.map(({ url, options }) => ({ url, method: options.method, body: options.body && JSON.parse(options.body) })), [
      { url: '/api/mods/node-goblin/controller', method: 'PUT', body: { enabled: true, host: '0.0.0.0', port: 8443 } },
      { url: '/api/mods/node-goblin/controller', method: 'PUT', body: { enabled: false, host: '127.0.0.1', port: 7443 } },
      { url: '/api/mods/node-goblin/controller/tls', method: 'PUT', body: { key: 'test-key', cert: 'test-cert', ca: 'test-ca' } },
      { url: '/api/mods/node-goblin/controller/tls', method: 'PUT', body: { key: 'test-key', cert: 'test-cert' } },
      { url: '/api/mods/node-goblin/controller/tls', method: 'DELETE', body: undefined },
    ]);
    assert.ok(calls.slice(0, 4).every(({ options }) => options.headers['content-type'] === 'application/json'));
    await assert.rejects(handleSettingsAction('save-controller', { 'bind-port': '65536' }), /valid bind host and port/);
    await assert.rejects(handleSettingsAction('save-tls', { 'tls-key': 'test-key' }), /private key and certificate are required/);
    assert.equal(calls.length, 5, 'invalid values do not send a request');
  } finally { globalThis.fetch = original; }
});
