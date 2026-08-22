const SETTINGS_NAME = 'targets';
const TARGET_ID = /^[a-z0-9][a-z0-9._-]*$/i;

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
  return {
    id: cleanId(value.id),
    name: cleanName(value.name),
    baseUrl: cleanBaseUrl(value.baseUrl),
    enabled: value.enabled !== false,
  };
}

function storedTargets(settings) {
  const values = settings.get(SETTINGS_NAME, []);
  if (!Array.isArray(values)) return [];
  return values.map((value) => {
    try { return cleanTarget(value); } catch { return null; }
  }).filter(Boolean);
}

function findTarget(targets, id) {
  const index = targets.findIndex((target) => target.id === id);
  if (index < 0) throw problem('api_target_not_found', 404);
  return index;
}

export async function activate({ api, settings }) {
  api.get('/targets', () => ({ ok: true, targets: storedTargets(settings) }));

  api.post('/targets', ({ body = {} }) => {
    const targets = storedTargets(settings);
    const target = cleanTarget(body);
    if (targets.some((value) => value.id === target.id)) throw problem('api_target_exists', 409);
    targets.push(target);
    settings.set(SETTINGS_NAME, targets);
    return { status: 201, body: { ok: true, target } };
  });

  api.put('/targets/:id', ({ params, body = {} }) => {
    const targets = storedTargets(settings);
    const index = findTarget(targets, params.id);
    const target = cleanTarget(body);
    if (target.id !== params.id) throw problem('target_id_immutable');
    targets[index] = target;
    settings.set(SETTINGS_NAME, targets);
    return { ok: true, target };
  });

  api.delete('/targets/:id', ({ params }) => {
    const targets = storedTargets(settings);
    const index = findTarget(targets, params.id);
    targets.splice(index, 1);
    settings.set(SETTINGS_NAME, targets);
    return { ok: true };
  });
}
