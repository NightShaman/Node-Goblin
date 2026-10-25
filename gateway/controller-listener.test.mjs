import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import test from 'node:test';
import { GatewayControllerListener, controllerAuthenticationProof } from './lib/controller-listener.mjs';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
    this.writable = true;
  }
  getCertificate() { return { raw: Buffer.from("test-controller-cert") }; }
  setEncoding() {}
  write(value) {
    this.writes.push(String(value));
    return true;
  }
  feed(message) {
    this.emit('data', typeof message === 'string' ? message : `${JSON.stringify(message)}\n`);
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.emit('close');
  }
  messages() {
    return this.writes.join('').split('\n').filter(Boolean).map(JSON.parse);
  }
}

class FakeServer extends EventEmitter {
  constructor(onSocket) {
    super();
    this.onSocket = onSocket;
  }
  listen() { this.listening = true; }
  close(callback) { this.closed = true; callback?.(); }
  connect(socket = new FakeSocket()) { this.onSocket(socket); return socket; }
}

function listenerFixture(options = {}) {
  const servers = [];
  const listener = new GatewayControllerListener({
    gateways: [{ gatewayId: 'gateway-1', controllerId: 'controller-a', secret: 'shared-secret' }],
    nonceFactory: () => 'nonce-0123456789abcdef',
    tlsServer: (_serverOptions, onSocket) => {
      const server = new FakeServer(onSocket);
      servers.push(server);
      return server;
    },
    ...options,
  }).listen(0);
  return { listener, server: servers[0] };
}

function authenticate(socket, overrides = {}) {
  const challenge = socket.messages()[0];
  const gatewayId = overrides.gatewayId ?? 'gateway-1';
  const controllerId = overrides.controllerId ?? 'controller-a';
  socket.feed({
    type: 'auth.response',
    gatewayId,
    controllerId,
    proof: overrides.proof ?? controllerAuthenticationProof('shared-secret', gatewayId, challenge.nonce),
    ...(overrides.gateway ? { gateway: overrides.gateway } : {}),
  });
}

const delay = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

test('authenticates known gateway with unpredictable challenge and tracks live gateway state', () => {
  const { listener, server } = listenerFixture();
  const socket = server.connect();
  try {
    const challenge = socket.messages()[0];
    assert.equal(challenge.type, 'auth.challenge');
    assert.equal(challenge.nonce.length >= 16, true);
    authenticate(socket);
    const ok = socket.messages().at(-1);
    assert.equal(ok.type, 'auth.ok');
    assert.deepEqual(listener.listLiveGateways(), [{ gatewayId: 'gateway-1', status: 'ok', activeOperations: [] }]);
  } finally {
    listener.close();
  }
});

test('rejects bad proof and duplicate live gateway identity safely', () => {
  const { listener, server } = listenerFixture();
  const first = server.connect();
  const duplicate = server.connect();
  try {
    authenticate(first, { proof: controllerAuthenticationProof('wrong-secret', 'gateway-1', 'nonce-0123456789abcdef') });
    assert.equal(first.messages().at(-1).error.code, 'auth_failed');

    const primary = server.connect();
    authenticate(primary);
    authenticate(duplicate);
    assert.equal(duplicate.messages().at(-1).error.code, 'gateway_already_connected');
    assert.equal(listener.liveGateway('gateway-1').socket, primary);
  } finally {
    listener.close();
  }
});

test('dispatches process.exec, correlates accepted events terminal response, and exposes lifecycle events', async () => {
  const { listener, server } = listenerFixture();
  const socket = server.connect();
  const seen = [];
  listener.on('gatewayAccepted', ({ message }) => seen.push(message.type));
  listener.on('gatewayEvent', ({ message }) => seen.push(message.type));
  listener.on('gatewayResponse', ({ message }) => seen.push(`${message.type}:${message.requestId}`));
  try {
    authenticate(socket);
    const dispatch = listener.dispatchProcessExec('gateway-1', { operationId: 'op-1', executable: process.execPath, args: ['-e', "process.stdout.write('x')"] });
    const outbound = socket.messages().find((message) => message.method === 'process.exec');
    assert.deepEqual(outbound.params, { operationId: 'op-1', executable: process.execPath, args: ['-e', "process.stdout.write('x')"] });
    socket.feed({ type: 'accepted', requestId: outbound.id, ok: true, operationId: 'op-1', protocolVersion: '1.0' });
    socket.feed({ type: 'process.stream', operationId: 'op-1', stream: 'stdout', seq: 1, data: 'x', truncated: false });
    socket.feed({ type: 'process.terminal', operationId: 'op-1', seq: 2, evidence: { type: 'process.result', stdout: 'x', stderr: '', exitCode: 0, cancelled: false, truncated: false, timedOut: false } });
    socket.feed({ type: 'response', requestId: outbound.id, ok: true, result: { operationId: 'op-1', replay: false, outcome: { type: 'process.result', stdout: 'x' } } });
    const result = await dispatch;
    assert.equal(result.accepted.operationId, 'op-1');
    assert.equal(result.events.some((event) => event.type === 'process.terminal'), true);
    assert.equal(result.response.result.operationId, 'op-1');
    assert.deepEqual(seen, ['accepted', 'process.stream', 'process.terminal', `response:${outbound.id}`]);
  } finally {
    listener.close();
  }
});

