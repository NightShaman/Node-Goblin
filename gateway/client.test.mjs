import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { GatewayClient } from './lib/client.mjs';

for (const terminal of ['eof', 'error', 'malformed', 'close', 'exit']) {
  test(`local client settles requests on ${terminal}`, async () => {
    const input = new PassThrough(); const output = new PassThrough();
    const child = new EventEmitter(); child.stdin = input; child.stdout = output;
    const client = new GatewayClient({ child });
    const pending = client.request('health');
    const rejected = assert.rejects(pending);
    if (terminal === 'eof') output.end();
    if (terminal === 'error') output.emit('error', new Error('fixture_error'));
    if (terminal === 'malformed') output.write('{bad}\n');
    if (terminal === 'close') { child.emit('close'); client.close(); }
    if (terminal === 'exit') child.emit('exit', 0);
    await rejected;
    child.emit('close');
    await client.close(); await client.close();
    assert.equal(client.pending.size, 0);
    assert.equal(client.events.size, 0);
    assert.equal(input.listenerCount('error'), 0);
    assert.equal(output.listenerCount('error'), 0);
  });
}

test('local client handles finite request options and already exited child', async () => {
  const child = new EventEmitter(); child.exitCode = 0;
  child.stdin = new PassThrough(); child.stdout = new PassThrough();
  const client = new GatewayClient({ child });
  await assert.rejects(client.request('health', {}, { timeoutMs: 5 }), /request_timeout/);
  const controller = new AbortController();
  const pending = client.request('health', {}, { signal: controller.signal });
  controller.abort(new Error('fixture_abort'));
  await assert.rejects(pending, /fixture_abort/);
  assert.equal(client.pending.size, 0);
  await client.close();
});
