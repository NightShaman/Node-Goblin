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
  const args = ['-p', 'Private task\nwith context', '--output-format', 'stream-json', '--model', 'gemini-3-pro-preview', '--approval-mode', 'yolo', '--resume', 'native-session'];
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
