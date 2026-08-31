import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';

const AUTH_CONTEXT = 'burrow-host-gateway-auth-v1';
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const DEFAULT_ACTIVITY_LIMIT = 256;

function optionalText(value, max = 255) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function safeGatewayMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { name: null, version: null, protocolVersion: null };
  return { name: optionalText(value.name), version: optionalText(value.version), protocolVersion: optionalText(value.protocolVersion) };
}

function operationOutcome(message) {
  const outcome = message?.result?.outcome;
  if (message?.ok === false) return { terminalOutcome: optionalText(message?.error?.code, 128) || 'failed', durationMs: null };
  if (!outcome || typeof outcome !== 'object') return { terminalOutcome: message?.result?.cancelling ? 'cancelling' : 'completed', durationMs: null };
  let terminalOutcome = 'completed';
  if (outcome.timedOut === true) terminalOutcome = 'timed_out';
  else if (outcome.cancelled === true) terminalOutcome = 'cancelled';
  else if (typeof outcome.exitCode === 'number' && outcome.exitCode !== 0) terminalOutcome = 'failed';
  else if (outcome.ok === false) terminalOutcome = 'failed';
  return { terminalOutcome, durationMs: Number.isFinite(outcome.durationMs) ? outcome.durationMs : null };
}

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing_${name}`);
  return value.trim();
}

function toGatewayRecords(gateways = []) {
  return new Map(gateways.map((gateway) => [
    requireText(gateway.gatewayId, 'gateway_id'),
    {
      controllerId: requireText(gateway.controllerId ?? 'controller', 'controller_id'),
      secret: requireText(gateway.secret, 'secret'),
    },
  ]));
}

export function challengeNonce(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqualHex(left, right) {
  if (!/^[0-9a-f]+$/i.test(String(left)) || !/^[0-9a-f]+$/i.test(String(right))) return false;
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function controllerAuthenticationProof(secret, gatewayId, nonce) {
  return crypto.createHmac('sha256', secret)
    .update(`${AUTH_CONTEXT}\0${gatewayId}\0${nonce}`)
    .digest('hex');
}

function disconnectError(gatewayId) {
  const error = new Error(`gateway ${gatewayId} disconnected before terminal response; retry with the same operationId after reconnect`);
  error.code = 'gateway_disconnected';
  error.gatewayId = gatewayId;
  error.retryable = true;
  error.action = 'retry_same_operation_id_after_reconnect';
  return error;
}

class GatewayConnection extends EventEmitter {
  constructor(listener, socket, nonce = challengeNonce()) {
    super();
    this.listener = listener;
    this.socket = socket;
    this.connectionId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    this.state = 'authenticating';
    this.buffer = '';
    this.gatewayId = null;
    this.controllerId = null;
    this.gatewayMetadata = { name: null, version: null, protocolVersion: null };
    this.connectedAt = new Date().toISOString();
    this.lastSeenAt = this.connectedAt;
    this.nonce = nonce;
    this.pendingRequests = new Map();
    this.activeOperationRequests = new Map();
    this.health = { status: 'authenticating', activeOperations: [] };
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.listener.emit('gatewaySocketError', { connection: this, error }));
    socket.on('close', () => this.onClose());
    this.send({ type: 'auth.challenge', nonce: this.nonce });
  }

  send(message) {
    if (this.socket.destroyed || !this.socket.writable) return false;
    return this.socket.write(`${JSON.stringify(message)}\n`);
  }

  fail(code) {
    this.send({ type: 'transport.error', ok: false, error: { code } });
    this.socket.destroy();
  }

  onData(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_FRAME_BYTES) return this.fail('frame_too_large');
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  onLine(line) {
    this.lastSeenAt = new Date().toISOString();
    let message;
    try { message = JSON.parse(line); } catch {
      return this.state === 'ready'
        ? this.send({ type: 'error', requestId: null, ok: false, error: { code: 'invalid_json' } })
        : this.fail('invalid_json');
    }
    return this.state === 'ready' ? this.onGatewayMessage(message) : this.onAuthMessage(message);
  }

  onAuthMessage(message) {
    if (message?.type !== 'auth.response') return this.fail('unauthenticated');
    let gatewayId;
    let controllerId;
    try {
      gatewayId = requireText(message.gatewayId, 'gateway_id');
      controllerId = requireText(message.controllerId, 'controller_id');
    } catch {
      return this.fail('invalid_auth_message');
    }
    const record = this.listener.gatewayRecords.get(gatewayId);
    if (!record) return this.fail('unknown_gateway');
    if (controllerId !== record.controllerId) return this.fail('controller_identity_mismatch');
    const expected = controllerAuthenticationProof(record.secret, gatewayId, this.nonce);
    if (!safeEqualHex(expected, message.proof)) return this.fail('auth_failed');
    if (!this.listener.bindGatewayIdentity(gatewayId, this)) return this.fail('gateway_already_connected');
    this.gatewayId = gatewayId;
    this.controllerId = controllerId;
    this.gatewayMetadata = safeGatewayMetadata(message.gateway);
    this.state = 'ready';
    this.health = { status: 'ok', activeOperations: [] };
    this.send({ type: 'auth.ok', connectionId: this.connectionId });
    this.listener.emit('gatewayAuthenticated', { gatewayId, connection: this });
  }

  onGatewayMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'accepted' && message.requestId != null && typeof message.operationId === 'string') {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        pending.accepted = message;
        this.activeOperationRequests.set(message.operationId, pending.requestId);
      }
      this.health.activeOperations = [...this.activeOperationRequests.keys()];
      this.listener.recordAccepted(this.gatewayId, pending, message);
      this.listener.emit('gatewayAccepted', { gatewayId: this.gatewayId, message });
      return;
    }
    if (message.type === 'response' && message.requestId != null) {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.pendingRequests.delete(message.requestId);
        const operationId = message?.result?.operationId || message?.error?.operationId;
        if (operationId) this.activeOperationRequests.delete(operationId);
        this.health.activeOperations = [...this.activeOperationRequests.keys()];
        this.listener.recordResponse(this.gatewayId, pending, message);
        pending.resolve({ accepted: pending.accepted ?? null, response: message, events: [...pending.events] });
      }
      if (message?.result?.activeOperations) this.health = message.result;
      this.listener.emit('gatewayResponse', { gatewayId: this.gatewayId, message });
      return;
    }
    if (message.type === 'error' && message.requestId != null) {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.pendingRequests.delete(message.requestId);
        this.listener.recordResponse(this.gatewayId, pending, message);
        pending.reject(Object.assign(new Error(message?.error?.code || 'gateway_error'), { code: message?.error?.code || 'gateway_error', envelope: message }));
      }
      this.listener.emit('gatewayProtocolError', { gatewayId: this.gatewayId, message });
      return;
    }
    if (typeof message.operationId === 'string') {
      const requestId = this.activeOperationRequests.get(message.operationId);
      if (requestId) {
        const pending = this.pendingRequests.get(requestId);
        if (pending) pending.events.push(message);
      }
      this.listener.emit('gatewayEvent', { gatewayId: this.gatewayId, message });
    }
  }

  dispatch(method, params = {}) {
    if (this.state !== 'ready') return Promise.reject(Object.assign(new Error('gateway_not_ready'), { code: 'gateway_not_ready' }));
    const requestId = crypto.randomUUID();
    const entry = { requestId, method, operationId: optionalText(params.operationId, 256), startedAt: new Date().toISOString(), accepted: null, events: [], resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.pendingRequests.set(requestId, entry);
    this.listener.recordDispatch(this.gatewayId, entry);
    const hasProtectedValues = params.protectedValues && Object.keys(params.protectedValues).length > 0;
    const boundParams = hasProtectedValues ? {
      ...params,
      protectedDelivery: {
        gatewayId: this.gatewayId,
        operationId: String(params.operationId || ''),
        requestId,
        connectionId: this.connectionId,
      },
    } : params;
    this.send({ id: requestId, method, params: boundParams });
    return promise;
  }

  onClose() {
    this.listener.unbindGatewayIdentity(this);
    this.state = 'closed';
    this.health = { status: 'disconnected', activeOperations: [] };
    const error = disconnectError(this.gatewayId ?? 'unknown');
    for (const pending of this.pendingRequests.values()) {
      this.listener.recordDisconnected(this.gatewayId, pending);
      pending.reject(error);
    }
    this.pendingRequests.clear();
    this.activeOperationRequests.clear();
    this.listener.emit('gatewayDisconnected', { gatewayId: this.gatewayId, connection: this });
  }
}

export class GatewayControllerListener extends EventEmitter {
  constructor({ gateways = [], serverOptions = {}, tlsServer = tls.createServer, nonceFactory = challengeNonce, activityLimit = DEFAULT_ACTIVITY_LIMIT } = {}) {
    super();
    this.gatewayRecords = toGatewayRecords(gateways);
    this.connections = new Map();
    this.gatewayHealth = new Map([...this.gatewayRecords.keys()].map((gatewayId) => [gatewayId, { gatewayId, status: 'disconnected', connected: false, connectedAt: null, lastSeenAt: null, activeOperations: [], name: null, version: null, protocolVersion: null }]));
    this.activityLimit = Math.max(1, Math.min(1000, Number(activityLimit) || DEFAULT_ACTIVITY_LIMIT));
    this.activity = [];
    this.nonceFactory = nonceFactory;
    this.server = tlsServer(serverOptions, (socket) => this.onSocket(socket));
    this.server.on('tlsClientError', (error, socket) => this.emit('tlsClientError', { error, socket }));
    this.server.on('error', (error) => this.emit('listenerError', error));
  }

  onSocket(socket) {
    this.emit('gatewaySocketAccepted', { socket });
    return new GatewayConnection(this, socket, this.nonceFactory());
  }

  bindGatewayIdentity(gatewayId, connection) {
    const existing = this.connections.get(gatewayId);
    if (existing && existing !== connection && existing.state !== 'closed') return false;
    this.connections.set(gatewayId, connection);
    return true;
  }

  unbindGatewayIdentity(connection) {
    if (connection.gatewayId && this.connections.get(connection.gatewayId) === connection) {
      this.connections.delete(connection.gatewayId);
      const previous = this.gatewayHealth.get(connection.gatewayId) || {};
      this.gatewayHealth.set(connection.gatewayId, { ...previous, gatewayId: connection.gatewayId, status: 'disconnected', connected: false, connectedAt: null, lastSeenAt: connection.lastSeenAt, activeOperations: [] });
    }
  }

  listen(...args) {
    this.server.listen(...args);
    return this;
  }

  close(callback) {
    for (const connection of this.connections.values()) connection.socket.destroy();
    this.server.close(callback);
  }

  liveGateway(gatewayId) {
    return this.connections.get(gatewayId) ?? null;
  }

  gatewaySnapshot(gatewayId, connection) {
    const snapshot = {
      gatewayId, status: connection.health.status, connected: true,
      connectedAt: connection.connectedAt, lastSeenAt: connection.lastSeenAt,
      activeOperations: [...connection.health.activeOperations], ...connection.gatewayMetadata,
    };
    this.gatewayHealth.set(gatewayId, snapshot);
    return { ...snapshot, activeOperations: [...snapshot.activeOperations] };
  }

  listLiveGateways() {
    return [...this.connections.entries()].map(([gatewayId, connection]) => ({
      gatewayId, status: connection.health.status, activeOperations: [...connection.health.activeOperations],
    }));
  }

  listGateways() {
    for (const [gatewayId, connection] of this.connections) this.gatewaySnapshot(gatewayId, connection);
    return [...this.gatewayHealth.values()].map((entry) => ({ ...entry, activeOperations: [...entry.activeOperations] }));
  }

  putActivity(entry) {
    const index = this.activity.findIndex((value) => value.gatewayId === entry.gatewayId && value.operationId === entry.operationId);
    if (index >= 0) this.activity.splice(index, 1);
    this.activity.push(Object.freeze({ ...entry }));
    while (this.activity.length > this.activityLimit) this.activity.shift();
  }

  recordDispatch(gatewayId, pending) {
    if (!pending.operationId || pending.method === 'cancel') return;
    this.putActivity({ gatewayId, operationId: pending.operationId, kind: pending.method === 'filesystem.execute' ? 'filesystem' : 'process', state: 'dispatching', replay: false, reconnectRequired: false, terminalOutcome: null, startedAt: pending.startedAt, endedAt: null, durationMs: null });
  }

  recordAccepted(gatewayId, pending, message) {
    if (!pending?.operationId) return;
    this.putActivity({ ...(this.activity.find((entry) => entry.gatewayId === gatewayId && entry.operationId === pending.operationId) || {}), gatewayId, operationId: pending.operationId, kind: pending.method === 'filesystem.execute' ? 'filesystem' : 'process', state: 'running', replay: false, reconnectRequired: false, terminalOutcome: null, startedAt: pending.startedAt, acceptedAt: new Date().toISOString(), endedAt: null, durationMs: null });
  }

  recordResponse(gatewayId, pending, message) {
    if (!pending?.operationId || pending.method === 'cancel') return;
    const endedAt = new Date().toISOString();
    const outcome = operationOutcome(message);
    this.putActivity({ ...(this.activity.find((entry) => entry.gatewayId === gatewayId && entry.operationId === pending.operationId) || {}), gatewayId, operationId: pending.operationId, kind: pending.method === 'filesystem.execute' ? 'filesystem' : 'process', state: 'terminal', replay: message?.result?.replay === true, reconnectRequired: false, terminalOutcome: outcome.terminalOutcome, startedAt: pending.startedAt, endedAt, durationMs: outcome.durationMs ?? Math.max(0, Date.parse(endedAt) - Date.parse(pending.startedAt)) });
  }

  recordDisconnected(gatewayId, pending) {
    if (!pending?.operationId || pending.method === 'cancel') return;
    this.putActivity({ ...(this.activity.find((entry) => entry.gatewayId === gatewayId && entry.operationId === pending.operationId) || {}), gatewayId, operationId: pending.operationId, kind: pending.method === 'filesystem.execute' ? 'filesystem' : 'process', state: 'interrupted', replay: false, reconnectRequired: true, terminalOutcome: null, startedAt: pending.startedAt, endedAt: null, durationMs: null });
  }

  listOperationActivity({ gatewayId = null, limit = 50 } = {}) {
    const bounded = Math.max(1, Math.min(this.activityLimit, Number(limit) || 50));
    return this.activity.filter((entry) => !gatewayId || entry.gatewayId === gatewayId).slice(-bounded).reverse().map((entry) => ({ ...entry }));
  }

  dispatchProcessExec(gatewayId, params = {}) {
    const connection = this.liveGateway(gatewayId);
    if (!connection) return Promise.reject(Object.assign(new Error('gateway_not_connected'), { code: 'gateway_not_connected' }));
    return connection.dispatch('process.exec', params);
  }

  dispatchFilesystem(gatewayId, params = {}) {
    const connection = this.liveGateway(gatewayId);
    if (!connection) return Promise.reject(Object.assign(new Error('gateway_not_connected'), { code: 'gateway_not_connected' }));
    return connection.dispatch('filesystem.execute', params);
  }

  dispatchCancel(gatewayId, operationId) {
    const connection = this.liveGateway(gatewayId);
    if (!connection) return Promise.reject(Object.assign(new Error('gateway_not_connected'), { code: 'gateway_not_connected' }));
    return connection.dispatch('cancel', { operationId });
  }
}
