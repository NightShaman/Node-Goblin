import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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


for (const runtime of ['codex', 'claude', 'gemini']) test(`authenticated ${runtime} RPC keeps OAuth bytes out of events journals and correlations`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-codex-e2e-'));
  let tlsServer;
  const listener = new GatewayControllerListener({ gateways: [{ gatewayId: 'gateway-1', controllerId: 'controller', secret: 'shared-secret' }],
    tlsServer: (_options, onSocket) => (tlsServer = new PairedTlsServer(onSocket)) }).listen(7443, '127.0.0.1');
  const journalPath = path.join(root, 'journal.json');
  const daemon = new GatewayDaemon({ journal: new OperationJournal({ filePath: journalPath }) });
  daemon.codex.executable = () => process.execPath;
  daemon.codex.claudeExecutable = () => process.execPath;
  daemon.codex.geminiExecutable = () => process.execPath;
  daemon.codex.spawnProcess = (exe, args, options) => spawn(exe, ['-e', "process.stdin.pipe(process.stdout);process.stderr.write('stderr-secret')"], options);
  const transport = new OutboundGatewayTransport({ host: 'controller.test', port: 7443, gatewayId: 'gateway-1', stateDir: path.join(root, 'trust'),
    enrollmentToken: 'shared-secret', ca: 'test-ca', daemon, tlsConnect: () => tlsServer.connect() });
  const seen = [];
  for (const event of ['gatewayEvent', 'gatewayResponse', 'gatewayProtocolError']) listener.on(event, value => seen.push(value));
  const controller = createProcessController(listener);
  const rpc = (method, params = {}) => controller.codexRpc({ targetId: 'gateway-1', method: `${runtime}.${method}`, params: { operationId: 'codex-e2e', ...params } });
  try {
    transport.start(); await once(transport, 'authenticated');
    await rpc('open', { cwd: root, ...(runtime === 'claude' ? { args: ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--allowedTools', 'Bash,Edit,Write,Read,Glob,Grep,NotebookEdit', '--permission-prompts', 'none', '--model', 'claude-sonnet-4-6'], token: 'oauth-env-secret' } : runtime === 'gemini' ? { args: ['-p', 'Private task', '--output-format', 'stream-json', '--model', 'gemini-3-pro-preview', '--approval-mode', 'yolo'], apiKey: 'gemini-env-secret' } : {}) });
    await rpc('write', { data: 'oauth-transient-secret\n' });
    let data = '';
    for (let i = 0; i < 100 && !data; i++) { data += (await rpc('read')).data; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(data, 'oauth-transient-secret\n');
    assert.doesNotMatch(JSON.stringify(seen), /oauth-transient-secret|oauth-env-secret|gemini-env-secret|Private task|stderr-secret/);
    assert.equal(listener.snapshotOperationActivity().operations.length, 0);
    assert.equal(fs.existsSync(journalPath), false);
    await rpc('close');
    let done = false;
    for (let i = 0; i < 100 && !done; i++) { done = (await rpc('read')).done; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(done, true); assert.equal(daemon.codex.sessions.size, 0);
  } finally { transport.stop(); listener.close(); await daemon.stop(); fs.rmSync(root, { recursive: true, force: true }); }
});
