import { createHash } from 'node:crypto';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { controllerIdentity } from '../gateway/index.mjs';
import { GatewayControllerListener, canonicalize } from '../gateway/index.mjs';

const SETTINGS_NAME = 'targets';
const CONTROLLER_SETTINGS_NAME = 'controller';
const CONTROLLER_GATEWAYS_NAME = 'controllerGateways';
const PENDING_PAIRINGS_NAME = 'pendingNodeGoblinPairings';
const TLS_METADATA_NAME = 'controllerTlsMetadata';
const TARGET_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const OPERATION_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/i;

function problem(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cleanId(value) {
  const id = String(value ?? '').trim();
  if (!TARGET_ID.test(id) || id === 'local') throw problem('target_id_invalid');
  return id;
}

function cleanProcessRequest(value = {}) {
  const command = value.command;
  const executable = value.executable;
  const args = value.args;
  if (command != null && (typeof command !== 'string' || !command.trim())) throw problem('command_invalid');
  if (executable != null && (typeof executable !== 'string' || !executable.trim())) throw problem('executable_invalid');
  if (args != null && (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string'))) throw problem('args_invalid');
  if (command != null && executable != null) throw problem('command_and_executable_mutually_exclusive');
  if (command == null && executable == null) throw problem('command_or_executable_required');
  if (command != null && args?.length) throw problem('args_with_command_invalid');
  return command != null ? { command: command.trim() } : { executable: executable.trim(), args: args ? [...args] : [] };
}

function cleanName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw problem('target_name_required');
  return name;
}

function cleanBaseUrl(value) {
  let url;
  try { url = new URL(String(value ?? '').trim()); } catch { throw problem('target_base_url_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw problem('target_base_url_invalid');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function cleanTarget(value = {}) {
  return { id: cleanId(value.id), name: cleanName(value.name), baseUrl: cleanBaseUrl(value.baseUrl), enabled: value.enabled !== false };
}

async function storedTargets(settings) {
  const values = await settings.get(SETTINGS_NAME, []);
  if (!Array.isArray(values)) return [];
  return values.map((value) => { try { return cleanTarget(value); } catch { return null; } }).filter(Boolean);
}

function findTarget(targets, id) {
  const index = targets.findIndex((target) => target.id === id);
  if (index < 0) throw problem('api_target_not_found', 404);
  return index;
}

function cleanControllerConfig(value = {}) {
  const enabled = value.enabled === true;
  const host = String(value.host ?? '127.0.0.1').trim();
  const port = Number(value.port ?? 7443);
  if (!host || host.length > 255) throw problem('controller_host_invalid');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw problem('controller_port_invalid');
  return { enabled, host, port };
}

async function storedControllerConfig(settings) {
  try { return cleanControllerConfig(await settings.get(CONTROLLER_SETTINGS_NAME, {})); }
  catch { return cleanControllerConfig(); }
}

function cleanGatewayIdentity(value = {}, gatewayId = value.gatewayId) {
  const id = cleanId(gatewayId);
  const controllerId = String(value.controllerId ?? 'controller').trim();
  if (!controllerId || controllerId.length > 255) throw problem('controller_id_invalid');
  return { gatewayId: id, controllerId };
}

async function configuredGatewayIdentities(settings, secrets) {
  const configured = await settings.get(CONTROLLER_GATEWAYS_NAME, []);
  if (!Array.isArray(configured)) return [];
  return (await Promise.all(configured.map(async (value) => {
    try {
      const identity = cleanGatewayIdentity(value);
      const hasSharedSecret = Boolean(await (secrets?.has?.(`controller.gateway.${identity.gatewayId}`) ?? secrets?.get?.(`controller.gateway.${identity.gatewayId}`)));
      const hasPublicKey = Boolean(await (secrets?.has?.(`controller.gateway.publicKey.${identity.gatewayId}`) ?? secrets?.get?.(`controller.gateway.publicKey.${identity.gatewayId}`)));
      const revoked = value?.status === 'revoked' || value?.revoked === true;
      const method = hasPublicKey ? 'ed25519' : (hasSharedSecret ? 'hmac' : (value?.method || null));
      const approved = !revoked && (hasSharedSecret || hasPublicKey || value?.status === 'approved' || value?.approved === true);
      return { ...identity, status: revoked ? 'revoked' : (approved ? 'approved' : 'untrusted'), approved, revoked, trusted: approved, method };
    } catch { return null; }
  }))).filter(Boolean);
}

async function pendingPairings(settings) { const values = await settings.get(PENDING_PAIRINGS_NAME, []); return Array.isArray(values) ? values.filter((value) => value?.gatewayId && value?.publicKey && value.status === 'pending') : []; }

async function controllerTlsMetadata(settings) {
  const value = await settings?.get?.(TLS_METADATA_NAME, null);
  return value && typeof value === 'object' ? value : null;
}

// TLS private material is written only to a mode-0700 temporary directory, read
// into encrypted mod secrets, then removed. Neither the key nor certificate is
// an openssl command argument or emitted to logs.
function generateControllerTls(host) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-controller-tls-'));
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  const san = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':') ? `IP:${host}` : `DNS:${host}`;
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650', '-subj', '/CN=Burrow Remote Nodes Controller', '-addext', `subjectAltName=${san}`, '-keyout', keyFile, '-out', certFile], { stdio: 'pipe' });
    const key = fs.readFileSync(keyFile, 'utf8');
    const cert = fs.readFileSync(certFile, 'utf8');
    if (!key.includes('PRIVATE KEY') || !cert.includes('CERTIFICATE')) throw new Error('generated_tls_invalid');
    const createdAt = new Date().toISOString();
    return { key, cert, metadata: { source: 'generated', algorithm: 'rsa-3072', host, subjectAltName: san, createdAt, expiresAt: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000).toISOString(), rotateAfter: new Date(Date.now() + 9 * 365 * 24 * 60 * 60 * 1000).toISOString(), fingerprintSha256: crypto.createHash('sha256').update(cert).digest('hex') } };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function gatewayRecords(settings, secrets) {
  const configured = await settings.get(CONTROLLER_GATEWAYS_NAME, []);
  if (!Array.isArray(configured)) return [];
  return (await Promise.all(configured.map(async (value) => {
    const gatewayId = String(value?.gatewayId ?? '').trim();
    const controllerId = String(value?.controllerId ?? 'controller').trim();
    if (!TARGET_ID.test(gatewayId) || !controllerId) return null;
    const secret = await secrets?.get?.(`controller.gateway.${gatewayId}`);
    const publicKey = await secrets?.get?.(`controller.gateway.publicKey.${gatewayId}`) || value.publicKey;
    return secret ? { gatewayId, controllerId, secret, publicKey } : (publicKey ? { gatewayId, controllerId, secret: '', publicKey } : null);
  }))).filter(Boolean);
}

function redact(value, secretValues) {
  if (typeof value === 'string') return secretValues.reduce((result, secret) => secret ? result.split(secret).join('[redacted]') : result, value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secretValues));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry, secretValues)]));
  return value;
}

