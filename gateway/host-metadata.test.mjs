import assert from 'node:assert/strict';
import test from 'node:test';
import { collectHostMetadata, MAX_HOST_ADDRESSES, MAX_HOST_INTERFACES } from './lib/host-metadata.mjs';
import { GatewayDaemon } from './lib/daemon.mjs';

const address = (address, family, internal = false) => ({ address, family, internal, mac: '00:11:22:33:44:55', cidr: 'private-subnet' });

test('host metadata filters internal, loopback, invalid and mismatched families without leaking MACs', () => {
  const host = collectHostMetadata({
    hostname: () => 'node-1.example', platform: () => 'linux',
    networkInterfaces: () => ({
      lo: [address('127.0.0.1', 'IPv4'), address('::1', 'IPv6'), address('192.0.2.7', 'IPv4', true)],
      en0: [address('192.0.2.2', 'IPv4'), address('2001:db8::2', 'IPv6'), address('2001:db8::3', 'IPv4'), address('not-ip', 'IPv4')],
      docker0: [address('172.17.0.1', 4)],
      tun0: [address('fd00::1', 6)],
    }),
  });
  assert.deepEqual(host, { hostname: 'node-1.example', platform: 'linux', addresses: [
    { interface: 'docker0', interfaceKind: 'container', family: 'IPv4', address: '172.17.0.1' },
    { interface: 'en0', interfaceKind: 'lan-candidate', family: 'IPv4', address: '192.0.2.2' },
    { interface: 'en0', interfaceKind: 'lan-candidate', family: 'IPv6', address: '2001:db8::2' },
    { interface: 'tun0', interfaceKind: 'vpn', family: 'IPv6', address: 'fd00::1' },
  ] });
  assert.equal(JSON.stringify(host).includes('00:11:22:33:44:55'), false);
  assert.equal(JSON.stringify(host).includes('private-subnet'), false);
  assert.equal('primary' in host, false);
  assert.equal('reachable' in host, false);
});

test('host metadata has per-field validation and fixed interface/address limits', () => {
  const invalid = collectHostMetadata({ hostname: () => 'invalid\nname', platform: () => 'windows; injection', networkInterfaces: () => { throw new Error('unavailable'); } });
  assert.deepEqual(invalid, { hostname: null, platform: null, addresses: [] });
  const entries = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [
    `eth${String(n).padStart(3, '0')}`, Array.from({ length: 10 }, (_, i) => address(`10.${n}.${i}.1`, 'IPv4')),
  ]));
  const host = collectHostMetadata({ hostname: () => 'bounded', platform: () => 'linux', networkInterfaces: () => entries });
  assert.equal(host.addresses.length, MAX_HOST_ADDRESSES);
  assert.equal(new Set(host.addresses.map((item) => item.interface)).size <= MAX_HOST_INTERFACES, true);
  assert.equal(host.addresses.every((item) => item.interface < 'eth032'), true);
  assert.equal(JSON.stringify(host).length < 10000, true);
});

test('daemon hello refreshes current OS network information on each request', async (t) => {
  const os = await import('node:os');
  const original = os.default.networkInterfaces;
  let current = '192.0.2.10';
  os.default.networkInterfaces = () => ({ eth0: [address(current, 'IPv4')] });
  t.after(() => { os.default.networkInterfaces = original; });
  const responses = [];
  const daemon = new GatewayDaemon({ telemetry: { async shutdown() {} } });
  const send = (message) => responses.push(message);
  await daemon.handle({ id: 'one', method: 'hello' }, send);
  current = '192.0.2.11';
  await daemon.handle({ id: 'two', method: 'hello' }, send);
  assert.equal(responses[0].result.host.addresses[0].address, '192.0.2.10');
  assert.equal(responses[1].result.host.addresses[0].address, '192.0.2.11');
  assert.equal(responses[0].result.protocolVersion, '1.0');
});
