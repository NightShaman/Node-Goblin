// Minimal OTLP ExportTraceServiceRequest encoder for the gateway's curated
// string attributes and simple spans. Field numbers and wire types are from
// opentelemetry/proto/{collector/trace/v1,trace/v1,common/v1,resource/v1}.
// This is deliberately not a general-purpose protobuf implementation.
function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}
function tag(field, wire) { return varint(field * 8 + wire); }
function bytes(field, value) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  return Buffer.concat([tag(field, 2), varint(data.length), data]);
}
function number(field, value) { return Buffer.concat([tag(field, 0), varint(value)]); }
function fixed64(field, value) {
  const data = Buffer.allocUnsafe(8);
  data.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([tag(field, 1), data]);
}
function fixed32(field, value) {
  const data = Buffer.allocUnsafe(4);
  data.writeUInt32LE(value >>> 0);
  return Buffer.concat([tag(field, 5), data]);
}
function message(field, parts) { return bytes(field, Buffer.concat(parts)); }
function keyValue({ key, value }) {
  return [bytes(1, key), message(2, [bytes(1, value.stringValue)])];
}
function span(value) {
  return [
    bytes(1, Buffer.from(value.traceId, 'hex')),
    bytes(2, Buffer.from(value.spanId, 'hex')),
    ...(value.traceState ? [bytes(3, value.traceState)] : []),
    ...(value.parentSpanId ? [bytes(4, Buffer.from(value.parentSpanId, 'hex'))] : []),
    bytes(5, value.name), number(6, value.kind),
    fixed64(7, value.startTimeUnixNano), fixed64(8, value.endTimeUnixNano),
    ...value.attributes.map((attribute) => message(9, keyValue(attribute))),
    message(15, [...(value.status.message ? [bytes(2, value.status.message)] : []), number(3, value.status.code)]),
    fixed32(16, value.flags),
  ];
}

export function encodeTraceRequest({ resourceSpans }) {
  return Buffer.concat(resourceSpans.map((resourceSpan) => message(1, [
    message(1, resourceSpan.resource.attributes.map((attribute) => message(1, keyValue(attribute)))),
    ...resourceSpan.scopeSpans.map((scopeSpans) => message(2, [
      message(1, [bytes(1, scopeSpans.scope.name), ...(scopeSpans.scope.version ? [bytes(2, scopeSpans.scope.version)] : [])]),
      ...scopeSpans.spans.map((item) => message(2, span(item))),
    ])),
  ])));
}

// Visit only the wire types used by OTLP. Never decode collector-provided text.
// This parser is deliberately bounded by the caller's response-size limit.
function visitFields(data, visit) {
  let offset = 0;
  function readVarint() {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= data.length) throw new Error('invalid_protobuf');
      const byte = data[offset++];
      if (i === 9 && byte > 1) throw new Error('invalid_protobuf');
      value |= BigInt(byte & 0x7f) << BigInt(i * 7);
      if (!(byte & 0x80)) return value;
    }
    throw new Error('invalid_protobuf');
  }
  while (offset < data.length) {
    const tag = readVarint();
    if (tag < 8n || tag > 0xffffffffn) throw new Error('invalid_protobuf');
    const field = Number(tag >> 3n); const wire = Number(tag & 7n);
    let value;
    if (wire === 0) value = readVarint();
    else if (wire === 2) {
      const length = readVarint();
      if (length > BigInt(data.length - offset)) throw new Error('invalid_protobuf');
      value = data.subarray(offset, offset + Number(length));
      offset += Number(length);
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > data.length) throw new Error('invalid_protobuf');
    } else throw new Error('invalid_protobuf');
    visit(field, wire, value);
  }
}

// ExportTraceServiceResponse.partial_success is field 1; its rejected_spans
// and error_message are fields 1 and 2. Only return a count and a flag, never
// the error message. Throw on malformed or negative int64 values.
export function decodeTraceResponse(data) {
  let rejectedSpans = 0; let warning = false;
  visitFields(data, (field, wire, nested) => {
    if (field !== 1) return;
    if (wire !== 2) throw new Error('invalid_protobuf');
    visitFields(nested, (number, type, value) => {
      if (number === 1) {
        if (type !== 0 || value > 0x7fffffffffffffffn) throw new Error('invalid_protobuf');
        rejectedSpans = Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value);
      } else if (number === 2) {
        if (type !== 2) throw new Error('invalid_protobuf');
        warning = value.length > 0;
      }
    });
  });
  return { rejectedSpans, warning };
}
