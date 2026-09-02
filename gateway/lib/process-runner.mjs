import { spawn } from 'node:child_process';
import os from 'node:os';
import process from 'node:process';
import { DEFAULT_MAX_OUTPUT_BYTES, digestHex, truncateUtf8 } from './protocol.mjs';

function normalizeExec(request = {}) {
  const command = request.command;
  const executable = request.executable;
  const args = request.args;
  if (command != null && (typeof command !== 'string' || !command.trim())) throw new Error('command_invalid');
  if (executable != null && (typeof executable !== 'string' || !executable.trim())) throw new Error('executable_invalid');
  if (args != null && (!Array.isArray(args) || args.some((value) => typeof value !== 'string'))) throw new Error('args_invalid');
  if (command != null && executable != null) throw new Error('command_and_executable_mutually_exclusive');
  if (command == null && executable == null) throw new Error('command_or_executable_required');
  if (command != null && args?.length) throw new Error('args_with_command_invalid');
  if (command != null) return { mode: 'shell', file: command.trim(), args: [], options: { shell: true } };
  return { mode: 'exec', file: executable.trim(), args: args ? [...args] : [], options: { shell: false } };
}

export function runProcess(request, { protectedEnv = null, emitEvent, signal, now = () => Date.now() } = {}) {
  const startHr = process.hrtime.bigint();
  const startedAt = new Date().toISOString();
  const cwd = request.cwd ? String(request.cwd) : process.cwd();
  const env = request.env && typeof request.env === 'object' ? Object.fromEntries(Object.entries(request.env).map(([key, value]) => [key, String(value)])) : undefined;
  const secretEnv = protectedEnv && typeof protectedEnv === 'object'
    ? Object.fromEntries(Object.entries(protectedEnv).map(([key, value]) => [key, String(value)])) : null;
  const maxOutputBytes = Number.isInteger(request.maxOutputBytes) && request.maxOutputBytes > 0 ? request.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES;
  const timeoutMs = Number.isInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : null;
  const deadlineMs = Number.isInteger(request.deadlineMs) ? request.deadlineMs : null;
  const exec = normalizeExec(request);
  const child = spawn(exec.file, exec.args, {
    cwd,
    env: env || secretEnv ? { ...process.env, ...(env || {}), ...(secretEnv || {}) } : process.env,
    shell: exec.options.shell,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let seq = 0;
  let truncated = false;
  let killRequested = false;
  let timeoutTriggered = false;
  let timeoutReason = null;
  const timers = [];

  const totalBytes = () => Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8');
  const secretValues = [...new Set(Object.values(secretEnv || {}).filter(Boolean))].sort((a, b) => b.length - a.length);
  const pending = { stdout: '', stderr: '' };

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
      terminate('SIGTERM');
    }
    emitEvent?.({ type: 'process.stream', stream, seq: ++seq, data: kept, truncated });
  };

  const noteChunk = (stream, chunk) => {
    // Terminal evidence and stream events are redacted before accumulation,
    // hashing, journaling, or transport back to the controller.
    pending[stream] += chunk.toString('utf8');
    drainRedacted(stream);
  };

  const terminate = (reasonSignal = 'SIGTERM') => {
    if (killRequested) return;
    killRequested = true;
    if (process.platform === 'win32') child.kill(reasonSignal);
    else {
      try { process.kill(-child.pid, reasonSignal); } catch { child.kill(reasonSignal); }
    }
  };

  if (timeoutMs) timers.push(setTimeout(() => {
    timeoutTriggered = true;
    timeoutReason = 'timeoutMs';
    terminate('SIGTERM');
  }, timeoutMs));

  if (deadlineMs !== null) {
    const delay = deadlineMs - now();
    if (delay <= 0) {
      timeoutTriggered = true;
      timeoutReason = 'deadlineMs';
      terminate('SIGTERM');
    } else {
      timers.push(setTimeout(() => {
        timeoutTriggered = true;
        timeoutReason = 'deadlineMs';
        terminate('SIGTERM');
      }, delay));
    }
  }

  signal?.addEventListener('abort', () => terminate('SIGTERM'), { once: true });
  child.stdout.on('data', (chunk) => noteChunk('stdout', chunk));
  child.stderr.on('data', (chunk) => noteChunk('stderr', chunk));

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, closeSignal) => {
      for (const timer of timers) clearTimeout(timer);
      drainRedacted('stdout', true);
      drainRedacted('stderr', true);
      const endedAt = new Date().toISOString();
      const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
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
        command: exec.mode === 'shell' ? exec.file : null,
        exitCode: code,
        signal: closeSignal,
        cancelled: signal?.aborted === true,
        truncated,
        timedOut: timeoutTriggered,
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
    });
  });
}
