import { CodexProcesses, codexExecutable, claudeExecutable, geminiExecutable } from './codex-process.mjs';
import { boundOutputFrame, boundCompletedOutcome } from './output-frame.mjs';
import readline from 'node:readline';
import { readFileSync } from 'node:fs';

const RELEASE_VERSION = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
import process from 'node:process';
import { OperationJournal } from './journal.mjs';
import { PROTOCOL_VERSION, normalizeTraceContext, operationIdFromRequest, requestDigestFromParams } from './protocol.mjs';
import { runProcess } from './process-runner.mjs';
import { runFilesystem } from './filesystem-runner.mjs';
import { createGatewayTelemetry } from './otel-runtime.mjs';
import { normalizePrivateTelemetryConfiguration } from './telemetry-configuration.mjs';
import { desktopErrorCodes, desktopRequest } from './windows-desktop.mjs';
import { collectHostMetadata } from './host-metadata.mjs';

export class GatewayDaemon {
  constructor({ input = process.stdin, output = process.stdout, error = process.stderr, now = () => Date.now(), journal = new OperationJournal(), identity = {}, telemetry = null, desktop = null } = {}) {
    this.input = input;
    this.output = output;
    this.error = error;
    this.now = now;
    this.journal = journal;
    this.identity = {
      name: 'burrow-host-gateway',
      version: RELEASE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      transport: 'stdio-jsonl',
      ...identity,
    };
    this.telemetry = telemetry || createGatewayTelemetry({ version: RELEASE_VERSION });
    this.controllers = new Map();
    this.codex = new CodexProcesses();
    this.desktop = desktop;
    this.rl = null;
    this.stopping = false;
  }

  send(message) {
    this.output.write(`${JSON.stringify(boundOutputFrame(message))}\n`);
  }

  sendProtocolError(requestId, code, extra = {}, send = (value) => this.send(value)) {
    send({ type: 'error', requestId, ok: false, error: { code, ...extra } });
  }

