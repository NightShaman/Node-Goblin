import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GatewayDaemon } from './lib/daemon.mjs';
import { OperationJournal } from './lib/journal.mjs';
import { boundOutputFrame, MAX_FRAME_BYTES } from './lib/output-frame.mjs';
import { digestHex } from './lib/protocol.mjs';

const bytes = m => Buffer.byteLength(JSON.stringify(m)) + 1;
for (const text of ['\n', '\0', '"', '\\', '😀']) {
  test(`encoded frame budget includes escaping and envelope ${JSON.stringify(text)}`, () => {
    const outcome = { type: 'process.result', stdout: text.repeat(1048576), stderr: 'tail', truncated: false };
    for (const message of [
      { type: 'process.terminal', operationId: 'op', seq: 99, evidence: outcome },
      { type: 'response', requestId: 'request'.repeat(100), ok: true, result: { operationId: 'op', replay: true, outcome } },
      { type: 'process.stream', operationId: 'op', data: outcome.stdout },
    ]) {
      const bounded = boundOutputFrame(message);
      assert.ok(bytes(bounded) <= MAX_FRAME_BYTES);
      const result = bounded.evidence ?? bounded.result?.outcome ?? bounded;
      assert.equal(result.truncated, true);
      assert.equal((result.stdout ?? result.data).includes('�'), false);
      if (result.stdout != null) assert.equal(result.stdoutDigest, digestHex(result.stdout));
    }
  });
}

test('huge non-text results fail explicitly rather than silently losing entries', () => {
  const result = boundOutputFrame({ type: 'response', requestId: 'id', ok: true, result: { outcome: { entries: ['x'.repeat(MAX_FRAME_BYTES)] } } });
  assert.equal(result.error.code, 'output_frame_too_large');
  assert.ok(bytes(result) <= MAX_FRAME_BYTES);
});

test('default and custom NUL file reads have bounded durable replay and truthful metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-frame-'));
  try {
    const filePath = path.join(root, 'nul');
    fs.writeFileSync(filePath, Buffer.alloc(1048576));
    const journal = () => new OperationJournal({ stateDir: root });
    for (const maxBytes of [undefined, 1048576]) {
      const writes = [];
      const request = { id: 'first', method: 'filesystem.execute', params: { operationId: `read-${maxBytes}`, tool: 'files_read', arguments: { filePath, maxBytes } } };
      const daemon = new GatewayDaemon({ journal: journal(), output: { write: s => writes.push(s) } });
      await daemon.handle(request);
      const response = JSON.parse(writes.at(-1));
      const outcome = response.result.outcome;
      assert.equal(outcome.transportTruncated, true);
      assert.equal(outcome.incomplete, true);
      assert.equal(outcome.nextOffsetBytes, null);
      assert.equal(outcome.returnedBytes, Buffer.byteLength(outcome.content));
      assert.equal(outcome.contentHash, digestHex(outcome.content).slice(0, 16));
      const restarted = new GatewayDaemon({ journal: journal(), output: { write: s => writes.push(s) } });
      await restarted.handle({ ...request, id: 'replay' });
      assert.equal(JSON.parse(writes.at(-1)).result.replay, true);
      assert.deepEqual(JSON.parse(writes.at(-1)).result.outcome, outcome);
      for (const frame of writes) assert.ok(Buffer.byteLength(frame) <= MAX_FRAME_BYTES);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('process terminal, response and journal use the same encoded-budget outcome', async () => {
  const writes = [];
  const daemon = new GatewayDaemon({ output: { write: s => writes.push(s) } });
  const request = { id: 'first', method: 'process.exec', params: { operationId: 'process-frame', maxOutputBytes: 2097152, executable: process.execPath, args: ['-e', "process.stdout.write('\\0'.repeat(1048576))"] } };
  await daemon.handle(request);
  await daemon.handle({ ...request, id: 'replay' });
  const messages = writes.map(JSON.parse);
  const terminal = messages.find(m => m.type === 'process.terminal');
  const response = messages.find(m => m.type === 'response' && m.requestId === 'first');
  const replay = messages.at(-1);
  assert.equal(terminal.evidence.transportTruncated, true);
  assert.deepEqual(terminal.evidence, response.result.outcome);
  assert.deepEqual(replay.result.outcome, terminal.evidence);
  assert.equal(replay.result.replay, true);
  for (const frame of writes) assert.ok(Buffer.byteLength(frame) <= MAX_FRAME_BYTES);
});
