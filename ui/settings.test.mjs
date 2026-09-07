import assert from 'node:assert/strict';
import test from 'node:test';
import { formatGatewayTimestamp } from './settings.js';

test('formats gateway timestamps in the browser locale while preserving missing values', () => {
  const raw = '2026-09-05T04:47:55.495Z';
  const expected = new Date(raw).toLocaleString();
  assert.equal(formatGatewayTimestamp(raw), expected);
  assert.equal(formatGatewayTimestamp(), '—');
});

test('falls back to the raw value when a gateway timestamp is invalid', () => {
  assert.equal(formatGatewayTimestamp('not-a-date'), 'not-a-date');
});

test('gateways contribute only revoke cards and assignments use the form-inventory contract', async () => {
  const { createSettingsContribution, handleSettingsAction } = await import('./settings.js');
  const contribution = await createSettingsContribution({ agents: [{ id: 'smatchet', name: 'Smatchet', executionEnvironment: { kind: 'local', workspaceRoot: '/workspace' } }], api: async path => path === '/gateway-trust' ? { gateways: [{ gatewayId: 'Hatchet', controllerId: 'control-a', approved: true }] } : {} });
  const section = contribution.sections.find(section => section.id === 'gateways');
  assert.equal(section.layout, 'form-inventory');
  assert.equal(section.actions[0].label, 'Enroll or rotate gateway');
  assert.equal(section.items[0].fields, undefined);
  assert.deepEqual(section.items[0].actions.map(action => action.label), ['Revoke']);
  const assignments = contribution.sections.find(section => section.id === 'assignments');
  assert.equal(assignments.layout, 'form-inventory');
  assert.equal(assignments.items[0].fields[0].control, 'select');
  assert.equal(section.items[0].metadata[0].label, 'Implementation');
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
  try {
    await handleSettingsAction('enroll-gateway', { 'enroll-gateway-id': 'Hatchet', 'enroll-controller-id': 'control-a', 'enroll-secret': 'test-only' });
    assert.equal(calls[0].url, '/api/mods/node-goblin/gateway-trust/Hatchet');
    assert.deepEqual(JSON.parse(calls[0].options.body), { controllerId: 'control-a', secret: 'test-only' });
  } finally { globalThis.fetch = original; }
});
