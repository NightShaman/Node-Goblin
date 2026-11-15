import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CodexProcesses } from './lib/codex-process.mjs';

test('interactive sessions enforce authenticated ownership, bounded writes and disconnect cleanup', async () => {
  const sessions = new CodexProcesses({ executable: () => process.execPath,
    spawnProcess: (exe, args, options) => spawn(exe, ['-e', "process.stdin.pipe(process.stdout);process.stderr.write('private-secret')"], options) });
  const owner = { connectionId: 'a' }; const other = { connectionId: 'b' };
  try {
    await assert.rejects(sessions.handle('codex.open', { operationId: 'op', cwd: process.cwd() }, null), /authenticated/);
    await sessions.handle('codex.open', { operationId: 'op', cwd: process.cwd() }, owner);
    await assert.rejects(sessions.handle('codex.read', { operationId: 'op' }, other), /owner/);
    await assert.rejects(sessions.handle('codex.write', { operationId: 'op', data: 'x'.repeat(128 * 1024 + 1) }, owner), /invalid/);
    await sessions.handle('codex.write', { operationId: 'op', data: 'transient-auth-secret\n' }, owner);
    let result;
    for (let count = 0; count < 100; count++) {
      result = await sessions.handle('codex.read', { operationId: 'op' }, owner);
      if (result.data) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.data, 'transient-auth-secret\n');
    sessions.closeAll(); assert.equal(sessions.sessions.size, 0);
  } finally { sessions.closeAll(); }
});
