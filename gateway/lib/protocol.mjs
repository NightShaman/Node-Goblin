import crypto from 'node:crypto';

export const PROTOCOL_VERSION = '1.0';
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
export const DEFAULT_JOURNAL_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_JOURNAL_LIMIT = 256;

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
  };
  return { method, params: normalized };
}

export function requestDigestFromParams(params = {}, method = 'process.exec') {
  return crypto.createHash('sha256').update(canonicalize(canonicalProcessRequest(params, method))).digest('hex');
}

export function operationIdFromRequest(request) {
  return crypto.createHash('sha256').update(canonicalize(request)).digest('hex');
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
