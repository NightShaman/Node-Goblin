import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GatewayDaemon } from '../../lib/daemon.mjs';
import { OperationJournal } from '../../lib/journal.mjs';
import { OutboundGatewayTransport } from '../../lib/network-transport.mjs';
import { WindowsDesktop, desktopErrorCodes } from '../../lib/windows-desktop.mjs';

const networkErrors = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER', 'controller_tls_identity_mismatch',
]);
const protocolErrors = new Set([
  'authentication_timeout', 'channel_binding_required', 'controller_identity_mismatch',
  'pairing_transcript_mismatch', 'controller_identity_missing', 'unauthenticated',
  'unexpected_auth_message', 'frame_too_large', 'invalid_json', 'authentication_failed',
  'invalid_auth', 'invalid_gateway_id', 'gateway_not_registered', 'invalid_proof', 'pairing_required',
  'pairing_rejected', 'gateway_identity_mismatch', 'pairing_timeout', 'gateway_revoked',
  'invalid_auth_message', 'channel_binding_unavailable', 'unknown_node', 'identity_mismatch',
  'auth_failed', 'gateway_already_connected', 'pending_pairings_full', 'gateway_identity_conflict',
]);
const stateErrors = new Set(['EACCES', 'EPERM', 'ENOENT', 'EBUSY', 'ENOSPC', 'unsupported_trust_version',
  'missing_controller_id', 'missing_controller_secret', 'invalid_node_identity']);

export function validateEndpoint(controller, gatewayId) {
  if (typeof controller !== 'string' || !/^tls:\/\/(?:\[[0-9a-f:.]+\]|[a-z0-9._-]+):[0-9]{1,5}\/?$/i.test(controller)
      || typeof gatewayId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/.test(gatewayId)
      || gatewayId === 'local') throw new Error('invalid_configuration');
  const endpoint = URL.parse(controller);
  const port = Number(endpoint?.port);
  if (!endpoint || port < 1 || port > 65535) throw new Error('invalid_configuration');
  return { host: endpoint.hostname.replace(/^\[|\]$/g, ''), port, gatewayId };
}

class ManagerTransport extends OutboundGatewayTransport {
  connect() {
    this.requiresPairingConfirmation = false;
    super.connect();
  }

  reject(code) {
    this.emit('authenticationError', protocolErrors.has(code) ? code : 'protocol_error');
    super.reject(code);
  }

  onLine(line) {
    if (!this.authenticated) {
      let message;
      try { message = JSON.parse(line); } catch {}
      if (message?.type === 'pairing.pending' && this.proofSent && message.pairingCode === this.localPairingCode) {
        this.requiresPairingConfirmation = true;
      }
      if (message?.type === 'auth.ok' && this.proofSent && this.requiresPairingConfirmation && !this.localConfirmation) {
        this.deferredAuth = line;
        this.emit('pairingPending', { gatewayId: this.gatewayId, pairingCode: this.localPairingCode });
        return;
      }
      if (message?.type === 'transport.error') {
        const code = message.error?.code;
        this.emit('authenticationError', protocolErrors.has(code) ? code : 'controller_rejected_authentication');
        this.socket.destroy();
        return;
      }
    }
    super.onLine(line);
  }
}