test('disconnect rejects pending work with actionable error and reconnect permits same operationId replay', async () => {
  const { listener, server } = listenerFixture();
  const first = server.connect();
  try {
    authenticate(first);
    const pending = listener.dispatchProcessExec('gateway-1', { operationId: 'replay-op', executable: process.execPath, args: ['-e', "process.stdout.write('once')"] });
    const outbound = first.messages().find((message) => message.method === 'process.exec');
    first.feed({ type: 'accepted', requestId: outbound.id, ok: true, operationId: 'replay-op', protocolVersion: '1.0' });
    first.destroy();
    await assert.rejects(pending, (error) => error.code === 'gateway_disconnected' && error.retryable === true && /same operationId/.test(error.message));

    const second = server.connect();
    authenticate(second);
    const replay = listener.dispatchProcessExec('gateway-1', { operationId: 'replay-op', executable: process.execPath, args: ['-e', "process.stdout.write('once')"] });
    const replayOutbound = second.messages().find((message) => message.method === 'process.exec');
    second.feed({ type: 'response', requestId: replayOutbound.id, ok: true, result: { operationId: 'replay-op', replay: true, outcome: { type: 'process.result', stdout: 'once' } } });
    const result = await replay;
    assert.equal(result.response.result.replay, true);
  } finally {
    listener.close();
  }
});

test('revoking a gateway removes its live connection and inventory immediately', () => {
  const { listener, server } = listenerFixture();
  const socket = server.connect();
  authenticate(socket);
  try {
    assert.equal(listener.listGateways()[0].gatewayId, 'gateway-1');
    assert.equal(listener.revokeGateway('gateway-1'), true);
    assert.equal(socket.destroyed, true);
    assert.equal(listener.liveGateway('gateway-1'), null);
    assert.deepEqual(listener.listGateways(), []);
  } finally { listener.close(); }
});

test('fans telemetry configuration to authenticated gateways', async () => {
  const { listener, server } = listenerFixture();
  const socket = server.connect();
  try {
    authenticate(socket);
    const pending = listener.configureTelemetry({ enabled: true, endpoint: 'https://collector.example', headers: 'x-token=private' });
    const outbound = socket.messages().find((message) => message.method === 'telemetry.configure');
    assert.equal(outbound.params.headers, 'x-token=private');
    socket.feed({ type: 'response', requestId: outbound.id, ok: true, result: { configured: true, source: 'controller' } });
    assert.deepEqual(await pending, { configured: 1, succeeded: 1, failed: 0 });
  } finally { listener.close(); }
});

test('dispatches cancellation and reports malformed frames without corrupting live tracking', async () => {
  const { listener, server } = listenerFixture();
  const socket = server.connect();
  try {
    authenticate(socket);
    const cancelling = listener.dispatchCancel('gateway-1', 'cancel-op');
    const cancelOutbound = socket.messages().find((message) => message.method === 'cancel');
    socket.feed('{broken\n');
    socket.feed({ type: 'response', requestId: cancelOutbound.id, ok: true, result: { operationId: 'cancel-op', cancelling: true } });
    const result = await cancelling;
    assert.equal(socket.messages().some((message) => message.type === 'error' && message.error.code === 'invalid_json'), true);
    assert.equal(result.response.result.cancelling, true);
    assert.deepEqual(listener.listLiveGateways(), [{ gatewayId: 'gateway-1', status: 'ok', activeOperations: [] }]);
  } finally {
    listener.close();
  }
});


