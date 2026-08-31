import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { GatewayDaemon } from './lib/daemon.mjs';
import { OperationJournal } from './lib/journal.mjs';
import { GatewayClient } from './lib/client.mjs';
import { operationIdFromRequest } from './lib/protocol.mjs';

async function collect(run, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8');
  output.on('data', (chunk) => { text += chunk; });
  const daemon = new GatewayDaemon({ input, output, ...options });
  daemon.start();
  await run({ input, output, daemon });
  await new Promise((resolve) => setTimeout(resolve, options.waitMs ?? 250));
  daemon.stop();
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('hello and health respond with identity and status', async () => {
  const messages = await collect(async ({ input }) => {
    input.write(JSON.stringify({ id: '1', method: 'hello' }) + '\n');
    input.write(JSON.stringify({ id: '2', method: 'health' }) + '\n');
  });
  assert.equal(messages[0].result.protocolVersion, '1.0');
  assert.equal(messages[1].result.status, 'ok');
});

test('process execution emits accepted stream terminal and replay', async () => {
  const request = { method: 'process.exec', params: { executable: process.execPath, args: ['-e', "process.stdout.write('out');process.stderr.write('err')"] } };
  const operationId = operationIdFromRequest(request);
  const messages = await collect(async ({ input }) => {
    input.write(JSON.stringify({ id: 'a', ...request }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 120));
    input.write(JSON.stringify({ id: 'b', ...request }) + '\n');
  });
  assert.equal(messages[0].type, 'accepted');
  assert.equal(messages[0].operationId, operationId);
  assert.equal(messages.some((message) => message.type === 'process.stream' && message.stream === 'stdout' && message.data === 'out'), true);
  assert.equal(messages.some((message) => message.type === 'process.stream' && message.stream === 'stderr' && message.data === 'err'), true);
  const terminal = messages.find((message) => message.type === 'process.terminal');
  assert.equal(terminal.evidence.exitCode, 0);
  assert.equal(typeof terminal.evidence.durationMs, 'number');
  const replay = messages.find((message) => message.requestId === 'b' && message.result?.replay === true);
  assert.equal(replay.result.operationId, operationId);
});

test('restart replay survives daemon restart with durable journal', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-state-'));
  const journal = () => new OperationJournal({ stateDir });
  const request = { method: 'process.exec', params: { executable: process.execPath, args: ['-e', "process.stdout.write('persisted')"] } };
  await collect(async ({ input }) => {
    input.write(JSON.stringify({ id: 'first', ...request }) + '\n');
  }, { journal: journal() });
  const replayed = await collect(async ({ input }) => {
    input.write(JSON.stringify({ id: 'second', ...request }) + '\n');
  }, { journal: journal(), waitMs: 50 });
  const replay = replayed.find((message) => message.requestId === 'second');
  assert.equal(replay.result.replay, true);
  assert.equal(replay.result.outcome.stdout, 'persisted');
});

test('cancel response reports cancellation request for active operation', async () => {
  const request = { id: 'x', method: 'process.exec', params: { executable: process.execPath, args: ['-e', "setInterval(()=>process.stdout.write('tick'),50)"] } };
  const operationId = operationIdFromRequest({ method: request.method, params: request.params });
  const messages = await collect(async ({ input }) => {
    input.write(JSON.stringify(request) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 180));
    input.write(JSON.stringify({ id: 'y', method: 'cancel', params: { operationId } }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    input.write(JSON.stringify({ id: 'z', method: 'health' }) + '\n');
  }, { waitMs: 350 });
  const cancel = messages.find((message) => message.requestId === 'y');
  assert.equal(cancel.result.operationId, operationId);
  assert.equal(cancel.result.cancelling, true);
});

test('explicit operation id conflicts when request changes', async () => {
  const operationId = 'op-1';
  const messages = await collect(async ({ input }) => {
    input.write(JSON.stringify({ id: '1', method: 'process.exec', params: { operationId, executable: process.execPath, args: ['-e', "process.stdout.write('one')"] } }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 120));
    input.write(JSON.stringify({ id: '2', method: 'process.exec', params: { operationId, executable: process.execPath, args: ['-e', "process.stdout.write('two')"] } }) + '\n');
  });
  const conflict = messages.find((message) => message.requestId === '2');
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'operation_id_conflict');
});

test('bounded output truncates utf8 safely and still returns terminal evidence', async () => {
  const messages = await collect(async ({ input }) => {
    input.write(JSON.stringify({ id: 'z', method: 'process.exec', params: { executable: process.execPath, args: ['-e', "process.stdout.write('€'.repeat(40))"], maxOutputBytes: 64 } }) + '\n');
  });
  const terminal = messages.find((message) => message.type === 'process.terminal');
  assert.equal(terminal.evidence.truncated, true);
  assert.equal(Buffer.byteLength(terminal.evidence.stdout, 'utf8') <= 64, true);
  assert.equal(terminal.evidence.stdout.endsWith('�'), false);
});

test('timeout emits terminal timeout evidence', async () => {
  const messages = await collect(async ({ input }) => {
    input.write(JSON.stringify({ id: 't', method: 'process.exec', params: { executable: process.execPath, args: ['-e', 'setTimeout(()=>{},1000)'], timeoutMs: 50 } }) + '\n');
  });
  const terminal = messages.find((message) => message.type === 'process.terminal');
  assert.equal(terminal.evidence.timedOut, true);
  assert.equal(terminal.evidence.timeoutReason, 'timeoutMs');
});

test('malformed json retains request id when recoverable', async () => {
  const messages = await collect(async ({ input }) => {
    input.write('{"id":"bad","method":"hello"\n');
  }, { waitMs: 50 });
  assert.equal(messages[0].type, 'error');
  assert.equal(messages[0].requestId, 'bad');
  assert.equal(messages[0].error.code, 'invalid_json');
});

test('client executes request and correlates events', async () => {
  const gatewayDir = path.dirname(new URL(import.meta.url).pathname);
  const client = GatewayClient.spawn({ cwd: gatewayDir });
  try {
    const result = await client.exec({ executable: process.execPath, args: ['-e', "process.stdout.write('client')"] });
    assert.equal(result.accepted.ok, true);
    assert.equal(result.response.ok, true);
    assert.equal(result.events.some((event) => event.type === 'process.terminal' && event.evidence.stdout === 'client'), true);
  } finally {
    await client.request('shutdown');
    await client.close();
  }
});

test('shutdown reports stopping', async () => {
  const messages = await collect(async ({ input }) => {
    input.write(JSON.stringify({ id: 's', method: 'shutdown' }) + '\n');
  });
  assert.equal(messages[0].result.status, 'stopping');
});

test('native filesystem execution returns correlated gateway evidence and replays', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-fs-'));
  const filePath = path.join(root, 'hello.txt');
  fs.writeFileSync(filePath, 'hello gateway');
  const request = { method: 'filesystem.execute', params: { operationId: 'fs-test-1', parentRunId: 'run-1', toolCallId: 'call-1', tool: 'files_read', arguments: { filePath } } };
  const messages = await collect(async ({ input }) => {
    input.write(JSON.stringify({ id: 'f1', ...request }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    input.write(JSON.stringify({ id: 'f2', ...request }) + '\n');
  }, { waitMs: 100 });
  assert.equal(messages[0].operationId, 'fs-test-1');
  const first = messages.find((message) => message.requestId === 'f1' && message.type === 'response');
  assert.equal(first.result.outcome.content, 'hello gateway');
  assert.equal(first.result.outcome.execution.kind, 'gateway');
  assert.equal(messages.find((message) => message.requestId === 'f2').result.replay, true);
});
