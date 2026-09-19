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
