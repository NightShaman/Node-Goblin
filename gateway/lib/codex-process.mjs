import { spawn } from 'node:child_process';
import { statSync, accessSync, mkdirSync, constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export function codexExecutable(env = process.env) {
  const candidates = env.BURROW_CODEX_EXECUTABLE ? [env.BURROW_CODEX_EXECUTABLE] :
    String(env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map(dir => path.join(dir, 'codex'));
  for (const file of candidates) {
    try { if (path.isAbsolute(file) && statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch {}
  }
  return null;
}

// Memory-only, connection-owned interactive IPC. No journal, output events,
// telemetry, stderr, or diagnostic strings may cross this boundary.
export class CodexProcesses {
  constructor({ executable = () => codexExecutable(), spawnProcess = spawn } = {}) {
    this.executable = executable; this.spawnProcess = spawnProcess; this.sessions = new Map();
  }
  async handle(method, params, owner) {
    if (!owner?.connectionId) throw new Error('codex_authenticated_transport_required');
    const id = params.operationId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('codex_operation_invalid');
    let entry = this.sessions.get(id);
    if (entry && entry.owner !== owner.connectionId) throw new Error('codex_owner_invalid');
    if (method === 'codex.open') {
      if (entry || this.sessions.size >= 8) throw new Error('codex_session_limit_or_conflict');
      if (typeof params.cwd !== 'string' || params.cwd.length > 4096 || !path.isAbsolute(params.cwd)
        || !statSync(params.cwd).isDirectory()) throw new Error('codex_cwd_invalid');
      const executable = this.executable();
      if (!executable) throw new Error('codex_unavailable');
      const codexHome = process.env.CODEX_HOME || (process.env.BURROW_GATEWAY_STATE_DIR ? path.join(process.env.BURROW_GATEWAY_STATE_DIR, 'codex') : null);
      if (codexHome) mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      const child = this.spawnProcess(executable, ['app-server', '--listen', 'stdio://'], {
        cwd: params.cwd, ...(codexHome ? { env: { ...process.env, CODEX_HOME: codexHome } } : {}), stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32',
      });
      entry = { child, owner: owner.connectionId, data: '', bytes: 0, done: false, decoder: new StringDecoder('utf8') };
      this.sessions.set(id, entry);
      entry.timer = setTimeout(() => this.destroy(id), 30 * 60_000); entry.timer.unref?.();
      child.stdout.on('data', chunk => {
        entry.data += entry.decoder.write(chunk); entry.bytes = Buffer.byteLength(entry.data);
        if (entry.bytes > 8 * 1024 * 1024) this.destroy(id);
      });
      child.stderr.on('data', () => {});
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => this.destroy(id));
      child.on('error', () => this.destroy(id));
      child.on('close', (code, signal) => { entry.done = true; entry.exitCode = code; entry.signal = signal; clearTimeout(entry.timer); entry.timer = setTimeout(() => this.destroy(id), 60_000); entry.timer.unref?.(); });
      return { operationId: id };
    }
    if (!entry) {
      if (method === 'codex.close') return { operationId: id, closed: true };
      throw new Error('codex_session_missing');
    }
    if (method === 'codex.write') {
      if (entry.done || typeof params.data !== 'string' || Buffer.byteLength(params.data) > 128 * 1024) throw new Error('codex_write_invalid');
      await new Promise((resolve, reject) => entry.child.stdin.write(params.data, error => error ? reject(new Error('codex_write_failed')) : resolve()));
      return { operationId: id, written: true };
    }
    if (method === 'codex.read') {
      // Character bound is below frame byte bound even for four-byte UTF-8.
      let end = Math.min(entry.data.length, 32 * 1024);
      if (end < entry.data.length && /[\uD800-\uDBFF]/.test(entry.data[end - 1])) end--;
      const data = entry.data.slice(0, end); entry.data = entry.data.slice(data.length);
      const done = entry.done && !entry.data;
      if (done) { clearTimeout(entry.timer); this.sessions.delete(id); }
      return { operationId: id, data, done, ...(done ? { exitCode: entry.exitCode, signal: entry.signal } : {}) };
    }
    if (method === 'codex.close') {
      if (params.signal != null && !['SIGTERM', 'SIGKILL'].includes(params.signal)) throw new Error('codex_signal_invalid');
      if (params.signal) {
        try { if (entry.child.pid && process.platform !== 'win32') process.kill(-entry.child.pid, params.signal); else entry.child.kill(params.signal); } catch {}
      } else entry.child.stdin.end();
      return { operationId: id, closed: entry.done };
    }
    throw new Error('codex_method_invalid');
  }
  destroy(id) {
    const entry = this.sessions.get(id); if (!entry) return;
    this.sessions.delete(id); clearTimeout(entry.timer); entry.data = ''; entry.done = true;
    try { if (entry.child.pid && process.platform !== 'win32') process.kill(-entry.child.pid, 'SIGKILL'); else entry.child.kill('SIGKILL'); } catch { try { entry.child.kill('SIGKILL'); } catch {} }
  }
  closeAll() { for (const id of this.sessions.keys()) this.destroy(id); }
}
