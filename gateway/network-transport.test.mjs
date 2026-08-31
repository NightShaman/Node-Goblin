import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authenticationProof, enrollController, OutboundGatewayTransport, readControllerTrust } from './lib/network-transport.mjs';

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

test('controller challenge authenticates with a bound HMAC proof', () => {
  const { transport, sockets } = fixture();
  try {
    const nonce = '0123456789abcdef';
    sockets[0].feed({ type: 'auth.challenge', nonce });
    const response = sockets[0].messages()[0];
    assert.deepEqual(response, {
      type: 'auth.response', gatewayId: 'gateway-1', controllerId: 'controller',
      proof: authenticationProof('one-time-secret', 'gateway-1', nonce),
      gateway: { name: 'burrow-host-gateway', version: '1.0.0', protocolVersion: '1.0' },
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
    await delay(150);
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
