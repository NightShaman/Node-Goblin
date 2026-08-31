import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { GatewayDaemon } from './daemon.mjs';

const AUTH_CONTEXT = 'burrow-host-gateway-auth-v1';

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing_${name}`);
  return value;
}

export function enrollmentPath(stateDir) {
  return path.join(stateDir, 'controller-trust.json');
}

// The enrollment token is a one-time out-of-band shared secret. Once persisted,
// subsequent supplied tokens are deliberately ignored rather than rotating trust.
export function enrollController({ stateDir, token, controllerId = 'controller' }) {
  requireText(stateDir, 'state_dir');
  const file = enrollmentPath(stateDir);
  if (fs.existsSync(file)) return readControllerTrust(stateDir);
  requireText(token, 'enrollment_token');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const trust = { version: 1, controllerId, secret: token, enrolledAt: new Date().toISOString() };
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(trust)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return trust;
}

export function readControllerTrust(stateDir) {
  const trust = JSON.parse(fs.readFileSync(enrollmentPath(stateDir), 'utf8'));
  if (trust?.version !== 1) throw new Error('unsupported_trust_version');
  requireText(trust.controllerId, 'controller_id');
  requireText(trust.secret, 'controller_secret');
  return trust;
}

export function authenticationProof(secret, gatewayId, nonce) {
  return crypto.createHmac('sha256', secret)
    .update(`${AUTH_CONTEXT}\0${gatewayId}\0${nonce}`)
    .digest('hex');
}

class SocketOutput {
  constructor() { this.socket = null; }
  write(data) {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) return false;
    return this.socket.write(data);
  }
}

export class OutboundGatewayTransport extends EventEmitter {
  constructor({ host, port, gatewayId = process.env.HOSTNAME || 'gateway', stateDir, enrollmentToken, ca, cert, key, servername = host, reconnectMinMs = 100, reconnectMaxMs = 5000, daemon, tlsConnect = tls.connect } = {}) {
    super();
    this.host = requireText(host, 'host');
    this.port = Number(port);
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('invalid_port');
    this.gatewayId = requireText(gatewayId, 'gateway_id');
    this.trust = enrollController({ stateDir, token: enrollmentToken });
    this.tlsOptions = { host: this.host, port: this.port, servername, rejectUnauthorized: true, ca, cert, key };
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.tlsConnect = tlsConnect;
    this.output = new SocketOutput();
    this.daemon = daemon || new GatewayDaemon({ output: this.output, identity: { transport: 'tls-jsonl-outbound' } });
    this.daemon.output = this.output;
    this.daemon.identity.transport = 'tls-jsonl-outbound';
    const stopDaemon = this.daemon.stop.bind(this.daemon);
    this.daemon.stop = () => { stopDaemon(); this.stop(); };
    this.socket = null;
    this.timer = null;
    this.stopped = true;
    this.attempt = 0;
    this.authenticated = false;
    this.proofSent = false;
    this.buffer = '';
  }

  start() {
    if (!this.stopped) return this;
    this.stopped = false;
    this.connect();
    return this;
  }

  connect() {
    if (this.stopped) return;
    this.authenticated = false;
    this.proofSent = false;
    this.buffer = '';
    const socket = this.tlsConnect(this.tlsOptions);
    this.socket = socket;
    this.output.socket = socket;
    socket.setEncoding('utf8');
    socket.on('secureConnect', () => this.emit('connected'));
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.emit('connectionError', error));
    socket.on('close', () => {
      if (this.output.socket === socket) this.output.socket = null;
      this.authenticated = false;
      this.emit('disconnected');
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** this.attempt++));
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
    this.timer.unref?.();
  }

  send(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  reject(code) {
    this.send({ type: 'transport.error', ok: false, error: { code } });
  }

  onData(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 2 * 1024 * 1024) {
      this.reject('frame_too_large');
      this.socket.destroy();
      return;
    }
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
      this.reject('invalid_json');
      return;
    }
    if (!this.authenticated) {
      if (message?.type === 'auth.challenge' && typeof message.nonce === 'string' && message.nonce.length >= 16) {
        this.send({
          type: 'auth.response',
          gatewayId: this.gatewayId,
          controllerId: this.trust.controllerId,
          proof: authenticationProof(this.trust.secret, this.gatewayId, message.nonce),
        });
        this.proofSent = true;
        return;
      }
      if (message?.type === 'auth.ok' && this.proofSent) {
        this.authenticated = true;
        this.attempt = 0;
        this.emit('authenticated');
        return;
      }
      this.reject('unauthenticated');
      return;
    }
    if (message?.type?.startsWith?.('auth.')) {
      this.reject('unexpected_auth_message');
      return;
    }
    this.daemon.handleLine(line);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.socket?.destroy();
    this.output.socket = null;
  }
}
