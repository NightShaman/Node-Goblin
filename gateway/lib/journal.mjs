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
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify({ entries: [...this.entries.entries()].map(([id, entry]) => ({ id, ...entry })) });
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, payload);
    fs.renameSync(tempPath, this.filePath);
  }

  prune(current = nowMs()) {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= current) this.entries.delete(key);
    }
    while (this.entries.size > this.limit) {
      const oldestKey = this.entries.keys().next().value;
      this.entries.delete(oldestKey);
    }
    this.save();
  }

  inspect(id, current = nowMs()) {
    this.prune(current);
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.expiresAt <= current) {
      this.entries.delete(id);
      this.save();
      return null;
    }
    return { requestDigest: entry.requestDigest, result: clone(entry.result), expiresAt: entry.expiresAt };
  }

  get(id, current = nowMs()) {
    return this.inspect(id, current)?.result ?? null;
  }

  put(id, requestDigest, result, current = nowMs()) {
    this.prune(current);
    this.entries.set(id, { requestDigest, result: clone(result), expiresAt: current + this.ttlMs });
    this.prune(current);
  }
}
