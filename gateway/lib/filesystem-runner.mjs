import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SUPPORTED = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'files_write', 'files_edit']);
const fingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// null means unbounded, matching the developer-tools filesystem contract. Explicit
// finite limits remain configurable by callers; the gateway must not invent a cap.
const bound = (value) => value == null || value === '' ? Infinity : Math.max(1, Math.floor(Number(value)));
const globRegex = (pattern) => {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        // A globstar followed by slash also matches no directory components.
        if (pattern[i + 1] === '/') { i += 1; source += '(?:.*/)?'; }
        else source += '.*';
      } else source += '[^/]*';
    } else if (c === '?') source += '[^/]';
    else source += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`${source}$`);
};

async function walk(root, { maxDepth, maxEntries, signal }) {
  const entries = [];
  let depthTruncated = false;
  let entryBudgetExhausted = false;
  async function visit(dir, depth) {
    signal?.throwIfAborted();
    const children = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const item of children) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      if (entries.length >= maxEntries) { entryBudgetExhausted = true; return; }
      const absolute = path.join(dir, item.name);
      const isDirectory = item.isDirectory();
      entries.push({ path: path.relative(root, absolute), type: isDirectory ? 'directory' : item.isFile() ? 'file' : item.isSymbolicLink() ? 'symlink' : 'other' });
      if (isDirectory) {
        if (depth < maxDepth) await visit(absolute, depth + 1);
        else depthTruncated = true;
      }
      if (entryBudgetExhausted) return;
    }
  }
  await visit(root, 0);
  return { entries, depthTruncated, entryBudgetExhausted };
}

const traversalMeta = (listing, extra = {}) => {
  const depthTruncated = listing?.depthTruncated === true;
  const entryBudgetExhausted = listing?.entryBudgetExhausted === true;
  const truncated = depthTruncated || entryBudgetExhausted || extra.resultLimitReached === true;
  const warnings = [];
  if (depthTruncated) warnings.push('depth limit reached; some directories were not traversed');
  if (entryBudgetExhausted) warnings.push('entry budget reached; some entries were not returned');
  if (extra.resultLimitReached) warnings.push('result limit reached; some matches were not returned');
  return { truncated, depthTruncated, entryBudgetExhausted, incomplete: truncated, warnings };
};

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
      const root = path.resolve(String(a.dirPath));
      const listing = await walk(root, { maxDepth: bound(a.maxDepth), maxEntries: tool === 'files_list' ? bound(a.maxEntries) : bound(a.maxTraversalEntries), signal });
      if (tool === 'files_list') result = { tool, ok: true, dirPath: root, entries: listing.entries, ...traversalMeta(listing), error: null, artifacts: null };
      else if (tool === 'files_find') {
        const pattern = String(a.pattern || '*'); const paths = listing.entries.map(e => e.path).filter(p => globRegex(pattern).test(p));
        const limit = bound(a.maxEntries); const limited = paths.length > limit;
        result = { tool, ok: true, dirPath: root, pattern, paths: paths.slice(0, limit), ...traversalMeta(listing, { resultLimitReached: limited }), error: null, artifacts: null };
      } else {
        const query = String(a.query || ''); if (!query) throw new Error('query_required');
        const matches = []; const limit = bound(a.maxMatches); let resultLimitReached = false;
        for (const entry of listing.entries) {
          signal?.throwIfAborted(); if (entry.type !== 'file') continue;
          let text; try { text = await fs.readFile(path.join(root, entry.path), 'utf8'); } catch { continue; }
          for (const [i, line] of text.split(/\r?\n/).entries()) if (line.includes(query)) {
            if (matches.length >= limit) { resultLimitReached = true; break; }
            matches.push({ filePath: entry.path, line: i + 1, text: line.slice(0, 1000) });
          }
          if (resultLimitReached) break;
        }
        result = { tool, ok: true, dirPath: root, query, matches, ...traversalMeta(listing, { resultLimitReached }), error: null, artifacts: null };
      }
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