export function runManagerHost({ input = process.stdin, output = process.stdout, onFatal = () => {} } = {}) {
  const send = (type, values = {}) => output.write(JSON.stringify({ type, ...values }) + '\n');
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let service;
  let daemon;
  let pairingCode;
  let connection = 0;
  let desktop;
  let desktopTimer;
  let desktopState;
  let stopping = false;

  function showDesktop(state) {
    if (desktopState === state || stopping) return;
    desktopState = state;
    send('desktop', { state });
  }

  function revokeDesktop(state = 'desktop_disabled') {
    clearInterval(desktopTimer);
    desktop?.stop(state);
    desktop = undefined;
    if (daemon) daemon.desktop = new WindowsDesktop({ enabled: false });
    showDesktop(state);
  }

  async function checkDesktop(helper) {
    if (helper !== desktop || helper.pending) return;
    try {
      const { available, state } = await helper.execute({ action: 'status' });
      if (helper !== desktop) return;
      if (available === true && state === 'available') showDesktop('available');
      else if (state === 'desktop_starting') showDesktop(state);
      else revokeDesktop(desktopErrorCodes.has(state) ? state : 'desktop_action_failed');
    } catch (error) {
      if (helper === desktop && error.code !== 'desktop_busy') {
        revokeDesktop(desktopErrorCodes.has(error.code) ? error.code : 'desktop_action_failed');
      }
    }
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    revokeDesktop();
    lines.close();
    input.destroy();
    if (daemon) {
      daemon.stopping = true;
      for (const { controller } of daemon.controllers.values()) controller.abort();
      // The transport wraps daemon.stop to close the socket and retry timer first.
      await daemon.stop();
    }
  }

  function start(message) {
    let endpoint;
    try { endpoint = validateEndpoint(message.controller, message.gatewayId); }
    catch { send('fatal', { code: 'invalid_configuration' }); return stop(); }
    try {
      daemon = new GatewayDaemon({
        journal: new OperationJournal({ stateDir: message.stateDir }),
        desktop: new WindowsDesktop({ enabled: false }),
        identity: { transport: 'tls-jsonl-outbound' },
      });
      service = new ManagerTransport({ ...endpoint, stateDir: message.stateDir, daemon });
      service.on('connected', () => send('connected'));
      service.on('connectionError', error => {
        send('connectionError', { code: networkErrors.has(error.code) ? error.code : 'tls_connection_failed' });
      });
      service.on('authenticationError', code => send('authenticationError', { code }));
      service.on('pairingPending', value => {
        pairingCode = value.pairingCode;
        send('pairing', { code: pairingCode });
      });
      service.on('authenticated', () => {
        pairingCode = undefined;
        send('authenticated', { connection: ++connection, desktopSupported: Boolean(daemon.secureTransportContext) });
      });
      service.on('disconnected', () => {
        pairingCode = undefined;
        revokeDesktop();
        if (!stopping) send('disconnected');
      });
      send('connecting');
      service.start();
    } catch (error) {
      const code = stateErrors.has(error.code) ? error.code : stateErrors.has(error.message) ? error.message : 'gateway_state_unreadable';
      send('fatal', { code });
      return stop();
    }
  }

  function command(message) {
    if (stopping) return;
    if (message?.type === 'stop') return stop();
    if (message?.type === 'start' && !service) return start(message);
    if (!service) return;
    if (message?.type === 'confirm') {
      if (pairingCode && message.code === pairingCode && !service.authenticated && service.confirmControllerPairing(message.code)) {
        pairingCode = undefined;
        if (!service.authenticated) send('confirmed');
      } else send('confirmationExpired');
    }
    if (message?.type === 'desktopOff') revokeDesktop();
    if (message?.type === 'desktopOn' && service.authenticated && daemon.secureTransportContext
        && message.connection === connection && !desktop) {
      try {
        const helperPath = fileURLToPath(new URL('./desktop-helper.ps1', import.meta.url));
        if (process.platform !== 'win32' || !fs.lstatSync(helperPath).isFile()) {
          showDesktop('desktop_helper_absent');
          return;
        }
        desktop = daemon.desktop = new WindowsDesktop({ enabled: true });
        const helper = desktop;
        showDesktop('desktop_starting');
        desktopTimer = setInterval(() => void checkDesktop(helper), 400);
      } catch {
        revokeDesktop('desktop_helper_absent');
      }
    }
  }

  function fatal() {
    if (!stopping) send('fatal', { code: 'gateway_runtime_failed' });
    onFatal();
    void stop().catch(onFatal);
  }

  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    try { Promise.resolve(command(message)).catch(fatal); } catch { fatal(); }
  });
  lines.on('close', () => void stop().catch(onFatal));
  return { stop, fatal };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { fatal } = runManagerHost({ onFatal: () => { process.exitCode = 1; } });
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
}
