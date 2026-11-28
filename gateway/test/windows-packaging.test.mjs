import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const gateway = fileURLToPath(new URL('..', import.meta.url));
const scripts = path.join(gateway, 'deploy', 'windows');
const windows = process.platform === 'win32';
const powershell = windows ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
const psArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const quoted = value => `'${value.replaceAll("'", "''")}'`;
function run(env, name, ...args) {
  return spawnSync(powershell, [...psArgs, '-File', path.join(scripts, name), ...args], { env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
}
function ok(result) {
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
}
function rejected(result, pattern) {
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr + result.stdout, pattern);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-package-'));
  const source = path.join(root, 'source gateway');
  fs.mkdirSync(source);
  // Deliberately do not copy the repository recursively into this fixture.
  for (const name of fs.readdirSync(gateway)) {
    if (name.endsWith('.mjs') && !name.endsWith('.test.mjs') || ['VERSION', 'package.json'].includes(name)) {
      fs.copyFileSync(path.join(gateway, name), path.join(source, name));
    }
  }
  fs.cpSync(path.join(gateway, 'lib'), path.join(source, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(source, 'deploy', 'windows'), { recursive: true });
  for (const name of fs.readdirSync(scripts)) fs.copyFileSync(path.join(scripts, name), path.join(source, 'deploy', 'windows', name));
  const local = path.join(root, 'local');
  fs.mkdirSync(local);
  const base = path.join(local, 'NodeGoblin');
  const runtime = path.join(base, 'runtime');
  const env = { ...process.env, LOCALAPPDATA: local };
  return { root, source, base, runtime, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }) };
}

test('Windows packaging static contract: explicit files, protected layout, no recursive copy/delete or provisioning', () => {
  const common = fs.readFileSync(path.join(scripts, 'package-common.ps1'), 'utf8');
  assert.match(common, /Join-Path \$script:Base 'runtime'/);
  assert.match(common, /ReparsePoint/);
  assert.match(common, /Get-CimInstance Win32_Process/);
  assert.match(common, /\^v24/);
  assert.match(common, /SetAccessRuleProtection\(\$true,\$false\)/);
  assert.match(common, /Source and installation data must not overlap/);
  assert.match(common, /Move\(\$backup,\$script:Runtime\)/);
  assert.match(common, /Unowned runtime file/);
  assert.doesNotMatch(common, /-Recurse|Copy-Item|Remove-Item|Stop-Process|taskkill|New-Service|Start-Service|Register-ScheduledTask|npm install|Invoke-WebRequest/i);
  for (const name of ['install', 'update', 'uninstall']) {
    const entry = fs.readFileSync(path.join(scripts, `${name}.ps1`), 'utf8');
    assert.match(entry, new RegExp(`Invoke-PackageOperation '${name}'`));
    assert.doesNotMatch(entry, /EnableDesktop|Start-Process|node-goblin.ps1.*run/);
  }
});

test('selected runtime inventory passes syntax and dependency checks on this host (not Windows proof)', () => {
  const f = fixture();
  try {
    const modules = [
      ...fs.readdirSync(f.source).filter(name => name.endsWith('.mjs')).map(name => path.join(f.source, name)),
      ...fs.readdirSync(path.join(f.source, 'lib')).map(name => path.join(f.source, 'lib', name)),
    ];
    for (const module of modules) execFileSync(process.execPath, ['--check', module], { stdio: 'pipe' });
    execFileSync(process.execPath, ['--input-type=module', '-e', "import {pathToFileURL} from 'node:url'; await import(pathToFileURL(process.argv[1]))", path.join(f.source, 'index.mjs')], { stdio: 'pipe' });
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.source, 'package.json'))).version, fs.readFileSync(path.join(f.source, 'VERSION'), 'utf8').trim());
  } finally { f.cleanup(); }
});

