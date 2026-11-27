import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { GatewayDaemon } from './lib/daemon.mjs';
import { WindowsDesktop } from './lib/windows-desktop.mjs';
import { registerDesktopTool } from '../server/desktop-tool.mjs';

const status = { action: 'status' };
const simulate = (timeout = 5000) => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), kill() { this.stopped = true; } });
  return { child, desktop: new WindowsDesktop({ enabled: true, systemRoot: 'fixture', spawnHelper: () => child, timeout }) };
};

test('desktop helper is optional, single-flight, and does not restart once consent ends', async () => {
  const disabled = new WindowsDesktop();
  assert.deepEqual(await disabled.execute(status), { available: false, state: 'desktop_disabled' });
  await assert.rejects(disabled.execute({ action: 'screenshot' }), { code: 'desktop_disabled' });
  const { child, desktop } = simulate();
  const request = once(child.stdin, 'data');
  const work = desktop.execute(status);
  assert.deepEqual(JSON.parse(String((await request)[0])), status);
  await assert.rejects(desktop.execute(status), { code: 'desktop_busy' });
  child.stdout.write('{"available":false,"state":"desktop_input_unavailable"}\r\n');
  assert.deepEqual(await work, { available: false, state: 'desktop_input_unavailable' });
  const abandoned = desktop.execute({ action: 'screenshot' });
  desktop.stop();
  assert.equal(child.stopped, true);
  await assert.rejects(abandoned, { code: 'desktop_helper_absent' });
  assert.deepEqual(await desktop.execute(status), { available: false, state: 'desktop_helper_absent' });
});

test('desktop helper kills hung workers and rejects malformed replies and arguments', async () => {
  const hung = simulate(30);
  await assert.rejects(hung.desktop.execute(status), { code: 'desktop_timeout' });
  assert.equal(hung.child.stopped, true);
  const bad = simulate();
  await assert.rejects(bad.desktop.execute({ action: 'status', windowId: '99:200' }), { code: 'desktop_arguments_invalid' });
  const request = bad.desktop.execute(status);
  bad.child.stdout.write('garbage\n');
  await assert.rejects(request, { code: 'desktop_response_invalid' });
  assert.equal(bad.child.stopped, true);
});

test('a local gateway request cannot access the desktop tool even if a helper exists', async () => {
  const daemon = new GatewayDaemon({ desktop: { execute() { assert.fail('local request reached desktop'); } } });
  const replies = [];
  await daemon.handle({ id: 'test', method: 'desktop.execute', params: status }, value => replies.push(value));
  assert.equal(replies[0].error.code, 'desktop_transport_required');
  assert.equal(daemon.controllers.size, 0);
});

test('desktop MCP tool is explicitly granted, reports disconnection and preserves typed image content', async () => {
  let spec;
  let connected = false;
  const image = '/9j/2Q=='; // marker sequence for this boundary test, not a screen capture
  registerDesktopTool({ register(x) { spec = x; } }, { async dispatchDesktop(host, request) {
    assert.equal(host, 'host');
    if (!connected) throw Object.assign(new Error('offline'), { code: 'gateway_not_connected' });
    assert.deepEqual(request, { action: 'screenshot' });
    return { response: { ok: true, result: { width: 16, height: 9, mimeType: 'image/jpeg', data: image } } };
  } });
  assert.equal(spec.availability, 'grant-required');
  assert.deepEqual(JSON.parse((await spec.handler({ targetId: 'host', ...status }, {})).content[0].text), { targetId: 'host', connected: false, available: false, state: 'gateway_not_connected' });
  connected = true;
  assert.deepEqual((await spec.handler({ targetId: 'host', action: 'screenshot' }, {})).content[1], { type: 'image', mimeType: 'image/jpeg', data: image });
});
