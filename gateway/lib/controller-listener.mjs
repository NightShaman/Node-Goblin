import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import tls from 'node:tls';

const AUTH_CONTEXT = 'burrow-host-gateway-auth-v1';
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

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
    this.state = 'ready';
    this.health = { status: 'ok', activeOperations: [] };
    this.send({ type: 'auth.ok' });
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
    const entry = { requestId, accepted: null, events: [], resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.pendingRequests.set(requestId, entry);
    this.send({ id: requestId, method, params });
    return promise;
  }

  onClose() {
    this.listener.unbindGatewayIdentity(this);
    this.state = 'closed';
    this.health = { status: 'disconnected', activeOperations: [] };
    const error = disconnectError(this.gatewayId ?? 'unknown');
    for (const pending of this.pendingRequests.values()) pending.reject(error);
    this.pendingRequests.clear();
    this.activeOperationRequests.clear();
    this.listener.emit('gatewayDisconnected', { gatewayId: this.gatewayId, connection: this });
  }
}

export class GatewayControllerListener extends EventEmitter {
  constructor({ gateways = [], serverOptions = {}, tlsServer = tls.createServer, nonceFactory = challengeNonce } = {}) {
    super();
    this.gatewayRecords = toGatewayRecords(gateways);
    this.connections = new Map();
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
    if (connection.gatewayId && this.connections.get(connection.gatewayId) === connection) this.connections.delete(connection.gatewayId);
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

  listLiveGateways() {
    return [...this.connections.entries()].map(([gatewayId, connection]) => ({
      gatewayId,
      status: connection.health.status,
      activeOperations: [...connection.health.activeOperations],
    }));
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
