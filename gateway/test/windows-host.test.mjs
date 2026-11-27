import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GatewayControllerListener } from '../lib/controller-listener.mjs';
import { GatewayDaemon } from '../lib/daemon.mjs';
import { OperationJournal } from '../lib/journal.mjs';
import { OutboundGatewayTransport } from '../lib/network-transport.mjs';
import { createProcessController } from '../../server/index.mjs';

const windows = process.platform === 'win32';

test('real TLS pairing authorizes a host, runs a harmless shell command, mutates a file and replays after reconnect', { timeout: 30_000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-host-'));
  const certPath = path.join(dir, 'test-cert.pem');
  const keyPath = path.join(dir, 'test-key.pem');
  const stateDir = path.join(dir, 'gateway-state');
  const gatewayId = 'test-host';
  let listener;
  let transport;
  try {
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1','-keyout',keyPath,'-out',certPath], { stdio: 'pipe' });
    listener = new GatewayControllerListener({ serverOptions: { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) } });
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const open = () => new OutboundGatewayTransport({ host: '127.0.0.1', port: listener.server.address().port, gatewayId, stateDir, daemon: new GatewayDaemon({ journal: new OperationJournal({ stateDir }) }) });
    transport = open();
    const pending = once(transport, 'pairingPending');
    const authenticated = once(transport, 'authenticated');
    transport.start();
    const [{ pairingCode }] = await pending;
    const approval = listener.preparePendingApproval(gatewayId);
    assert.equal(pairingCode, approval.pairingCode);
    assert.equal(transport.confirmControllerPairing(pairingCode), true);
    assert.equal(listener.commitPendingApproval(gatewayId, approval).status, 'approved');
    await authenticated;
    const controller = createProcessController(listener);
    assert.equal((await controller.describeHost(gatewayId)).platform, process.platform);
    const request = { targetId: gatewayId, operationId: 'shell-smoke', process: windows
      ? { commandShell: 'powershell', command: "Write-Output ('node' + '-goblin')", cwd: dir }
      : { command: 'printf node-goblin', cwd: dir } };
    const executed = await controller.executeProcess(request);
    assert.equal(executed.ok, true);
    assert.equal(executed.stdout.trim(), 'node-goblin');
    const protectedCase = await controller.executeProcess({
      targetId: gatewayId, operationId: 'protected-env-case',
      process: { executable: process.execPath,
        args: ['-e', 'console.log(process.env.NG_FIXTURE_CASE); console.log(process.env.ng_fixture_case)'],
        env: { NG_FIXTURE_CASE: 'ordinary-env-fixture' } },
      protectedValues: { ng_fixture_case: 'protected-env-fixture' },
    });
    assert.equal(protectedCase.ok, true);
    assert.deepEqual(protectedCase.stdout.trim().split(/\r?\n/),
      windows ? ['[redacted]', '[redacted]'] : ['ordinary-env-fixture', '[redacted]']);
    if (windows) t.diagnostic('NG_WINDOWS_PROTECTED_ENV_VERIFIED: protected value wins across casing in the child and is redacted');
    if (windows) {
      const cmd = await controller.executeProcess({ targetId: gatewayId, operationId: 'cmd-smoke', process: { commandShell: 'cmd', command: 'echo node-goblin && echo second' } });
      assert.equal(cmd.ok, true);
      assert.deepEqual(cmd.stdout.trim().split(/\r?\n/).map(line => line.trim()), ['node-goblin','second']);
    }
    const filePath = path.join(dir, 'fixture space.txt');
    const write = (operationId, content) => listener.dispatchFilesystem(gatewayId, { operationId, tool: 'files_write', arguments: { filePath, content } });
    const first = await write('write-once', 'original');
    assert.equal(first.response.result.outcome.ok, true);
    assert.equal((await write('replace-once', 'updated')).response.result.outcome.ok, true);
    assert.equal(fs.readFileSync(filePath,'utf8'), 'updated');
    const disconnected = once(listener, 'gatewayDisconnected');
    await transport.stop();
    await disconnected;
    transport = open();
    const second = once(transport, 'authenticated');
    transport.start();
    await second;
    assert.equal((await write('write-once','original')).response.result.replay, true);
    assert.equal(fs.readFileSync(filePath,'utf8'), 'updated');
  } finally {
    await transport?.stop();
    await listener?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows cancellation stops a known child and grandchild', { skip: !windows, timeout: 15_000 }, async () => {
  const { runProcess } = await import('../lib/process-runner.mjs');
  const controller = new AbortController();
  let pids;
  let output = '';
  try {
    const result = await runProcess({ executable: process.execPath, args: ['-e', `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
      process.stdout.write(process.pid + ',' + child.pid + '\\n');
      setInterval(() => {}, 1000);
    `], timeoutMs: 8_000 }, { signal: controller.signal, emitEvent(event) {
      if (event.type !== 'process.stream' || event.stream !== 'stdout') return;
      output += event.data;
      const ids = /^(\d+),(\d+)\r?\n/.exec(output);
      if (ids) { pids = ids.slice(1).map(Number); controller.abort(); }
    } });
    assert.ok(pids, 'fixture did not produce both process IDs');
    assert.equal(result.cancelled, true);
    assert.equal(result.killed, true);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally {
    for (const pid of pids ?? []) { try { process.kill(pid); } catch {} }
  }
});
