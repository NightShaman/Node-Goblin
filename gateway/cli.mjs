#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { GatewayDaemon } from './lib/daemon.mjs';
import { OperationJournal } from './lib/journal.mjs';
import { OutboundGatewayTransport } from './lib/network-transport.mjs';

function fileFromEnv(name) {
  return process.env[name] ? fs.readFileSync(process.env[name]) : undefined;
}

let service;
if (process.env.BURROW_GATEWAY_CONTROLLER_URL) {
  const controller = new URL(process.env.BURROW_GATEWAY_CONTROLLER_URL);
  if (controller.protocol !== 'tls:') throw new Error('controller URL must use tls:');
  const stateDir = process.env.BURROW_GATEWAY_STATE_DIR;
  if (!stateDir) throw new Error('BURROW_GATEWAY_STATE_DIR is required for network transport');
  const daemon = new GatewayDaemon({
    journal: new OperationJournal({ stateDir }),
    identity: { transport: 'tls-jsonl-outbound' },
  });
  service = new OutboundGatewayTransport({
    host: controller.hostname,
    port: Number(controller.port || 443),
    gatewayId: process.env.BURROW_GATEWAY_ID,
    stateDir,
    enrollmentToken: process.env.BURROW_GATEWAY_ENROLLMENT_TOKEN,
    ca: fileFromEnv('BURROW_GATEWAY_CA_FILE'),
    cert: fileFromEnv('BURROW_GATEWAY_CERT_FILE'),
    key: fileFromEnv('BURROW_GATEWAY_KEY_FILE'),
    daemon,
  }).start();
} else {
  service = new GatewayDaemon();
  service.start();
}

const shutdown = () => {
  service.stopping = true;
  const daemon = service.daemon || service;
  for (const entry of daemon.controllers.values()) entry.controller.abort();
  service.stop();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
