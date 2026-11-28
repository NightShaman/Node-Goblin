import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validateEndpoint } from '../deploy/windows/manager-host.mjs';
import { GatewayControllerListener } from '../lib/controller-listener.mjs';

const entry = fileURLToPath(new URL('../deploy/windows/manager-host.mjs', import.meta.url));

test('manager validates explicit outbound TLS endpoints and gateway IDs', () => {
  assert.deepEqual(validateEndpoint('tls://[::1]:7443', 'lab-node'), { host: '::1', port: 7443, gatewayId: 'lab-node' });
  for (const address of ['https://host:7443', 'tls://host', 'tls://host:0', 'tls://host:65536',
    'tls://user:password@host:7443', 'tls://host:7443/path', 'tls://host:7443?query']) {
    assert.throws(() => validateEndpoint(address, 'lab-node'), { message: 'invalid_configuration' });
  }
  assert.throws(() => validateEndpoint('tls://host:7443', 'local'), { message: 'invalid_configuration' });
});

function worker() {
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exit = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const events = [];
  let index = 0;
  createInterface({ input: child.stdout }).on('line', line => events.push(JSON.parse(line)));
  return {
    events,
    send(message) { child.stdin.write(JSON.stringify(message) + '\n'); },
    close() { child.stdin.end(); },
    async next(type, predicate = () => true) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && child.exitCode == null) {
        while (index < events.length) {
          const event = events[index++];
          if (event.type === type && predicate(event)) return event;
        }
        await delay(10);
      }
      assert.fail(`Did not receive ${type}; saw ${events.map(event => event.type).join(', ')}`);
    },
    async done() {
      const outcome = await Promise.race([exit, delay(5000, 'manager did not exit', { ref: false })]);
      assert.deepEqual(outcome, [0, null]);
      assert.equal(stderr, '');
    },
    async cleanup() {
      if (child.exitCode == null && child.signalCode == null) child.kill();
      await exit;
    },
  };
}

test('manager pipe gates real TLS pairing, reuses trust and handles reconnect and EOF', { timeout: 25_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-manager-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  const stateDir = path.join(dir, 'state');
  const gatewayId = 'manager-fixture';
  const children = [];
  let listener;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'pipe' });
    listener = new GatewayControllerListener({ serverOptions: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } });
    const listening = once(listener, 'listening');
    listener.listen(0, '127.0.0.1');
    await listening;
    const desktopStatus = async () => (await listener.dispatchDesktop(gatewayId, { action: 'status' })).response.result;
    const start = { type: 'start', controller: `tls://127.0.0.1:${listener.server.address().port}`, gatewayId, stateDir };
    const first = worker();
    children.push(first);
    assert.equal(fs.existsSync(stateDir), false);
    first.send(start);
    await first.next('connected');
    const { code } = await first.next('pairing');
    const approval = listener.preparePendingApproval(gatewayId);
    assert.equal(code, approval.pairingCode);
    // Exercise the race where Burrow approves ahead of the local button.
    listener.commitPendingApproval(gatewayId, approval);
    await first.next('pairing');
    first.send({ type: 'confirm', code: code + 'X' });
    await first.next('confirmationExpired');
    assert.equal(first.events.some(event => event.type === 'authenticated'), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, 'node-identity.json'))).controllerPublicKey, undefined);
    first.send({ type: 'confirm', code });
    assert.deepEqual(await first.next('authenticated'), { type: 'authenticated', connection: 1, desktopSupported: true });
    assert.ok(JSON.parse(fs.readFileSync(path.join(stateDir, 'node-identity.json'))).controllerTlsFingerprint);
    const status = await desktopStatus();
    assert.equal(status.state, 'desktop_disabled');
    listener.connections.get(gatewayId).socket.destroy();
    await first.next('disconnected');
    assert.equal((await first.next('authenticated')).connection, 2);
    first.send({ type: 'desktopOn', connection: 1 });
    first.send({ type: 'confirm', code });
    await first.next('confirmationExpired');
    assert.equal(first.events.some(event => event.type === 'desktop' && event.state === 'desktop_starting'), false);
    assert.equal((await desktopStatus()).state, 'desktop_disabled');
    const disconnect = once(listener, 'gatewayDisconnected');
    first.send({ type: 'stop' });
    await first.done();
    await disconnect;

    const second = worker();
    children.push(second);
    second.send(start);
    await second.next('authenticated');
    assert.equal(second.events.some(event => event.type === 'pairing'), false);
    assert.equal((await desktopStatus()).state, 'desktop_disabled');
    // Revoke the controller record while retaining the local pin. A reported
    // pairing still requires the current local confirmation.
    listener.revokeGateway(gatewayId);
    await second.next('pairing');
    listener.rejectPending(gatewayId);
    assert.equal((await second.next('authenticationError')).code, 'pairing_rejected');
    const renewed = await second.next('pairing');
    listener.commitPendingApproval(gatewayId, listener.preparePendingApproval(gatewayId));
    await second.next('pairing');
    assert.equal(second.events.filter(event => event.type === 'authenticated').length, 1);
    second.send({ type: 'confirm', code: renewed.code });
    assert.equal((await second.next('authenticated')).connection, 2);
    second.close();
    await second.done();
  } finally {
    await Promise.all(children.map(child => child.cleanup()));
    await listener?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