  async handle(message, send = (value) => this.send(value)) {
    if (!message || typeof message !== 'object') throw new Error('invalid_message');
    const method = String(message.method ?? '');
    const params = message.params && typeof message.params === 'object' ? message.params : {};
    if (/^(codex|claude|gemini)\./.test(method)) {
      try {
        const result = await this.codex.handle(method, params, this.secureTransportContext);
        send({ type: 'response', requestId: message.id ?? null, ok: true, result });
      } catch { this.sendProtocolError(message.id ?? null, 'codex_transport_failed', {}, send); }
      return;
    }
    if (method === 'desktop.execute') {
      try {
        if (!this.secureTransportContext) throw new Error('desktop_transport_required');
        if (this.stopping) throw new Error('desktop_helper_absent');
        const request = desktopRequest(params);
        if (!this.desktop && request.action !== 'status') throw new Error('desktop_disabled');
        const result = this.desktop ? await this.desktop.execute(request) : { available: false, state: 'desktop_unsupported' };
        send({ type: 'response', requestId: message.id ?? null, ok: true, result });
      } catch (error) { this.sendProtocolError(message.id ?? null, desktopErrorCodes.has(error.message) ? error.message : 'desktop_action_failed', {}, send); }
      return;
    }
    if (method === 'hello') {
      send({ type: 'response', requestId: message.id ?? null, ok: true, result: { ...this.identity, host: { ...collectHostMetadata(), codex: { available: Boolean(codexExecutable()), protocol: 1 }, claude: { available: Boolean(claudeExecutable()), protocol: 1 }, gemini: { available: Boolean(geminiExecutable()), protocol: 1 } } } });
      return;
    }
    if (method === 'health') {
      send({ type: 'response', requestId: message.id ?? null, ok: true, result: { status: this.stopping ? 'stopping' : 'ok', activeOperations: [...this.controllers.keys()] } });
      return;
    }
    if (method === 'telemetry.configure') {
      const result = await this.telemetry.configure(params);
      send({ type: 'response', requestId: message.id ?? null, ok: true, result });
      return;
    }
    if (method === 'cancel') {
      const operationId = String(params.operationId ?? '');
      const active = this.controllers.get(operationId);
      if (active) active.controller.abort();
      send({ type: 'response', requestId: message.id ?? null, ok: true, result: { operationId, cancelling: Boolean(active) } });
      return;
    }
    if (method === 'shutdown') {
      if (this.controllers.size) {
        this.sendProtocolError(message.id ?? null, 'shutdown_requires_idle', {}, send);
        return;
      }
      this.stopping = true;
      send({ type: 'response', requestId: message.id ?? null, ok: true, result: { status: 'stopping' } });
      queueMicrotask(() => this.stop());
      return;
    }
    if (this.stopping) {
      this.sendProtocolError(message.id ?? null, 'gateway_stopping', {}, send);
      return;
    }
    if (method !== 'process.exec' && method !== 'filesystem.execute') throw new Error('unknown_method');

    const protectedValues = params.protectedValues && typeof params.protectedValues === 'object' && !Array.isArray(params.protectedValues)
      ? { ...params.protectedValues } : null;
    const hasProtectedValues = protectedValues && Object.keys(protectedValues).length > 0;
    if (hasProtectedValues) {
      const delivery = params.protectedDelivery;
      const context = this.secureTransportContext;
      const validValues = method === 'process.exec' && Object.entries(protectedValues)
        .every(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === 'string' && value.length > 0);
      if (!validValues || !context || delivery?.gatewayId !== context.gatewayId || delivery?.connectionId !== context.connectionId
        || delivery?.requestId !== String(message.id ?? '') || delivery?.operationId !== String(params.operationId ?? '')) {
        throw new Error('protected_delivery_binding_invalid');
      }
    }
    // The private owner is admitted only on the authenticated controller
    // transport, never from an operator's local process.exec/FS request.
    if (params.telemetryConfiguration != null && !this.secureTransportContext) throw new Error('telemetry_configuration_transport_required');
    const telemetryConfiguration = normalizePrivateTelemetryConfiguration(params.telemetryConfiguration);
    const safeParams = { ...params };
    delete safeParams.protectedValues;
    delete safeParams.protectedDelivery;
    delete safeParams.telemetryConfiguration;
    const traceContext = normalizeTraceContext(safeParams.traceContext);
    delete safeParams.traceContext;
    const operationRequest = { method, params: safeParams };
    const requestDigest = requestDigestFromParams(safeParams, method);
    const operationId = String(safeParams.operationId || operationIdFromRequest(operationRequest));
    const replay = this.journal.inspect(operationId, this.now());
    if (replay) {
      if (hasProtectedValues) {
        send({ type: 'response', requestId: message.id ?? null, ok: false, error: { code: 'protected_redelivery_forbidden', operationId } });
        return;
      }
      if (replay.requestDigest && replay.requestDigest !== requestDigest) {
        send({ type: 'response', requestId: message.id ?? null, ok: false, error: { code: 'operation_id_conflict', operationId } });
        return;
      }
      send({ type: 'response', requestId: message.id ?? null, ok: true, result: { operationId, replay: true, outcome: replay.result } });
      return;
    }

    const active = this.controllers.get(operationId);
    if (active) {
      if (active.requestDigest !== requestDigest) {
        send({ type: 'response', requestId: message.id ?? null, ok: false, error: { code: 'operation_id_conflict', operationId } });
        return;
      }
      send({ type: 'response', requestId: message.id ?? null, ok: false, error: { code: 'operation_in_progress', operationId } });
      return;
    }

    const controller = new AbortController();
    this.controllers.set(operationId, { controller, requestDigest });
    send({ type: 'accepted', requestId: message.id ?? null, ok: true, operationId, protocolVersion: PROTOCOL_VERSION });

    try {
      let terminalEvent;
      const rawOutcome = await this.telemetry.execute({
        kind: method === 'process.exec' ? 'process' : 'filesystem',
        tool: method === 'filesystem.execute' ? safeParams.tool : 'shell_exec',
        targetId: this.secureTransportContext?.gatewayId || null,
        operationId,
        traceContext,
        ...(telemetryConfiguration ? { telemetryConfiguration } : {}),
        operation: () => method === 'process.exec'
          ? runProcess(safeParams, { protectedEnv: protectedValues, signal: controller.signal, now: this.now, emitEvent: (event) => {
            if (event.type === 'process.terminal') terminalEvent = event;
            else send({ ...event, operationId });
          } })
          : runFilesystem(safeParams, { signal: controller.signal, now: this.now }),
      });
      const outcome = boundCompletedOutcome(rawOutcome, { operationId, requestId: message.id ?? null });
      this.journal.put(operationId, requestDigest, outcome, this.now());
      if (terminalEvent) send({ ...terminalEvent, evidence: outcome, operationId });
      send({ type: 'response', requestId: message.id ?? null, ok: true, result: { operationId, replay: false, outcome } });
    } catch (error) {
      send({ type: 'response', requestId: message.id ?? null, ok: false, error: { code: error.message || 'process_failed', operationId } });
    } finally {
      this.controllers.delete(operationId);
    }
  }

  handleLine(line, send = (value) => this.send(value)) {
    if (!line.trim()) return;
    let requestId = null;
    try {
      const parsed = JSON.parse(line);
      requestId = parsed && typeof parsed === 'object' ? parsed.id ?? null : null;
      Promise.resolve().then(() => this.handle(parsed, send)).catch((error) => {
        this.sendProtocolError(requestId, error.message || 'invalid_request', {}, send);
      });
    } catch {
      const match = line.match(/"id"\s*:\s*("(?:[^"\\]|\\.)*"|null|[0-9]+|true|false)/);
      if (match) {
        try { requestId = JSON.parse(match[1]); } catch {}
      }
      this.sendProtocolError(requestId, 'invalid_json', {}, send);
    }
  }

  start() {
    this.rl = readline.createInterface({ input: this.input, crlfDelay: Infinity });
    this.rl.on('line', (line) => this.handleLine(line));
    return this;
  }

  async stop() {
    this.codex.closeAll();
    if (this.rl) this.rl.close();
    if (this.output !== process.stdout && typeof this.output.end === 'function') this.output.end();
    await this.telemetry.shutdown();
  }
}
