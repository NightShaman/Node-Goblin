import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { CodexProcesses, validateClaudeInvocation } from './lib/codex-process.mjs';

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

test('Claude validates headless arguments and scopes OAuth to child environment', async () => {
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit', '--permission-prompts', 'none', '--model', 'claude-sonnet-4-6'];
  const owner = { connectionId: 'claude-test' }; let invocation;
  const sessions = new CodexProcesses({ claudeExecutable: () => process.execPath, spawnProcess: (exe, argv, options) => {
    invocation = { exe, argv, options };
    return spawn(exe, ['-e', 'process.stdin.resume()'], options);
  } });
  const open = { operationId: 'claude-test', cwd: process.cwd(), args, token: 'test-oauth-secret' };
  try {
    for (const invalid of [{ args: [...args, '--dangerously-skip-permissions'] }, { args: ['--help'] }, { token: '' }, { token: 'bad\nsecret' }, { cwd: 'relative' }]) {
      await assert.rejects(sessions.handle('claude.open', { ...open, ...invalid }, owner));
    }
    assert.equal(invocation, undefined);
    await sessions.handle('claude.open', open, owner);
    assert.deepEqual(invocation.argv, args);
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.env.CLAUDE_CODE_OAUTH_TOKEN, open.token);
    assert.equal(invocation.options.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(invocation.options.env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(JSON.stringify(invocation.argv).includes(open.token), false);
    assert.equal(JSON.stringify([...sessions.sessions.values()].map(({ child, timer, ...value }) => value)).includes(open.token), false);
    await assert.rejects(sessions.handle('codex.read', { operationId: open.operationId }, owner), /owner/);
    await assert.rejects(sessions.handle('claude.read', { operationId: open.operationId }, { connectionId: 'other' }), /owner/);
    await sessions.handle('claude.close', { operationId: open.operationId, signal: 'SIGTERM' }, owner);
  } finally { sessions.closeAll(); }
});

test('CLI discovery accepts absolute executable paths only and standard system fallback', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { claudeExecutable, codexExecutable, geminiExecutable } = await import('./lib/codex-process.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-discovery-'));
  try {
    const cli = path.join(dir, 'claude');
    fs.writeFileSync(cli, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(claudeExecutable({ PATH: dir }), cli);
    const gemini = path.join(dir, 'gemini');
    fs.writeFileSync(gemini, '#!/bin/sh\n', { mode: 0o755 });
    assert.equal(geminiExecutable({ PATH: dir }), gemini);
    assert.equal(geminiExecutable({ BURROW_GEMINI_EXECUTABLE: gemini }), gemini);
    assert.equal(geminiExecutable({ PATH: dir, BURROW_GEMINI_EXECUTABLE: './gemini' }), null);
    assert.equal(claudeExecutable({ PATH: '', BURROW_CLAUDE_EXECUTABLE: cli }), cli);
    assert.equal(claudeExecutable({ PATH: dir, BURROW_CLAUDE_EXECUTABLE: './claude' }), null);
    fs.chmodSync(cli, 0o644);
    assert.equal(claudeExecutable({ BURROW_CLAUDE_EXECUTABLE: cli }), null);
    assert.equal(codexExecutable({ BURROW_CODEX_EXECUTABLE: dir }), null);
    for (const [name, resolve] of [['claude', claudeExecutable], ['codex', codexExecutable], ['gemini', geminiExecutable]]) {
      const expected = ['/usr/local/bin', '/usr/bin', '/bin'].map(dir => path.join(dir, name)).find(file => {
        try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
      }) || null;
      assert.equal(resolve({ PATH: '' }), expected);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Claude service account gets private writable HOME and configuration directory', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-service-home-'));
  const original = process.env.BURROW_GATEWAY_STATE_DIR;
  process.env.BURROW_GATEWAY_STATE_DIR = state;
  let env;
  const sessions = new CodexProcesses({ claudeExecutable: () => process.execPath,
    spawnProcess: (exe, args, options) => { env = options.env; return spawn(exe, ['-e', 'process.stdin.resume()'], options); } });
  try {
    await sessions.handle('claude.open', { operationId: 'service-home', cwd: state, token: 'test-oauth',
      args: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit', '--permission-prompts', 'none', '--model', 'claude-sonnet-4-6'] }, { connectionId: 'service' });
    assert.equal(env.HOME, path.join(state, 'claude'));
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(state, 'claude/.claude'));
    assert.equal(fs.statSync(env.CLAUDE_CONFIG_DIR).mode & 0o777, 0o700);
    assert.equal(fs.statSync(env.HOME).mode & 0o777, 0o700);
  } finally {
    sessions.closeAll();
    if (original === undefined) delete process.env.BURROW_GATEWAY_STATE_DIR; else process.env.BURROW_GATEWAY_STATE_DIR = original;
    fs.rmSync(state, { recursive: true, force: true });
  }
});


test('Claude unattended contract requires coding permissions, rejects drift, and accepts resume', () => {
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit', '--permission-prompts', 'none', '--model', 'claude-sonnet-4-6'];
  const token = 'test-token';
  assert.deepEqual(validateClaudeInvocation({ args, token }), args);
  const resume = [...args, '--resume', 'native-session'];
  assert.deepEqual(validateClaudeInvocation({ args: resume, token }), resume);
  for (const bad of [args.filter((_, i) => i < 6 || i > 9),
    args.map((a, i) => i === 7 ? 'Read' : a), args.map((a, i) => i === 9 ? 'host' : a),
    [...args, '--dangerously-skip-permissions'], [...args, '--resume', '../bad']]) {
    assert.throws(() => validateClaudeInvocation({ args: bad, token }), /claude_invocation_invalid/);
  }
});

test('Gemini validates headless contract, isolates API-key auth and enforces runtime ownership', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-service-home-'));
  const saved = { ...process.env };
  Object.assign(process.env, { BURROW_GATEWAY_STATE_DIR: state, GOOGLE_API_KEY: 'ambient', GOOGLE_APPLICATION_CREDENTIALS: '/bad',
    GOOGLE_GENAI_USE_VERTEXAI: 'true', GEMINI_CLI_USE_COMPUTE_ADC: 'true', GEMINI_API_KEY: 'ambient-gemini' });
  let invocation;
  const sessions = new CodexProcesses({ geminiExecutable: () => process.execPath, spawnProcess: (exe, args, options) => {
    invocation = { args, options }; return spawn(exe, ['-e', 'process.stdin.resume()'], options);
  } });
  const owner = { connectionId: 'gemini-owner' };
  const args = ['-p', 'Private task\nwith context', '--output-format', 'stream-json', '--model', 'gemini-3-pro-preview', '--approval-mode', 'yolo', '--skip-trust', '--resume', 'native-session'];
  const open = { operationId: 'gemini-test', cwd: state, args, apiKey: 'selected-test-key' };
  try {
    for (const invalid of [{ args: [...args, '--yolo'] }, { args: ['--help'] }, { args: args.map((v, i) => i === 7 ? '../bad' : v) },
      { apiKey: '' }, { apiKey: 'bad\nkey' }, { cwd: 'relative' }]) {
      await assert.rejects(sessions.handle('gemini.open', { ...open, ...invalid }, owner));
    }
    assert.equal(invocation, undefined);
    await assert.rejects(sessions.handle('gemini.open', open, null), /authenticated/);
    await sessions.handle('gemini.open', open, owner);
    assert.deepEqual(invocation.args, args);
    assert.equal(invocation.options.env.GEMINI_API_KEY, open.apiKey);
    for (const key of ['GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'GEMINI_CLI_USE_COMPUTE_ADC']) assert.equal(invocation.options.env[key], undefined);
    assert.equal(process.env.GEMINI_API_KEY, 'ambient-gemini');
    assert.equal(invocation.options.env.HOME, path.join(state, 'gemini'));
    assert.equal(fs.statSync(path.join(state, 'gemini/.gemini')).mode & 0o777, 0o700);
    assert.equal(invocation.options.shell, false);
    assert.equal(JSON.stringify(invocation.args).includes(open.apiKey), false);
    assert.equal(JSON.stringify([...sessions.sessions.values()].map(({ child, timer, ...value }) => value)).includes(open.apiKey), false);
    await assert.rejects(sessions.handle('claude.read', { operationId: open.operationId }, owner), /owner/);
    await assert.rejects(sessions.handle('gemini.read', { operationId: open.operationId }, { connectionId: 'other' }), /owner/);
    await sessions.handle('gemini.close', { operationId: open.operationId, signal: 'SIGTERM' }, owner);
  } finally {
    sessions.closeAll();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('Gemini private diagnostics redact chunk-split keys and omit structured payloads', async () => {
  const sessions = new CodexProcesses({ geminiExecutable: () => process.execPath,
    spawnProcess: (exe, args, options) => spawn(exe, ['-e', `process.stderr.write('bad selected-'); setTimeout(() => { process.stderr.write('test-key\\n{"tool_result":"private payload"}\\n'); process.exitCode = 17; }, 20)`], options) });
  const owner = { connectionId: 'diagnostic-owner' };
  try {
    await sessions.handle('gemini.open', { operationId: 'diagnostic', cwd: process.cwd(), apiKey: 'selected-test-key',
      args: ['-p', 'task', '--output-format', 'stream-json', '--model', 'gemini-test', '--approval-mode', 'yolo', '--skip-trust'] }, owner);
    let stderr = '', result;
    for (let i = 0; i < 100; i++) {
      result = await sessions.handle('gemini.read', { operationId: 'diagnostic' }, owner);
      stderr += result.stderr;
      if (result.done) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.done, true);
    assert.equal(result.exitCode, 17);
    assert.match(stderr, /bad \[redacted\]/);
    assert.doesNotMatch(stderr, /selected-test-key|private payload|tool_result/);
  } finally { sessions.closeAll(); }
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, message) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await pause(10);
  }
  assert.fail(message);
}

for (const [runtime, disconnect] of [['codex', false], ['claude', false], ['gemini', false], ['gemini', true]]) {
  test(`${runtime} ${disconnect ? 'disconnect' : 'RPC cancellation'} kills detached shell and TERM-resistant grandchild after read consumes leader`, { skip: process.platform !== 'linux' }, async () => {
    const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-tree-'));
    const marker = path.join(dir, 'marker'), ready = path.join(dir, 'ready'), shellPid = path.join(dir, 'shell-pid');
    const grandchild = path.join(dir, 'grandchild.cjs'), root = path.join(dir, 'root.cjs');
    fs.writeFileSync(grandchild, `const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setTimeout(() => fs.writeFileSync(${JSON.stringify(marker)}, 'escaped'), 1400); setInterval(() => {}, 1000);`);
    fs.writeFileSync(root, `const {spawn} = require('node:child_process'); const fs = require('node:fs'); const child = spawn('/bin/sh', ['-c', 'trap "" TERM; "$1" "$2" & wait', 'tree-test', process.execPath, ${JSON.stringify(grandchild)}], {detached:true, stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(shellPid)}, String(child.pid)); child.unref(); process.stdin.resume();`);
    const sessions = new CodexProcesses({ executable: () => process.execPath, claudeExecutable: () => process.execPath, geminiExecutable: () => process.execPath,
      spawnProcess: (exe, args, options) => spawn(exe, [root], options) });
    const owner = { connectionId: `tree-${runtime}` };
    const args = runtime === 'claude'
      ? ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit', '--permission-prompts', 'none', '--model', 'test']
      : ['-p', 'task', '--output-format', 'stream-json', '--model', 'test', '--approval-mode', 'yolo'];
    const pids = [];
    const alive = pid => {
      try { return !['Z', 'X'].includes(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[0]); } catch { return false; }
    };
    try {
      await sessions.handle(`${runtime}.open`, { operationId: 'tree', cwd: dir, args, token: 'test-token', apiKey: 'test-key' }, owner);
      pids.push(sessions.sessions.get('tree').child.pid);
      await waitFor(() => fs.existsSync(ready), 'grandchild not ready');
      pids.push(Number(fs.readFileSync(shellPid, 'utf8')), Number(fs.readFileSync(ready, 'utf8')));
      if (disconnect) sessions.closeAll();
      else await sessions.handle(`${runtime}.close`, { operationId: 'tree', signal: 'SIGTERM' }, owner);
      if (!disconnect) {
        await waitFor(() => sessions.sessions.get('tree')?.done, 'leader did not exit');
        const result = await sessions.handle(`${runtime}.read`, { operationId: 'tree' }, owner);
        assert.equal(result.done, true);
      }
      assert.equal(sessions.sessions.size, 0);
      assert.equal(alive(pids[2]), true, 'grandchild must resist TERM to exercise delayed KILL');
      await waitFor(() => pids.every(pid => !alive(pid)), 'cancelled descendants survived KILL');
      await pause(1500);
      assert.equal(fs.existsSync(marker), false, 'cancelled tool produced delayed side effect');
    } finally {
      sessions.closeAll();
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
