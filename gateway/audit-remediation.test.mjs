import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { boundedPending, controllerIdentity, MAX_PENDING_PAIRINGS, pairingCode, signPairing, verifyPairing } from './lib/pairing.mjs';
import { GatewayControllerListener } from './lib/controller-listener.mjs';
import { OutboundGatewayTransport } from './lib/network-transport.mjs';
import { OperationJournal } from './lib/journal.mjs';

const raw = Buffer.from('locally observed controller DER');
const fingerprint = crypto.createHash('sha256').update(raw).digest('hex');
class Socket extends EventEmitter {
  writable = true; destroyed = false; writes = [];
  setEncoding() {}
  getCertificate() { return { raw }; }
  getPeerCertificate() { return { raw }; }
  write(data) { this.writes.push(JSON.parse(data)); return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } }
}
function fixture(options = {}) {
  const listener = new GatewayControllerListener({ ...options, tlsServer: () => Object.assign(new EventEmitter(), { close(callback) { callback?.(); } }) });
  const socket = new Socket(); const connection = listener.onSocket(socket);
  return { listener, socket, connection };
}
function response(f, node, id = 'new-node', tlsFingerprint = fingerprint) {
  return { type: 'auth.response', channelBinding: 'tls-cert-sha256', gatewayId: id, controllerId: 'controller', nodePublicKey: node.publicKey,
    pairingSignature: signPairing(node, f.connection.nonce, id, f.listener.pairingIdentity.publicKey, tlsFingerprint) };
}

test('TLS transcript changes both signature and comparison code; relay cert substitution fails', async () => {
  const node = controllerIdentity(); const f = fixture();
  try {
    const message = response(f, node);
    const transcript = { nonce: f.connection.nonce, gatewayId: 'new-node', gatewayPublicKey: node.publicKey, controllerPublicKey: f.listener.pairingIdentity.publicKey, signature: message.pairingSignature, tlsFingerprint: fingerprint };
    assert.equal(verifyPairing(transcript), true);
    assert.equal(verifyPairing({ ...transcript, tlsFingerprint: 'a'.repeat(64) }), false);
    assert.notEqual(pairingCode(transcript), pairingCode({ ...transcript, tlsFingerprint: 'a'.repeat(64) }));
    f.connection.onAuthMessage(response(f, node, 'new-node', 'a'.repeat(64)));
    assert.equal(f.socket.destroyed, true); assert.equal(f.listener.pending.size, 0);
  } finally { await f.listener.close(); }
});

test('new registrations cannot downgrade, while explicitly preexisting approved identities retain v1', async () => {
  const node = controllerIdentity();
  for (const existing of [false, true]) {
    const f = fixture({ gateways: existing ? [{ gatewayId: 'new-node', controllerId: 'controller', publicKey: node.publicKey }] : [] });
    try {
      const message = response(f, node); delete message.channelBinding;
      message.pairingSignature = signPairing(node, f.connection.nonce, 'new-node', f.listener.pairingIdentity.publicKey);
      f.connection.onAuthMessage(message);
      assert.equal(f.connection.state, existing ? 'ready' : 'closed');
    } finally { await f.listener.close(); }
  }
  const f = fixture({ gateways: [{ gatewayId: 'new-node', controllerId: 'controller', publicKey: node.publicKey, channelBinding: true }] });
  try { const message = response(f, node); delete message.channelBinding; f.connection.onAuthMessage(message); assert.equal(f.socket.writes.at(-1).error.code, 'channel_binding_required'); }
  finally { await f.listener.close(); }
});

test('pending collections reject invalid/oversized identities and keys and cap durable restore and admission', async () => {
  const node = controllerIdentity();
  const records = Array.from({ length: MAX_PENDING_PAIRINGS + 20 }, (_, i) => ({ gatewayId: `node-${i}`, controllerId: 'controller', publicKey: node.publicKey, status: 'pending', extra: 'not retained' }));
  records.push({ ...records[0], gatewayId: '../bad' }, { ...records[0], gatewayId: 'x'.repeat(256) }, { ...records[0], publicKey: 'x'.repeat(1025) });
  const restored = boundedPending(records);
  assert.equal(restored.length, MAX_PENDING_PAIRINGS); assert.equal(restored[0].extra, undefined);
  const f = fixture({ pairings: records });
  try {
    f.connection.onAuthMessage(response(f, node));
    assert.equal(f.socket.writes.at(-1).error.code, 'pending_pairings_full');
    assert.equal(f.listener.pending.size, MAX_PENDING_PAIRINGS); assert.equal(f.listener.connections.size, 0);
  } finally { await f.listener.close(); }
  for (const id of ['../bad', 'x'.repeat(256), 'local']) {
    const f = fixture(); try { f.connection.onAuthMessage(response(f, node, id)); assert.equal(f.listener.pending.size, 0); assert.equal(f.socket.destroyed, true); } finally { await f.listener.close(); }
  }
});

test('new outbound pairing rejects stripped channel binding, including CA bootstrap', async () => {
  for (const ca of [undefined, 'explicit CA']) {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-downgrade-')); const socket = new Socket();
    const transport = new OutboundGatewayTransport({ host: 'controller.test', port: 7443, stateDir, ca, tlsConnect: () => socket }).start();
    try {
      socket.emit('secureConnect');
      socket.emit('data', `${JSON.stringify({ type: 'auth.challenge', nonce: '0123456789abcdef', controllerPublicKey: controllerIdentity().publicKey })}\n`);
      assert.equal(socket.destroyed, true); assert.equal(transport.authenticated, false);
    } finally { await transport.stop(); fs.rmSync(stateDir, { recursive: true, force: true }); }
  }
});

test('journal creates restrictive atomic replacements even with permissive umask and predictable symlink trap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-journal-')); const old = process.umask(0);
  try {
    const filePath = path.join(dir, 'state', 'operations.json'); fs.mkdirSync(path.dirname(filePath));
    const victim = path.join(dir, 'victim'); fs.writeFileSync(victim, 'untouched'); fs.symlinkSync(victim, `${filePath}.tmp-${process.pid}`);
    const journal = new OperationJournal({ filePath }); journal.put('op', 'digest', { output: 'sensitive' });
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600); assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
    journal.put('two', 'digest', {}); assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.equal(new OperationJournal({ filePath }).get('op').output, 'sensitive');
  } finally { process.umask(old); fs.rmSync(dir, { recursive: true, force: true }); }
});
