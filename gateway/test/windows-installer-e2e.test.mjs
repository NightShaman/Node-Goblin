import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { GatewayControllerListener } from '../lib/controller-listener.mjs';

const requested = process.env.NODE_GOBLIN_MANAGER_E2E === '1';
const script = name => fileURLToPath(new URL(name, import.meta.url));
const powershell = (...args) => ['-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', ...args];
const authenticated = 'Connected and authenticated with Burrow';
const start = 'Save consent and start';
const pairing = 'Current pairing code';
const enableDesktop = 'Enable desktop for this connection';

function launch(exe, args, options = {}) {
  const child = spawn(exe, args, { stdio: 'ignore', ...options });
  const exit = once(child, 'exit');
  // Keep spawn failures available to await without unhandled rejections.
  exit.catch(() => {});
  return { child, exit };
}

async function checkExit(proc, label, timeout = 15_000) {
  const result = await Promise.race([proc.exit, delay(timeout, null, { ref: false })]);
  if (!result) proc.child.kill();
  assert.equal(result?.[0], 0, label);
}

async function until(label, probe, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await probe();
    if (value) return value;
    await delay(150);
  } while (Date.now() < deadline);
  assert.fail(label);
}

function openDriver() {
  const { child, exit } = launch('powershell.exe', powershell(script('./windows-manager-ui.ps1')), {
    stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  return {
    async call(action, fields = {}) {
      child.stdin.write(JSON.stringify({ action, ...fields }) + '\n');
      const reply = await Promise.race([lines.next(), delay(action === 'ready' ? 20_000 : 8000, null, { ref: false })]);
      if (!reply || reply.done) {
        child.kill();
        throw new Error(`UI driver stopped replying during ${action}`);
      }
      let result;
      try { result = JSON.parse(reply.value); }
      catch { throw new Error(`Invalid UI driver reply during ${action}`); }
      if (!result.ok) throw new Error(`UI driver ${action}${fields.name ? ' (' + fields.name + ')' : ''}: ${result.error} at script line ${result.line}`);
      return result.value;
    },
    async close() {
      child.stdin.end();
      await checkExit({ child, exit }, 'UI driver did not exit cleanly', 5000);
    },
  };
}

test('installed Windows manager pairs through its native GUI as a standard user', {
  skip: requested ? false : 'Set NODE_GOBLIN_MANAGER_E2E=1 in a disposable interactive Windows profile',
  timeout: 240_000,
}, async t => {
  assert.equal(process.platform, 'win32', 'The requested native exercise requires Windows');
  const appPath = path.join(process.env.LOCALAPPDATA, 'NodeGoblin', 'app');
  const exe = path.join(appPath, 'NodeGoblin.exe');
  const node = path.join(appPath, 'node', 'node.exe');
  assert.ok(fs.existsSync(exe), 'Installed manager executable is missing');
  assert.ok(fs.realpathSync(process.execPath).toLowerCase() === fs.realpathSync(node).toLowerCase(),
    'Run this test with the installed bundled Node');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-installed-e2e-'));
  const driver = openDriver();
  const owned = new Set();
  const gatewayId = `installer-${randomUUID()}`;
  let listener, fixture, pid, primaryError;
  const ui = (action, name, value) => driver.call(action, { pid, name, value });
  const visible = () => ui('window');
  const expectWindow = () => until('Manager window did not open', visible);
  const expectLabel = name => until(`Manager did not show "${name}"`, () => ui('exists', name));
  const open = (...args) => launch(exe, args, { cwd: appPath });
  const shutdown = () => checkExit(open('--shutdown'), 'Installed --shutdown failed');
  const track = async (processId, image) => {
    assert.ok(Number.isSafeInteger(processId) && processId > 0 && processId !== process.pid, 'Invalid owned PID');
    await driver.call('track', { pid: processId, exe: image });
    owned.add(processId);
  };
  const expectExit = async (processId, label) => {
    await until(label, () => driver.call('exited', { pid: processId }));
    owned.delete(processId);
  };
  const desktop = (action, options) => until('Desktop helper remained busy', async () => {
    const { response } = await listener.dispatchDesktop(gatewayId, { action, ...options });
    return response.error?.code === 'desktop_busy' ? null : response;
  }, 5000);
  const desktopState = async () => (await desktop('status')).result?.state;
  const dispatch = params => listener.dispatchProcessExec(gatewayId, { cwd: dir, ...params });
  const outcome = async params => (await dispatch(params)).response.result?.outcome;
  const gatewayPid = async operationId => {
    const result = await outcome({ operationId, executable: node, args: ['-p', 'process.ppid'] });
    assert.equal(result?.ok, true, 'Could not identify installed gateway process');
    const processId = Number(result.stdout.trim());
    await track(processId, node);
    return processId;
  };
  const writeThenRead = async label => {
    const leaf = `${label}.txt`;
    const { response } = await listener.dispatchFilesystem(gatewayId, {
      operationId: `${label}-write`, tool: 'files_write',
      arguments: { filePath: path.join(dir, leaf), content: label },
    });
    assert.equal(response.result?.outcome?.ok, true, 'Authenticated file write failed');
    const read = await outcome({ operationId: `${label}-read`, commandShell: 'powershell', command: `Get-Content -LiteralPath '${leaf}'` });
    assert.equal(read?.ok, true, 'Authenticated PowerShell read failed');
    assert.equal(read.stdout.trim(), label);
  };
  const waitAuth = async () => {
    const [event] = await once(listener, 'gatewayAuthenticated', { signal: AbortSignal.timeout(20_000) });
    assert.equal(event.gatewayId, gatewayId);
    return event.connection;
  };

  try {
    await driver.call('ready');
    const initialPid = process.env.NODE_GOBLIN_MANAGER_PID;
    pid = initialPid ? Number(initialPid) : open().child.pid;
    await track(pid, exe);
    const initialWindow = await expectWindow();
    const probe = path.join(dir, 'desktop-probe.json');
    await checkExit(launch('powershell.exe', powershell(script('./windows-desktop-probe.ps1'), '-ResultPath', probe)),
      'Interactive desktop probe failed');
    const desktopProbe = JSON.parse(fs.readFileSync(probe, 'utf8'));
    assert.equal(desktopProbe.state, 'interactive_non_elevated_capture_verified', 'Requires an unlocked standard-user desktop');

    const key = path.join(dir, 'key.pem');
    const cert = path.join(dir, 'cert.pem');
    const gitBins = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
      .filter(Boolean).map(root => path.join(root, 'Git', 'usr', 'bin', 'openssl.exe'));
    const openssl = process.env.NODE_GOBLIN_TEST_OPENSSL || gitBins.find(file => fs.existsSync(file)) || 'openssl.exe';
    await checkExit(launch(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert],
    { windowsHide: true }), 'Disposable TLS certificate generation failed');
    listener = new GatewayControllerListener({ serverOptions: { key: fs.readFileSync(key), cert: fs.readFileSync(cert) } });
    const listening = once(listener, 'listening', { signal: AbortSignal.timeout(5000) });
    listener.listen(0, '127.0.0.1');
    await listening;

    await expectLabel('Stopped');
    assert.equal(await ui('enabled', start), false, 'Start must require explicit consent');
    await ui('set', 'Controller URL', `tls://127.0.0.1:${listener.server.address().port}`);
    await ui('set', 'Gateway ID', gatewayId);
    assert.equal(await ui('enabled', start), false, 'Editing settings must not grant consent');
    await ui('toggle', 'I grant Burrow the access described above');
    await ui('invoke', start);
    const approval = await until('No live pairing approval from the listener', () => listener.preparePendingApproval(gatewayId));
    await expectLabel('Pairing pending. Compare the current code in Burrow.');
    const shown = await until('Manager did not display a pairing code', () => ui('read', pairing));
    assert.ok(shown === approval.pairingCode, 'Displayed pairing code differs from the live Burrow approval');
    assert.equal(await ui('enabled', 'Confirm pairing on this computer'), false);
    await ui('toggle', 'This code matches the current code in Burrow');
    await ui('invoke', 'Confirm pairing on this computer');
    await expectLabel('Confirmed on this computer. Waiting for Burrow approval…');
    const firstAuth = waitAuth();
    firstAuth.catch(() => {});
    assert.equal(listener.commitPendingApproval(gatewayId, approval)?.status, 'approved');
    const firstConnection = await firstAuth;
    await expectLabel(authenticated);
    assert.ok(await ui('read', pairing) === '', 'Manager did not clear the pairing code');
    await writeThenRead('paired');
    t.diagnostic('NG_WINDOWS_MANAGER_PAIRING_VERIFIED: installed GUI paired and ran PowerShell/files');

    assert.equal(await desktopState(), 'desktop_disabled');
    assert.equal((await desktop('screenshot')).error?.code, 'desktop_disabled');
    await ui('invoke', enableDesktop);
    await until('Desktop consent did not enable the helper', async () => await desktopState() === 'available', 35_000);
    await expectLabel('Desktop access is enabled for this connection.');
    const ready = path.join(dir, 'fixture-ready.txt');
    const marker = path.join(dir, 'fixture-invoked.txt');
    const fixtureScript = script('./windows-desktop-app.ps1');
    fixture = launch('powershell.exe', powershell(fixtureScript, '-Marker', marker, '-Ready', ready));
    await until('Owned desktop fixture did not open', () => fs.existsSync(ready));
    const fixtureId = fs.readFileSync(ready, 'utf8');
    assert.match(fixtureId, new RegExp(`^${fixture.child.pid}:\\d+$`));
    await until('Helper did not enumerate the owned fixture', async () => (await desktop('windows')).result?.windows
      .some(window => window.windowId === fixtureId && window.title === 'Node Goblin disposable application'));
    const capture = (await desktop('screenshot')).result;
    assert.equal(capture?.mimeType, 'image/jpeg');
    const jpeg = Buffer.from(capture.data, 'base64');
    assert.ok(jpeg.length > 1024 && jpeg.readUInt16BE(0) === 0xffd8 && jpeg.readUInt16BE(jpeg.length - 2) === 0xffd9,
      'Desktop helper did not return a JPEG capture');
    assert.equal(await driver.call('compareCapture', { pid: fixture.child.pid, handle: fixtureId.split(':')[1], jpeg: capture.data }),
      true, 'JPEG did not match the visible fixture region on the primary display');
    const control = (await desktop('inspect', { windowId: fixtureId })).result?.controls
      .find(item => item.enabled && item.name === 'Write harmless proof');
    assert.ok(control, 'Desktop fixture button was not inspectable');
    assert.equal((await desktop('invoke', { windowId: fixtureId, controlId: control.controlId })).result?.invoked, true);
    await until('Desktop fixture button did not write its marker', () => fs.existsSync(marker));
    assert.equal(fs.readFileSync(marker, 'utf8'), 'invoked in the Windows app');
    await checkExit(launch('powershell.exe', powershell(fixtureScript, '-StopHelper'), { windowsHide: true }),
      'Could not invoke the visible desktop helper Stop button');
    await expectLabel('Desktop access is off. The helper stopped or is unavailable.');
    // After detecting helper exit the manager adapter replaces it with a disabled instance.
    assert.equal(await desktopState(), 'desktop_disabled');
    assert.equal((await desktop('screenshot')).error?.code, 'desktop_disabled');
    await writeThenRead('after-desktop-stop');
    t.diagnostic('NG_WINDOWS_MANAGER_DESKTOP_VERIFIED: desktop opt-in, JPEG, owned app invoke and local revocation');

    await ui('close');
    await until('Closing the manager did not hide its window', async () => await visible() === 0);
    assert.ok(listener.liveGateway(gatewayId) === firstConnection, 'Closing the window lost the authenticated connection');
    await writeThenRead('tray');
    await checkExit(open(), 'Second manager invocation did not exit');
    assert.equal(await expectWindow(), initialWindow, 'Second launch did not reopen the original manager window');
    await expectLabel(authenticated);
    assert.ok(listener.liveGateway(gatewayId) === firstConnection, 'Second invocation replaced the gateway connection');

    const worker = await gatewayPid('first-worker');
    const stopProbe = {
      operationId: 'manager-stop-probe', executable: node, timeoutMs: 90_000,
      args: ['-e', "require('node:fs').writeFileSync('stop-pid', String(process.pid)); setInterval(() => {}, 1000)"],
    };
    const pendingStop = dispatch(stopProbe);
    pendingStop.catch(() => {});
    const stopFile = path.join(dir, 'stop-pid');
    const stopPid = await until('Stop probe did not start', () => fs.existsSync(stopFile) && Number(fs.readFileSync(stopFile, 'utf8')));
    await track(stopPid, node);
    await ui('invoke', 'Stop gateway');
    await expectLabel('Stopped');
    await expectExit(stopPid, 'Stop gateway did not cancel the running process');
    await expectExit(worker, 'Stop gateway did not exit the gateway worker');
    await until('Stop gateway did not disconnect the transport', () => !listener.liveGateway(gatewayId));
    await ui('toggle', 'Start Node Goblin on Windows sign-in');
    const command = await driver.call('registry');
    assert.equal(command, `"${exe}" --background`);
    await shutdown();
    await expectExit(pid, 'First manager did not exit');

    let pendingPairings = 0;
    listener.on('gatewayPairingPending', () => pendingPairings++);
    const backgroundAuth = waitAuth();
    backgroundAuth.catch(() => {});
    // The exact installed registry command is checked above before executing it.
    pid = open(command.slice(command.lastIndexOf(' ') + 1)).child.pid;
    await track(pid, exe);
    await backgroundAuth;
    assert.equal(pendingPairings, 0, 'Sign-in launch attempted to pair again');
    assert.equal(await visible(), 0, 'Sign-in launch opened the manager window');
    assert.equal(await desktopState(), 'desktop_disabled');
    assert.equal((await desktop('screenshot')).error?.code, 'desktop_disabled');
    const replay = (await dispatch(stopProbe)).response.result;
    assert.equal(replay?.replay, true, 'Stopped work was not recorded as a completed operation');
    assert.equal(replay.outcome?.cancelled, true, 'The running operation was not cancelled by Stop gateway');
    await writeThenRead('sign-in');
    await checkExit(open(), 'Opening the background manager did not exit the second invocation');
    await expectWindow();
    await expectLabel(authenticated);
    await expectLabel('Desktop access is off. Enabling it lets Burrow view and interact with this Windows desktop.');

    const backgroundWorker = await gatewayPid('background-worker');
    // The launcher exits before shutdown, leaving an owned descendant for the
    // job to reap. A live-request cancellation alone cannot terminate this one.
    const descendant = await outcome({
      operationId: 'shutdown-descendant', executable: node,
      args: ['-e', `const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
        child.on('spawn', () => { console.log(child.pid); child.unref(); });`],
    });
    assert.equal(descendant?.ok, true, 'Descendant launcher did not finish');
    const descendantPid = Number(descendant.stdout.trim());
    await track(descendantPid, node);
    assert.equal(await driver.call('exited', { pid: descendantPid }), false, 'Shutdown descendant was never alive');
    await shutdown();
    await expectExit(pid, '--shutdown left the manager running');
    await expectExit(backgroundWorker, '--shutdown left the gateway worker running');
    await expectExit(descendantPid, '--shutdown left an owned descendant running');
    await until('--shutdown did not disconnect the transport', () => !listener.liveGateway(gatewayId));
    t.diagnostic('NG_WINDOWS_MANAGER_LIFECYCLE_VERIFIED: tray, singleton reopen, cancellation, sign-in trust and job shutdown');
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    const clean = async operation => {
      try { await operation(); } catch (error) { cleanupErrors.push(error); }
    };
    if (pid && owned.has(pid)) await clean(shutdown);
    for (const processId of owned) await clean(() => driver.call('terminate', { pid: processId }));
    if (fixture) {
      fixture.child.kill();
      await clean(() => fixture.exit);
    }
    await clean(() => listener?.close());
    await clean(() => driver.close());
    await clean(() => fs.rmSync(dir, { recursive: true, force: true }));
    if (cleanupErrors.length) {
      if (!primaryError) throw new AggregateError(cleanupErrors, 'Native fixture cleanup failed');
      t.diagnostic(`Native fixture cleanup reported ${cleanupErrors.length} error(s)`);
    }
  }
});