test('native Windows install/update/uninstall preserve data, reject unsafe inputs and retain old code after validation failure', { skip: !windows, timeout: 180_000 }, () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.source, 'secret.env'), 'must not copy');
    fs.mkdirSync(path.join(f.source, 'state'));
    fs.writeFileSync(path.join(f.source, 'state', 'identity.json'), 'must not copy');
    ok(run(f.env, 'install.ps1', '-Source', f.source));
    assert.ok(fs.existsSync(path.join(f.runtime, 'cli.mjs')));
    assert.ok(!fs.existsSync(path.join(f.runtime, 'secret.env')));
    assert.ok(!fs.existsSync(path.join(f.runtime, 'state')));
    const launcher = path.join(f.runtime, 'deploy', 'windows', 'node-goblin.ps1');
    ok(spawnSync(powershell, [...psArgs, '-File', launcher, 'configure', '-Controller', 'tls://127.0.0.1:7443', '-GatewayId', 'packaging-test'], { env: f.env, encoding: 'utf8', timeout: 15_000 }));
    const config = path.join(f.base, 'config', 'gateway.env');
    const state = path.join(f.base, 'state');
    fs.writeFileSync(path.join(state, 'node-identity.json'), 'retained identity fixture');
    fs.writeFileSync(path.join(state, 'operations.json'), 'retained journal fixture');
    const data = [config, ...fs.readdirSync(state).map(name => path.join(state, name))];
    const snapshots = data.map(file => fs.readFileSync(file));
    const acl = file => execFileSync(powershell, [...psArgs, '-Command', `[IO.File]::GetAccessControl(${quoted(file)}).Sddl`], { encoding: 'utf8' }).trim();
    const acls = data.map(acl);
    rejected(run(f.env, 'install.ps1', '-Source', f.source), /already exists/);
    rejected(run(f.env, 'update.ps1', '-Source', f.runtime), /must not overlap/);
    rejected(run(f.env, 'update.ps1', '-Source', f.env.LOCALAPPDATA), /must not overlap/);
    const before = fs.readFileSync(path.join(f.runtime, 'index.mjs'), 'utf8');
    const next = fs.readFileSync(path.join(f.source, 'index.mjs'), 'utf8') + '\n// replacement marker\n';
    fs.writeFileSync(path.join(f.source, 'index.mjs'), "import './missing-runtime-module.mjs';\n");
    rejected(run(f.env, 'update.ps1', '-Source', f.source), /dependency graph does not load/);
    assert.equal(fs.readFileSync(path.join(f.runtime, 'index.mjs'), 'utf8'), before);
    assert.ok(!fs.readdirSync(f.base).some(name => name.startsWith('.stage-')));
    fs.writeFileSync(path.join(f.source, 'index.mjs'), next);
    fs.writeFileSync(path.join(f.runtime, 'unrelated.txt'), 'leave alone');
    rejected(run(f.env, 'update.ps1', '-Source', f.source), /Unowned runtime file/);
    rejected(run(f.env, 'uninstall.ps1'), /Unowned runtime file/);
    assert.equal(fs.readFileSync(path.join(f.runtime, 'unrelated.txt'), 'utf8'), 'leave alone');
    fs.unlinkSync(path.join(f.runtime, 'unrelated.txt'));
    ok(run(f.env, 'update.ps1', '-Source', f.source));
    assert.equal(fs.readFileSync(path.join(f.runtime, 'index.mjs'), 'utf8'), next);
    for (let i = 0; i < data.length; i++) {
      assert.deepEqual(fs.readFileSync(data[i]), snapshots[i]);
      assert.equal(acl(data[i]), acls[i], 'packaging modified a data ACL');
    }
    const runtimeAcl = execFileSync('icacls.exe', [f.runtime], { encoding: 'utf8' });
    assert.doesNotMatch(runtimeAcl, /\b(?:Everyone|Authenticated Users|BUILTIN\\Users):/i);
    fs.writeFileSync(path.join(f.base, 'unrelated.txt'), 'preserve sibling');
    ok(run(f.env, 'uninstall.ps1'));
    assert.ok(!fs.existsSync(f.runtime));
    for (let i = 0; i < data.length; i++) assert.deepEqual(fs.readFileSync(data[i]), snapshots[i]);
    assert.equal(fs.readFileSync(path.join(f.base, 'unrelated.txt'), 'utf8'), 'preserve sibling');
    ok(run(f.env, 'uninstall.ps1'));
    ok(run(f.env, 'install.ps1', '-Source', f.source));
    for (let i = 0; i < data.length; i++) assert.deepEqual(fs.readFileSync(data[i]), snapshots[i]);
  } finally { f.cleanup(); }
});

test('native Windows rejects source/destination junctions, unexpected ACLs, missing Node and unowned runtime', { skip: !windows, timeout: 120_000 }, () => {
  const f = fixture();
  try {
    const missingNode = { ...f.env, PATH: '' };
    rejected(run(missingNode, 'install.ps1', '-Source', f.source), /node.exe/);
    assert.ok(!fs.existsSync(f.runtime));
    const library = path.join(f.source, 'lib');
    const outside = path.join(f.root, 'outside');
    fs.renameSync(library, outside);
    fs.symlinkSync(outside, library, 'junction');
    rejected(run(f.env, 'install.ps1', '-Source', f.source), /reparse point/);
    fs.rmdirSync(library);
    fs.symlinkSync(path.join(f.root, 'missing-target'), library, 'junction');
    rejected(run(f.env, 'install.ps1', '-Source', f.source), /reparse point|Cannot find|Could not find|does not exist/);
    fs.rmdirSync(library);
    fs.renameSync(outside, library);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'untouched');
    fs.symlinkSync(outside, f.runtime, 'junction');
    rejected(run(f.env, 'install.ps1', '-Source', f.source), /already exists|reparse point/);
    rejected(run(f.env, 'uninstall.ps1'), /reparse point/);
    assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'untouched');
    fs.rmdirSync(f.runtime);
    fs.mkdirSync(f.runtime);
    rejected(run(f.env, 'uninstall.ps1'), /unowned runtime/);
    fs.rmdirSync(f.runtime);
    ok(run(f.env, 'install.ps1', '-Source', f.source));
    execFileSync('icacls.exe', [f.runtime, '/grant', '*S-1-1-0:(R)'], { stdio: 'pipe' });
    rejected(run(f.env, 'update.ps1', '-Source', f.source), /Unexpected ACL entry/);
    rejected(run(f.env, 'uninstall.ps1'), /Unexpected ACL entry/);
    execFileSync('icacls.exe', [f.runtime, '/remove:g', '*S-1-1-0'], { stdio: 'pipe' });
    ok(run(f.env, 'uninstall.ps1'));
  } finally { f.cleanup(); }
});

