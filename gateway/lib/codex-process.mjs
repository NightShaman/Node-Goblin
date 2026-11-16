import { spawn } from 'node:child_process';
import { statSync, accessSync, mkdirSync, writeFileSync, readFileSync, readdirSync, constants } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

function findExecutable(env, override, name) {
  const candidates = override ? [override] :
    [...String(env.PATH || '').split(path.delimiter).filter(path.isAbsolute), '/usr/local/bin', '/usr/bin', '/bin'].map(dir => path.join(dir, name));
  for (const file of candidates) {
    try { if (path.isAbsolute(file) && statSync(file).isFile()) { accessSync(file, constants.X_OK); return file; } } catch {}
  }
  return null;
}

export function codexExecutable(env = process.env) { return findExecutable(env, env.BURROW_CODEX_EXECUTABLE, 'codex'); }
export function claudeExecutable(env = process.env) { return findExecutable(env, env.BURROW_CLAUDE_EXECUTABLE, 'claude'); }
export function geminiExecutable(env = process.env) { return findExecutable(env, env.BURROW_GEMINI_EXECUTABLE, 'gemini'); }

// Accept only the headless JSONL contract, never arbitrary CLI flags or env.
export function validateClaudeInvocation({ args, token } = {}) {
  const prefix = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit', '--permission-prompts', 'none', '--model'];
  if (!Array.isArray(args) || ![12, 14].includes(args.length)
    || prefix.some((arg, i) => args[i] !== arg)
    || typeof args[11] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,239}$/.test(args[11])
    || (args.length === 14 && (args[12] !== '--resume' || typeof args[13] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(args[13])))
    || typeof token !== 'string' || !token.length || token.length > 16384 || /[\x00-\x20\x7f]/.test(token)) {
    throw new Error('claude_invocation_invalid');
  }
  return [...args];
}

// Only the headless stream-json contract; credentials never become CLI flags.
export function validateGeminiInvocation({ args, apiKey } = {}) {
  const trust = args?.[8] === '--skip-trust' ? 1 : 0;
  if (!Array.isArray(args) || ![8 + trust, 10 + trust].includes(args.length)
    || args[0] !== '-p' || args[2] !== '--output-format' || args[3] !== 'stream-json'
    || args[4] !== '--model' || args[6] !== '--approval-mode' || args[7] !== 'yolo'
    || typeof args[5] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,239}$/.test(args[5])
    || typeof args[1] !== 'string' || !args[1].length || Buffer.byteLength(args[1]) > 96 * 1024 || args[1].includes('\0')
    || (args.length === 10 + trust && (args[8 + trust] !== '--resume' || typeof args[9 + trust] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(args[9 + trust])))
    || typeof apiKey !== 'string' || !apiKey.length || apiKey.length > 16384 || /[\x00-\x20\x7f]/.test(apiKey)) {
    throw new Error('gemini_invocation_invalid');
  }
  return [...args];
}

// Linux /proc identities let cancellation follow detached descendants without
// signalling a PID that has since been reused. Never inspect/kill a tree on
// successful completion: CLIs may intentionally leave background work running.
function linuxProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid: Number(pid), parent: Number(fields[1]), start: fields[19] };
  } catch { return null; }
}

function trackDescendants(tracked) {
  const processes = new Map();
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      const info = linuxProcess(pid);
      if (info) processes.set(info.pid, info);
    }
  } catch { return; }
  const parents = new Set();
  for (const [pid, start] of tracked) if (processes.get(pid)?.start === start) parents.add(pid);
  // Include every generation, irrespective of session or process group.
  let changed;
  do {
    changed = false;
    for (const info of processes.values()) {
      if (!parents.has(info.pid) && parents.has(info.parent)) {
        parents.add(info.pid); tracked.set(info.pid, info.start); changed = true;
      }
    }
  } while (changed);
}

