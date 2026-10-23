import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = path.resolve('..', 'install.sh');

test('Mini Node Goblin bootstrap uses this repository release authority', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /REPOSITORY=.*NightShaman\/Node-Goblin/);
  assert.match(text, /releases\/download\/v\$VERSION/);
  assert.match(text, /sha256sum -c/);
  assert.match(text, /releases\/latest/);
  assert.match(text, /YYYY\.MM\.DD\[\.N\]/);
  assert.match(text, /--controller and --node-id must be supplied together/);
  assert.doesNotMatch(text, /GoblinKing-Burrow\/Burrow|ENROLLMENT_TOKEN|PRIVATE_KEY|PASSWORD/);
  const syntax = spawnSync('sh', ['-n', script], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

test('Mini Node Goblin bootstrap help is usable without network access', () => {
  const result = spawnSync('sh', [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /--version YYYY\.MM\.DD\[\.N\]/);
  assert.match(result.stderr, /sudo node-goblin configure/);
});

test('selected revisioned release is verified and passed to its package installer', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-bootstrap-'));
  try {
    const bin = path.join(tmp, 'bin'); fs.mkdirSync(bin);
    const name = 'node-goblin-2026.10.18.2';
    const root = path.join(tmp, name); fs.mkdirSync(path.join(root, 'deploy'), { recursive: true });
    fs.writeFileSync(path.join(root, 'deploy/install.sh'), '#!/bin/sh\nset -eu\n[ "$1" = --source ]\n[ "$2" = "$(dirname "$(dirname "$0")")" ]\nprintf "source-verified\\n" >> "$RECEIPT"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'deploy/update.sh'), '#!/bin/sh\nset -eu\n[ "$1" = --source ]\nprintf "update-and-restart\\n" >> "$RECEIPT"\n', { mode: 0o755 });
    const archive = path.join(tmp, `${name}.tar.gz`);
    assert.equal(spawnSync('tar', ['-czf', archive, '-C', tmp, name]).status, 0);
    const digest = spawnSync('sha256sum', [archive], { encoding: 'utf8' }).stdout.split(' ')[0];
    fs.writeFileSync(`${archive}.sha256`, `${digest}  ${name}.tar.gz\n`);
    fs.writeFileSync(path.join(bin, 'id'), '#!/bin/sh\necho 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$URL_LOG"
case "$2" in
 https://github.com/NightShaman/Node-Goblin/releases/download/v2026.10.18.2/${name}.tar.gz) cp "$FIXTURE" "$4" ;;
 https://github.com/NightShaman/Node-Goblin/releases/download/v2026.10.18.2/${name}.tar.gz.sha256) cp "$FIXTURE.sha256" "$4" ;;
 *) echo 'unexpected release authority' >&2; exit 42 ;;
esac
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE_GOBLIN_VERSION: '2026.10.18.2', FIXTURE: archive, URL_LOG: path.join(tmp, 'urls'), RECEIPT: path.join(tmp, 'receipt') };
    const run = (args = [], extra = {}) => spawnSync('sh', [script, ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
    const incomplete = run(['--controller', 'host:123']);
    assert.equal(incomplete.status, 2); assert.equal(fs.existsSync(env.URL_LOG), false);
    const invalid = run(['--version', '2026.10.18.0']);
    assert.equal(invalid.status, 2); assert.equal(fs.existsSync(env.URL_LOG), false);
    const wrong = run([], { NODE_GOBLIN_REPOSITORY: 'NightShaman/Burrow' });
    assert.equal(wrong.status, 42); assert.equal(fs.existsSync(env.RECEIPT), false);
    const conflicting = run(['--update', '--controller', 'host:123', '--node-id', 'node']);
    assert.equal(conflicting.status, 2);
    assert.equal(fs.existsSync(env.RECEIPT), false);
    const good = run(); assert.equal(good.status, 0, good.stderr);
    assert.equal(fs.readFileSync(env.RECEIPT, 'utf8'), 'source-verified\n');
    const updated = run(['--update']);
    assert.equal(updated.status, 0, updated.stderr);
    assert.equal(fs.readFileSync(env.RECEIPT, 'utf8'), 'source-verified\nupdate-and-restart\n');
    assert.doesNotMatch(updated.stdout, /Next:.*configure/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
