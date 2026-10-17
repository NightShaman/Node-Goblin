import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SUPPORTED = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'files_write', 'files_edit']);
const fingerprint = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

// One daemon-local owner per canonical path, shared by write and edit.
const mutations = new Map();
async function mutationPath(filePath) {
  try { return await fs.realpath(filePath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(filePath);
    return parent === filePath ? filePath : path.join(await mutationPath(parent), path.basename(filePath));
  }
}
async function snapshot(filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('atomic_mutation_requires_single_link_file');
    return { stat, content: await fs.readFile(filePath) };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const contentVersion = (content) => crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
async function mutate(filePath, a, edit, signal) {
  const target = await mutationPath(filePath);
  const previous = mutations.get(target) || Promise.resolve();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  mutations.set(target, held);
  await previous;
  let temporary;
  try {
    signal?.throwIfAborted();
    const before = await snapshot(target);
    if (a.expectedContentHash !== undefined && a.expectedContentHash !== (before ? contentVersion(before.content) : null)) throw new Error('content_version_conflict');
    let content = String(a.content ?? '');
    if (edit) {
      if (!before) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      const text = before.content.toString('utf8');
      const oldText = String(a.oldText ?? '');
      const count = oldText ? text.split(oldText).length - 1 : 0;
      if (count !== 1) throw new Error(count ? 'old_text_not_unique' : 'old_text_not_found');
      content = text.replace(oldText, String(a.newText ?? ''));
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    temporary = path.join(path.dirname(target), `.node-goblin-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: before ? before.stat.mode & 0o777 : 0o666 });
    if (before) {
      const staged = await fs.stat(temporary);
      if (staged.uid !== before.stat.uid || staged.gid !== before.stat.gid) await fs.chown(temporary, before.stat.uid, before.stat.gid);
      await fs.chmod(temporary, before.stat.mode & 0o7777);
    }
    const current = await snapshot(target);
    // Detect outside writers since our read. POSIX rename has no compare-and-swap:
    // independent editors must cooperate to exclude the final check/rename race.
    if (Boolean(before) !== Boolean(current) || (before && (before.stat.ino !== current.stat.ino || before.stat.dev !== current.stat.dev
      || before.stat.mtimeMs !== current.stat.mtimeMs || before.stat.ctimeMs !== current.stat.ctimeMs || !before.content.equals(current.content)))) throw new Error('content_version_conflict');
    signal?.throwIfAborted();
    await fs.rename(temporary, target);
    temporary = null;
    return { existed: Boolean(before), bytesWritten: Buffer.byteLength(content), contentHash: contentVersion(Buffer.from(content)) };
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => {});
    release();
    if (mutations.get(target) === held) mutations.delete(target);
  }
}

// Defaults bound recursive work and response volume; explicit positive caller
// limits override them. Null/omitted values select defaults, never one entry.
const bound = (value, fallback) => value == null || value === '' || !Number.isSafeInteger(Number(value)) || Number(value) < 1 ? fallback : Number(value);
const traversalBudget = () => bound(process.env.BURROW_FILESYSTEM_TRAVERSAL_ENTRIES, 4000);
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
  const warnings = [];
  let depthTruncated = false;
  let entryBudgetExhausted = false;
  async function visit(dir, depth) {
    signal?.throwIfAborted();
    let children;
    try { children = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
    catch (error) { if (dir === root) throw error; warnings.push(`unreadable_directory:${path.relative(root, dir)}:${error.code || 'error'}`); return; }
    for (const item of children) {
      if (item.name.startsWith('.') || item.name === 'node_modules') continue;
      if (entries.length >= maxEntries) { entryBudgetExhausted = true; return; }
      const absolute = path.join(dir, item.name);
      const isDirectory = item.isDirectory();
      entries.push({ path: path.relative(root, absolute), type: isDirectory ? 'directory' : item.isFile() ? 'file' : item.isSymbolicLink() ? 'symlink' : 'other' });
      if (isDirectory) {
        if (depth < maxDepth) await visit(absolute, depth + 1);
        else {
          try { const hidden = await fs.readdir(absolute); if (hidden.some(name => !name.startsWith('.') && name !== 'node_modules')) depthTruncated = true; }
          catch (error) { warnings.push(`unreadable_directory:${path.relative(root, absolute)}:${error.code || 'error'}`); }
        }
      }
      if (entryBudgetExhausted) return;
    }
  }
  await visit(root, 0);
  return { entries, depthTruncated, entryBudgetExhausted, warnings };
}

const traversalMeta = (listing, extra = {}) => {
  const depthTruncated = listing?.depthTruncated === true;
  const entryBudgetExhausted = listing?.entryBudgetExhausted === true;
  const truncated = depthTruncated || entryBudgetExhausted || extra.resultLimitReached === true;
  const warnings = [...(listing?.warnings || [])];
  if (depthTruncated) warnings.push('depth limit reached; some directories were not traversed');
  if (entryBudgetExhausted) warnings.push('entry budget reached; some entries were not returned');
  if (extra.resultLimitReached) warnings.push('result limit reached; some matches were not returned');
  return { truncated, depthTruncated, entryBudgetExhausted, incomplete: truncated || warnings.length > 0, warnings };
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
      const listing = await walk(root, { maxDepth: bound(a.maxDepth, tool === 'files_list' ? 4 : 8), maxEntries: tool === 'files_list' ? bound(a.maxEntries, 500) : bound(a.maxTraversalEntries, traversalBudget()), signal });
      if (tool === 'files_list') result = { tool, ok: true, dirPath: root, entries: listing.entries, ...traversalMeta(listing), error: null, artifacts: null };
      else if (tool === 'files_find') {
        const pattern = String(a.pattern || '*'); const paths = listing.entries.map(e => e.path).filter(p => globRegex(pattern).test(p));
        const limit = bound(a.maxEntries, 500); const limited = paths.length > limit;
        result = { tool, ok: true, dirPath: root, pattern, paths: paths.slice(0, limit), ...traversalMeta(listing, { resultLimitReached: limited }), error: null, artifacts: null };
      } else {
        const query = String(a.query || ''); if (!query) throw new Error('query_required');
        const matches = []; const limit = bound(a.maxMatches, 200); let resultLimitReached = false;
        for (const entry of listing.entries) {
          signal?.throwIfAborted(); if (entry.type !== 'file') continue;
          let text; try { text = await fs.readFile(path.join(root, entry.path), 'utf8'); } catch (error) { listing.warnings.push(`unreadable_file:${entry.path}:${error.code || 'error'}`); continue; }
          for (const [i, line] of text.split(/\r?\n/).entries()) if (line.includes(query)) {
            if (matches.length >= limit) { resultLimitReached = true; break; }
            matches.push({ filePath: entry.path, line: i + 1, text: line.slice(0, 1000) });
          }
          if (resultLimitReached) break;
        }
        result = { tool, ok: true, dirPath: root, query, matches, ...traversalMeta(listing, { resultLimitReached }), error: null, artifacts: null };
      }
    } else if (tool === 'files_write') {
      const filePath = path.resolve(String(a.filePath));
      const changed = await mutate(filePath, a, false, signal);
      result = { tool, ok: true, filePath, workspaceRoot: a.workspaceRoot || null, encoding: 'utf8', created: !changed.existed, overwrote: changed.existed, bytesWritten: changed.bytesWritten, contentHash: changed.contentHash, error: null, artifacts: null };
    } else {
      const filePath = path.resolve(String(a.filePath));
      const changed = await mutate(filePath, a, true, signal);
      result = { tool, ok: true, filePath, replaced: 1, changedFiles: [filePath], contentHash: changed.contentHash, error: null, artifacts: null };
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