function terminateTree(entry, signal = 'SIGTERM') {
  if (entry.cancelling) return;
  entry.cancelling = true;
  const child = entry.child;
  const tracked = new Map();
  if (entry.identity) tracked.set(child.pid, entry.identity);
  if (process.platform === 'linux') trackDescendants(tracked);
  const send = sig => {
    // Preserve the process-group fallback on other POSIX platforms. On Linux
    // only use it while the original group leader still has its identity.
    const rootAlive = process.platform !== 'linux' || (entry.identity && linuxProcess(child.pid)?.start === entry.identity);
    if (rootAlive) {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {}
    }
    for (const [pid, start] of tracked) {
      if (linuxProcess(pid)?.start === start) { try { process.kill(pid, sig); } catch {} }
    }
  };
  send(signal);
  if (signal === 'SIGKILL') return;
  // Not entry.timer: close/read/destroy may consume the session before this
  // grace period expires, but detached TERM-resistant children still need KILL.
  const cleanup = setTimeout(() => {
    if (process.platform === 'linux') trackDescendants(tracked);
    send('SIGKILL');
  }, 500);
  cleanup.unref?.();
}

// Memory-only, connection-owned interactive IPC. No journal, output events,
// telemetry or raw diagnostics. Gemini returns bounded redacted diagnostic text
// only through this private authenticated RPC, never public evidence.
export class CodexProcesses {
  constructor({ executable = () => codexExecutable(), claudeExecutable: resolveClaude = () => claudeExecutable(), geminiExecutable: resolveGemini = () => geminiExecutable(), spawnProcess = spawn } = {}) {
    this.executable = executable; this.claudeExecutable = resolveClaude; this.geminiExecutable = resolveGemini; this.spawnProcess = spawnProcess; this.sessions = new Map();
  }
  async handle(method, params, owner) {
    if (!owner?.connectionId) throw new Error('codex_authenticated_transport_required');
    const runtime = method.split('.')[0];
    if (!['codex', 'claude', 'gemini'].some(name => ['open', 'write', 'read', 'close'].some(action => method === `${name}.${action}`))) throw new Error('codex_method_invalid');
    method = method.replace(/^(claude|gemini)\./, 'codex.');
    const id = params.operationId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('codex_operation_invalid');
    let entry = this.sessions.get(id);
    if (entry && (entry.owner !== owner.connectionId || entry.runtime !== runtime)) throw new Error('codex_owner_invalid');
    if (method === 'codex.open') {
      if (entry || this.sessions.size >= 8) throw new Error('codex_session_limit_or_conflict');
      if (typeof params.cwd !== 'string' || params.cwd.length > 4096 || !path.isAbsolute(params.cwd)
        || !statSync(params.cwd).isDirectory()) throw new Error('codex_cwd_invalid');
      const args = runtime === 'claude' ? validateClaudeInvocation(params) : runtime === 'gemini' ? validateGeminiInvocation(params) : ['app-server', '--listen', 'stdio://'];
      const executable = runtime === 'claude' ? this.claudeExecutable() : runtime === 'gemini' ? this.geminiExecutable() : this.executable();
      if (!executable) throw new Error('codex_unavailable');
      const codexHome = process.env.CODEX_HOME || (process.env.BURROW_GATEWAY_STATE_DIR ? path.join(process.env.BURROW_GATEWAY_STATE_DIR, 'codex') : null);
      if (runtime === 'codex' && codexHome) mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      let env;
      if (runtime === 'claude') {
        env = { ...process.env };
        for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDECODE$)/.test(key)) delete env[key];
        // Service accounts may have /nonexistent as their login home. Keep CLI
        // config/cache writable without borrowing root's interactive profile.
        if (process.env.BURROW_GATEWAY_STATE_DIR) {
          env.HOME = path.join(process.env.BURROW_GATEWAY_STATE_DIR, 'claude');
          env.CLAUDE_CONFIG_DIR = path.join(env.HOME, '.claude');
          mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
        }
        env.CLAUDE_CODE_OAUTH_TOKEN = params.token;
      } else if (runtime === 'gemini') {
        env = { ...process.env };
        // Do not let ambient OAuth, Vertex or service-account auth override the
        // selected API key. This environment is private to this child only.
        for (const key of Object.keys(env)) if (/^(GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_)/.test(key)) delete env[key];
        if (process.env.BURROW_GATEWAY_STATE_DIR) {
          env.HOME = path.join(process.env.BURROW_GATEWAY_STATE_DIR, 'gemini');
          mkdirSync(path.join(env.HOME, '.gemini'), { recursive: true, mode: 0o700 });
        }
        env.GEMINI_API_KEY = params.apiKey;
        // System scope wins over workspace and existing interactive auth settings.
        if (env.HOME) {
          const settingsPath = path.join(env.HOME, '.gemini', 'burrow-system-settings.json');
          mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
          writeFileSync(settingsPath, JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key', enforcedType: 'gemini-api-key', useExternal: false } } }), { mode: 0o600 });
          env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = settingsPath;
        }
      } else if (codexHome) env = { ...process.env, CODEX_HOME: codexHome };
      const child = this.spawnProcess(executable, args, {
        cwd: params.cwd, ...(env ? { env } : {}), stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32',
      });
      entry = { child, identity: process.platform === 'linux' ? linuxProcess(child.pid)?.start : null, runtime, owner: owner.connectionId, data: '', bytes: 0, done: false, decoder: new StringDecoder('utf8') };
      this.sessions.set(id, entry);
      child.stdout.on('data', chunk => {
        entry.data += entry.decoder.write(chunk); entry.bytes = Buffer.byteLength(entry.data);
        if (entry.bytes > 8 * 1024 * 1024) this.destroy(id);
      });
      // Assemble complete lines before redacting so chunk-split keys cannot leak.
      // Drop oversized/structured tool lines rather than forwarding raw payloads.
      let diagnosticLine = '', droppingDiagnostic = false;
      const diagnosticDecoder = new StringDecoder('utf8');
      const sanitize = value => String(value || '').split(params.apiKey || '\0').join('[redacted]')
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 2000);
      const retainLine = () => {
        if (!droppingDiagnostic && !/[{}]|^\s*[\[]|tool[_ -]?(use|result|payload)|parameters\s*[:=]/i.test(diagnosticLine)) {
          entry.stderr = ((entry.stderr || '') + sanitize(diagnosticLine) + '\n').slice(-8000);
        }
        diagnosticLine = ''; droppingDiagnostic = false;
      };
      child.stderr.on('data', chunk => {
        if (runtime !== 'gemini') return;
        for (const part of diagnosticDecoder.write(chunk).split(/(?<=\n)/)) {
          if (!droppingDiagnostic) diagnosticLine += part;
          if (diagnosticLine.length > 32768) { diagnosticLine = ''; droppingDiagnostic = true; }
          if (part.endsWith('\n')) retainLine();
        }
      });
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => this.destroy(id));
      child.on('error', error => {
        if (runtime === 'gemini') entry.processError = sanitize(error?.message);
        else this.destroy(id);
      });
      child.on('close', (code, signal) => { if (runtime === 'gemini') { diagnosticLine += diagnosticDecoder.end(); retainLine(); } entry.done = true; entry.exitCode = code; entry.signal = signal; clearTimeout(entry.timer); if (this.sessions.get(id) === entry) { entry.timer = setTimeout(() => this.destroy(id), 60_000); entry.timer.unref?.(); } });
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
      const stderr = runtime === 'gemini' ? entry.stderr || '' : '';
      entry.stderr = '';
      const done = entry.done && !entry.data;
      if (done) { clearTimeout(entry.timer); this.sessions.delete(id); }
      return { operationId: id, data, done, ...(runtime === 'gemini' ? { stderr, ...(entry.processError ? { processError: entry.processError } : {}) } : {}), ...(done ? { exitCode: entry.exitCode, signal: entry.signal } : {}) };
    }
    if (method === 'codex.close') {
      if (params.signal != null && !['SIGTERM', 'SIGKILL'].includes(params.signal)) throw new Error('codex_signal_invalid');
      if (params.signal) {
        terminateTree(entry, params.signal);
      } else entry.child.stdin.end();
      return { operationId: id, closed: entry.done };
    }
    throw new Error('codex_method_invalid');
  }
  destroy(id) {
    const entry = this.sessions.get(id); if (!entry) return;
    this.sessions.delete(id); clearTimeout(entry.timer); entry.data = '';
    if (!entry.done) terminateTree(entry);
    entry.done = true;
  }
  closeAll() { for (const id of this.sessions.keys()) this.destroy(id); }
}
