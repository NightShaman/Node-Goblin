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

for (const text of ['¢', '€', '😀']) {
  for (let cut = 1; cut < Buffer.byteLength(text); cut++) {
    test(`incremental UTF-8 on both streams: ${text} cut ${cut}`, async () => {
      const bytes = [...Buffer.from(text)];
      const events = [];
      const result = await runProcess({ executable: process.execPath, args: ['-e', `
        const b = Buffer.from(${JSON.stringify(bytes)});
        process.stdout.write(b.subarray(0, ${cut}));
        process.stderr.write(b.subarray(0, ${cut}));
        setTimeout(() => { process.stdout.write(b.subarray(${cut})); process.stderr.write(b.subarray(${cut})); }, 30);
      `] }, { emitEvent: e => events.push(e) });
      assert.equal(result.stdout, text);
      assert.equal(result.stderr, text);
      for (const stream of ['stdout', 'stderr']) assert.equal(events.filter(e => e.type === 'process.stream' && e.stream === stream).map(e => e.data).join(''), text);
    });
  }
}

test('decoder flushes incomplete final sequences and keeps cross-chunk multibyte redaction', async () => {
  const events = [];
  const secret = '€😀token';
  const result = await runProcess({ executable: process.execPath, args: ['-e', `
    const b = Buffer.from(process.env.TEST_VALUE);
    let i = 0; const timer = setInterval(() => {
      if (i < b.length) { process.stdout.write(b.subarray(i, ++i)); }
      else { clearInterval(timer); process.stderr.write(Buffer.from([0xe2, 0x82])); }
    }, 5);
  `] }, { protectedEnv: { TEST_VALUE: secret }, emitEvent: e => events.push(e) });
  assert.equal(result.stdout, '[redacted]');
  assert.equal(result.stderr, '�');
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test('multibyte redaction and truncation share the byte limit without replacement characters', async () => {
  const result = await runProcess({ executable: process.execPath, maxOutputBytes: 11, args: ['-e', "process.stdout.write(process.env.TEST_VALUE); setTimeout(() => process.stdout.write('😀'), 30)"] }, { protectedEnv: { TEST_VALUE: '€token' } });
  assert.equal(result.stdout, '[redacted]');
  assert.equal(result.truncated, true);
});
