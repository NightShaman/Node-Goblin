import readline from 'node:readline';
import process from 'node:process';
import { spawn } from 'node:child_process';

export class GatewayClient {
  constructor({ child, input = child?.stdin, output = child?.stdout } = {}) {
    this.child = child;
    this.input = input;
    this.output = output;
    this.nextId = 1;
    this.pending = new Map();
    this.events = new Map();
    this.terminalError = null;
    this.childClosed = !child || child.exitCode != null || child.signalCode != null;
    this.childDone = this.childClosed ? Promise.resolve() : new Promise((resolve) => {
      child.once('close', () => {
        this.childClosed = true;
        this.terminate(new Error('gateway_child_closed'));
        resolve();
      });
    });
    this.onError = (error) => this.terminate(error);
    this.onExit = () => this.terminate(new Error('gateway_child_exited'));
    this.input.on('error', this.onError);
    this.output.on('error', this.onError);
    child?.on('error', this.onError);
    child?.once('exit', this.onExit);
    this.rl = readline.createInterface({ input: this.output, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
        if (!message || typeof message !== 'object') throw new Error('invalid_gateway_message');
      } catch (error) { this.terminate(error); return; }
      if (message.requestId != null && this.pending.has(message.requestId) && (message.type === 'response' || message.type === 'error' || message.type === 'accepted')) {
        const entry = this.pending.get(message.requestId);
        if (message.type === 'accepted') {
          entry.accepted = message;
          entry.onAccepted?.(message);
        } else {
          this.pending.delete(message.requestId);
          entry.cleanup();
          entry.resolve({ accepted: entry.accepted ?? null, message });
        }
        return;
      }
      if (message.operationId) {
        const listeners = this.events.get(message.operationId) ?? [];
        for (const listener of listeners) listener(message);
      }
    });
    this.rl.on('error', this.onError);
    this.rl.once('close', () => this.terminate(new Error('gateway_output_closed')));
  }

  terminate(error) {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(error); }
    this.pending.clear();
    this.events.clear();
    this.rl.close();
  }

  static spawn({ command = process.execPath, args = ['cli.mjs'], cwd, env = process.env } = {}) {
    // This helper speaks local stdio, not the network service selected by env.
    const childEnv = { ...env };
    delete childEnv.BURROW_GATEWAY_CONTROLLER_URL;
    const child = spawn(command, args, { cwd, env: childEnv, stdio: ['pipe', 'pipe', 'inherit'] });
    return new GatewayClient({ child });
  }

  onOperation(operationId, listener) {
    const listeners = this.events.get(operationId) ?? [];
    listeners.push(listener);
    this.events.set(operationId, listeners);
    return () => {
      const remaining = (this.events.get(operationId) ?? []).filter((entry) => entry !== listener);
      if (remaining.length) this.events.set(operationId, remaining);
      else this.events.delete(operationId);
    };
  }

  request(method, params = {}, { onAccepted, timeoutMs, signal } = {}) {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('request_aborted'));
    if (timeoutMs != null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) return Promise.reject(new Error('invalid_timeout'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      let timer;
      const fail = (error) => {
        if (!this.pending.delete(id)) return;
        cleanup();
        reject(error);
      };
      const onAbort = () => fail(signal.reason ?? new Error('request_aborted'));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      this.pending.set(id, { resolve, reject, cleanup, accepted: null, onAccepted });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (timeoutMs != null) timer = setTimeout(() => fail(new Error('request_timeout')), timeoutMs);
      try {
        this.input.write(`${JSON.stringify({ id, method, params })}\n`, (error) => { if (error) fail(error); });
      } catch (error) { fail(error); }
    });
  }

  async exec(params = {}, listener) {
    const seen = [];
    let unlisten = null;
    try {
      const { accepted, message } = await this.request('process.exec', params, {
        onAccepted: (acceptedMessage) => {
          unlisten = this.onOperation(acceptedMessage.operationId, (event) => {
            seen.push(event);
            listener?.(event);
          });
        },
      });
      return { accepted, response: message, events: seen };
    } finally { unlisten?.(); }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.terminate(new Error('gateway_client_closed'));
    this.input.end();
    // Child 'close' waits for stdio EOF; readline.close() pauses its input.
    this.output.resume?.();
    this.closePromise = this.childDone.finally(() => {
      this.input.removeListener('error', this.onError);
      this.output.removeListener('error', this.onError);
      this.rl.removeListener('error', this.onError);
      this.child?.removeListener('error', this.onError);
      this.child?.removeListener('exit', this.onExit);
    });
    return this.closePromise;
  }
}
