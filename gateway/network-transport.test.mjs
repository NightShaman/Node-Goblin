import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authenticationProof, enrollController, enrollmentConsumedPath, markEnrollmentConsumed, OutboundGatewayTransport, pairingCodePath, readControllerTrust, writePairingCode } from './lib/network-transport.mjs';
import { controllerIdentity } from './lib/pairing.mjs';
import { MAX_FRAME_BYTES } from './lib/output-frame.mjs';

class FakeSocket extends EventEmitter {
  constructor() { super(); this.writes = []; this.destroyed = false; this.writable = true; }
  setEncoding() {}
  write(value) { this.writes.push(String(value)); return true; }
  feed(message) { this.emit('data', typeof message === 'string' ? message : `${JSON.stringify(message)}\n`); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.emit('close');
  }
  messages() { return this.writes.join('').split('\n').filter(Boolean).map(JSON.parse); }
}

const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test_condition_timeout');
    await delay(10);
  }
}

function fixture(options = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-network-'));
  const sockets = [];
  const transport = new OutboundGatewayTransport({
    host: 'controller.test', port: 7443, gatewayId: 'gateway-1', stateDir,
    enrollmentToken: 'one-time-secret', reconnectMinMs: 10, reconnectMaxMs: 10,
    tlsConnect: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    ...options,
  }).start();
  return { transport, sockets, stateDir };
}

function authenticate(socket, nonce = '0123456789abcdef') {
  socket.feed({ type: 'auth.challenge', nonce });
  socket.feed({ type: 'auth.ok' });
}

test('one-time enrollment persists private trust and cannot be replaced by a later token', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-enroll-'));
  const first = enrollController({ stateDir, token: 'first-secret', controllerId: 'primary' });
  const second = enrollController({ stateDir, token: 'attacker-secret', controllerId: 'other' });
  assert.equal(first.secret, 'first-secret');
  assert.deepEqual(second, readControllerTrust(stateDir));
  assert.equal(second.controllerId, 'primary');
  assert.equal(fs.statSync(path.join(stateDir, 'controller-trust.json')).mode & 0o777, 0o600);
});

