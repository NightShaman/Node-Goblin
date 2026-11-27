import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../deploy/windows/node-goblin.ps1', import.meta.url));
const windows = process.platform === 'win32';

test('Windows bootstrap has safe foreground-only commands and no token argument surface', () => {
  const source = fs.readFileSync(script, 'utf8');
  assert.match(source, /ValidateSet\('configure','run','pairing-code','confirm-pairing','help'\)/);
  assert.match(source, /BURROW_GATEWAY_STATE_DIR/);
  assert.match(source, /pairing-code\.json/);
  assert.match(source, /pairing-confirmation\.json/);
  assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(source, /ReparsePoint/);
  assert.doesNotMatch(source, /enrollment-token|--enrollment|Start-Service|New-Service|Register-ScheduledTask/i);
});

test('Windows bootstrap help runs under Windows PowerShell 5.1+', { skip: !windows }, () => {
  const result = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'help'], { encoding:'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /foreground/i);
});

test('Windows bootstrap validation rejects CLI token args and confirms only matching code', { skip: !windows }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-win-'));
  try {
    const bad = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'confirm-pairing','INVALID-CODE'], { encoding:'utf8', env: { ...process.env, LOCALAPPDATA: tmp } });
    assert.notEqual(bad.status, 0);
    assert.match(`${bad.stdout}${bad.stderr}`, /displayed code/);
    const env = { ...process.env, LOCALAPPDATA: tmp };
    const configure = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'configure','-Controller','tls://127.0.0.1:7443','-GatewayId','fixture-win'], { encoding:'utf8', env });
    assert.equal(configure.status, 0, configure.stderr || configure.stdout);
    const state = path.join(tmp, 'NodeGoblin', 'state');
    fs.writeFileSync(path.join(state,'pairing-code.json'), JSON.stringify({ gatewayId: 'fixture-win', pairingCode: 'A123-B456-CD90' }));
    const confirms = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'confirm-pairing','A123-B456-CD90'], { encoding:'utf8', env });
    assert.equal(confirms.status, 0, confirms.stderr || confirms.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,'pairing-confirmation.json'),'utf8')), { pairingCode: 'A123-B456-CD90' });
  } finally { fs.rmSync(tmp, { recursive:true, force:true }); }
});
