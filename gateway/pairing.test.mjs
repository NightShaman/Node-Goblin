import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { controllerIdentity, loadNodeIdentity, pairingCode, signPairing, verifyPairing } from './lib/pairing.mjs';

test('Node Goblin identity is durable and pairing transcript verifies with a shared code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-'));
  try {
    const node = loadNodeIdentity(dir); const repeated = loadNodeIdentity(dir); const controller = controllerIdentity(); const nonce = 'nonce-0123456789abcdef';
    assert.equal(node.publicKey, repeated.publicKey);
    const signature = signPairing(node, nonce, 'goblin-1', controller.publicKey);
    assert.equal(verifyPairing({ nonce, gatewayId: 'goblin-1', gatewayPublicKey: node.publicKey, controllerPublicKey: controller.publicKey, signature }), true);
    assert.match(pairingCode({ nonce, gatewayId: 'goblin-1', gatewayPublicKey: node.publicKey, controllerPublicKey: controller.publicKey }), /^[0-9A-F]{4}(-[0-9A-F]{4}){2}$/);
    assert.equal(fs.statSync(path.join(dir, 'node-identity.json')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
