import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const gateway = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const build = path.join(gateway, 'deploy/build-release.sh');

test('calendar release is deterministic and directly installable', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-release-'));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-install-'));
  try {
    const env = { ...process.env, SOURCE_DATE_EPOCH: '0' };
    let result = spawnSync(build, [out], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    const version = fs.readFileSync(path.join(gateway, 'VERSION'), 'utf8').trim();
    assert.match(version, /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/);
    const artifact = path.join(out, `node-goblin-${version}.tar.gz`);
    const first = fs.readFileSync(artifact);
    result = spawnSync(build, [out], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(artifact), first);
    result = spawnSync('tar', ['-xzf', artifact, '-C', out], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const packageRoot = path.join(out, `node-goblin-${version}`);
    result = spawnSync(path.join(packageRoot, 'deploy/install.sh'), ['--source', packageRoot, '--root', stage, '--skip-account', '--no-systemd'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(stage, 'opt/burrow-host-gateway/VERSION'), 'utf8').trim(), version);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
