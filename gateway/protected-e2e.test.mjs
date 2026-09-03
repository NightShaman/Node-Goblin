import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GatewayControllerListener } from './lib/controller-listener.mjs';
import { GatewayDaemon } from './lib/daemon.mjs';
import { OperationJournal } from './lib/journal.mjs';
import { OutboundGatewayTransport } from './lib/network-transport.mjs';
import { createOperationCorrelationStore, createProcessController } from '../server/index.mjs';

class PairedSocket extends EventEmitter {
  constructor() { super(); this.peer = null; this.destroyed = false; this.writable = true; }
  setEncoding() {}
  write(value) {
    if (!this.writable) return false;
    const data = String(value);
    queueMicrotask(() => { if (!this.peer.destroyed) this.peer.emit('data', data); });
    return true;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.emit('close');
    if (!this.peer.destroyed) {
      this.peer.destroyed = true;
      this.peer.writable = false;
      this.peer.emit('close');
    }
  }
}

function socketPair() {
  const client = new PairedSocket();
  const server = new PairedSocket();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

class PairedTlsServer extends EventEmitter {
  constructor(onSocket) { super(); this.onSocket = onSocket; }
  listen() {}
  close(callback) { callback?.(); }
  connect() {
    const pair = socketPair();
    queueMicrotask(() => { pair.client.emit('secureConnect'); this.onSocket(pair.server); });
    return pair.client;
  }
}

test('authenticated controller to TLS transport injects protected child env without evidence or correlation leakage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-protected-e2e-'));
  const journalPath = path.join(root, 'operations.json');
  let tlsServer;
  const listener = new GatewayControllerListener({
    gateways: [{ gatewayId: 'gateway-1', controllerId: 'controller', secret: 'shared-secret' }],
    tlsServer: (_options, onSocket) => (tlsServer = new PairedTlsServer(onSocket)),
  }).listen(7443, '127.0.0.1');
  const daemon = new GatewayDaemon({ journal: new OperationJournal({ filePath: journalPath }) });
  const transport = new OutboundGatewayTransport({
    host: 'controller.test', port: 7443, gatewayId: 'gateway-1', stateDir: path.join(root, 'trust'),
    enrollmentToken: 'shared-secret', ca: 'test-ca', daemon, tlsConnect: () => tlsServer.connect(),
  });
  const gatewayEvents = [];
  listener.on('gatewayEvent', ({ message }) => gatewayEvents.push(message));
  const values = new Map();
  const settings = {
    get: async (name, fallback) => values.has(name) ? structuredClone(values.get(name)) : fallback,
    set: async (name, value) => (values.set(name, structuredClone(value)), value),
  };
  const operationStore = createOperationCorrelationStore(settings);
  const controller = createProcessController(listener, { operationStore });
  const secret = 'split-secret-value-93842';
  try {
    transport.start();
    await once(transport, 'authenticated');
    const result = await controller.executeProcess({
      operationId: 'protected-e2e', gatewayId: 'gateway-1', parentRunId: 'run-secret', toolCallId: 'call-secret',
      process: { command: `${process.execPath} -e "process.stdout.write(process.env.TOKEN.slice(0,7));setTimeout(()=>process.stdout.write(process.env.TOKEN.slice(7)),10)"` },
      protectedValues: { TOKEN: secret },
      protectedBindingMetadata: [{ name: 'TOKEN', ref: 'protected://token' }],
    });
    const terminal = gatewayEvents.find((event) => event.type === 'process.terminal');
    const streamText = gatewayEvents.filter((event) => event.type === 'process.stream').map((event) => event.data).join('');
    const journalText = fs.readFileSync(journalPath, 'utf8');
    const correlationText = JSON.stringify(values.get('controllerOperations'));
    assert.equal(result.stdout, '[redacted]');
    assert.equal(streamText, '[redacted]');
    assert.equal(terminal.evidence.stdout, '[redacted]');
    assert.equal([JSON.stringify(result), JSON.stringify(gatewayEvents), journalText, correlationText].some((text) => text.includes(secret)), false);
    assert.equal((await operationStore.get('protected-e2e')).parentRunId, 'run-secret');
    assert.equal((await operationStore.get('protected-e2e')).toolCallId, 'call-secret');
  } finally {
    transport.stop();
    listener.close();
  }
});
