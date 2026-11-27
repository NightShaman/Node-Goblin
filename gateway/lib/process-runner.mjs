import { spawn } from 'node:child_process';
import os from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import process from 'node:process';
import { DEFAULT_MAX_OUTPUT_BYTES, digestHex, truncateUtf8 } from './protocol.mjs';

export function buildExec(request = {}, platform = process.platform, env = process.env) {
  const command = request.command;
  const executable = request.executable;
  const args = request.args;
  if (command != null && (typeof command !== 'string' || !command.trim())) throw new Error('command_invalid');
  if (executable != null && (typeof executable !== 'string' || !executable.trim())) throw new Error('executable_invalid');
  if (args != null && (!Array.isArray(args) || args.some((value) => typeof value !== 'string'))) throw new Error('args_invalid');
  if (command != null && executable != null) throw new Error('command_and_executable_mutually_exclusive');
  if (command == null && executable == null) throw new Error('command_or_executable_required');
  if (command != null && args?.length) throw new Error('args_with_command_invalid');
  const shell = request.commandShell;
  if (shell != null && (command == null || !['powershell', 'cmd'].includes(shell))) throw new Error('command_shell_invalid');
  if (command != null && platform === 'win32') {
    if (shell === 'powershell') {
      const file = env.SystemRoot ? `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe';
      const script = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)\n' + command.trim();
      return { mode: 'shell', shell, file, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], options: { shell: false } };
    }
    // Node builds the Windows /d /s /c command line (including its outer
    // quotes) the same way as for the legacy default shell.
    return { mode: 'shell', shell: 'cmd', file: command.trim(), args: [], options: { shell: env.ComSpec || env.COMSPEC || 'cmd.exe' } };
  }
  if (shell != null) throw new Error('command_shell_unsupported');
  if (command != null) return { mode: 'shell', file: command.trim(), args: [], options: { shell: true } };
  return { mode: 'exec', file: executable.trim(), args: args ? [...args] : [], options: { shell: false } };
}

function processEnvironment(ordinary, protectedValues) {
  if (!ordinary && !protectedValues) return process.env;
  if (process.platform !== 'win32') return { ...process.env, ...ordinary, ...protectedValues };
  // Windows treats names as case-insensitive; Node otherwise keeps the first
  // lexicographic spelling, not necessarily the highest-priority layer.
  const entries = new Map();
  for (const layer of [process.env, ordinary, protectedValues]) {
    for (const [name, value] of Object.entries(layer || {})) entries.set(name.toUpperCase(), [name, value]);
  }
  return Object.fromEntries(entries.values());
}

export function runProcess(request, { protectedEnv = null, emitEvent, signal, now = () => Date.now() } = {}) {
  const startHr = process.hrtime.bigint();
  const startedAt = new Date().toISOString();
  const cwd = request.cwd ? String(request.cwd) : process.cwd();
  const env = request.env && typeof request.env === 'object' ? Object.fromEntries(Object.entries(request.env).map(([key, value]) => [key, String(value)])) : undefined;
  const secretEnv = protectedEnv && typeof protectedEnv === 'object'
    ? Object.fromEntries(Object.entries(protectedEnv).map(([key, value]) => [key, String(value)])) : null;
  const maxOutputBytes = Number.isInteger(request.maxOutputBytes) && request.maxOutputBytes > 0 ? request.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = Number.isInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : 30_000;
  const deadlineMs = Number.isInteger(request.deadlineMs) ? request.deadlineMs : null;
  const exec = buildExec(request);
  const child = spawn(exec.file, exec.args, {
    cwd,
    env: processEnvironment(env, secretEnv),
    shell: exec.options.shell,
    detached: process.platform !== 'win32',
    ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let seq = 0;
  let truncated = false;
  let killed = false;
  let settled = false;
  let stopReason = null;
  const timers = [];

  const totalBytes = () => Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');
  const secretValues = [...new Set(Object.values(secretEnv || {}).filter(Boolean))].sort((a, b) => b.length - a.length);
  const pending = { stdout: '', stderr: '' };
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };

  // Redact as a stream, retaining only a possible secret prefix. Redacting each
  // child chunk independently leaks values when a process writes a secret in
  // multiple chunks.
  const drainRedacted = (stream, final = false) => {
    let source = pending[stream];
    let text = '';
    let cursor = 0;
    while (cursor < source.length) {
      const secret = secretValues.find((value) => source.startsWith(value, cursor));
      if (secret) {
        text += '[redacted]';
        cursor += secret.length;
        continue;
      }
      if (!final && secretValues.some((value) => value.startsWith(source.slice(cursor)))) break;
      text += source[cursor++];
    }
    pending[stream] = source.slice(cursor);
    if (!text) return;
    const room = Math.max(0, maxOutputBytes - totalBytes());
    const kept = room > 0 ? truncateUtf8(text, room) : '';
    if (stream === 'stdout') stdout += kept;
    else stderr += kept;
    if (Buffer.byteLength(kept, 'utf8') !== Buffer.byteLength(text, 'utf8') && !truncated) {
      truncated = true;
      stop('outputLimit');
    }
    emitEvent?.({ type: 'process.stream', stream, seq: ++seq, data: kept, truncated });
  };

  const noteChunk = (stream, chunk) => {
    // Terminal evidence and stream events are redacted before accumulation,
    // hashing, journaling, or transport back to the controller.
    pending[stream] += decoders[stream].write(chunk);
    drainRedacted(stream);
  };

  const terminate = (reasonSignal = 'SIGTERM') => {
    if (!child.pid) return false;
    try { process.kill(-child.pid, reasonSignal); return true; }
    catch { try { return child.kill(reasonSignal); } catch { return false; } }
  };

  let forceSettle = null;
  let treeKillPending = false;
  let pendingClose = null;
  const stopWindows = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const taskkill = process.env.SystemRoot ? `${process.env.SystemRoot}\\System32\\taskkill.exe` : 'taskkill.exe';
    // Best effort for a live leader and its known tree. A spawn alone is not proof
    // the target tree was killed; use the system utility's exit status.
    treeKillPending = true;
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    const done = (code) => {
      if (!treeKillPending) return;
      treeKillPending = false;
      killed = code === 0;
      if (!killed && child.exitCode === null && child.signalCode === null) { try { child.kill(); } catch {} }
      if (pendingClose) forceSettle?.(...pendingClose);
    };
    killer.once('error', () => done(null));
    killer.once('exit', done);
  };
  const stop = (reason) => {
    // The first trigger owns the stop; a deadline during grace must not
    // relabel an overflow (or schedule a second escalation).
    if (settled || stopReason !== null) return;
    stopReason = reason;
    if (process.platform === 'win32') {
      stopWindows();
      const timer = setTimeout(() => forceSettle?.(null, null), 3_000);
      timer.unref?.();
      timers.push(timer);
      return;
    }
    killed = terminate('SIGTERM') || killed;
    const killTimer = setTimeout(() => { killed = terminate('SIGKILL') || killed; }, 1_000);
    const fallbackTimer = setTimeout(() => forceSettle?.(null, 'SIGTERM'), 1_100);
    killTimer.unref?.();
    fallbackTimer.unref?.();
    timers.push(killTimer, fallbackTimer);
  };

  timers.push(setTimeout(() => stop('timeoutMs'), timeoutMs));

  if (deadlineMs !== null) {
    const delay = deadlineMs - now();
    if (delay <= 0) {
      stop('deadlineMs');
    } else {
      timers.push(setTimeout(() => {
        stop('deadlineMs');
      }, delay));
    }
  }

  const onAbort = () => stop('abort');
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout.on('data', (chunk) => noteChunk('stdout', chunk));
  child.stderr.on('data', (chunk) => noteChunk('stderr', chunk));

  return new Promise((resolve, reject) => {
    const finish = (code, closeSignal) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      pending.stdout += decoders.stdout.end();
      pending.stderr += decoders.stderr.end();
      drainRedacted('stdout', true);
      drainRedacted('stderr', true);
      const endedAt = new Date().toISOString();
      const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
      const timeoutReason = stopReason === 'timeoutMs' || stopReason === 'deadlineMs' ? stopReason : null;
      const result = {
        type: 'process.result',
        startedAt,
        endedAt,
        durationMs,
        cwd,
        effectiveUid: typeof process.geteuid === 'function' ? process.geteuid() : null,
        effectiveGid: typeof process.getegid === 'function' ? process.getegid() : null,
        hostname: os.hostname(),
        mode: exec.mode,
        executable: exec.mode === 'exec' ? exec.file : null,
        args: exec.mode === 'exec' ? exec.args : [],
        command: exec.mode === 'shell' ? request.command.trim() : null,
        ...(exec.shell ? { commandShell: exec.shell } : {}),
        exitCode: code,
        signal: closeSignal,
        cancelled: stopReason === 'abort',
        killed,
        truncated,
        timedOut: timeoutReason !== null,
        timeoutReason,
        timeoutMs,
        deadlineMs,
        stdout,
        stderr,
        stdoutDigest: digestHex(stdout),
        stderrDigest: digestHex(stderr),
      };
      emitEvent?.({ type: 'process.terminal', seq: ++seq, evidence: result });
      resolve(result);
    };
    forceSettle = finish;
    child.once('error', reject);
    child.once('close', (...result) => {
      if (treeKillPending) pendingClose = result;
      else finish(...result);
    });
  });
}
