import readline from 'node:readline';
import process from 'node:process';
import { OperationJournal } from './journal.mjs';
import { PROTOCOL_VERSION, operationIdFromRequest, requestDigestFromParams } from './protocol.mjs';
import { runProcess } from './process-runner.mjs';

export class GatewayDaemon {
  constructor({ input = process.stdin, output = process.stdout, error = process.stderr, now = () => Date.now(), journal = new OperationJournal(), identity = {} } = {}) {
    this.input = input;
    this.output = output;
    this.error = error;
    this.now = now;
    this.journal = journal;
    this.identity = {
      name: 'burrow-host-gateway',
      version: '1.0.0',
      protocolVersion: PROTOCOL_VERSION,
      transport: 'stdio-jsonl',
      ...identity,
    };
    this.controllers = new Map();
    this.rl = null;
    this.stopping = false;
  }

  send(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  sendProtocolError(requestId, code, extra = {}) {
    this.send({ type: 'error', requestId, ok: false, error: { code, ...extra } });
  }

  async handle(message) {
    if (!message || typeof message !== 'object') throw new Error('invalid_message');
    const method = String(message.method ?? '');
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    if (method === 'hello') {
      this.send({ type: 'response', requestId: message.id ?? null, ok: true, result: { ...this.identity } });
      return;
    }
    if (method === 'health') {
      this.send({ type: 'response', requestId: message.id ?? null, ok: true, result: { status: this.stopping ? 'stopping' : 'ok', activeOperations: [...this.controllers.keys()] } });
      return;
    }
    if (method === 'cancel') {
      const operationId = String(params.operationId ?? '');
      const active = this.controllers.get(operationId);
      if (active) active.controller.abort();
      this.send({ type: 'response', requestId: message.id ?? null, ok: true, result: { operationId, cancelling: Boolean(active) } });
      return;
    }
    if (method === 'shutdown') {
      this.stopping = true;
      for (const controller of this.controllers.values()) controller.abort();
      this.send({ type: 'response', requestId: message.id ?? null, ok: true, result: { status: 'stopping' } });
      queueMicrotask(() => this.stop());
      return;
    }
    if (method !== 'process.exec') throw new Error('unknown_method');

    const operationRequest = { method, params };
    const requestDigest = requestDigestFromParams(params);
    const operationId = String(params.operationId || operationIdFromRequest(operationRequest));
    const replay = this.journal.inspect(operationId, this.now());
    if (replay) {
      if (replay.requestDigest && replay.requestDigest !== requestDigest) {
        this.send({ type: 'response', requestId: message.id ?? null, ok: false, error: { code: 'operation_id_conflict', operationId } });
        return;
      }
      this.send({ type: 'response', requestId: message.id ?? null, ok: true, result: { operationId, replay: true, outcome: replay.result } });
      return;
    }

    const active = this.controllers.get(operationId);
    if (active) {
      if (active.requestDigest !== requestDigest) {
        this.send({ type: 'response', requestId: message.id ?? null, ok: false, error: { code: 'operation_id_conflict', operationId } });
        return;
      }
      this.send({ type: 'response', requestId: message.id ?? null, ok: false, error: { code: 'operation_in_progress', operationId } });
      return;
    }

    const controller = new AbortController();
    this.controllers.set(operationId, { controller, requestDigest });
    this.send({ type: 'accepted', requestId: message.id ?? null, ok: true, operationId, protocolVersion: PROTOCOL_VERSION });

    try {
      const outcome = await runProcess(params, {
        signal: controller.signal,
        now: this.now,
        emitEvent: (event) => this.send({ ...event, operationId }),
      });
      this.journal.put(operationId, requestDigest, outcome, this.now());
      this.send({ type: 'response', requestId: message.id ?? null, ok: true, result: { operationId, replay: false, outcome } });
    } catch (error) {
      this.send({ type: 'response', requestId: message.id ?? null, ok: false, error: { code: error.message || 'process_failed', operationId } });
    } finally {
      this.controllers.delete(operationId);
    }
  }

  start() {
    this.rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    this.rl.on('line', (line) => {
      if (!line.trim()) return;
      let requestId = null;
      try {
        const parsed = JSON.parse(line);
        requestId = parsed && typeof parsed === 'object' ? parsed.id ?? null : null;
        Promise.resolve().then(() => this.handle(parsed)).catch((error) => {
          this.sendProtocolError(requestId, error.message || 'invalid_request');
        });
      } catch {
        const match = line.match(/"id"\s*:\s*("(?:[^"\\]|\\.)*"|null|[0-9]+|true|false)/);
        if (match) {
          try { requestId = JSON.parse(match[1]); } catch {}
        }
        this.sendProtocolError(requestId, 'invalid_json');
      }
    });
    return this;
  }

  stop() {
    if (this.rl) this.rl.close();
    if (this.output !== process.stdout && typeof this.output.end === 'function') this.output.end();
  }
}
