// Copy only resolved, private Core transport fields. These values are never
// process arguments, operation semantics, or public activity.
const TRANSPORT_STRINGS = ['endpoint', 'headers', 'tracesEndpoint', 'metricsEndpoint', 'tracesHeaders', 'metricsHeaders'];
const DESTINATION_STRINGS = ['id', ...TRANSPORT_STRINGS, 'protocol', 'metricsTemporality'];
const DESTINATION_BOOLEANS = ['enabled', 'tracesEnabled', 'metricsEnabled', 'environmentOwned'];
const TLS_FIELDS = ['caCertificate', 'clientCertificate', 'clientKey'];

function invalid() { throw new Error('telemetry_configuration_invalid'); }
function object(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value;
}
function copyFields(source, names, type, output, { nullable = false } = {}) {
  for (const name of names) {
    if (!Object.hasOwn(source, name)) continue;
    const value = source[name];
    if (typeof value !== type && !(nullable && value === null)) invalid();
    output[name] = value;
  }
}
function environmentTls(value) {
  const source = object(value);
  const result = {};
  for (const signal of ['traces', 'metrics']) {
    if (!Object.hasOwn(source, signal)) continue;
    result[signal] = {};
    copyFields(object(source[signal]), TLS_FIELDS, 'string', result[signal]);
  }
  return result;
}
function copyEnvironment(source, output) {
  if (Object.hasOwn(source, 'environmentTls')) output.environmentTls = environmentTls(source.environmentTls);
  if (Object.hasOwn(source, 'environmentTlsErrors')) {
    if (!Array.isArray(source.environmentTlsErrors) || source.environmentTlsErrors.some(value => !['traces', 'metrics'].includes(value))) invalid();
    output.environmentTlsErrors = [...source.environmentTlsErrors];
  }
}
function destination(value) {
  const source = object(value);
  const result = {};
  copyFields(source, DESTINATION_STRINGS, 'string', result, { nullable: true });
  copyFields(source, DESTINATION_BOOLEANS, 'boolean', result);
  if (typeof result.id !== 'string' || !result.id || typeof result.enabled !== 'boolean') invalid();
  if (Object.hasOwn(source, 'tls')) {
    const tls = object(source.tls);
    result.tls = {};
    copyFields(tls, ['verify'], 'boolean', result.tls);
    copyFields(tls, ['caCertificate'], 'string', result.tls);
  }
  copyEnvironment(source, result);
  return result;
}

export function normalizePrivateTelemetryConfiguration(value) {
  if (value == null) return null;
  // Round-trip before projection to make JSON semantics explicit and reject
  // cycles/BigInts before this value reaches the telemetry runtime.
  let source;
  try { source = object(JSON.parse(JSON.stringify(value))); } catch { invalid(); }
  const result = {};
  copyFields(source, ['enabled'], 'boolean', result);
  copyFields(source, TRANSPORT_STRINGS, 'string', result, { nullable: true });
  // Multi-destination consumers may omit the legacy scalar endpoint; retain
  // it only when supplied, but require it for legacy scalar payloads.
  if (typeof result.enabled !== 'boolean' || (!Object.hasOwn(source, 'destinations') && typeof result.endpoint !== 'string')
    || (Object.hasOwn(source, 'endpoint') && typeof result.endpoint !== 'string')) invalid();
  copyEnvironment(source, result);
  if (Object.hasOwn(source, 'destinations')) {
    if (!Array.isArray(source.destinations)) invalid();
    result.destinations = source.destinations.map(destination);
  }
  return result;
}
