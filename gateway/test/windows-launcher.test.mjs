import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GatewayControllerListener } from '../lib/controller-listener.mjs';
import { createProcessController } from '../../server/index.mjs';

const script = fileURLToPath(new URL('../deploy/windows/node-goblin.ps1', import.meta.url));
const windows = process.platform === 'win32';
const args = (...command) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...command];
const run = (env, ...command) => spawnSync('powershell.exe', args(...command), { env, encoding: 'utf8', timeout: 10_000 });
function checked(env, ...command) {
  const result = run(env, ...command);
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}

test('Windows foreground launcher pairs over TLS, runs PowerShell and persists a protected identity across restart', { skip: !windows, timeout: 50_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-launcher-'));
  const env = { ...process.env, LOCALAPPDATA: root, BURROW_GATEWAY_STATE_DIR: path.join(root, 'must-not-create') };
  const state = path.join(root, 'NodeGoblin', 'state');
  const host = 'test-launcher';
  let listener, child, childDone;
  const open = () => {
    child = spawn('powershell.exe', args('run'), { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.stderr.resume(); // Do not emit pairing codes in CI logs.
    childDone = once(child, 'exit');
    childDone.catch(() => {});
  };
  const halt = async () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000, windowsHide: true, stdio: 'ignore' });
    assert.equal(killed.status, 0, 'fixture PowerShell process tree could not be stopped');
    await childDone;
  };
  try {
    const key = path.join(root, 'key.pem');
    const cert = path.join(root, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'pipe', timeout: 10_000 });
    listener = new GatewayControllerListener({ serverOptions: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } });
    const listening = once(listener, 'listening', { signal: AbortSignal.timeout(5_000) });
    listener.listen(0, '127.0.0.1');
    await listening;
    checked(env, 'configure', '-Controller', `tls://127.0.0.1:${listener.server.address().port}`, '-GatewayId', host);
    const pending = once(listener, 'gatewayPairingPending', { signal: AbortSignal.timeout(10_000) });
    open();
    await pending;
    const approval = listener.preparePendingApproval(host);
    assert.ok(approval);
    const codeFile = path.join(state, 'pairing-code.json');
    for (let i = 0; !fs.existsSync(codeFile) && i < 100; i++) await delay(40);
    assert.ok(checked(env, 'pairing-code').includes(approval.pairingCode), 'operator and controller codes differ');
    checked(env, 'confirm-pairing', approval.pairingCode);
    const confirmFile = path.join(state, 'pairing-confirmation.json');
    for (let i = 0; fs.existsSync(confirmFile) && i < 100; i++) await delay(40);
    assert.ok(!fs.existsSync(confirmFile), 'gateway did not consume the local confirmation');
    assert.equal(listener.commitPendingApproval(host, approval)?.status, 'approved');
    const controller = createProcessController(listener);
    const work = path.join(root, 'launcher proof.txt');
    const write = () => listener.dispatchFilesystem(host, { operationId: 'write', tool: 'files_write', arguments: { filePath: work, content: 'launcher' } });
    assert.equal((await write()).response.result.outcome.ok, true);
    const executed = await controller.executeProcess({ targetId: host, operationId: 'launcher-smoke', process: { commandShell: 'powershell', cwd: root, command: "Get-Content -LiteralPath 'launcher proof.txt'" } });
    assert.equal(executed.ok, true);
    assert.equal(executed.stdout.trim(), 'launcher');
    assert.ok(!fs.existsSync(env.BURROW_GATEWAY_STATE_DIR), 'launcher honored inherited state override');
    const identity = path.join(state, 'node-identity.json');
    assert.ok(fs.existsSync(identity));
    const acl = execFileSync('icacls.exe', [identity], { encoding: 'utf8', timeout: 5_000 });
    assert.match(acl, /\(F\)/, 'missing full-control ACL on generated identity');
    assert.doesNotMatch(acl, /\b(?:Everyone|Authenticated Users|BUILTIN\\Users):/i);
    const disconnected = once(listener, 'gatewayDisconnected', { signal: AbortSignal.timeout(10_000) });
    await halt();
    await disconnected;
    const reconnected = once(listener, 'gatewayAuthenticated', { signal: AbortSignal.timeout(10_000) });
    open();
    assert.equal((await reconnected)[0].gatewayId, host);
    assert.equal((await write()).response.result.replay, true);
  } finally {
    try { await halt(); } finally {
      await listener?.close();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
});

test('Windows launcher refuses an unexpected ACL entry and a reparse point', { skip: !windows, timeout: 30_000 }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-acl-'));
  const env = { ...process.env, LOCALAPPDATA: root };
  try {
    checked(env, 'configure', '-Controller', 'tls://127.0.0.1:7443', '-GatewayId', 'acl-test');
    const config = path.join(root, 'NodeGoblin', 'config', 'gateway.env');
    const before = fs.readFileSync(config, 'utf8');
    execFileSync('icacls.exe', [config, '/grant', '*S-1-1-0:(R)'], { stdio: 'pipe', windowsHide: true, timeout: 5_000 });
    const rejected = run(env, 'configure', '-Controller', 'tls://127.0.0.1:7444', '-GatewayId', 'acl-test');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Unexpected ACL entry/);
    assert.equal(fs.readFileSync(config, 'utf8'), before);
    execFileSync('icacls.exe', [config, '/remove:g', '*S-1-1-0'], { stdio: 'pipe', windowsHide: true, timeout: 5_000 });
    const state = path.join(root, 'NodeGoblin', 'state');
    const untouched = path.join(root, 'target');
    fs.mkdirSync(untouched);
    fs.rmdirSync(state);
    fs.symlinkSync(untouched, state, 'junction');
    const junction = run(env, 'configure', '-Controller', 'tls://127.0.0.1:7444', '-GatewayId', 'acl-test');
    assert.notEqual(junction.status, 0);
    assert.match(junction.stderr, /Refusing reparse point/);
    assert.deepEqual(fs.readdirSync(untouched), []);
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); }
});
