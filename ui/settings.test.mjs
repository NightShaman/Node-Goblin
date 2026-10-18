import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsContribution, formatGatewayTimestamp, handleSettingsAction } from './settings.js';

let testAccessApi;
function settingsContext(gateways) {
  return {
    accessApi: testAccessApi,
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


const accessPath = '/api/operator/mods/node-goblin/access';
function accessRecord(overrides = {}) {
  return { ok: true, modId: 'node-goblin', declaredCapabilities: ['execution-provider-v1'], grants: [], adminAgentIds: ['operator-agent'], diagnosticAgentIds: ['diagnostic-agent'], ...overrides };
}
async function withFetch(stub, run) {
  const previous = testAccessApi;
  let setup = true;
  testAccessApi = async options => {
    if (setup) return accessRecord();
    const response = await stub(accessPath, options);
    if (!response.ok) throw Object.assign(new Error('operator request failed'), { status: response.status });
    return response.json ? response.json() : {};
  };
  await createSettingsContribution(settingsContext([]));
  setup = false;
  try { await run(); } finally { testAccessApi = previous; }
}
test('missing approval is visible and loading settings never grants or reactivates', async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => accessRecord() };
  }, async () => {
    const contribution = await createSettingsContribution(settingsContext([]));
    const section = contribution.sections.find(section => section.id === 'core-access');
    assert.match(section.description, /approval is missing/);
    assert.match(section.description, /disable then enable/);
    assert.match(section.description, /Enable alone does not reload/);
    assert.equal(section.actions[0].id, 'approve-core-execution');
    assert.match(section.actions[0].confirm, /Grant Node Goblin execution-provider-v1/);
    assert.deepEqual(calls, [{ url: accessPath, options: undefined }]);
  });
});
test('explicit approval reads fresh policy, preserves unrelated fields and only writes the grant', async () => {
  const calls = [];
  const current = accessRecord({ grants: ['mod-management-v1'], declaredCapabilities: ['execution-provider-v1', 'mod-management-v1'] });
  await withFetch(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => current };
  }, async () => {
    assert.deepEqual(await handleSettingsAction('approve-core-execution', {}), { restartRequired: true });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, accessPath);
    assert.equal(calls[0].options, undefined);
    assert.equal(calls[1].url, accessPath);
    assert.equal(calls[1].options.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[1].options.body), {
      grants: ['mod-management-v1', 'execution-provider-v1'],
      adminAgentIds: ['operator-agent'], diagnosticAgentIds: ['diagnostic-agent'],
    });
  });
});
test('saved approval is distinct from active registration and repeated approval does not write', async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => accessRecord({ grants: ['execution-provider-v1'] }) };
  }, async () => {
    const section = (await createSettingsContribution(settingsContext([]))).sections.find(section => section.id === 'core-access');
    assert.match(section.description, /approval is saved/);
    assert.match(section.description, /connection alone does not prove/);
    assert.deepEqual(section.actions, []);
    await handleSettingsAction('approve-core-execution', {});
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.options === undefined));
  });
});
test('operator auth rejection leaves normal settings usable and offers no grant action', async () => {
  await withFetch(async () => ({ ok: false, status: 403 }), async () => {
    const sections = (await createSettingsContribution(settingsContext([]))).sections;
    const section = sections.find(section => section.id === 'core-access');
    assert.match(section.description, /Sign in with operator authentication/);
    assert.deepEqual(section.actions, []);
    assert.ok(sections.find(section => section.id === 'controller'));
    await assert.rejects(handleSettingsAction('approve-core-execution', {}), /operator authentication/);
  });
});
test('invalid or undeclared access records never trigger a policy replacement', async () => {
  for (const record of [accessRecord({ modId: 'other-mod' }), accessRecord({ adminAgentIds: null }), accessRecord({ declaredCapabilities: [] })]) {
    const calls = [];
    await withFetch(async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => record }; }, async () => {
      await assert.rejects(handleSettingsAction('approve-core-execution', {}));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].options, undefined);
    });
  }
});
test('failed approval is surfaced and does not restart or change lifecycle', async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({ url, options });
    return options ? { ok: false, status: 403 } : { ok: true, json: async () => accessRecord() };
  }, async () => {
    await assert.rejects(handleSettingsAction('approve-core-execution', {}), /operator authentication/);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.url === accessPath));
  });
});
test('older hosts without accessApi show an upgrade message and cannot approve', async () => {
  const previous = testAccessApi;
  testAccessApi = undefined;
  try {
    const section = (await createSettingsContribution(settingsContext([]))).sections.find(section => section.id === 'core-access');
    assert.match(section.description, /Update the UI/);
    assert.deepEqual(section.actions, []);
    await assert.rejects(handleSettingsAction('approve-core-execution', {}), /Update the UI/);
  } finally { testAccessApi = previous; }
});
