import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const gateway = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-update-'));
  const root = path.join(dir, 'root'); fs.mkdirSync(root);
  const calls = path.join(dir, 'calls'); const counter = path.join(dir, 'restarts');
  const systemctl = path.join(dir, 'systemctl');
  fs.writeFileSync(systemctl, `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$CALLS"
case "$1:\${2:-}" in
show:--property=LoadState) echo loaded;;
show:--property=ActiveState) echo inactive;;
stop:*) [ "\${FAIL_STOP:-}" != yes ];;
restart:*)
 n=$(cat "$COUNTER" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$COUNTER"
 if [ "\${FAIL_RESTART:-}" = yes ] && [ "$n" = 1 ]; then exit 1; fi;;
is-active:*)
 if [ "\${FAIL_ACTIVE:-}" = yes ] && [ "$(cat "$COUNTER")" = 1 ]; then exit 1; fi;;
esac
`, { mode: 0o755 });
  const env = { ...process.env, BURROW_GATEWAY_ROOT: root, SYSTEMCTL: systemctl, CALLS: calls, COUNTER: counter };
  const run = (script, args = [], extra = {}) => spawnSync('sh', [path.join(gateway, 'deploy', script), '--root', root, '--skip-account', ...args], { env: { ...env, ...extra }, encoding: 'utf8' });
  assert.equal(run('install.sh', ['--no-systemd']).status, 0);
  const installed = path.join(root, 'opt/burrow-host-gateway');
  fs.writeFileSync(path.join(installed, 'prior-marker'), 'prior');
  const config = path.join(root, 'etc/burrow-host-gateway/gateway.env');
  fs.writeFileSync(config, 'BURROW_GATEWAY_CONTROLLER_URL=tls://controller:7443\nBURROW_GATEWAY_ID=test-node\n');
  const identity = path.join(root, 'var/lib/burrow-host-gateway/node-identity.json');
  fs.writeFileSync(identity, 'preserved identity and trust');
  return { dir, root, installed, config, identity, calls, run, clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
test('update stops, installs and restarts without changing config/trust', () => {
  const f = fixture();
  try {
    const config = fs.readFileSync(f.config);
    const result = f.run('update.sh');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /installed and service restarted/);
    assert.equal(fs.existsSync(path.join(f.installed, 'prior-marker')), false);
    assert.deepEqual(fs.readFileSync(f.config), config);
    assert.equal(fs.readFileSync(f.identity, 'utf8'), 'preserved identity and trust');
    assert.match(fs.readFileSync(f.calls, 'utf8'), /stop burrow-host-gateway.service[\s\S]*daemon-reload[\s\S]*restart burrow-host-gateway.service[\s\S]*is-active --quiet/);
  } finally { f.clean(); }
});
for (const failure of ['FAIL_RESTART', 'FAIL_ACTIVE', 'FAIL_STOP']) test(`update ${failure} fails and recovers prior runtime`, () => {
  const f = fixture();
  try {
    const result = f.run('update.sh', [], { [failure]: 'yes' });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /installed and service restarted/);
    assert.equal(fs.readFileSync(path.join(f.installed, 'prior-marker'), 'utf8'), 'prior');
    assert.equal(fs.readFileSync(f.identity, 'utf8'), 'preserved identity and trust');
    const restarts = fs.readFileSync(f.calls, 'utf8').match(/^restart /gm) ?? [];
    assert.equal(restarts.length, failure === 'FAIL_STOP' ? 1 : 2);
    if (failure !== 'FAIL_STOP') assert.match(result.stderr, /restored previous package/);
  } finally { f.clean(); }
});
test('invalid update prerequisites never touch the service', () => {
  for (const scenario of ['absent', 'unconfigured', 'invalid', 'no-systemd']) {
    const f = fixture();
    try {
      const args = [];
      if (scenario === 'absent') fs.rmSync(path.join(f.installed, 'VERSION'));
      if (scenario === 'unconfigured') fs.writeFileSync(f.config, '');
      if (scenario === 'invalid') {
        const source = path.join(f.dir, 'source'); fs.cpSync(gateway, source, { recursive: true });
        fs.rmSync(path.join(source, 'lib/daemon.mjs')); args.push('--source', source);
      }
      if (scenario === 'no-systemd') args.push('--no-systemd');
      assert.notEqual(f.run('update.sh', args).status, 0, scenario);
      assert.equal(fs.existsSync(f.calls), false, scenario);
      assert.equal(fs.readFileSync(path.join(f.installed, 'prior-marker'), 'utf8'), 'prior');
    } finally { f.clean(); }
  }
});
