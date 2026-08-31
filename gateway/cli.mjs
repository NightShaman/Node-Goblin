#!/usr/bin/env node
import process from 'node:process';
import { GatewayDaemon } from './lib/daemon.mjs';

const daemon = new GatewayDaemon();
daemon.start();

const shutdown = () => {
  daemon.stopping = true;
  for (const entry of daemon.controllers.values()) entry.controller.abort();
  daemon.stop();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
