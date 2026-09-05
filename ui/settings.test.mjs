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
