import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GatewayDaemon } from './lib/daemon.mjs';
import { OperationJournal } from './lib/journal.mjs';
import { canonicalize, canonicalProcessRequest, operationIdFromRequest, requestDigestFromParams } from './lib/protocol.mjs';
import { createOperationCorrelationStore } from '../server/index.mjs';

const traceContext = { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01', tracestate: 'vendor=value' };
const replacementTrace = { traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-03', tracestate: 'other=value' };
const privateA = { enabled: true, endpoint: 'https://one.example', headers: 'x-token=private-one' };
const privateB = { enabled: true, endpoint: 'https://two.example', headers: 'x-token=private-two' };

// Produced from `git show 9062016fee78163f4afda841f6622f217446f537:gateway/lib/protocol.mjs`.
// Gateway hashes the whole request; the controller hashes the canonical params.
// These are literal vectors, not calculated using the upgraded implementation.
const vectors = [
  {
    name: 'process explicit', method: 'process.exec', kind: 'process',
    params: { operationId: 'legacy-process-explicit', executable: 'printf', args: ['legacy %s', 'ok'], cwd: '/tmp', env: { Z: 'last', A: 'first' }, protectedBindingMetadata: [{ name: 'TOKEN', ref: 'protected://legacy' }], traceContext },
    canonical: '{"method":"process.exec","params":{"args":["legacy %s","ok"],"cwd":"/tmp","env":{"A":"first","Z":"last"},"executable":"printf","operationId":undefined,"protectedBindingMetadata":[{"name":"TOKEN","ref":"protected://legacy"}],"protectedDelivery":undefined,"protectedValues":undefined,"traceContext":undefined}}',
    digest: '514b6f7f8ca6fcaa7cea1ba622470136cbee829ae2969d91005b5855bc69525f',
    correlationDigest: '8c0bcb29a44a63d2e798f69050f3aff668a366bff19beb9b605824364ca794bd',
    id: 'legacy-process-explicit',
  },
  {
    name: 'process implicit', method: 'process.exec', kind: 'process',
    params: { executable: 'printf', args: ['implicit-replay'], env: { A: '1' }, traceContext },
    canonical: '{"method":"process.exec","params":{"args":["implicit-replay"],"env":{"A":"1"},"executable":"printf","operationId":undefined,"protectedDelivery":undefined,"protectedValues":undefined,"traceContext":undefined}}',
    digest: 'e9fa6e0d84ed42c158c7b4592e4793c432c6ea78385e78c542fc4013fd748589',
    correlationDigest: '1f756fa13209713c2e8b49d03b08541d6e8047c8443b469cd3b066628059b0d5',
    id: 'e9fa6e0d84ed42c158c7b4592e4793c432c6ea78385e78c542fc4013fd748589',
  },
  {
    name: 'filesystem explicit', method: 'filesystem.execute', kind: 'filesystem',
    params: { operationId: 'legacy-filesystem-explicit', parentRunId: 'legacy-run', toolCallId: 'legacy-call', tool: 'files_write', arguments: { filePath: '/tmp/node-goblin-upgrade-fixture.txt', content: 'legacy' } },
    canonical: '{"method":"filesystem.execute","params":{"arguments":{"content":"legacy","filePath":"/tmp/node-goblin-upgrade-fixture.txt"},"operationId":undefined,"parentRunId":"legacy-run","protectedDelivery":undefined,"protectedValues":undefined,"tool":"files_write","toolCallId":"legacy-call","traceContext":undefined}}',
    digest: '59b07890d67cfadec6acbe8e1b0cdc92c4e398c49d825643ad960824c0b7ac43',
    correlationDigest: 'bfcde4e59c9a221229861ddcbcebb970ed193587eaf45371b3859b12aa6fa132',
    id: 'legacy-filesystem-explicit',
  },
  {
    name: 'filesystem implicit', method: 'filesystem.execute', kind: 'filesystem',
    params: { parentRunId: 'legacy-run', toolCallId: 'legacy-call-implicit', tool: 'files_write', arguments: { filePath: '/tmp/node-goblin-upgrade-implicit-fixture.txt', content: 'legacy' } },
    canonical: '{"method":"filesystem.execute","params":{"arguments":{"content":"legacy","filePath":"/tmp/node-goblin-upgrade-implicit-fixture.txt"},"operationId":undefined,"parentRunId":"legacy-run","protectedDelivery":undefined,"protectedValues":undefined,"tool":"files_write","toolCallId":"legacy-call-implicit","traceContext":undefined}}',
    digest: '991ec32df1cd6d2b1c0f873256ff371e6e70bebd1e3e68d24c7afd7639f1311d',
    correlationDigest: '6500b4a5618a4ae436ea0d16166c3c6efc7c56e09f14071456a6e3716a19142f',
    id: '991ec32df1cd6d2b1c0f873256ff371e6e70bebd1e3e68d24c7afd7639f1311d',
  },
];

function variants(params) {
  return [params, { ...params, traceContext: replacementTrace }, { ...params, telemetryConfiguration: undefined },
    { ...params, telemetryConfiguration: null }, { ...params, traceContext: replacementTrace, telemetryConfiguration: privateA },
    { ...params, telemetryConfiguration: privateB }];
}

function semanticChange(vector) {
  return vector.kind === 'process'
    ? { ...vector.params, args: [...vector.params.args, 'changed'] }
    : { ...vector.params, arguments: { ...vector.params.arguments, content: 'changed' } };
}

test('only top-level telemetry configuration is ignored, not nested operation data', () => {
  const base = { tool: 'files_write', arguments: { filePath: '/tmp/fixture', content: 'before', telemetryConfiguration: 'semantic value' } };
  const other = { ...base, arguments: { ...base.arguments, telemetryConfiguration: 'different semantic value' } };
  assert.notEqual(requestDigestFromParams(base, 'filesystem.execute'), requestDigestFromParams(other, 'filesystem.execute'));
  const process = { executable: 'example', env: { telemetryConfiguration: 'one' } };
  assert.notEqual(requestDigestFromParams(process), requestDigestFromParams({ ...process, env: { telemetryConfiguration: 'two' } }));
});

test('protected values remain transport-only while protected binding metadata remains semantic', () => {
  const base = { executable: 'example', protectedBindingMetadata: [{ name: 'TOKEN', ref: 'protected://one' }] };
  const sent = { ...base, protectedValues: { TOKEN: 'not-journalled' }, protectedDelivery: { requestId: 'delivery-one' } };
  const changed = { ...base, protectedBindingMetadata: [{ name: 'TOKEN', ref: 'protected://two' }] };
  assert.equal(requestDigestFromParams(base), requestDigestFromParams(sent));
  assert.notEqual(requestDigestFromParams(base), requestDigestFromParams(changed));
});

for (const vector of vectors) {
  test(`${vector.name} preserves pre-upgrade canonical bytes, digest and implicit ID`, () => {
    for (const params of variants(vector.params)) {
      const original = structuredClone(params);
      const canonical = canonicalProcessRequest(params, vector.method);
      assert.deepEqual(params, original, 'normalization must not mutate the input');
      assert.equal(Object.hasOwn(canonical.params, 'telemetryConfiguration'), false);
      assert.equal(Object.hasOwn(canonical.params, 'traceContext'), true, 'traceContext:undefined is legacy canonical form');
      assert.equal(canonical.params.traceContext, undefined);
      assert.equal(canonicalize(canonical), vector.canonical);
      assert.equal(requestDigestFromParams(params, vector.method), vector.digest);
      assert.equal(operationIdFromRequest({ method: vector.method, params }), vector.digest);
    }
    assert.notEqual(requestDigestFromParams(semanticChange(vector), vector.method), vector.digest);
  });

  test(`${vector.name} replays the pre-upgrade durable journal without executing`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-replay-upgrade-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const filePath = path.join(dir, 'operations.json');
    const outcome = { type: `${vector.kind}.result`, legacyOutcome: vector.name };
    const disk = JSON.stringify({ entries: [{ id: vector.id, requestDigest: vector.digest, result: outcome, expiresAt: Date.now() + 60_000 }] });
    fs.writeFileSync(filePath, disk);

    let executed = 0;
    const telemetry = { async execute() { executed++; return { unexpected: 'new execution' }; }, async shutdown() {} };
    const daemon = new GatewayDaemon({ journal: new OperationJournal({ stateDir: dir }), telemetry });
    daemon.secureTransportContext = { gatewayId: 'legacy-gateway', connectionId: 'authenticated-connection' };
    const frames = [];
    for (const [index, params] of variants(vector.params).entries()) {
      await daemon.handle({ id: `retry-${index}`, method: vector.method, params }, frame => frames.push(frame));
      assert.deepEqual(frames.at(-1), { type: 'response', requestId: `retry-${index}`, ok: true, result: { operationId: vector.id, replay: true, outcome } });
    }
    assert.equal(frames.length, variants(vector.params).length, 'no accepted, stream or terminal frames on replay');
    assert.equal(executed, 0, 'journal replay must never run the operation or telemetry');
    assert.equal(fs.readFileSync(filePath, 'utf8'), disk, 'replay leaves the legacy journal untouched');

    // Even an old implicitly generated ID, when supplied explicitly on a changed
    // retry, must still reject changed process/filesystem semantics.
    await daemon.handle({ id: 'changed', method: vector.method, params: { ...semanticChange(vector), operationId: vector.id, telemetryConfiguration: privateA } }, frame => frames.push(frame));
    assert.equal(frames.at(-1).error.code, 'operation_id_conflict');
    assert.equal(frames.at(-1).error.operationId, vector.id);
    assert.equal(executed, 0);
    assert.equal(fs.readFileSync(filePath, 'utf8'), disk);
  });

  test(`${vector.name} resumes pre-upgrade controller correlation without conflict`, async () => {
    const request = { operationId: vector.id, targetId: 'legacy-gateway', parentRunId: 'legacy-run', toolCallId: 'legacy-call' };
    const legacyRecord = { ...request, kind: vector.kind, requestDigest: vector.correlationDigest, state: 'dispatching', terminalReference: null, updatedAt: '2026-01-01T00:00:00.000Z' };
    const values = new Map([['controllerOperations', [legacyRecord]]]);
    const settings = {
      async get(key, fallback) { return structuredClone(values.get(key) ?? fallback); },
      async set(key, value) { values.set(key, structuredClone(value)); },
    };
    const recovered = createOperationCorrelationStore(settings);
    for (const params of variants(vector.params)) assert.deepEqual(await recovered.begin(request, vector.kind, params), legacyRecord);
    assert.deepEqual(await recovered.get(vector.id), legacyRecord);
    assert.deepEqual(values.get('controllerOperations'), [legacyRecord]);
    await assert.rejects(recovered.begin(request, vector.kind, semanticChange(vector)), /operation_correlation_conflict/);
    await recovered.terminal(vector.id, { response: { result: { operationId: vector.id, replay: true, outcome: { legacy: true } } } });
    const restarted = createOperationCorrelationStore(settings);
    assert.equal((await restarted.begin(request, vector.kind, { ...vector.params, telemetryConfiguration: privateB })).terminalReference.replay, true);
    assert.equal(JSON.stringify([...values]).includes('private-'), false);
  });
}
