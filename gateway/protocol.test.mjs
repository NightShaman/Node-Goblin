import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTraceContext, operationIdFromRequest, requestDigestFromParams } from './lib/protocol.mjs';

const first = { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', tracestate: 'vendor=value' };
const second = { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-03', tracestate: 'other=value' };

test('W3C trace context accepts flag bytes, validates tracestate, and rejects invalid carriers', () => {
  assert.deepEqual(normalizeTraceContext(first), first);
  assert.equal(normalizeTraceContext(second).traceparent.endsWith('-03'), true);
  for (const value of [{ traceparent: 'invalid' }, { traceparent: '00-' + '0'.repeat(32) + '-0123456789abcdef-01' }, { ...first, tracestate: 'dup=a,dup=b' }, { ...first, tracestate: 'bad key=value' }, { ...first, tracestate: 'x=a,b' }]) {
    assert.throws(() => normalizeTraceContext(value), /trace_context_invalid/);
  }
});

test('trace context never changes semantic operation ids or request digests', () => {
  const request = { method: 'process.exec', params: { executable: 'printf', args: ['ok'], traceContext: first } };
  const retry = { ...request, params: { ...request.params, traceContext: second } };
  assert.equal(operationIdFromRequest(request), operationIdFromRequest(retry));
  assert.equal(requestDigestFromParams(request.params), requestDigestFromParams(retry.params));
});
