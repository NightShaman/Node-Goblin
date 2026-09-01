import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const gateway = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const install = path.join(gateway, 'deploy', 'install.sh');
const uninstall = path.join(gateway, 'deploy', 'uninstall.sh');
function run(script, root, args = []) {
  const result = spawnSync(script, ['--root', root, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('host package installer stages idempotently without root or systemd and preserves config/state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-gateway-package-'));
  try {
    run(install, root, ['--skip-account', '--no-systemd']);
    const config = path.join(root, 'etc/burrow-host-gateway/gateway.env');
    const state = path.join(root, 'var/lib/burrow-host-gateway');
    const unit = path.join(root, 'etc/systemd/system/burrow-host-gateway.service');
    assert.equal(fs.existsSync(path.join(root, 'opt/burrow-host-gateway/cli.mjs')), true);
    const operatorCli = path.join(root, 'usr/local/bin/node-goblin');
    assert.equal(fs.existsSync(operatorCli), true);
    assert.equal(fs.readlinkSync(path.join(root, 'usr/local/bin/burrow-host-gateway')), 'node-goblin');
    assert.equal(fs.existsSync(unit), true);
    assert.match(fs.readFileSync(unit, 'utf8'), /User=burrow\nGroup=burrow/);
    assert.match(fs.readFileSync(unit, 'utf8'), /EnvironmentFile=-\/etc\/burrow-host-gateway\/gateway.env/);
    fs.writeFileSync(config, 'BURROW_GATEWAY_ENROLLMENT_TOKEN=not-in-a-command\n');
    const configured = spawnSync(operatorCli, ['configure', 'controller.internal:7443', 'kitchen-node'], {
      encoding: 'utf8', env: { ...process.env, BURROW_GATEWAY_ROOT: root },
    });
    assert.equal(configured.status, 0, configured.stderr);
    const configuredText = fs.readFileSync(config, 'utf8');
    assert.match(configuredText, /^BURROW_GATEWAY_ENROLLMENT_TOKEN=not-in-a-command$/m);
    assert.match(configuredText, /^BURROW_GATEWAY_CONTROLLER_URL=tls:\/\/controller\.internal:7443$/m);
    assert.match(configuredText, /^BURROW_GATEWAY_ID=kitchen-node$/m);
    assert.equal(fs.statSync(config).mode & 0o777, 0o640);
    fs.writeFileSync(path.join(state, 'controller-trust.json'), 'durable');
    run(install, root, ['--skip-account', '--no-systemd']);
    assert.equal(fs.readFileSync(config, 'utf8'), configuredText);
    assert.equal(fs.readFileSync(path.join(state, 'controller-trust.json'), 'utf8'), 'durable');
    run(uninstall, root, ['--no-systemd']);
    assert.equal(fs.existsSync(path.join(root, 'opt/burrow-host-gateway')), false);
    assert.equal(fs.existsSync(operatorCli), false);
    assert.equal(fs.existsSync(path.join(root, 'usr/local/bin/burrow-host-gateway')), false);
    assert.equal(fs.existsSync(unit), false);
    assert.equal(fs.existsSync(config), true);
    assert.equal(fs.existsSync(path.join(state, 'controller-trust.json')), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('deployment artifacts enforce dedicated account, outbound config, and no secret values', () => {
  const unit = fs.readFileSync(path.join(gateway, 'deploy/burrow-host-gateway.service'), 'utf8');
  const env = fs.readFileSync(path.join(gateway, 'deploy/gateway.env.example'), 'utf8');
  const script = fs.readFileSync(install, 'utf8');
  const operatorCli = fs.readFileSync(path.join(gateway, 'deploy/node-goblin'), 'utf8');
  assert.match(unit, /User=burrow/);
  assert.match(unit, /Group=burrow/);
  assert.match(unit, /BURROW_GATEWAY_STATE_DIR=\/var\/lib\/burrow-host-gateway/);
  assert.match(unit, /EnvironmentFile=-\/etc\/burrow-host-gateway\/gateway.env/);
  assert.match(script, /UID_VALUE=4226/);
  assert.match(script, /GID_VALUE=4226/);
  assert.match(script, /if getent passwd "\$NAME"/);
  assert.match(script, /existing user \$NAME must have \$NAME as its primary group/);
  assert.doesNotMatch(script, /user \$NAME exists with a different UID\/GID/);
  assert.match(env, /BURROW_GATEWAY_CONTROLLER_URL=tls:\/\//);
  assert.doesNotMatch(env, /BURROW_GATEWAY_ENROLLMENT_TOKEN=\S+/);
  assert.match(operatorCli, /enable --now/);
  assert.match(operatorCli, /is-active --quiet/);
  assert.doesNotMatch(operatorCli, /ENROLLMENT_TOKEN=.*\$[12]/);
});
