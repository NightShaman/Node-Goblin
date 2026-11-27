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
import { registerDesktopTool } from '../../server/desktop-tool.mjs';
import { createProcessController } from '../../server/index.mjs';

const script = fileURLToPath(new URL('../deploy/windows/node-goblin.ps1', import.meta.url));
const windows = process.platform === 'win32';
const verifyDesktop = windows && process.env.NODE_GOBLIN_DESKTOP_E2E === '1';
const appScript = fileURLToPath(new URL('./windows-desktop-app.ps1', import.meta.url));
const appArgs = (...options) => ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', appScript, ...options];
const args = (...command) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...command];
const run = (env, ...command) => spawnSync('powershell.exe', args(...command), { env, encoding: 'utf8', timeout: 10_000 });
function checked(env, ...command) {
  const result = run(env, ...command);
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}

test('Windows foreground launcher pairs over TLS, runs PowerShell and persists a protected identity across restart', { skip: !windows, timeout: 95_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-launcher-'));
  const env = { ...process.env, LOCALAPPDATA: root, BURROW_GATEWAY_STATE_DIR: path.join(root, 'must-not-create') };
  const state = path.join(root, 'NodeGoblin', 'state');
  const host = 'test-launcher';
  let listener, child, childDone, gatewayPid, startupError, app, appDone, primaryError;
  const diagnostic = () => startupError?.replace(/\b[A-F0-9]{4}(?:-[A-F0-9]{4}){2}\b/g, '[pairing code]');
  const open = (desktop) => {
    gatewayPid = undefined;
    child = spawn('powershell.exe', args('run', ...(desktop ? ['-EnableDesktop'] : [])), { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    startupError = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { startupError = (startupError + chunk).slice(-4000); });
    childDone = once(child, 'exit');
    childDone.catch(() => {});
  };
  const halt = async () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (gatewayPid) {
      // This is the gateway that directly spawned our owned probe. Its exit
      // releases the foreground launcher and the desktop helper's input pipe.
      // Killing it is fixture cleanup, not proof of console Ctrl+C delivery.
      try { process.kill(gatewayPid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    } else {
      const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000, windowsHide: true, encoding: 'utf8' });
      assert.equal(killed.status, 0, `fixture launcher cleanup failed: ${killed.error?.message || killed.stderr || killed.stdout}`);
    }
    await Promise.race([childDone, delay(5_000, undefined, { ref: false }).then(() => { throw new Error('fixture launcher did not exit'); })]);
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
    open(verifyDesktop);
    await pending.catch(error => { throw new Error(`launcher never requested pairing: ${diagnostic() || 'no stderr'}`, { cause: error }); });
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
    const identifyGateway = async (operationId) => {
      const probe = await controller.executeProcess({ targetId: host, operationId,
        process: { executable: process.execPath, args: ['-p', 'process.ppid'] } });
      assert.equal(probe.ok, true, 'could not identify the owned gateway process');
      const pid = Number(probe.stdout.trim());
      assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== child.pid && pid !== process.pid, 'invalid owned gateway PID');
      gatewayPid = pid;
    };
    await identifyGateway('launcher-owned-pid');
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
    let desktop;
    if (verifyDesktop) {
      let tool;
      registerDesktopTool({ register(spec) { tool = spec; } }, listener);
      assert.equal(tool.availability, 'grant-required');
      desktop = (action, options = {}) => tool.handler({ targetId: host, action, ...options }, {});
      let status = await desktop('status');
      assert.equal(JSON.parse(status.content[0].text).available, true, status.content[0].text);
      const marker = path.join(root, 'desktop-action.txt');
      const ready = path.join(root, 'desktop-app-ready.txt');
      // Do not request SW_HIDE for the disposable process that owns the test window.
      app = spawn('powershell.exe', appArgs('-Marker', marker, '-Ready', ready), { env, stdio: ['ignore', 'ignore', 'pipe'] });
      appDone = once(app, 'exit');
      appDone.catch(() => {});
      let appError = '';
      app.stderr.setEncoding('utf8').on('data', chunk => { appError = (appError + chunk).slice(-4000); });
      for (let i = 0; !fs.existsSync(ready) && i < 40 && app.exitCode === null; i++) await delay(150);
      assert.ok(fs.existsSync(ready), `fixture app did not open (exit ${app.exitCode}): ${appError}`);
      const fixtureId = fs.readFileSync(ready, 'utf8');
      assert.match(fixtureId, new RegExp(`^${app.pid}:\\d+$`));
      let win, count;
      for (let i = 0; !win && i < 25; i++) {
        const result = await desktop('windows');
        assert.notEqual(result.isError, true, `${result.content[0].text}; ${diagnostic() || 'no helper stderr'}`);
        const { windows } = JSON.parse(result.content[0].text);
        assert.ok(Array.isArray(windows), 'desktop windows result did not contain a list');
        count = windows.length;
        assert.ok(!windows.some(window => window.title === 'Node Goblin desktop access'), 'remote enumeration exposed the local Stop window');
        win = windows.find(window => window.windowId === fixtureId && window.title === 'Node Goblin disposable application');
        if (!win) await delay(150);
      }
      assert.ok(win, `owned fixture window not listed (${count} eligible windows, fixture ${fixtureId}, exit ${app.exitCode}): ${appError}`);
      const capture = await desktop('screenshot');
      assert.equal(capture.content[1]?.mimeType, 'image/jpeg', capture.content[0].text);
      assert.ok(Buffer.from(capture.content[1].data, 'base64').length > 1024);
      const inspected = await desktop('inspect', { windowId: win.windowId });
      assert.notEqual(inspected.isError, true, `${inspected.content[0].text}; ${diagnostic() || 'no helper stderr'}`);
      const inspect = JSON.parse(inspected.content[0].text);
      const control = inspect.controls?.find(item => item.enabled && item.name === 'Write harmless proof');
      assert.ok(control, JSON.stringify(inspect));
      const invocation = await desktop('invoke', { windowId: win.windowId, controlId: control.controlId });
      assert.equal(JSON.parse(invocation.content[0].text).invoked, true, invocation.content[0].text);
      for (let i = 0; !fs.existsSync(marker) && i < 30; i++) await delay(100);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'invoked in the Windows app');
      t.diagnostic('NG_WINDOWS_DESKTOP_APP_INVOKED: owned application wrote its marker after the primary JPEG and UIA invoke');
      const stopped = spawnSync('powershell.exe', appArgs('-StopHelper'), { env, encoding: 'utf8', timeout: 10_000, windowsHide: true });
      assert.equal(stopped.status, 0, stopped.error?.message || stopped.stderr);
      for (let i = 0; i < 15; i++) {
        status = await desktop('status');
        if (JSON.parse(status.content[0].text).state === 'desktop_helper_absent') break;
        await delay(100);
      }
      assert.equal(JSON.parse(status.content[0].text).state, 'desktop_helper_absent');
      assert.equal((await desktop('screenshot')).isError, true);
      assert.equal((await write()).response.result.replay, true, 'desktop stop did not preserve shell/files transport');
      t.diagnostic('NG_WINDOWS_DESKTOP_STOP_VERIFIED: local Stop revoked desktop access while file replay stayed connected');
    }
    const disconnected = once(listener, 'gatewayDisconnected', { signal: AbortSignal.timeout(10_000) });
    await halt();
    await disconnected;
    const reconnected = once(listener, 'gatewayAuthenticated', { signal: AbortSignal.timeout(10_000) });
    open();
    const [connection] = await reconnected.catch(error => { throw new Error(`launcher did not reconnect: ${diagnostic() || 'no stderr'}`, { cause: error }); });
    assert.equal(connection.gatewayId, host);
    await identifyGateway('launcher-restarted-pid');
    assert.equal((await write()).response.result.replay, true);
    if (desktop) {
      assert.equal(JSON.parse((await desktop('status')).content[0].text).state, 'desktop_disabled');
      t.diagnostic('NG_WINDOWS_DESKTOP_E2E_VERIFIED: paired TLS, PowerShell/files, primary JPEG, owned app inspect/invoke marker, local Stop, files replay and opt-in reset on restart');
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      try {
        if (app?.pid && app.exitCode === null && app.signalCode === null) { app.kill(); await appDone; }
      } finally {
        try { await halt(); } finally {
          await listener?.close();
          fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
        }
      }
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      t.diagnostic(`Fixture cleanup also failed: ${cleanupError.message}`);
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
