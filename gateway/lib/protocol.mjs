import crypto from 'node:crypto';

export const PROTOCOL_VERSION = '1.0';
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_JOURNAL_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_JOURNAL_LIMIT = 256;

const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const TRACESTATE_KEY = /^(?:[a-z][_0-9a-z\-*\/]{0,255}|[a-z0-9][_0-9a-z\-*\/]{0,240}@[a-z][_0-9a-z\-*\/]{0,13})$/;
const OPERATION_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/i;
const TARGET_ID = /^[a-z0-9][a-z0-9._-]*$/i;
const FILESYSTEM_TOOLS = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'files_write', 'files_edit']);

export function normalizeTraceContext(value = null) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('trace_context_invalid');
  const traceparent = String(value.traceparent || '').trim().toLowerCase();
  if (!TRACEPARENT.test(traceparent)) throw new Error('trace_context_invalid');
  const [, traceId, spanId, flags] = traceparent.split('-');
  if (traceId === '0'.repeat(32) || spanId === '0'.repeat(16)) throw new Error('trace_context_invalid');
  const tracestate = value.tracestate == null ? '' : String(value.tracestate).trim();
  if (tracestate) {
    if (tracestate.length > 512 || /[\r\n]/.test(tracestate)) throw new Error('trace_context_invalid');
    const members = tracestate.split(',');
    if (members.length > 32) throw new Error('trace_context_invalid');
    const keys = new Set();
    for (const member of members) {
      const separator = member.indexOf('=');
      const key = member.slice(0, separator).trim();
      const memberValue = member.slice(separator + 1).trim();
      if (separator < 1 || !TRACESTATE_KEY.test(key) || keys.has(key) || !memberValue || memberValue.length > 256
        || /[,=]/.test(memberValue) || [...memberValue].some((character) => { const code = character.charCodeAt(0); return code < 0x20 || code > 0x7e; })) throw new Error('trace_context_invalid');
      keys.add(key);
    }
  }
  return Object.freeze({ traceparent, ...(tracestate ? { tracestate } : {}) });
}

export function parseTraceContext(value = null) {
  const carrier = normalizeTraceContext(value);
  if (!carrier) return null;
  const [, traceId, spanId, flags] = carrier.traceparent.split('-');
  const traceFlags = Number.parseInt(flags, 16);
  return Object.freeze({ ...carrier, traceId, spanId, traceFlags, sampled: Boolean(traceFlags & 1) });
}

export function safeTelemetryOperationId(value) { const text = String(value || ''); return OPERATION_ID.test(text) ? text : null; }
export function safeTelemetryTargetId(value) { const text = String(value || ''); return TARGET_ID.test(text) ? text : null; }
export function safeTelemetryTool(value) { const text = String(value || ''); return text === 'shell_exec' || FILESYSTEM_TOOLS.has(text) ? text : null; }

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

export function canonicalProcessRequest(params = {}, method = 'process.exec') {
  const normalized = {
    ...params,
    operationId: undefined,
    // Secret material is one-shot transport data. Safe binding metadata remains
    // in the digest so reference/name conflicts are still detected.
    protectedValues: undefined,
    protectedDelivery: undefined,
    // Trace propagation is transport context, not operation semantics. A retry
    // with the same operationId may arrive under a replacement parent span.
    traceContext: undefined,
  };
  // Private exporter configuration is transport context, never semantics.
  // Omit the key entirely: canonicalize includes keys with undefined values,
  // and adding a new one would invalidate pre-upgrade journal digests and IDs.
  delete normalized.telemetryConfiguration;
  return { method, params: normalized };
}

export function requestDigestFromParams(params = {}, method = 'process.exec') {
  return crypto.createHash('sha256').update(canonicalize(canonicalProcessRequest(params, method))).digest('hex');
}

export function operationIdFromRequest(request = {}) {
  return crypto.createHash('sha256').update(canonicalize(canonicalProcessRequest(request.params || {}, request.method || 'process.exec'))).digest('hex');
}

export function digestHex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function truncateUtf8(text, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return '';
  const buffer = Buffer.from(String(text), 'utf8');
  if (buffer.byteLength <= maxBytes) return String(text);
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0b11000000) === 0b10000000) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

export function nowMs() {
  return Date.now();
}