test('exposes gateway version and connection health metadata plus bounded safe operation activity', async () => {
  const { listener, server } = listenerFixture({ activityLimit: 2 });
  const socket = server.connect();
  try {
    authenticate(socket, { gateway: { name: 'burrow-host-gateway', version: '1.2.3', protocolVersion: '1.0', secret: 'ignored' } });
    const gateway = listener.listGateways()[0];
    assert.equal(gateway.connected, true);
    assert.equal(gateway.version, '1.2.3');
    assert.equal(gateway.protocolVersion, '1.0');
    assert.equal(typeof gateway.connectedAt, 'string');
    assert.equal(typeof gateway.lastSeenAt, 'string');
    assert.equal(JSON.stringify(gateway).includes('ignored'), false);

    const dispatch = listener.dispatchProcessExec('gateway-1', { operationId: 'activity-op', command: 'echo secret', protectedValues: { TOKEN: 'protected-secret' } });
    const outbound = socket.messages().find((message) => message.method === 'process.exec');
    socket.feed({ type: 'accepted', requestId: outbound.id, ok: true, operationId: 'activity-op' });
    socket.feed({ type: 'response', requestId: outbound.id, ok: true, result: { operationId: 'activity-op', replay: true, outcome: { type: 'process.result', exitCode: 0, durationMs: 7, stdout: 'unbounded output' } } });
    await dispatch;
    const activity = listener.listOperationActivity({ limit: 100 });
    assert.deepEqual(activity.map(({ gatewayId, operationId, kind, state, replay, reconnectRequired, terminalOutcome, durationMs }) => ({ gatewayId, operationId, kind, state, replay, reconnectRequired, terminalOutcome, durationMs })), [
      { gatewayId: 'gateway-1', operationId: 'activity-op', kind: 'process', state: 'terminal', replay: true, reconnectRequired: false, terminalOutcome: 'completed', durationMs: 7 },
    ]);
    assert.equal(JSON.stringify(activity).includes('echo secret'), false);
    assert.equal(JSON.stringify(activity).includes('protected-secret'), false);
    assert.equal(JSON.stringify(activity).includes('unbounded output'), false);
  } finally { listener.close(); }
});

test('retains disconnected last-seen health and marks pending operations reconnect-required', async () => {
  const { listener, server } = listenerFixture();
  const socket = server.connect();
  authenticate(socket, { gateway: { version: '1.2.3' } });
  const pending = listener.dispatchProcessExec('gateway-1', { operationId: 'interrupted-op', command: 'sleep 1' });
  socket.destroy();
  await assert.rejects(pending, /disconnected/);
  const gateway = listener.listGateways()[0];
  assert.equal(gateway.connected, false);
  assert.equal(gateway.status, 'disconnected');
  assert.equal(typeof gateway.lastSeenAt, 'string');
  const activity = listener.listOperationActivity()[0];
  assert.equal(activity.state, 'interrupted');
  assert.equal(activity.reconnectRequired, true);
  listener.close();
});

