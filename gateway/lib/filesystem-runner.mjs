import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SUPPORTED = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'files_write', 'files_edit']);
const fingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const bounded = (value, fallback, max) => Math.max(1, Math.min(Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback, max));

async function walk(root, { maxDepth, maxEntries, signal }) {
  const entries = []; let truncated = false;
  async function visit(dir, depth) {
    signal?.throwIfAborted();
    for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      if (entries.length >= maxEntries) { truncated = true; return; }
      const absolute = path.join(dir, item.name);
      entries.push({ path: path.relative(root, absolute), type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : item.isSymbolicLink() ? 'symlink' : 'other' });
      if (item.isDirectory() && depth < maxDepth) await visit(absolute, depth + 1);
      if (truncated) return;
    }
  }
  await visit(root, 0); return { entries, truncated };
}

export async function runFilesystem(params = {}, { signal, now = () => Date.now() } = {}) {
  const started = now();
  const tool = String(params.tool || '');
  const a = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
  let result;
  try {
    if (!SUPPORTED.has(tool)) throw Object.assign(new Error('native_filesystem_tool_unsupported'), { code: 'native_filesystem_tool_unsupported' });
    signal?.throwIfAborted();
  if (tool === 'files_read') {
    const filePath = path.resolve(String(a.filePath)); const stat = await fs.stat(filePath);
    const offsetBytes = Math.max(0, Number(a.offsetBytes) || 0); const maxBytes = Math.max(0, Number(a.maxBytes ?? 512000));
    const buffer = (await fs.readFile(filePath)).subarray(offsetBytes, offsetBytes + maxBytes); const content = buffer.toString(a.encoding || 'utf8');
    result = { tool, ok: true, filePath, workspaceRoot: a.workspaceRoot || null, encoding: a.encoding || 'utf8', bytes: stat.size, modifiedAt: stat.mtime.toISOString(), offsetBytes, returnedBytes: buffer.length, contentHash: crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16), truncated: offsetBytes + buffer.length < stat.size, nextOffsetBytes: offsetBytes + buffer.length < stat.size ? offsetBytes + buffer.length : null, content, error: null, warnings: [], artifacts: null };
  } else if (tool === 'files_inspect') {
    const target = path.resolve(String(a.path)); try { const stat = await fs.lstat(target); result = { tool, ok: true, path: target, exists: true, type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other', size: stat.size, modifiedAt: stat.mtime.toISOString(), symlinkTarget: stat.isSymbolicLink() ? await fs.readlink(target) : null, error: null, artifacts: null }; } catch (error) { if (error.code !== 'ENOENT') throw error; result = { tool, ok: true, path: target, exists: false, type: null, size: null, modifiedAt: null, symlinkTarget: null, error: null, artifacts: null }; }
  } else if (tool === 'files_list' || tool === 'files_find' || tool === 'files_search') {
    const root = path.resolve(String(a.dirPath)); const listing = await walk(root, { maxDepth: bounded(a.maxDepth, tool === 'files_list' ? 4 : 8, 24), maxEntries: 4000, signal });
    if (tool === 'files_list') result = { tool, ok: true, dirPath: root, entries: listing.entries.slice(0, bounded(a.maxEntries, 500, 2000)), truncated: listing.truncated, warnings: [], error: null, artifacts: null };
    else if (tool === 'files_find') { const pattern = String(a.pattern || '*'); const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')}$`); const paths = listing.entries.map(e => e.path).filter(p => re.test(p)).slice(0, bounded(a.maxEntries, 500, 2000)); result = { tool, ok: true, dirPath: root, pattern, paths, truncated: listing.truncated, warnings: [], error: null, artifacts: null }; }
    else { const query = String(a.query || ''); if (!query) throw new Error('query_required'); const matches = []; const limit = bounded(a.maxMatches, 200, 1000); for (const entry of listing.entries) { signal?.throwIfAborted(); if (entry.type !== 'file' || matches.length >= limit) continue; let text; try { text = await fs.readFile(path.join(root, entry.path), 'utf8'); } catch { continue; } text.split(/\r?\n/).forEach((line, i) => { if (matches.length < limit && line.includes(query)) matches.push({ filePath: entry.path, line: i + 1, text: line.slice(0, 1000) }); }); } result = { tool, ok: true, dirPath: root, query, matches, truncated: listing.truncated || matches.length >= limit, warnings: [], error: null, artifacts: null }; }
  } else if (tool === 'files_write') {
    const filePath = path.resolve(String(a.filePath)); let existed = true; try { await fs.stat(filePath); } catch (e) { if (e.code === 'ENOENT') existed = false; else throw e; } await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(filePath, String(a.content ?? ''), 'utf8'); result = { tool, ok: true, filePath, workspaceRoot: a.workspaceRoot || null, encoding: 'utf8', created: !existed, overwrote: existed, bytesWritten: Buffer.byteLength(String(a.content ?? '')), error: null, artifacts: null };
  } else {
    const filePath = path.resolve(String(a.filePath)); const before = await fs.readFile(filePath, 'utf8'); const oldText = String(a.oldText ?? ''); const count = oldText ? before.split(oldText).length - 1 : 0; if (count !== 1) throw new Error(count ? 'old_text_not_unique' : 'old_text_not_found'); await fs.writeFile(filePath, before.replace(oldText, String(a.newText ?? '')), 'utf8'); result = { tool, ok: true, filePath, replaced: 1, changedFiles: [filePath], error: null, artifacts: null };
  }
  } catch (error) {
    const code = String(error?.code || error?.message || 'native_filesystem_failed').split(':')[0];
    const base = { tool: tool || 'native_filesystem', ok: false, error: code, diagnostic: { code, message: code }, warnings: [], artifacts: null };
    if (tool === 'files_read' || tool === 'files_write' || tool === 'files_edit') result = { ...base, filePath: typeof a.filePath === 'string' ? a.filePath : null };
    else if (tool === 'files_inspect') result = { ...base, path: typeof a.path === 'string' ? a.path : null };
    else result = { ...base, dirPath: typeof a.dirPath === 'string' ? a.dirPath : null };
  }
  result.durationMs = now() - started; result.resultFingerprint = fingerprint(result); result.execution = { kind: 'gateway', protocolMethod: 'filesystem.execute' }; return result;
}
