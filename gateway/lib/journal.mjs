import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_JOURNAL_LIMIT, DEFAULT_JOURNAL_TTL_MS, nowMs } from './protocol.mjs';

function clone(value) {
  return structuredClone(value);
}

export class OperationJournal {
  constructor({ ttlMs = DEFAULT_JOURNAL_TTL_MS, limit = DEFAULT_JOURNAL_LIMIT, stateDir = process.env.BURROW_GATEWAY_STATE_DIR, filePath } = {}) {
    this.ttlMs = ttlMs;
    this.limit = limit;
    this.entries = new Map();
    this.filePath = filePath ?? (stateDir ? path.join(stateDir, 'operations.json') : null);
    this.load();
  }

  load(current = nowMs()) {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string') continue;
      this.entries.set(entry.id, { requestDigest: entry.requestDigest ?? null, result: entry.result, expiresAt: Number(entry.expiresAt) || 0 });
    }
    this.prune(current);
  }

  save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const payload = JSON.stringify({ entries: [...this.entries.entries()].map(([id, entry]) => ({ id, ...entry })) });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    try {
      fs.writeFileSync(tempPath, payload, { mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, this.filePath);
    } finally { fs.rmSync(tempPath, { force: true }); }
  }

  prune(current = nowMs(), persist = true) {
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= current) { this.entries.delete(key); changed = true; }
    }
    while (this.entries.size > this.limit) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
      changed = true;
    }
    if (changed && persist) this.save();
    return changed;
  }

  inspect(id, current = nowMs()) {
    this.prune(current);
    const entry = this.entries.get(id);
    if (!entry) return null;
    return { requestDigest: entry.requestDigest, result: clone(entry.result), expiresAt: entry.expiresAt };
  }

  get(id, current = nowMs()) {
    return this.inspect(id, current)?.result ?? null;
  }

  put(id, requestDigest, result, current = nowMs()) {
    this.prune(current, false);
    this.entries.set(id, { requestDigest, result: clone(result), expiresAt: current + this.ttlMs });
    this.prune(current, false);
    this.save();
  }
}
