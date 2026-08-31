import { GatewayControllerListener } from '../gateway/index.mjs';

const SETTINGS_NAME = 'targets';
const CONTROLLER_SETTINGS_NAME = 'controller';
const CONTROLLER_GATEWAYS_NAME = 'controllerGateways';
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

function storedTargets(settings) {
  const values = settings.get(SETTINGS_NAME, []);
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

function storedControllerConfig(settings) {
  try { return cleanControllerConfig(settings.get(CONTROLLER_SETTINGS_NAME, {})); }
  catch { return cleanControllerConfig(); }
}

function cleanGatewayIdentity(value = {}, gatewayId = value.gatewayId) {
  const id = cleanId(gatewayId);
  const controllerId = String(value.controllerId ?? 'controller').trim();
  if (!controllerId || controllerId.length > 255) throw problem('controller_id_invalid');
  return { gatewayId: id, controllerId };
}

function configuredGatewayIdentities(settings, secrets) {
  const configured = settings.get(CONTROLLER_GATEWAYS_NAME, []);
  if (!Array.isArray(configured)) return [];
  return configured.flatMap((value) => {
    try {
      const identity = cleanGatewayIdentity(value);
      return [{ ...identity, trusted: Boolean(secrets?.has?.(`controller.gateway.${identity.gatewayId}`) ?? secrets?.get?.(`controller.gateway.${identity.gatewayId}`)) }];
    } catch { return []; }
  });
}

function gatewayRecords(settings, secrets) {
  const configured = settings.get(CONTROLLER_GATEWAYS_NAME, []);
  if (!Array.isArray(configured)) return [];
  return configured.flatMap((value) => {
    const gatewayId = String(value?.gatewayId ?? '').trim();
    const controllerId = String(value?.controllerId ?? 'controller').trim();
    if (!TARGET_ID.test(gatewayId) || !controllerId) return [];
    const secret = secrets?.get?.(`controller.gateway.${gatewayId}`);
    return secret ? [{ gatewayId, controllerId, secret }] : [];
  });
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

/** Controller listener lifecycle kept separate from HTTP route registration for testability and future host cleanup support. */
export function createControllerService({ settings, secrets, listenerFactory = (options) => new GatewayControllerListener(options), logger = console } = {}) {
  const config = storedControllerConfig(settings);
  const records = gatewayRecords(settings, secrets);
  const secretValues = records.map((record) => record.secret);
  let listener = null;
  let startError = null;
  if (config.enabled) {
    const key = secrets?.get?.('controller.tls.key');
    const cert = secrets?.get?.('controller.tls.cert');
    const ca = secrets?.get?.('controller.tls.ca');
    if (!key || !cert) startError = 'controller_tls_credentials_missing';
    else {
      try {
        listener = listenerFactory({ gateways: records, serverOptions: { key, cert, ...(ca ? { ca } : {}) } });
        listener.listen(config.port, config.host);
      } catch (error) {
        startError = 'controller_listener_start_failed';
        logger.error?.(`Remote Nodes controller listener failed: ${String(error?.message || error)}`);
      }
    }
  }
  const state = () => ({ enabled: config.enabled, host: config.host, port: config.port, running: Boolean(listener), ...(startError ? { error: startError } : {}) });
  return Object.freeze({
    state,
    listLiveGateways: () => listener ? listener.listLiveGateways() : [],
    async dispatchProcessExec(gatewayId, params) {
      if (!listener) throw Object.assign(new Error(startError || 'controller_not_running'), { code: startError || 'controller_not_running' });
      return redact(await listener.dispatchProcessExec(gatewayId, params), secretValues);
    },
    async dispatchCancel(gatewayId, operationId) {
      if (!listener) throw Object.assign(new Error(startError || 'controller_not_running'), { code: startError || 'controller_not_running' });
      return redact(await listener.dispatchCancel(gatewayId, operationId), secretValues);
    },
    close: () => listener?.close(),
  });
}

export async function activate({ api, settings, secrets, logger, controllerService, listenerFactory } = {}) {
  const service = controllerService ?? createControllerService({ settings, secrets, listenerFactory, logger });
  api.get('/targets', () => ({ ok: true, targets: storedTargets(settings) }));
  api.post('/targets', ({ body = {} }) => {
    const targets = storedTargets(settings); const target = cleanTarget(body);
    if (targets.some((value) => value.id === target.id)) throw problem('api_target_exists', 409);
    targets.push(target); settings.set(SETTINGS_NAME, targets);
    return { status: 201, body: { ok: true, target } };
  });
  api.put('/targets/:id', ({ params, body = {} }) => {
    const targets = storedTargets(settings); const index = findTarget(targets, params.id); const target = cleanTarget(body);
    if (target.id !== params.id) throw problem('target_id_immutable');
    targets[index] = target; settings.set(SETTINGS_NAME, targets); return { ok: true, target };
  });
  api.delete('/targets/:id', ({ params }) => { const targets = storedTargets(settings); targets.splice(findTarget(targets, params.id), 1); settings.set(SETTINGS_NAME, targets); return { ok: true }; });

  api.get('/controller', () => ({ ok: true, controller: service.state() }));
  api.put('/controller', ({ body = {} }) => {
    const controller = cleanControllerConfig(body);
    settings.set(CONTROLLER_SETTINGS_NAME, controller);
    return { ok: true, controller, restartRequired: true };
  });
  api.put('/controller/tls', ({ body = {} }) => {
    const key = String(body.key ?? ''); const cert = String(body.cert ?? '');
    if (!key.trim() || !cert.trim()) throw problem('controller_tls_credentials_required');
    secrets.set('controller.tls.key', key); secrets.set('controller.tls.cert', cert);
    if (body.ca == null || body.ca === '') secrets.clear?.('controller.tls.ca');
    else secrets.set('controller.tls.ca', String(body.ca));
    return { ok: true, restartRequired: true };
  });
  api.delete('/controller/tls', () => {
    secrets.clear?.('controller.tls.key'); secrets.clear?.('controller.tls.cert'); secrets.clear?.('controller.tls.ca');
    return { ok: true, restartRequired: true };
  });
  api.get('/gateway-trust', () => ({ ok: true, gateways: configuredGatewayIdentities(settings, secrets) }));
  api.put('/gateway-trust/:gatewayId', ({ params, body = {} }) => {
    const identity = cleanGatewayIdentity(body, params.gatewayId);
    const secret = String(body.secret ?? '');
    if (!secret.trim()) throw problem('gateway_secret_required');
    const gateways = configuredGatewayIdentities(settings, secrets).map(({ gatewayId, controllerId }) => ({ gatewayId, controllerId }));
    const index = gateways.findIndex((entry) => entry.gatewayId === identity.gatewayId);
    if (index < 0) gateways.push(identity); else gateways[index] = identity;
    secrets.set(`controller.gateway.${identity.gatewayId}`, secret);
    settings.set(CONTROLLER_GATEWAYS_NAME, gateways);
    return { ok: true, gateway: { ...identity, trusted: true }, restartRequired: true };
  });
  api.delete('/gateway-trust/:gatewayId', ({ params }) => {
    const gatewayId = cleanId(params.gatewayId);
    const gateways = configuredGatewayIdentities(settings, secrets).filter((entry) => entry.gatewayId !== gatewayId).map(({ gatewayId: id, controllerId }) => ({ gatewayId: id, controllerId }));
    settings.set(CONTROLLER_GATEWAYS_NAME, gateways); secrets.clear?.(`controller.gateway.${gatewayId}`);
    return { ok: true, restartRequired: true };
  });
  api.get('/gateways', () => ({ ok: true, gateways: service.listLiveGateways() }));
  api.post('/gateways/:gatewayId/processes', async ({ params, body = {} }) => {
    const operationId = String(body.operationId ?? '').trim();
    if (!OPERATION_ID.test(operationId)) throw problem('operation_id_invalid');
    try { return { ok: true, operationId, dispatch: await service.dispatchProcessExec(params.gatewayId, { ...body, operationId }) }; }
    catch (error) { throw serviceError(error); }
  });
  api.post('/gateways/:gatewayId/operations/:operationId/cancel', async ({ params }) => {
    if (!OPERATION_ID.test(params.operationId)) throw problem('operation_id_invalid');
    try { return { ok: true, operationId: params.operationId, dispatch: await service.dispatchCancel(params.gatewayId, params.operationId) }; }
    catch (error) { throw serviceError(error); }
  });
  // Current Burrow runtime does not invoke a deactivate hook. Returning close makes cleanup available to a lifecycle-aware host.
  return Object.freeze({ close: service.close });
}
