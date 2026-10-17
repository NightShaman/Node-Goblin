import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const gateway = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-lifecycle-'));
  const root = path.join(dir, 'root'); const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin); fs.mkdirSync(root);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, BURROW_GATEWAY_ROOT: root };
  const run = (script, args = [], extra = {}) => spawnSync('sh', [path.join(gateway, 'deploy', script), ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  const stub = (name, text) => { const file = path.join(bin, name); fs.writeFileSync(file, `#!/bin/sh\n${text}\n`, { mode: 0o755 }); return file; };
  return { dir, root, bin, env, run, stub, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('installer rejects partial producer/consumer copies and rolls back post-switch failure', () => {
  const f = fixture();
  try {
    const args = ['--root', f.root, '--skip-account', '--no-systemd'];
    assert.equal(f.run('install.sh', args).status, 0);
    const installed = path.join(f.root, 'opt/burrow-host-gateway');
    fs.writeFileSync(path.join(installed, 'old-marker'), 'prior runtime');
    const operator = path.join(f.root, 'usr/local/bin/node-goblin');
    const prior = fs.readFileSync(operator);
    const realTar = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
    for (const body of [
      `"${realTar}" "$@"; exit 31`,
      `case " $* " in *" -xf "*) exit 32;; esac\nexec "${realTar}" "$@"`,
      `case " $* " in *" -cf "*) exec "${realTar}" --exclude=./lib/daemon.mjs "$@";; esac\nexec "${realTar}" "$@"`,
    ]) {
      f.stub('tar', body);
      assert.notEqual(f.run('install.sh', args).status, 0);
      assert.equal(fs.readFileSync(path.join(installed, 'old-marker'), 'utf8'), 'prior runtime');
      assert.deepEqual(fs.readFileSync(operator), prior);
    }
    fs.unlinkSync(path.join(f.bin, 'tar'));
    f.stub('install', 'exit 33');
    const failed = f.run('install.sh', args);
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /restored previous/);
    assert.equal(fs.readFileSync(path.join(installed, 'old-marker'), 'utf8'), 'prior runtime');
    assert.deepEqual(fs.readFileSync(operator), prior);
    fs.unlinkSync(path.join(f.bin, 'install'));
    const source = path.join(f.dir, 'source'); fs.cpSync(gateway, source, { recursive: true });
    fs.unlinkSync(path.join(source, 'deploy/node-goblin'));
    assert.notEqual(f.run('install.sh', [...args, '--source', source]).status, 0);
    assert.equal(fs.existsSync(path.join(installed, 'old-marker')), true);
  } finally { f.clean(); }
});

test('package validation rejects incomplete dependency graphs and preserves the installed package', () => {
  const f = fixture();
  try {
    const args = ['--root', f.root, '--skip-account', '--no-systemd'];
    assert.equal(f.run('install.sh', args).status, 0);
    const installed = path.join(f.root, 'opt/burrow-host-gateway');
    fs.writeFileSync(path.join(installed, 'old-marker'), 'prior runtime');
    for (const mutate of [
      (source) => fs.rmSync(path.join(source, 'lib/output-frame.mjs')),
      (source) => fs.writeFileSync(path.join(source, 'package.json'), '{broken'),
      (source) => fs.writeFileSync(path.join(source, 'VERSION'), 'invalid\n'),
      (source) => {
        fs.rmSync(path.join(source, 'lib/output-frame.mjs'));
        fs.symlinkSync('/etc/passwd', path.join(source, 'lib/output-frame.mjs'));
      },
    ]) {
      const source = fs.mkdtempSync(path.join(f.dir, 'source-'));
      fs.cpSync(gateway, source, { recursive: true });
      mutate(source);
      assert.notEqual(f.run('install.sh', [...args, '--source', source]).status, 0);
      assert.equal(fs.readFileSync(path.join(installed, 'old-marker'), 'utf8'), 'prior runtime');
    }
  } finally { f.clean(); }
});

test('builder failure never publishes an archive or checksum', () => {
  const f = fixture();
  try {
    f.stub('tar', 'exit 34');
    const out = path.join(f.dir, 'output');
    assert.notEqual(f.run('build-release.sh', [out]).status, 0);
    assert.deepEqual(fs.readdirSync(out), []);
  } finally { f.clean(); }
});

test('service stop is a prerequisite for unpair and uninstall, including absent/inactive states', () => {
  for (const action of ['unpair', 'uninstall']) for (const scenario of ['stop-fails', 'still-active', 'absent', 'inactive', 'stopped', 'unknown']) {
    const f = fixture();
    try {
      assert.equal(f.run('install.sh', ['--root', f.root, '--skip-account', '--no-systemd']).status, 0);
      const state = path.join(f.root, 'var/lib/burrow-host-gateway');
      const trust = path.join(state, 'controller-trust.json'); fs.writeFileSync(trust, 'prior trust');
      const systemctl = f.stub('systemctl-stub', `
case "$1:$2" in
show:--property=LoadState) ${scenario === 'unknown' ? 'exit 1' : `echo ${scenario === 'absent' ? 'not-found' : 'loaded'}`};;
show:--property=ActiveState) echo ${scenario === 'still-active' ? 'active' : 'inactive'};;
stop:*) exit ${scenario === 'stop-fails' ? '1' : '0'};;
esac`);
      const result = action === 'unpair' ? f.run('node-goblin', ['unpair'], { SYSTEMCTL: systemctl }) : f.run('uninstall.sh', ['--root', f.root], { SYSTEMCTL: systemctl });
      const blocked = ['stop-fails', 'still-active', 'unknown'].includes(scenario);
      assert.equal(result.status === 0, !blocked, `${action}/${scenario}: ${result.stderr}`);
      assert.equal(fs.existsSync(path.join(f.root, 'opt/burrow-host-gateway')), action === 'unpair' || blocked);
      assert.equal(fs.existsSync(trust), action === 'uninstall' || blocked);
    } finally { f.clean(); }
  }
});

test('configure saves only; connect does not restart; explicit apply restarts and reports failures', () => {
  const f = fixture();
  try {
    const log = path.join(f.dir, 'calls');
    const systemctl = f.stub('systemctl-stub', `echo "$*" >>"${log}"\n[ "$1" != restart ] || [ "\${FAIL_RESTART:-}" != yes ]`);
    const env = { SYSTEMCTL: systemctl };
    const result = f.run('node-goblin', ['configure', 'controller:7443', 'node-1'], env);
    assert.equal(result.status, 0); assert.match(result.stdout, /saved, not applied/); assert.equal(fs.existsSync(log), false);
    assert.equal(f.run('node-goblin', ['connect'], env).status, 0);
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /restart/);
    assert.notEqual(f.run('node-goblin', ['apply'], env).status, 0);
    assert.equal(f.run('node-goblin', ['apply', '--restart'], env).status, 0);
    assert.match(fs.readFileSync(log, 'utf8'), /restart burrow-host-gateway.service/);
    const failed = f.run('node-goblin', ['apply', '--restart'], { ...env, FAIL_RESTART: 'yes' });
    assert.notEqual(failed.status, 0); assert.doesNotMatch(failed.stdout, /is active/);
  } finally { f.clean(); }
});

test('custom in-tree builder output is excluded and repeatable', () => {
  const f = fixture();
  try {
    const source = path.join(f.dir, 'source'); fs.cpSync(gateway, source, { recursive: true });
    const out = path.join(source, 'release-output');
    const build = () => spawnSync('sh', [path.join(source, 'deploy/build-release.sh'), out], { env: { ...f.env, SOURCE_DATE_EPOCH: '0' }, encoding: 'utf8' });
    assert.equal(build().status, 0);
    const archive = path.join(out, fs.readdirSync(out).find((file) => file.endsWith('.tar.gz')));
    const first = fs.readFileSync(archive);
    assert.equal(build().status, 0); assert.deepEqual(fs.readFileSync(archive), first);
  } finally { f.clean(); }
});