test('consumed bootstrap enrollment cannot recreate trust after unpair', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-enroll-consumed-'));
  try {
    markEnrollmentConsumed(stateDir);
    assert.equal(enrollController({ stateDir, token: 'must-not-reappear' }), null);
    assert.equal(fs.existsSync(path.join(stateDir, 'controller-trust.json')), false);
    assert.equal(fs.existsSync(enrollmentConsumedPath(stateDir)), true);
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('pairing code is written as protected local state for operator display', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-pairing-code-'));
  try {
    writePairingCode(stateDir, { gatewayId: 'gateway-1', pairingCode: 'ABCD-1234-5678' });
    const file = pairingCodePath(stateDir);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).pairingCode, 'ABCD-1234-5678');
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('controller challenge authenticates with a bound HMAC proof', () => {
  const { transport, sockets } = fixture();
  try {
    const nonce = '0123456789abcdef';
    sockets[0].feed({ type: 'auth.challenge', nonce });
    const response = sockets[0].messages()[0];
    assert.deepEqual(response, {
      type: 'auth.response', gatewayId: 'gateway-1', controllerId: 'controller',
      proof: authenticationProof('one-time-secret', 'gateway-1', nonce),
      gateway: { name: 'burrow-host-gateway', version: readFileSync(new URL('./VERSION', import.meta.url), 'utf8').trim(), protocolVersion: '1.0' },
    });
    assert.notEqual(response.proof, authenticationProof('wrong', 'gateway-1', nonce));
  } finally { transport.stop(); }
});

test('unauthenticated and malformed requests cannot reach daemon', async () => {
  const { transport, sockets } = fixture();
  try {
    sockets[0].feed({ type: 'auth.ok' });
    sockets[0].feed({ id: 'no', method: 'process.exec', params: { executable: process.execPath } });
    sockets[0].feed('{broken\n');
    await delay();
    const messages = sockets[0].messages();
    assert.equal(messages[0].error.code, 'unauthenticated');
    assert.equal(messages[1].error.code, 'unauthenticated');
    assert.equal(messages[2].error.code, 'invalid_json');
    assert.equal(transport.daemon.controllers.size, 0);
  } finally { transport.stop(); }
});

test('authenticated execution correlates accepted, terminal evidence, and response', async () => {
  const { transport, sockets } = fixture();
  try {
    authenticate(sockets[0]);
    sockets[0].feed({ id: 'run', method: 'process.exec', params: { operationId: 'evidence-op', executable: process.execPath, args: ['-e', "process.stdout.write('evidence')"] } });
    await waitFor(() => sockets[0].messages().some((m) => m.requestId === 'run' && m.type === 'response'));
    const messages = sockets[0].messages();
    const accepted = messages.find((m) => m.type === 'accepted');
    const terminal = messages.find((m) => m.type === 'process.terminal');
    const response = messages.find((m) => m.requestId === 'run' && m.type === 'response');
    assert.equal(accepted.operationId, 'evidence-op');
    assert.equal(terminal.operationId, accepted.operationId);
    assert.equal(terminal.evidence.stdout, 'evidence');
    assert.equal(response.result.operationId, accepted.operationId);
  } finally { transport.stop(); }
});

test('disconnect keeps the daemon alive while waiting to reconnect', () => {
  const { transport, sockets } = fixture({ reconnectMinMs: 10000, reconnectMaxMs: 10000 });
  try {
    sockets[0].destroy();
    assert.equal(transport.timer?.hasRef?.(), true);
  } finally { transport.stop(); }
});

test('TLS ServerName defaults to hostnames and is omitted for IP controllers', () => {
  const hostname = fixture();
  const ip = fixture({ host: '10.10.20.110' });
  try {
    assert.equal(hostname.transport.tlsOptions.servername, 'controller.test');
    assert.equal(Object.hasOwn(ip.transport.tlsOptions, 'servername'), false);
  } finally { hostname.transport.stop(); ip.transport.stop(); }
});

test('in-flight output remains owned by the disconnected authenticated connection', async () => {
  const { transport, sockets } = fixture();
  try {
    authenticate(sockets[0]);
    sockets[0].feed({ id: 'old-request', method: 'process.exec', params: {
      operationId: 'continuing-op', executable: process.execPath,
      args: ['-e', "setTimeout(() => process.stdout.write('late-output'), 80)"],
    } });
    await waitFor(() => sockets[0].messages().some((message) => message.type === 'accepted'));
    sockets[0].destroy();
    await waitFor(() => sockets.length === 2);
    await delay(150);
    assert.equal(transport.authenticated, false);
    assert.deepEqual(sockets[1].messages(), []);
    authenticate(sockets[1], 'fedcba9876543210');
    await delay(30);
    assert.equal(sockets[1].messages().some((message) => message.requestId === 'old-request' || message.operationId === 'continuing-op'), false);
    sockets[1].feed({ id: 'replay', method: 'process.exec', params: {
      operationId: 'continuing-op', executable: process.execPath,
      args: ['-e', "setTimeout(() => process.stdout.write('late-output'), 80)"],
    } });
    await waitFor(() => sockets[1].messages().some((message) => message.requestId === 'replay'));
    const replay = sockets[1].messages().find((message) => message.requestId === 'replay');
    assert.equal(replay.result.replay, true);
    assert.equal(replay.result.outcome.stdout, 'late-output');
  } finally { transport.stop(); }
});

test('outbound framing budgets each UTF-8 frame rather than a coalesced character buffer', () => {
  const daemon = { identity: {}, secureTransportContext: null, stop() {}, handleLine(line) { this.lines ??= []; this.lines.push(line); } };
  const accepted = fixture({ daemon });
  const rejected = fixture({ daemon: { identity: {}, secureTransportContext: null, stop() {}, handleLine() {} } });
  try {
    authenticate(accepted.sockets[0]);
    const small = `${JSON.stringify({ id: 'small', method: 'health', value: 'x'.repeat(600_000) })}\n`;
    accepted.sockets[0].feed(small + small);
    assert.equal(accepted.sockets[0].destroyed, false);
    assert.equal(daemon.lines.length, 2);
    rejected.sockets[0].feed('😀'.repeat(Math.ceil(MAX_FRAME_BYTES / 4)));
    assert.equal(rejected.sockets[0].messages().at(-1).error.code, 'frame_too_large');
    assert.equal(rejected.sockets[0].destroyed, true);
  } finally { accepted.transport.stop(); rejected.transport.stop(); }
});

test('outbound authentication deadline closes stalled connections', async () => {
  const { transport, sockets } = fixture({ handshakeTimeoutMs: 20, reconnectMinMs: 10000, reconnectMaxMs: 10000 });
  try {
    await waitFor(() => sockets[0].destroyed);
    assert.equal(sockets[0].messages().at(-1).error.code, 'authentication_timeout');
    assert.equal(transport.authenticated, false);
  } finally { transport.stop(); }
});

test('disconnect reconnects, reauthenticates, and replays completed operation', async () => {
  const { transport, sockets } = fixture();
  try {
    authenticate(sockets[0]);
    const request = { id: 'first', method: 'process.exec', params: { operationId: 'replay-op', executable: process.execPath, args: ['-e', "process.stdout.write('once')"] } };
    sockets[0].feed(request);
    await delay(120);
    sockets[0].destroy();
    await delay(30);
    assert.equal(sockets.length, 2);
    authenticate(sockets[1], 'fedcba9876543210');
    sockets[1].feed({ ...request, id: 'second' });
    await delay();
    const replay = sockets[1].messages().find((m) => m.requestId === 'second');
    assert.equal(replay.result.replay, true);
    assert.equal(replay.result.outcome.stdout, 'once');
    assert.equal(sockets[1].messages().some((m) => m.type === 'accepted'), false);
  } finally { transport.stop(); }
});

test('authenticated cancellation emits correlated terminal cancellation evidence', async () => {
  const { transport, sockets } = fixture();
  try {
    authenticate(sockets[0]);
    sockets[0].feed({ id: 'run', method: 'process.exec', params: { operationId: 'cancel-op', executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } });
    await delay(80);
    sockets[0].feed({ id: 'cancel', method: 'cancel', params: { operationId: 'cancel-op' } });
    await delay(120);
    const messages = sockets[0].messages();
    const cancellation = messages.find((m) => m.requestId === 'cancel');
    const terminal = messages.find((m) => m.type === 'process.terminal');
    assert.equal(cancellation.result.cancelling, true);
    assert.equal(terminal.operationId, 'cancel-op');
    assert.equal(terminal.evidence.cancelled, true);
  } finally { transport.stop(); }
});

test('no-CA first pairing permits only bootstrap TLS, pins the approved controller certificate, and rejects a changed certificate', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-pair-pin-'));
  const sockets = [];
  const certificate = (text) => Buffer.from(text);
  const transport = new OutboundGatewayTransport({
    host: 'controller.test', port: 7443, gatewayId: 'goblin-1', stateDir,
    reconnectMinMs: 10000, reconnectMaxMs: 10000,
    tlsConnect: (options) => { const socket = new FakeSocket(); socket.options = options; socket.raw = certificate('controller-certificate-one'); socket.getPeerCertificate = () => ({ raw: socket.raw }); sockets.push(socket); return socket; },
  }).start();
  try {
    assert.equal(sockets[0].options.rejectUnauthorized, false);
    sockets[0].emit('secureConnect');
    const controller = controllerIdentity();
    const nonce = '0123456789abcdef';
    sockets[0].feed({ type: 'auth.challenge', nonce, controllerPublicKey: controller.publicKey });
    const response = sockets[0].messages()[0];
    assert.equal(response.nodePublicKey != null, true);
    sockets[0].feed({ type: 'pairing.pending', pairingCode: response.pairingCode });
    assert.equal(transport.confirmControllerPairing(response.pairingCode), true);
    sockets[0].feed({ type: 'auth.ok', connectionId: 'approved-1' });
    const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'node-identity.json'), 'utf8'));
    assert.equal(typeof saved.controllerTlsFingerprint, 'string'); assert.equal(saved.controllerPublicKey, controller.publicKey);
    sockets[0].destroy(); transport.timer && clearTimeout(transport.timer); transport.timer = null; transport.connect();
    assert.equal(sockets[1].options.rejectUnauthorized, false);
    sockets[1].emit('secureConnect');
    sockets[1].feed({ type: 'auth.challenge', nonce: 'fedcba9876543210', controllerPublicKey: controller.publicKey });
    assert.equal(sockets[1].messages()[0].nodePublicKey != null, true);
    sockets[1].feed({ type: 'auth.ok', connectionId: 'approved-2' }); assert.equal(transport.authenticated, true);
    sockets[1].destroy(); transport.timer && clearTimeout(transport.timer); transport.timer = null; transport.connect();
    sockets[2].raw = certificate('attacker-certificate'); sockets[2].emit('secureConnect');
    assert.equal(sockets[2].destroyed, true);
  } finally { transport.stop(); fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('unconfirmed bootstrap never persists trust or admits requests; mismatched transcript closes', () => {
  const { transport, sockets, stateDir } = fixture({ enrollmentToken: undefined });
  try {
    const socket = sockets[0];
    socket.getPeerCertificate = () => ({ raw: Buffer.from('certificate') });
    socket.emit('secureConnect');
    socket.feed({ type: 'auth.challenge', nonce: '0123456789abcdef', controllerPublicKey: controllerIdentity().publicKey });
    const code = socket.messages()[0].pairingCode;
    socket.feed({ type: 'auth.ok' });
    assert.equal(transport.authenticated, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'node-identity.json'))).controllerPublicKey, undefined);
    socket.feed({ id: 'blocked', method: 'health' });
    assert.equal(socket.messages().at(-1).error.code, 'unauthenticated');
    assert.equal(transport.confirmControllerPairing('WRONG'), false);
    socket.feed({ type: 'pairing.pending', pairingCode: 'FFFF-FFFF-FFFF' === code ? '0000-0000-0000' : 'FFFF-FFFF-FFFF' });
    assert.equal(socket.destroyed, true);
    assert.equal(transport.confirmControllerPairing(code), false);
  } finally { transport.stop(); fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('local confirmation is transcript-scoped and is discarded on reconnect', () => {
  const { transport, sockets, stateDir } = fixture({ enrollmentToken: undefined });
  try {
    const controller = controllerIdentity();
    sockets[0].feed({ type: 'auth.challenge', nonce: '0123456789abcdef', controllerPublicKey: controller.publicKey });
    const oldCode = sockets[0].messages()[0].pairingCode;
    assert.equal(transport.confirmControllerPairing(oldCode), true);
    sockets[0].destroy(); clearTimeout(transport.timer); transport.timer = null; transport.connect();
    sockets[1].feed({ type: 'auth.challenge', nonce: 'fedcba9876543210', controllerPublicKey: controller.publicKey });
    assert.equal(transport.confirmControllerPairing(oldCode), false);
    sockets[1].feed({ type: 'auth.ok' });
    assert.equal(transport.authenticated, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'node-identity.json'))).controllerPublicKey, undefined);
  } finally { transport.stop(); fs.rmSync(stateDir, { recursive: true, force: true }); }
});
