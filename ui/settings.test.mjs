import assert from 'node:assert/strict';
import test from 'node:test';
import { createSettingsContribution, formatGatewayTimestamp, handleSettingsAction } from './settings.js';

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