test('pending approval is committed only after its live challenge is revalidated', async () => {
  const { controllerIdentity, loadNodeIdentity, signPairing } = await import('./lib/pairing.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'listener-pairing-'));
  const pairingIdentity = controllerIdentity();
  const { listener, server } = listenerFixture({ gateways: [], pairingIdentity });
  const socket = server.connect();
  const identity = loadNodeIdentity(stateDir);
  try {
    const nonce = socket.messages()[0].nonce;
    socket.feed({ type: 'auth.response', channelBinding: 'tls-cert-sha256', gatewayId: 'fresh-node', controllerId: 'controller', nodePublicKey: identity.publicKey,
      pairingSignature: signPairing(identity, nonce, 'fresh-node', pairingIdentity.publicKey, crypto.createHash('sha256').update(Buffer.from('test-controller-cert')).digest('hex')) });
    const pending = listener.preparePendingApproval('fresh-node');
    assert.equal(pending.gatewayId, 'fresh-node');
    assert.equal(socket.messages().some((message) => message.type === 'auth.ok'), false);
    assert.equal(listener.liveGateway('fresh-node').state, 'pending');
    const approved = listener.commitPendingApproval('fresh-node', pending);
    assert.equal(approved.status, 'approved');
    assert.equal(socket.messages().at(-1).type, 'auth.ok');
    assert.equal(listener.liveGateway('fresh-node').state, 'ready');
  } finally { listener.close(); fs.rmSync(stateDir, { recursive: true, force: true }); }
});

test('revoke removes pending and operation activity and is idempotent', () => {
  const { listener } = listenerFixture();
  listener.pending.set('gateway-1', { gatewayId: 'gateway-1', status: 'pending' });
  listener.putActivity({ gatewayId: 'gateway-1', operationId: 'stale-op' });
  assert.equal(listener.revokeGateway('gateway-1'), true);
  assert.deepEqual(listener.listPending(), []);
  assert.deepEqual(listener.listOperationActivity(), []);
  assert.equal(listener.revokeGateway('gateway-1'), false);
  listener.close();
});

test('cancel receipts and duplicate replies cannot steal execution event or activity ownership', async () => {
  const { listener, server } = listenerFixture();
  const socket = server.connect();
  authenticate(socket);
  const connection = listener.liveGateway('gateway-1');
  const original = listener.dispatchProcessExec('gateway-1', { operationId: 'owned' });
  const ownerId = socket.messages().at(-1).id;
  socket.feed({ type: 'accepted', requestId: ownerId, operationId: 'owned' });
  const cancel = listener.dispatchCancel('gateway-1', 'owned');
  const cancelId = socket.messages().at(-1).id;
  socket.feed({ type: 'response', requestId: cancelId, ok: true, result: { operationId: 'owned', cancelling: true } });
  await cancel;
  const duplicate = listener.dispatchProcessExec('gateway-1', { operationId: 'owned' });
  const duplicateId = socket.messages().at(-1).id;
  socket.feed({ type: 'response', requestId: duplicateId, ok: false, error: { operationId: 'owned', code: 'operation_active' } });
  await duplicate;
  assert.equal(connection.activeOperationRequests.get('owned'), ownerId);
  assert.deepEqual(listener.listLiveGateways()[0].activeOperations, ['owned']);
  assert.equal(listener.listOperationActivity()[0].state, 'running');
  socket.feed({ type: 'process.stream', operationId: 'owned', text: 'late' });
  socket.feed({ type: 'process.terminal', operationId: 'owned', evidence: { cancelled: true } });
  socket.feed({ type: 'response', requestId: ownerId, ok: true, result: { operationId: 'owned', outcome: { cancelled: true } } });
  const result = await original;
  assert.deepEqual(result.events.map(event => event.type), ['process.stream', 'process.terminal']);
  assert.deepEqual(listener.listLiveGateways()[0].activeOperations, []);
  assert.equal(listener.listOperationActivity()[0].terminalOutcome, 'cancelled');
  listener.close();
});

test('listener forwards actual server listening, error and close lifecycle events', () => {
  const { listener, server } = listenerFixture();
  const events = [];
  listener.on('listening', () => events.push('listening'));
  listener.on('listenerError', (error) => events.push(error.code));
  listener.on('close', () => events.push('close'));
  listener.listen(7443, 'localhost');
  assert.deepEqual(events, []);
  server.emit('listening');
  server.emit('error', Object.assign(new Error('bind failed'), { code: 'EADDRINUSE' }));
  server.emit('close');
  assert.deepEqual(events, ['listening', 'EADDRINUSE', 'close']);
});

test('listener drains authenticating and ready sockets and rejects pending dispatch', async () => {
  const { listener, server } = listenerFixture();
  const authenticating = server.connect();
  const ready = server.connect(); authenticate(ready);
  const dispatched = listener.dispatchProcessExec('gateway-1', { operationId: 'drain' });
  const rejected = assert.rejects(dispatched, { code: 'gateway_disconnected' });
  await listener.close(); await rejected;
  await listener.close();
  assert.equal(authenticating.destroyed, true);
  assert.equal(ready.destroyed, true);
  assert.equal(listener.sockets.size, 0);
  const late = server.connect(); assert.equal(late.destroyed, true);
});

test('listener bounds authentication lifetime', async () => {
  const { listener, server } = listenerFixture({ handshakeTimeoutMs: 5 });
  const socket = server.connect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(socket.destroyed, true);
  assert.equal(socket.messages().at(-1).error.code, 'authentication_timeout');
  await listener.close();
});

test('describeHost reads current authenticated hello metadata, tolerates old gateways, and clears deadlines', async () => {
  const { listener, server } = listenerFixture();
  const socket = server.connect();
  try {
    assert.equal(await listener.describeHost('gateway-1'), null);
    authenticate(socket);
    const host = { hostname: 'worker', platform: 'linux', addresses: [
      { interface: 'docker0', family: 'IPv4', address: '172.17.0.1', interfaceKind: 'lan-candidate', mac: 'secret' },
      { interface: 'eno1', family: 'IPv4', address: '10.10.20.105' },
      { interface: 'evil\ntext', family: 'IPv4', address: '10.0.0.1' },
    ] };
    const read = listener.describeHost('gateway-1');
    const request = socket.messages().at(-1);
    assert.equal(request.method, 'hello');
    socket.feed({ type: 'response', requestId: request.id, ok: true, result: { host } });
    const result = await read;
    assert.equal(result.hostname, 'worker');
    assert.equal(result.addresses[0].address, '10.10.20.105');
    assert.equal(result.addresses[1].interfaceKind, 'container');
    assert.equal(JSON.stringify(result).includes('mac'), false);
    assert.ok(Number.isFinite(Date.parse(result.observedAt)));
    const legacy = listener.describeHost('gateway-1');
    socket.feed({ type: 'response', requestId: socket.messages().at(-1).id, ok: true, result: { name: 'old' } });
    assert.equal(await legacy, null);
    const keepAlive = setInterval(() => {}, 20);
    try { assert.equal(await listener.describeHost('gateway-1', 10), null); }
    finally { clearInterval(keepAlive); }
    assert.equal(listener.liveGateway('gateway-1').pendingRequests.size, 0);
    const disconnected = listener.describeHost('gateway-1');
    socket.destroy();
    assert.equal(await disconnected, null);
  } finally { listener.close(); }
});
