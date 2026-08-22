import { randomUUID } from 'node:crypto';

const SETTINGS_NAME = 'nodes';
const secretName = (id) => `node:${id}:credential`;
const now = () => new Date().toISOString();

function problem(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cleanText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw problem(`${field}_required`);
  return text;
}

function cleanBaseUrl(value) {
  const text = cleanText(value, 'base_url');
  let url;
  try { url = new URL(text); } catch { throw problem('base_url_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw problem('base_url_invalid');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function storedNodes(settings) {
  const nodes = settings.get(SETTINGS_NAME, []);
  return Array.isArray(nodes) ? nodes : [];
}

function publicNode(node, secrets) {
  return {
    id: node.id,
    name: node.name,
    baseUrl: node.baseUrl,
    enabled: node.enabled !== false,
    status: ['online', 'offline', 'unknown'].includes(node.status) ? node.status : 'unknown',
    lastCheckedAt: node.lastCheckedAt || null,
    lastSeenAt: node.lastSeenAt || null,
    version: node.version || null,
    error: node.error || null,
    credentialConfigured: secrets.has(secretName(node.id)),
  };
}

function findNode(nodes, id) {
  const index = nodes.findIndex((node) => node.id === id);
  if (index < 0) throw problem('remote_node_not_found', 404);
  return { index, node: nodes[index] };
}

function saveCredential(secrets, id, body, { create = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, 'credential')) return;
  const value = body.credential;
  if (value === null || value === undefined || String(value) === '') {
    secrets.clear(secretName(id));
    return;
  }
  secrets.set(secretName(id), String(value));
}

function authHeaders(credential) {
  const headers = { accept: 'application/json' };
  const value = String(credential || '').trim();
  if (!value) return headers;
  if (/^(basic|bearer)\s+/i.test(value)) headers.authorization = value;
  else headers.authorization = `Bearer ${value}`;
  return headers;
}

function healthVersion(body, response) {
  const header = response.headers.get('x-burrow-version');
  return header || body?.version || body?.burrowVersion || body?.build?.version || null;
}

async function checkRemote(node, secrets) {
  const checkedAt = now();
  try {
    const credential = secrets.get(secretName(node.id));
    const response = await fetch(`${node.baseUrl}/api/health`, {
      headers: authHeaders(credential),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`remote_node_http_${response.status}`);
    if (!body || body.ok !== true || body.runtime !== 'burrow') throw new Error('remote_node_health_invalid');
    return { ...node, status: 'online', lastCheckedAt: checkedAt, lastSeenAt: checkedAt, version: healthVersion(body, response), error: null };
  } catch (error) {
    return { ...node, status: 'offline', lastCheckedAt: checkedAt, error: String(error?.message || error) };
  }
}

export async function activate({ api, settings, secrets }) {
  api.get('/nodes', () => ({ ok: true, nodes: storedNodes(settings).map((node) => publicNode(node, secrets)) }));

  api.post('/nodes', ({ body = {} }) => {
    const nodes = storedNodes(settings);
    const node = {
      id: randomUUID(),
      name: cleanText(body.name, 'name'),
      baseUrl: cleanBaseUrl(body.baseUrl),
      enabled: body.enabled !== false,
      status: 'unknown',
      lastCheckedAt: null,
      lastSeenAt: null,
      version: null,
      error: null,
    };
    nodes.push(node);
    settings.set(SETTINGS_NAME, nodes);
    saveCredential(secrets, node.id, body, { create: true });
    return { status: 201, body: { ok: true, node: publicNode(node, secrets) } };
  });

  api.put('/nodes/:id', ({ params, body = {} }) => {
    const nodes = storedNodes(settings);
    const { index, node } = findNode(nodes, params.id);
    const updated = {
      ...node,
      name: cleanText(body.name, 'name'),
      baseUrl: cleanBaseUrl(body.baseUrl),
      enabled: body.enabled !== false,
    };
    if (updated.baseUrl !== node.baseUrl) Object.assign(updated, { status: 'unknown', lastCheckedAt: null, lastSeenAt: null, version: null, error: null });
    nodes[index] = updated;
    settings.set(SETTINGS_NAME, nodes);
    saveCredential(secrets, updated.id, body);
    return { ok: true, node: publicNode(updated, secrets) };
  });

  api.delete('/nodes/:id', ({ params }) => {
    const nodes = storedNodes(settings);
    const { index, node } = findNode(nodes, params.id);
    nodes.splice(index, 1);
    settings.set(SETTINGS_NAME, nodes);
    secrets.clear(secretName(node.id));
    return { ok: true };
  });

  api.post('/nodes/:id/check', async ({ params }) => {
    const nodes = storedNodes(settings);
    const { index, node } = findNode(nodes, params.id);
    if (node.enabled === false) throw problem('remote_node_disabled', 409);
    const checked = await checkRemote(node, secrets);
    nodes[index] = checked;
    settings.set(SETTINGS_NAME, nodes);
    return { ok: true, node: publicNode(checked, secrets) };
  });
}
