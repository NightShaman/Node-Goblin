import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
test('release version stamps and verifies all tagged version authorities', () => {
  const root = mkdtempSync(join(tmpdir(), 'node-release-'));
  try {
    mkdirSync(join(root, 'gateway/deploy'), { recursive: true });
    const script = join(root, 'gateway/deploy/set-release-version.mjs');
    copyFileSync(new URL('../deploy/set-release-version.mjs', import.meta.url), script);
    for (const file of ['burrow.mod.json', 'gateway/package.json']) writeFileSync(join(root, file), '{"version":"old","keep":true}');
    writeFileSync(join(root, 'gateway/VERSION'), 'old\n');
    execFileSync(process.execPath, [script, '2026.09.19.10']);
    execFileSync(process.execPath, [script, '2026.09.19.10', '--check']);
    assert.equal(JSON.parse(readFileSync(join(root, 'burrow.mod.json'))).keep, true);
    assert.throws(() => execFileSync(process.execPath, [script, '2026.09.19.2', '--check'], {stdio:'pipe'}));
    assert.throws(() => execFileSync(process.execPath, [script, 'invalid'], {stdio:'pipe'}));
  } finally { rmSync(root, {recursive:true,force:true}); }
});

test('runtime hello and all release authorities agree without changing protocol version', async () => {
  const { GatewayDaemon } = await import('../lib/daemon.mjs');
  const root = new URL('../../', import.meta.url);
  const version = readFileSync(new URL('gateway/VERSION', root), 'utf8').trim();
  assert.equal(JSON.parse(readFileSync(new URL('burrow.mod.json', root))).version, version);
  assert.equal(JSON.parse(readFileSync(new URL('gateway/package.json', root))).version, version);
  let response;
  const daemon = new GatewayDaemon({ output: { write: (line) => { response = JSON.parse(line); } } });
  await daemon.handle({ id: 'version', method: 'hello' });
  assert.equal(response.result.version, version);
  assert.equal(response.result.protocolVersion, '1.0');
});
