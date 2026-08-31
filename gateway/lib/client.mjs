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
    this.rl = readline.createInterface({ input: this.output, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      const message = JSON.parse(line);
      if (message.requestId != null && this.pending.has(message.requestId) && (message.type === 'response' || message.type === 'error' || message.type === 'accepted')) {
        const entry = this.pending.get(message.requestId);
        if (message.type === 'accepted') {
          entry.accepted = message;
          entry.onAccepted?.(message);
        } else {
          this.pending.delete(message.requestId);
          entry.resolve({ accepted: entry.accepted ?? null, message });
        }
        return;
      }
      if (message.operationId) {
        const listeners = this.events.get(message.operationId) ?? [];
        for (const listener of listeners) listener(message);
      }
    });
  }

  static spawn({ command = process.execPath, args = ['cli.mjs'], cwd } = {}) {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    return new GatewayClient({ child });
  }

  onOperation(operationId, listener) {
    const listeners = this.events.get(operationId) ?? [];
    listeners.push(listener);
    this.events.set(operationId, listeners);
    return () => {
      this.events.set(operationId, (this.events.get(operationId) ?? []).filter((entry) => entry !== listener));
    };
  }

  request(method, params = {}, { onAccepted } = {}) {
    const id = String(this.nextId++);
    return new Promise((resolve) => {
      this.pending.set(id, { resolve, accepted: null, onAccepted });
      this.input.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async exec(params = {}, listener) {
    const seen = [];
    let unlisten = null;
    const { accepted, message } = await this.request('process.exec', params, {
      onAccepted: (acceptedMessage) => {
        unlisten = this.onOperation(acceptedMessage.operationId, (event) => {
          seen.push(event);
          listener?.(event);
        });
      },
    });
    unlisten?.();
    return { accepted, response: message, events: seen };
  }

  async close() {
    this.rl.close();
    this.input.end();
    if (this.child) await new Promise((resolve) => this.child.once('close', resolve));
  }
}
