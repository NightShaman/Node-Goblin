import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { EventEmitter } from 'node:events';
import { GatewayDaemon } from './daemon.mjs';
import { loadNodeIdentity, signPairing, pairingCode } from './pairing.mjs';

const AUTH_CONTEXT = 'burrow-host-gateway-auth-v1';

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`missing_${name}`);
  return value;
}

export function enrollmentPath(stateDir) {
  return path.join(stateDir, 'controller-trust.json');
}

export function enrollmentConsumedPath(stateDir) {
  return path.join(stateDir, 'controller-enrollment-consumed');
}

export function markEnrollmentConsumed(stateDir) {
  const file = enrollmentConsumedPath(stateDir);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
}

export function pairingCodePath(stateDir) {
  return path.join(stateDir, 'pairing-code.json');
}

export function writePairingCode(stateDir, value) {
  const file = pairingCodePath(stateDir);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ gatewayId: value.gatewayId, pairingCode: value.pairingCode, updatedAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
}

export function clearPairingCode(stateDir) {
  fs.rmSync(pairingCodePath(stateDir), { force: true });
}

// The enrollment token is a one-time out-of-band shared secret. Once the first
// authentication succeeds, it cannot silently recreate trust after an explicit
// unpair; a later connection must use the normal pairing flow.
export function enrollController({ stateDir, token, controllerId = 'controller' }) {
  requireText(stateDir, 'state_dir');
  const file = enrollmentPath(stateDir);
  if (fs.existsSync(file)) return readControllerTrust(stateDir);
  if (fs.existsSync(enrollmentConsumedPath(stateDir))) return null;
  requireText(token, 'enrollment_token');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const trust = { version: 1, controllerId, secret: token, enrolledAt: new Date().toISOString() };
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(trust)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
  return trust;
}

function persistNodeIdentity(stateDir, identity) {
  const file = path.join(stateDir, 'node-identity.json');
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(identity)}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file); fs.chmodSync(file, 0o600);
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
  constructor({ host, port, gatewayId = process.env.HOSTNAME || 'gateway', stateDir, enrollmentToken, ca, cert, key, servername, reconnectMinMs = 100, reconnectMaxMs = 5000, daemon, tlsConnect = tls.connect } = {}) {
    super();
    this.host = requireText(host, 'host');
    this.port = Number(port);
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535) throw new Error('invalid_port');
    this.gatewayId = requireText(gatewayId, 'gateway_id');
    const hadTrust = fs.existsSync(enrollmentPath(stateDir));
    this.trust = enrollmentToken ? enrollController({ stateDir, token: enrollmentToken }) : (hadTrust ? readControllerTrust(stateDir) : null);
    this.enrollmentTokenUsed = Boolean(enrollmentToken && !hadTrust && this.trust);
    this.nodeIdentity = loadNodeIdentity(stateDir); this.stateDir = stateDir; this.pendingControllerPublicKey = null; this.pendingControllerTlsFingerprint = null;
    this.hasExplicitCa = Boolean(ca);
    // Only an entirely unpaired node without an explicit CA gets a temporary
    // unauthenticated TLS channel for the pairing-code transcript.
    this.pinnedTlsFingerprint = this.nodeIdentity.controllerTlsFingerprint || null;
    const pairingBootstrap = !this.hasExplicitCa && !this.trust && !this.nodeIdentity.controllerPublicKey && !this.pinnedTlsFingerprint;
    const tlsServername = servername === undefined ? (net.isIP(this.host) ? undefined : this.host) : servername;
    this.tlsOptions = { host: this.host, port: this.port, ...(tlsServername ? { servername: tlsServername } : {}), rejectUnauthorized: pairingBootstrap || Boolean(this.pinnedTlsFingerprint) ? false : true, ca, cert, key };
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
    this.connectionId = null;
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
    socket.on('secureConnect', () => {
      const raw = socket.getPeerCertificate?.(true)?.raw;
      const fingerprint = raw ? crypto.createHash('sha256').update(raw).digest('hex') : null;
      const pinned = typeof this.pinnedTlsFingerprint === 'string' && /^[0-9a-f]{64}$/i.test(this.pinnedTlsFingerprint) ? this.pinnedTlsFingerprint : null;
      if (this.pinnedTlsFingerprint && (!pinned || !fingerprint || !crypto.timingSafeEqual(Buffer.from(pinned, 'hex'), Buffer.from(fingerprint, 'hex')))) {
        const error = new Error('controller_tls_identity_mismatch'); error.code = 'controller_tls_identity_mismatch'; this.emit('connectionError', error); socket.destroy(); return;
      }
      this.pendingControllerTlsFingerprint = fingerprint;
      this.emit('connected');
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.emit('connectionError', error));
    socket.on('close', () => {
      if (this.output.socket === socket) this.output.socket = null;
      this.authenticated = false;
      this.connectionId = null;
      this.daemon.secureTransportContext = null;
      this.emit('disconnected');
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.timer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** this.attempt++));
    // Keep the retry timer referenced: it may be the only event-loop handle after
    // a controller disconnect, and the daemon must remain alive to reconnect.
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delay);
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
        this.pendingControllerPublicKey = message.controllerPublicKey;
        if (!this.trust && (!message.controllerPublicKey || (this.nodeIdentity.controllerPublicKey && this.nodeIdentity.controllerPublicKey !== message.controllerPublicKey))) { this.reject('controller_identity_mismatch'); this.socket.destroy(); return; }
        this.send({
          type: 'auth.response',
          gatewayId: this.gatewayId,
          controllerId: this.trust?.controllerId ?? 'controller',
          ...(this.trust ? { proof: authenticationProof(this.trust.secret, this.gatewayId, message.nonce) } : { nodePublicKey: this.nodeIdentity.publicKey, pairingSignature: signPairing(this.nodeIdentity, message.nonce, this.gatewayId, message.controllerPublicKey), pairingCode: pairingCode({ nonce: message.nonce, gatewayId: this.gatewayId, gatewayPublicKey: this.nodeIdentity.publicKey, controllerPublicKey: message.controllerPublicKey }) }),
          gateway: {
            name: this.daemon.identity.name,
            version: this.daemon.identity.version,
            protocolVersion: this.daemon.identity.protocolVersion,
          },
        });
        this.proofSent = true;
        return;
      }
      if (message?.type === 'pairing.pending' && this.proofSent && typeof message.pairingCode === 'string') {
        // Pending sockets deliberately never receive daemon requests. Expose the transcript code for operator comparison.
        this.emit('pairingPending', { gatewayId: this.gatewayId, pairingCode: message.pairingCode });
        return;
      }
      if (message?.type === 'auth.ok' && this.proofSent) {
        this.authenticated = true;
        if (this.enrollmentTokenUsed) markEnrollmentConsumed(this.stateDir);
        clearPairingCode(this.stateDir);
        if (!this.trust && !this.nodeIdentity.controllerPublicKey) {
          if (!this.pendingControllerPublicKey || !this.pendingControllerTlsFingerprint) { this.reject('controller_identity_missing'); this.socket.destroy(); return; }
          this.nodeIdentity.controllerPublicKey = this.pendingControllerPublicKey;
          this.nodeIdentity.controllerTlsFingerprint = this.pendingControllerTlsFingerprint;
          this.pinnedTlsFingerprint = this.pendingControllerTlsFingerprint;
          persistNodeIdentity(this.stateDir, this.nodeIdentity);
        }
        this.connectionId = typeof message.connectionId === 'string' ? message.connectionId : null;
        this.daemon.secureTransportContext = this.connectionId
          ? { gatewayId: this.gatewayId, connectionId: this.connectionId } : null;
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