test('native Windows refuses a live installed gateway without killing it', { skip: !windows, timeout: 90_000 }, async () => {
  const f = fixture();
  let child, done;
  try {
    ok(run(f.env, 'install.ps1', '-Source', f.source));
    // A real installed CLI process, using its ordinary foreground stdio mode.
    child = spawn(process.execPath, [path.join(f.runtime, 'cli.mjs')], { env: { ...f.env, BURROW_GATEWAY_CONTROLLER_URL: '' }, stdio: ['pipe', 'ignore', 'pipe'] });
    done = once(child, 'exit');
    await delay(500);
    assert.equal(child.exitCode, null);
    rejected(run(f.env, 'update.ps1', '-Source', f.source), /Target gateway is running/);
    rejected(run(f.env, 'uninstall.ps1'), /Target gateway is running/);
    assert.equal(child.exitCode, null, 'packaging killed the gateway');
    child.stdin.end();
    await Promise.race([done, delay(5000, undefined, { ref: false }).then(() => { throw new Error('CLI did not stop after stdin closed'); })]);
    ok(run(f.env, 'uninstall.ps1'));
  } finally {
    if (child && child.exitCode === null) { child.kill(); await done; }
    f.cleanup();
  }
});

test('native Windows replacement failure restores prior runtime using a real staged-file lock', { skip: !windows, timeout: 90_000 }, () => {
  const f = fixture();
  try {
    ok(run(f.env, 'install.ps1', '-Source', f.source));
    const before = fs.readFileSync(path.join(f.runtime, 'index.mjs'), 'utf8');
    fs.appendFileSync(path.join(f.source, 'index.mjs'), '\n// must not replace the old version\n');
    // Fault injection only controls when to take an actual Windows file handle.
    // No filesystem operation, ACL check, Node execution or process query is mocked.
    const command = `
      . ${quoted(path.join(scripts, 'package-common.ps1'))}
      $originalValidation = (Get-Command Assert-RuntimePackage).ScriptBlock
      function Assert-RuntimePackage([string]$Path, [string[]]$Files) {
        & $originalValidation $Path $Files
        $script:heldFile = [IO.File]::Open((Join-Path $Path 'cli.mjs'),'Open','Read','Read')
      }
      $failed = $false
      try { Invoke-PackageOperation 'update' ${quoted(f.source)} }
      catch { $failed = $true }
      finally { if ($script:heldFile) { $script:heldFile.Dispose() } }
      if (-not $failed) { throw 'Expected Windows rename refusal for the locked staged file.' }
      foreach ($stage in Get-ChildItem -LiteralPath ${quoted(f.base)} -Filter '.stage-*') { Remove-OwnedRuntime $stage.FullName }
    `;
    ok(spawnSync(powershell, [...psArgs, '-Command', command], { env: f.env, encoding: 'utf8', timeout: 60_000 }));
    assert.equal(fs.readFileSync(path.join(f.runtime, 'index.mjs'), 'utf8'), before);
    assert.ok(!fs.readdirSync(f.base).some(name => name.startsWith('.backup-') || name.startsWith('.stage-')));
    ok(run(f.env, 'uninstall.ps1'));
  } finally { f.cleanup(); }
});

// Classification only: real native installed-process refusal is exercised above.
test('Windows process visibility ignores inaccessible foreign processes but refuses an unreadable known own process', { skip: !windows }, () => {
  const command = `
    . ${quoted(path.join(scripts, 'package-common.ps1'))}
    $script:Runtime = 'C:\\fixture\\runtime'
    function Get-CimInstance { [PSCustomObject]@{ CommandLine=$null } }
    function Invoke-CimMethod { throw 'Foreign process access denied' }
    Assert-GatewayStopped
    function Invoke-CimMethod { [PSCustomObject]@{ ReturnValue=0; Sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value } }
    $rejected=$false
    try { Assert-GatewayStopped } catch { if ($_.Exception.Message -like '*current-user Node*') { $rejected=$true } else { throw } }
    if (-not $rejected) { throw 'Unreadable own process was not rejected' }
  `;
  ok(spawnSync(powershell, [...psArgs, '-Command', command], { encoding: 'utf8', timeout: 15_000 }));
});
