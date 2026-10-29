import crypto from 'node:crypto';

const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const SAFE_OUTCOMES = new Set([
  'completed', 'cancelling', 'timed_out', 'cancelled', 'failed',
  'gateway_not_connected', 'gateway_not_ready', 'gateway_disconnected', 'gateway_dispatch_failed',
  'operation_id_conflict', 'operation_in_progress', 'protected_redelivery_forbidden',
  'process_failed', 'filesystem_failed', 'output_frame_too_large',
]);

function invalid(code) {
  return Object.assign(new Error(code), { statusCode: 400 });
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid('archive_date_invalid');
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) throw invalid('archive_date_invalid');
  return value;
}

function dateFormatter(value) {
  // The UI supplies an IANA zone, not a UTC offset or the controller's timezone.
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_+./-]{0,127}$/.test(value)) throw invalid('archive_time_zone_invalid');
  try {
    return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: value, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short',
    });
  } catch { throw invalid('archive_time_zone_invalid'); }
}

function dateInZone(formatter, timestamp) {
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(({ type, value }) => [type, value]));
  return parts.era === 'AD' ? `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}` : null;
}

function pageSize(value) {
  if (value == null) return DEFAULT_PAGE_SIZE;
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > MAX_PAGE_SIZE) throw invalid('archive_limit_invalid');
  return Number(value);
}

// Only the listener's existing metadata keys leave this route. In particular,
// gateway-provided error codes may contain arbitrary exception text or secrets.
function projectActivity(entry) {
  if (!entry || typeof entry.gatewayId !== 'string' || typeof entry.operationId !== 'string'
    || typeof entry.startedAt !== 'string' || !Number.isFinite(Date.parse(entry.startedAt))) return null;
  const operation = {
    gatewayId: entry.gatewayId,
    operationId: entry.operationId,
    kind: ['process', 'filesystem'].includes(entry.kind) ? entry.kind : null,
    state: ['dispatching', 'running', 'terminal', 'interrupted'].includes(entry.state) ? entry.state : null,
    replay: entry.replay === true,
    reconnectRequired: entry.reconnectRequired === true,
    terminalOutcome: entry.terminalOutcome == null ? null : (SAFE_OUTCOMES.has(entry.terminalOutcome) ? entry.terminalOutcome : 'failed'),
    startedAt: new Date(entry.startedAt).toISOString(),
    endedAt: typeof entry.endedAt === 'string' && Number.isFinite(Date.parse(entry.endedAt)) ? new Date(entry.endedAt).toISOString() : null,
    durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : null,
  };
  if (typeof entry.acceptedAt === 'string' && Number.isFinite(Date.parse(entry.acceptedAt))) operation.acceptedAt = new Date(entry.acceptedAt).toISOString();
  return operation;
}

// Use binary string ordering, not localeCompare, so distinct IDs always break
// timestamp ties consistently across hosts and locales.
function compareDescending(left, right) {
  for (const key of ['startedAt', 'gatewayId', 'operationId']) {
    if (left[key] < right[key]) return 1;
    if (left[key] > right[key]) return -1;
  }
  return 0;
}

function scopeHash(date, timeZone, gatewayId, query) {
  return crypto.createHash('sha256').update(JSON.stringify([date, timeZone, gatewayId, query])).digest('base64url');
}

function encodeCursor(secret, scope, operation) {
  const payload = Buffer.from(JSON.stringify({ v: 1, scope, key: [operation.startedAt, operation.gatewayId, operation.operationId] })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function decodeCursor(secret, scope, value) {
  const fail = () => { throw invalid('archive_cursor_invalid'); };
  if (typeof value !== 'string') return fail();
  const parts = value.split('.');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return fail();
  const [payload, signature] = parts;
  const actual = Buffer.from(signature, 'base64url');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest();
  if (actual.toString('base64url') !== signature || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return fail();
  try {
    const bytes = Buffer.from(payload, 'base64url');
    if (bytes.toString('base64url') !== payload) return fail();
    const decoded = JSON.parse(bytes.toString('utf8'));
    if (decoded?.v !== 1 || decoded.scope !== scope || !Array.isArray(decoded.key) || decoded.key.length !== 3
      || decoded.key.some((item) => typeof item !== 'string') || !Number.isFinite(Date.parse(decoded.key[0]))
      || new Date(decoded.key[0]).toISOString() !== decoded.key[0]) return fail();
    return { startedAt: decoded.key[0], gatewayId: decoded.key[1], operationId: decoded.key[2] };
  } catch { return fail(); }
}

/** A read-only view of the current listener buffer, not a durable execution archive. */
export function createOperationArchive(service, cleanGatewayId) {
  // A cursor belongs to this activation and query scope, and is not an authority
  // to read data. No cursor keys or snapshots are persisted.
  const secret = crypto.randomBytes(32);
  return ({ query = {} } = {}) => {
    const date = query.date == null || query.date === '' ? null : parseDate(query.date);
    const formatter = dateFormatter(query.timeZone);
    const timeZone = formatter.resolvedOptions().timeZone;
    const limit = pageSize(query.limit);
    const gatewayId = query.gatewayId == null || query.gatewayId === '' ? null : cleanGatewayId(query.gatewayId);
    if (query.q != null && (typeof query.q !== 'string' || query.q.length > 200)) throw invalid('archive_query_invalid');
    const text = (query.q || '').trim().toLowerCase();
    const scope = scopeHash(date, timeZone, gatewayId, text);
    const cursor = query.cursor == null ? null : decodeCursor(secret, scope, query.cursor);

    const snapshot = service.snapshotOperationActivity?.() ?? { available: false, maxEntries: null, operations: [] };
    const retained = Array.isArray(snapshot.operations) ? snapshot.operations : [];
    const operations = retained.map(projectActivity).filter((operation) => operation
      && (!gatewayId || operation.gatewayId === gatewayId)
      && (!date || dateInZone(formatter, new Date(operation.startedAt)) === date)
      && (!text || [operation.gatewayId, operation.operationId, operation.kind, operation.state, operation.terminalOutcome]
        .some((value) => typeof value === 'string' && value.toLowerCase().includes(text))))
      .sort(compareDescending);
    const after = cursor ? operations.filter((operation) => compareDescending(operation, cursor) > 0) : operations;
    const page = after.slice(0, limit);
    const hasMore = after.length > page.length;
    return {
      ok: true,
      operations: page,
      nextCursor: hasMore ? encodeCursor(secret, scope, page.at(-1)) : null,
      hasMore,
      history: {
        source: 'controller_listener_activity', available: snapshot.available === true, complete: false, volatile: true,
        retainedEntries: retained.length, maxEntries: snapshot.maxEntries ?? null, matchedEntries: operations.length,
        lostOnRestart: true, evictsOldestUpdated: true, clearedOnGatewayRevocation: true,
      },
    };
  };
}
