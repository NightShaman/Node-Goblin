const SETTINGS_NAME = 'targets';
const TARGET_ID = /^[a-z0-9][a-z0-9._-]*$/i;

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

function cleanId(value) {
  const id = cleanText(value, 'target_id');
  if (!TARGET_ID.test(id) || id === 'local') throw problem('target_id_invalid');
  return id;
}

function cleanBaseUrl(value) {
  const text = cleanText(value, 'base_url');
  let url;
  try { url = new URL(text); } catch { throw problem('base_url_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw problem('base_url_invalid');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function cleanTarget(body = {}) {
  return {
    id: cleanId(body.id),
    name: cleanText(body.name, 'name'),
    baseUrl: cleanBaseUrl(body.baseUrl),
    enabled: body.enabled !== false,
  };
}

function storedTargets(settings) {
  const targets = settings.get(SETTINGS_NAME, []);
  if (!Array.isArray(targets)) return [];
  return targets.flatMap((target) => {
    try { return [cleanTarget(target)]; } catch { return []; }
  });
}

function findTarget(targets, id) {
  const index = targets.findIndex((target) => target.id === id);
  if (index < 0) throw problem('api_target_not_found', 404);
  return { index, target: targets[index] };
}

export async function activate({ api, settings }) {
  api.get('/targets', () => ({ ok: true, targets: storedTargets(settings) }));

  api.post('/targets', ({ body = {} }) => {
    const targets = storedTargets(settings);
    const target = cleanTarget(body);
    if (targets.some((entry) => entry.id === target.id)) throw problem('api_target_exists', 409);
    targets.push(target);
    settings.set(SETTINGS_NAME, targets);
    return { status: 201, body: { ok: true, target } };
  });

  api.put('/targets/:id', ({ params, body = {} }) => {
    const targets = storedTargets(settings);
    const { index } = findTarget(targets, params.id);
    const target = cleanTarget(body);
    if (target.id !== params.id) throw problem('target_id_immutable');
    targets[index] = target;
    settings.set(SETTINGS_NAME, targets);
    return { ok: true, target };
  });

  api.delete('/targets/:id', ({ params }) => {
    const targets = storedTargets(settings);
    const { index } = findTarget(targets, params.id);
    targets.splice(index, 1);
    settings.set(SETTINGS_NAME, targets);
    return { ok: true };
  });
}
