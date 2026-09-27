import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess } from './lib/process-runner.mjs';

const stubbornProcess = [
  '-e',
  "process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']}); process.stdout.write('ready'); setInterval(()=>{},1000)",
];

test('timeout terminates the process group and settles with local-compatible evidence', async () => {
  const started = Date.now();
  const result = await runProcess({ executable: process.execPath, args: stubbornProcess, timeoutMs: 30 });
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.killed, true);
  assert.equal(result.timeoutReason, 'timeoutMs');
  assert.equal(result.timeoutMs, 30);
  assert.equal(result.exitCode, null);
  assert.ok(['SIGTERM', 'SIGKILL'].includes(result.signal));
  if (result.signal === 'SIGKILL') assert.ok(Date.now() - started >= 900);
  assert.ok(Date.now() - started < 2_500);
});

test('abort after child readiness escalates the process group and settles as cancelled rather than timed out', async () => {
  const abort = new AbortController();
  const running = runProcess({ executable: process.execPath, args: stubbornProcess, timeoutMs: 5_000 }, { signal: abort.signal, emitEvent: event => { if (event.type === 'process.stream' && event.data.includes('ready')) abort.abort(); } });
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.killed, true);
  assert.equal(result.timeoutReason, null);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, 'SIGKILL');
});