function serviceError(error) {
  const code = error?.code || 'gateway_dispatch_failed';
  const statusCode = code === 'gateway_not_connected' || code === 'gateway_not_ready' || code === 'gateway_disconnected' ? 503 : 400;
  return problem(code, statusCode);
}

function dispatchError(envelope) {
  const detail = envelope?.error || {};
  const error = new Error(detail.code || 'gateway_dispatch_failed');
  error.code = detail.code || 'gateway_dispatch_failed';
  error.operationId = detail.operationId;
  error.envelope = envelope;
  return error;
}

const OPERATIONS_NAME = 'controllerOperations';

function requestDigest(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** Durable controller-owned correlation. The gateway journal remains authoritative for execution replay. */
export function createOperationCorrelationStore(settings) {
  // Serialize read-modify-write transactions so concurrent operations cannot
  // overwrite one another through the asynchronous host RPC boundary.
  let queue = Promise.resolve();
  const read = async () => {
    const value = await settings?.get?.(OPERATIONS_NAME, []);
    return Array.isArray(value) ? value : [];
  };
  const transact = (operation) => {
    const pending = queue.then(operation, operation);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  };
  const writeRecord = async (records, record) => {
    const index = records.findIndex((entry) => entry.operationId === record.operationId);
    if (index < 0) records.push(record); else records[index] = record;
    await settings?.set?.(OPERATIONS_NAME, records);
    return record;
  };
  return Object.freeze({
    begin(request, kind, payload) {
      return transact(async () => {
        const digest = requestDigest(payload);
        const records = await read();
        const existing = records.find((entry) => entry.operationId === request.operationId);
        if (existing && (existing.requestDigest !== digest || existing.gatewayId !== request.gatewayId || existing.kind !== kind)) {
          throw Object.assign(new Error('operation_correlation_conflict'), { code: 'operation_correlation_conflict' });
        }
        return existing || writeRecord(records, { operationId: request.operationId, parentRunId: request.parentRunId, toolCallId: request.toolCallId,
          gatewayId: request.gatewayId, kind, requestDigest: digest, state: 'dispatching', terminalReference: null, updatedAt: new Date().toISOString() });
      });
    },
    terminal(operationId, dispatch) {
      return transact(async () => {
        const records = await read();
        const existing = records.find((entry) => entry.operationId === operationId);
        if (!existing) throw Object.assign(new Error('operation_correlation_missing'), { code: 'operation_correlation_missing' });
        const result = dispatch?.response?.result || {};
        return writeRecord(records, { ...existing, state: 'terminal', terminalReference: {
          operationId: result.operationId || operationId, replay: result.replay === true,
          outcomeDigest: requestDigest(result.outcome ?? null),
        }, updatedAt: new Date().toISOString() });
      });
    },
    get(operationId) { return queue.then(read).then((records) => records.find((entry) => entry.operationId === operationId) || null); },
  });
}

function terminalEvidence(dispatch) {
  const terminal = dispatch?.events?.findLast?.((event) => event?.type === 'process.terminal');
  return terminal?.evidence ?? dispatch?.response?.result?.outcome ?? null;
}

/** Map authenticated gateway evidence to the result shape consumed by shell_exec callers. */
export function shellExecResult(request, dispatch) {
  const response = dispatch?.response;
  if (!response?.ok) throw dispatchError(response);
  const evidence = terminalEvidence(dispatch);
  if (!evidence || evidence.type !== 'process.result') throw Object.assign(new Error('gateway_terminal_evidence_missing'), { code: 'gateway_terminal_evidence_missing' });
  const operationId = request.operationId;
  const correlatedIds = [dispatch?.accepted?.operationId, response?.result?.operationId,
    ...(dispatch?.events || []).filter((event) => event?.type === 'process.terminal').map((event) => event.operationId),
  ].filter((value) => value != null);
  if (correlatedIds.some((value) => value !== operationId)) throw Object.assign(new Error('gateway_operation_id_mismatch'), { code: 'gateway_operation_id_mismatch' });
  const stdout = String(evidence.stdout ?? '');
  const stderr = String(evidence.stderr ?? '');
  const cancelled = evidence.cancelled === true;
  const timedOut = evidence.timedOut === true;
  return {
    tool: 'shell_exec',
    ok: evidence.exitCode === 0 && !cancelled && !timedOut,
    command: request.process.command || [request.process.executable, ...(request.process.args || [])].filter(Boolean).join(' '),
    reason: null,
    cwd: evidence.cwd ?? request.process.cwd ?? null,
    exitCode: evidence.exitCode ?? null,
    signal: evidence.signal ?? null,
    timedOut,
    cancelled,
    killed: evidence.signal != null,
    durationMs: evidence.durationMs ?? null,
    stdout,
    stderr,
    stdoutTruncated: evidence.truncated === true,
    stderrTruncated: evidence.truncated === true,
    stdoutOriginalChars: stdout.length,
    stderrOriginalChars: stderr.length,
    error: null,
    artifacts: null,
    operationId,
    gatewayId: request.gatewayId,
  };
}

/** Adapt the backend's correlated remote request to the existing gateway controller service. */
export function createProcessController(service, { logger = console, operationStore = null } = {}) {
  if (!service || typeof service.dispatchProcessExec !== 'function' || typeof service.dispatchCancel !== 'function') throw new Error('controller_service_invalid');
  return Object.freeze({
    async executeProcess(request = {}, { abortSignal = null } = {}) {
      const operationId = String(request.operationId ?? '').trim();
      const gatewayId = String(request.gatewayId ?? '').trim();
      if (!OPERATION_ID.test(operationId)) throw new Error('operation_id_invalid');
      if (!gatewayId) throw new Error('gateway_id_required');
      let process;
      try { process = cleanProcessRequest(request.process); }
      catch (error) { throw new Error(error.message); }
      const params = { operationId, ...process };
      if (request.process.cwd) params.cwd = String(request.process.cwd);
      if (request.process.env) params.env = { ...request.process.env };
      if (request.process.timeoutMs != null) params.timeoutMs = Number(request.process.timeoutMs);
      const protectedValues = request.protectedValues && typeof request.protectedValues === 'object'
        ? { ...request.protectedValues } : null;
      const protectedBindingMetadata = Array.isArray(request.protectedBindingMetadata)
        ? request.protectedBindingMetadata.map((entry) => ({ ...entry })) : [];
      if (protectedBindingMetadata.length) params.protectedBindingMetadata = protectedBindingMetadata;
      let cancelPromise = null;
      const cancel = () => {
        if (!cancelPromise) cancelPromise = Promise.resolve(service.dispatchCancel(gatewayId, operationId)).catch((error) => {
          logger.warn?.('Remote Nodes cancellation dispatch failed: cancellation_dispatch_failed');
        });
      };
      await operationStore?.begin(request, 'process', params);
      // Values exist only in this transient dispatch object. The listener binds
      // them to its authenticated connection and generated request id.
      const dispatchParams = protectedValues ? { ...params, protectedValues } : params;
      const dispatchPromise = service.dispatchProcessExec(gatewayId, dispatchParams);
      if (abortSignal?.aborted) cancel();
      else abortSignal?.addEventListener('abort', cancel, { once: true });
      try {
        const dispatch = await dispatchPromise;
        const result = shellExecResult(request, dispatch);
        await operationStore?.terminal(operationId, dispatch);
        return result;
      } finally {
        abortSignal?.removeEventListener?.('abort', cancel);
      }
    },
    async executeNativeFilesystem(request = {}, { abortSignal = null } = {}) {
      const operationId = String(request.operationId ?? '').trim();
      const gatewayId = String(request.gatewayId ?? '').trim();
      if (!OPERATION_ID.test(operationId)) throw new Error('operation_id_invalid');
      if (!gatewayId) throw new Error('gateway_id_required');
      const params = { operationId, parentRunId: request.parentRunId, toolCallId: request.toolCallId, tool: request.operation?.tool, arguments: { ...(request.operation?.arguments || {}) } };
      let cancelPromise = null;
      const cancel = () => { if (!cancelPromise) cancelPromise = Promise.resolve(service.dispatchCancel(gatewayId, operationId)).catch((error) => logger.warn?.('Remote Nodes cancellation dispatch failed: cancellation_dispatch_failed')); };
      await operationStore?.begin(request, 'filesystem', params);
      const dispatchPromise = service.dispatchFilesystem(gatewayId, params);
      if (abortSignal?.aborted) cancel(); else abortSignal?.addEventListener('abort', cancel, { once: true });
      try {
        const dispatch = await dispatchPromise;
        if (!dispatch?.response?.ok) throw dispatchError(dispatch?.response);
        const correlated = [dispatch.accepted?.operationId, dispatch.response?.result?.operationId].filter(Boolean);
        if (correlated.some((id) => id !== operationId)) throw new Error('gateway_operation_id_mismatch');
        await operationStore?.terminal(operationId, dispatch);
        return { ...dispatch.response.result.outcome, operationId, gatewayId, parentRunId: request.parentRunId, toolCallId: request.toolCallId, execution: { kind: 'gateway', gatewayId } };
      } finally { abortSignal?.removeEventListener?.('abort', cancel); }
    },
  });
}

/** Controller listener lifecycle kept separate from HTTP route registration for testability and future host cleanup support. */
export async function createControllerService({ settings, secrets, listenerFactory = (options) => new GatewayControllerListener(options), logger = console } = {}) {
  const config = await storedControllerConfig(settings);
  const records = await gatewayRecords(settings, secrets);
  let pairingIdentity; const savedPairingIdentity = await secrets?.get?.('controller.pairing.identity');
  try { pairingIdentity = savedPairingIdentity ? JSON.parse(savedPairingIdentity) : null; } catch {}
  if (!pairingIdentity?.publicKey || !pairingIdentity?.privateKey) { pairingIdentity = controllerIdentity(); await secrets?.set?.('controller.pairing.identity', JSON.stringify(pairingIdentity)); }
  const secretValues = records.map((record) => record.secret);
  let key = await secrets?.get?.('controller.tls.key');
  let cert = await secrets?.get?.('controller.tls.cert');
  const ca = await secrets?.get?.('controller.tls.ca');
  let tlsMetadata = await controllerTlsMetadata(settings);
  let startError = null;
  if (config.enabled && (!key || !cert)) {
    try {
      const generated = generateControllerTls(config.host);
      key = generated.key; cert = generated.cert;
      await secrets?.set?.('controller.tls.key', key); await secrets?.set?.('controller.tls.cert', cert);
      await settings?.set?.(TLS_METADATA_NAME, generated.metadata); tlsMetadata = generated.metadata;
    } catch (error) {
      startError = 'controller_tls_generation_failed';
      logger.error?.('Remote Nodes controller TLS generation failed: controller_tls_generation_failed');
    }
  }
  if (!tlsMetadata && key && cert) { tlsMetadata = { source: 'configured' }; await settings?.set?.(TLS_METADATA_NAME, tlsMetadata); }
  const tlsConfigured = { key: Boolean(key), cert: Boolean(cert), ca: Boolean(ca) };
  let listener = null;
  if (config.enabled && !startError) {
    if (!key || !cert) startError = 'controller_tls_credentials_missing';
    else {
      try {
        listener = listenerFactory({ gateways: records, pairings: await pendingPairings(settings), pairingIdentity, serverOptions: { key, cert, ...(ca ? { ca } : {}) } });
        listener.listen(config.port, config.host);
      } catch (error) {
        startError = 'controller_listener_start_failed';
        logger.error?.('Remote Nodes controller listener failed: controller_listener_start_failed');
      }
    }
  }
  const state = () => ({ enabled: config.enabled, host: config.host, port: config.port, running: Boolean(listener), tls: { configured: tlsConfigured.key && tlsConfigured.cert, ready: Boolean(listener) && tlsConfigured.key && tlsConfigured.cert, keyConfigured: tlsConfigured.key, certConfigured: tlsConfigured.cert, caConfigured: tlsConfigured.ca, ...(tlsMetadata ? { source: tlsMetadata.source || 'configured', createdAt: tlsMetadata.createdAt || null, expiresAt: tlsMetadata.expiresAt || null, rotateAfter: tlsMetadata.rotateAfter || null, host: tlsMetadata.host || null } : {}) }, ...(startError ? { error: startError } : {}) });
  if (listener?.on) listener.on('gatewayPairingPending', (pairing) => {
    void (async () => {
      const values = await pendingPairings(settings);
      const index = values.findIndex((entry) => entry.gatewayId === pairing.gatewayId);
      if (index < 0) values.push(pairing); else values[index] = pairing;
      await settings.set(PENDING_PAIRINGS_NAME, values);
    })().catch(() => logger.error?.('Remote Nodes pairing persistence failed: pairing_persistence_failed'));
  });
  return Object.freeze({
    state,
    listPendingPairings: async () => listener?.listPending?.() ?? await pendingPairings(settings),
    async approvePairing(gatewayId) {
      const pairing = listener?.approvePending?.(gatewayId);
      if (!pairing) throw Object.assign(new Error('pairing_not_found'), { code: 'pairing_not_found' });
      const gateways = (await configuredGatewayIdentities(settings, secrets)).map(({ gatewayId: id, controllerId, status, approved, revoked, method }) => ({ gatewayId: id, controllerId, status, approved, revoked, method }));
      const index = gateways.findIndex((entry) => entry.gatewayId === gatewayId);
      const trusted = { gatewayId, controllerId: pairing.controllerId };
      if (index < 0) gateways.push(trusted); else gateways[index] = trusted;
      await settings.set(CONTROLLER_GATEWAYS_NAME, gateways);
      await secrets?.set?.(`controller.gateway.publicKey.${gatewayId}`, pairing.publicKey);
      await settings.set(PENDING_PAIRINGS_NAME, (await pendingPairings(settings)).filter((entry) => entry.gatewayId !== gatewayId));
      return { gatewayId: pairing.gatewayId, controllerId: pairing.controllerId, pairingCode: pairing.pairingCode, status: 'approved', trusted: true };
    },
    async rejectPairing(gatewayId) {
      const pairing = listener?.rejectPending?.(gatewayId);
      if (!pairing) throw Object.assign(new Error('pairing_not_found'), { code: 'pairing_not_found' });
      await settings.set(PENDING_PAIRINGS_NAME, (await pendingPairings(settings)).filter((entry) => entry.gatewayId !== gatewayId));
      return pairing;
    },
    listLiveGateways: () => listener ? listener.listLiveGateways() : [],
    listGateways: () => listener
      ? (listener.listGateways?.() ?? listener.listLiveGateways())
      : records.map(({ gatewayId }) => ({ gatewayId, status: 'disconnected', connected: false, connectedAt: null, lastSeenAt: null, activeOperations: [], name: null, version: null, protocolVersion: null })),
    listOperationActivity: (options) => listener?.listOperationActivity?.(options) ?? [],
    async dispatchProcessExec(gatewayId, params) {
      if (!listener) throw Object.assign(new Error(startError || 'controller_not_running'), { code: startError || 'controller_not_running' });
      return redact(await listener.dispatchProcessExec(gatewayId, params), secretValues);
    },
    async dispatchFilesystem(gatewayId, params) {
      if (!listener) throw Object.assign(new Error(startError || 'controller_not_running'), { code: startError || 'controller_not_running' });
      return redact(await listener.dispatchFilesystem(gatewayId, params), secretValues);
    },
    async dispatchCancel(gatewayId, operationId) {
      if (!listener) throw Object.assign(new Error(startError || 'controller_not_running'), { code: startError || 'controller_not_running' });
      return redact(await listener.dispatchCancel(gatewayId, operationId), secretValues);
    },
    close: () => listener?.close(),
  });
}

export async function activate({ api, settings, secrets, logger, processExecution, controllerService, listenerFactory } = {}) {
  const service = controllerService ?? await createControllerService({ settings, secrets, listenerFactory, logger });
  const operationStore = createOperationCorrelationStore(settings);
  const unregisterController = processExecution?.registerController?.(createProcessController(service, { logger, operationStore }));
  api.get('/targets', async () => ({ ok: true, targets: await storedTargets(settings) }));
  api.post('/targets', async ({ body = {} }) => {
    const targets = await storedTargets(settings); const target = cleanTarget(body);
    if (targets.some((value) => value.id === target.id)) throw problem('api_target_exists', 409);
    targets.push(target); await settings.set(SETTINGS_NAME, targets);
    return { status: 201, body: { ok: true, target } };
  });
  api.put('/targets/:id', async ({ params, body = {} }) => {
    const targets = await storedTargets(settings); const index = findTarget(targets, params.id); const target = cleanTarget(body);
    if (target.id !== params.id) throw problem('target_id_immutable');
    targets[index] = target; await settings.set(SETTINGS_NAME, targets); return { ok: true, target };
  });
  api.delete('/targets/:id', async ({ params }) => { const targets = await storedTargets(settings); targets.splice(findTarget(targets, params.id), 1); await settings.set(SETTINGS_NAME, targets); return { ok: true }; });

  api.get('/controller', () => ({ ok: true, controller: service.state() }));
  api.put('/controller', async ({ body = {} }) => {
    const controller = cleanControllerConfig(body);
    await settings.set(CONTROLLER_SETTINGS_NAME, controller);
    return { ok: true, controller, restartRequired: true };
  });
  api.put('/controller/tls', async ({ body = {} }) => {
    const key = String(body.key ?? ''); const cert = String(body.cert ?? '');
    if (!key.trim() || !cert.trim()) throw problem('controller_tls_credentials_required');
    await secrets.set('controller.tls.key', key); await secrets.set('controller.tls.cert', cert); await settings.set(TLS_METADATA_NAME, { source: 'configured' });
    if (body.ca == null || body.ca === '') await secrets.clear?.('controller.tls.ca');
    else await secrets.set('controller.tls.ca', String(body.ca));
    return { ok: true, restartRequired: true };
  });
  api.delete('/controller/tls', async () => {
    await secrets.clear?.('controller.tls.key'); await secrets.clear?.('controller.tls.cert'); await secrets.clear?.('controller.tls.ca'); await settings.delete?.(TLS_METADATA_NAME);
    return { ok: true, restartRequired: true };
  });
  api.get('/pairings', async () => ({ ok: true, pairings: await service.listPendingPairings?.() ?? [] }));
  api.post('/pairings/:gatewayId/approve', async ({ params }) => ({ ok: true, pairing: await service.approvePairing(cleanId(params.gatewayId)) }));
  api.post('/pairings/:gatewayId/reject', async ({ params }) => ({ ok: true, pairing: await service.rejectPairing(cleanId(params.gatewayId)) }));
  api.get('/gateway-trust', async () => ({ ok: true, gateways: await configuredGatewayIdentities(settings, secrets) }));
  api.put('/gateway-trust/:gatewayId', async ({ params, body = {} }) => {
    const identity = cleanGatewayIdentity(body, params.gatewayId);
    const secret = String(body.secret ?? '');
    if (!secret.trim()) throw problem('gateway_secret_required');
    const gateways = (await configuredGatewayIdentities(settings, secrets)).map(({ gatewayId, controllerId, status, approved, revoked, method }) => ({ gatewayId, controllerId, status, approved, revoked, method }));
    const index = gateways.findIndex((entry) => entry.gatewayId === identity.gatewayId);
    if (index < 0) gateways.push(identity); else gateways[index] = identity;
    await secrets.set(`controller.gateway.${identity.gatewayId}`, secret);
    await settings.set(CONTROLLER_GATEWAYS_NAME, gateways);
    return { ok: true, gateway: { ...identity, status: 'approved', approved: true, revoked: false, trusted: true, method: 'hmac' }, restartRequired: true };
  });
  api.delete('/gateway-trust/:gatewayId', async ({ params }) => {
    const gatewayId = cleanId(params.gatewayId);
    const current = await configuredGatewayIdentities(settings, secrets);
    const existing = current.find((entry) => entry.gatewayId === gatewayId);
    const gateways = current.filter((entry) => entry.gatewayId !== gatewayId).map(({ gatewayId: id, controllerId, status, approved, revoked, method }) => ({ gatewayId: id, controllerId, status, approved, revoked, method }));
    gateways.push({ gatewayId, controllerId: existing?.controllerId || 'controller', status: 'revoked', approved: false, revoked: true, method: existing?.method || null });
    await settings.set(CONTROLLER_GATEWAYS_NAME, gateways); await secrets.clear?.(`controller.gateway.${gatewayId}`); await secrets.clear?.(`controller.gateway.publicKey.${gatewayId}`);
    return { ok: true, gateway: { gatewayId, controllerId: existing?.controllerId || 'controller', status: 'revoked', approved: false, revoked: true, trusted: false, method: existing?.method || null }, restartRequired: true };
  });
  api.get('/gateways', () => ({ ok: true, gateways: service.listGateways?.() ?? service.listLiveGateways() }));
  api.get('/operations', ({ query = {} } = {}) => {
    const requested = Number(query.limit ?? 50);
    const limit = Number.isInteger(requested) ? Math.max(1, Math.min(256, requested)) : 50;
    const gatewayId = query.gatewayId == null || query.gatewayId === '' ? null : cleanId(query.gatewayId);
    return { ok: true, operations: service.listOperationActivity?.({ gatewayId, limit }) ?? [], limit };
  });
  api.post('/gateways/:gatewayId/processes', async ({ params, body = {} }) => {
    const operationId = String(body.operationId ?? '').trim();
    if (!OPERATION_ID.test(operationId)) throw problem('operation_id_invalid');
    const process = cleanProcessRequest(body);
    try { return { ok: true, operationId, dispatch: await service.dispatchProcessExec(params.gatewayId, { ...body, ...process, operationId }) }; }
    catch (error) { throw serviceError(error); }
  });
  api.post('/gateways/:gatewayId/operations/:operationId/cancel', async ({ params }) => {
    if (!OPERATION_ID.test(params.operationId)) throw problem('operation_id_invalid');
    try { return { ok: true, operationId: params.operationId, dispatch: await service.dispatchCancel(params.gatewayId, params.operationId) }; }
    catch (error) { throw serviceError(error); }
  });
  return Object.freeze({
    async close() {
      unregisterController?.();
      await service.close();
    },
  });
}
