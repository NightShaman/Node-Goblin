import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFilesystem } from './lib/filesystem-runner.mjs';

test('filesystem operation matrix preserves kinds and structures path/type failures', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fs-matrix-')); const file=path.join(root,'a.txt'); fs.writeFileSync(file,'alpha');
 const cases=[
  ['files_read',{filePath:file}],['files_list',{dirPath:root}],['files_list',{dirPath:file}],['files_read',{filePath:root}],
  ['files_inspect',{path:file}],['files_find',{dirPath:root,pattern:'*.txt'}],['files_search',{dirPath:root,query:'alpha'}],
 ];
 for (let i=0;i<cases.length;i++){const [tool,args]=cases[i]; const r=await runFilesystem({tool,arguments:args}); assert.equal(r.tool,tool); if(i===2){assert.equal(r.ok,false);assert.equal(r.error,'ENOTDIR')} else if(i===3){assert.equal(r.ok,false);assert.equal(r.error,'EISDIR')} else assert.equal(r.ok,true);}
 const made=path.join(root,'b.txt'); assert.equal((await runFilesystem({tool:'files_write',arguments:{filePath:made,content:'before'}})).ok,true);
 assert.equal((await runFilesystem({tool:'files_edit',arguments:{filePath:made,oldText:'before',newText:'after'}})).ok,true);
 assert.equal((await runFilesystem({tool:'files_read',arguments:{filePath:made}})).content,'after');
});

test('filesystem traversal reports depth and entry truncation with explicit bounds', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fs-bounds-')); fs.mkdirSync(path.join(root,'one','two'),{recursive:true});
 fs.writeFileSync(path.join(root,'one','two','deep.mjs'),'x'); fs.writeFileSync(path.join(root,'sibling.mjs'),'x');
 const complete=await runFilesystem({tool:'files_list',arguments:{dirPath:root}});
 assert.equal(complete.incomplete,false); assert.equal(complete.truncated,false); assert.equal(complete.depthTruncated,false); assert.equal(complete.entryBudgetExhausted,false);
 const shallow=await runFilesystem({tool:'files_list',arguments:{dirPath:root,maxDepth:1}});
 assert.equal(shallow.depthTruncated,true); assert.equal(shallow.incomplete,true); assert.match(shallow.warnings.join(' '),/depth/);
 const budget=await runFilesystem({tool:'files_list',arguments:{dirPath:root,maxEntries:1}});
 assert.equal(budget.entryBudgetExhausted,true); assert.equal(budget.incomplete,true); assert.equal(budget.entries.length,1);
});

test('files_find preserves globstar semantics including zero directories', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fs-glob-')); fs.mkdirSync(path.join(root,'nested','dir'),{recursive:true});
 fs.writeFileSync(path.join(root,'root.mjs'),'x'); fs.writeFileSync(path.join(root,'nested','dir','deep.mjs'),'x');
 const result=await runFilesystem({tool:'files_find',arguments:{dirPath:root,pattern:'**/*.mjs'}});
 assert.deepEqual(result.paths,['nested/dir/deep.mjs','root.mjs']); assert.equal(result.incomplete,false);
});

test('files_find and files_search distinguish result limits from complete traversal', async () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fs-results-')); fs.writeFileSync(path.join(root,'a.mjs'),'hit\nhit'); fs.writeFileSync(path.join(root,'b.mjs'),'hit');
 const found=await runFilesystem({tool:'files_find',arguments:{dirPath:root,pattern:'*.mjs',maxEntries:1}});
 assert.equal(found.paths.length,1); assert.equal(found.truncated,true); assert.equal(found.entryBudgetExhausted,false);
 const searched=await runFilesystem({tool:'files_search',arguments:{dirPath:root,query:'hit',maxMatches:1}});
 assert.equal(searched.matches.length,1); assert.equal(searched.truncated,true); assert.equal(searched.incomplete,true); assert.match(searched.warnings.join(' '),/result limit/);
});

test('null bounds select defaults and depth truncation does not hide siblings or empty directories', async t => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gateway-defaults-'));
  t.after(() => fs.promises.rm(root, {recursive:true,force:true}));
  await fs.promises.mkdir(path.join(root,'a','nested','deep'),{recursive:true});
  await fs.promises.writeFile(path.join(root,'a','nested','deep','file.mjs'),'x');
  await fs.promises.mkdir(path.join(root,'z','empty'),{recursive:true});
  const list=await runFilesystem({tool:'files_list',arguments:{dirPath:root,maxDepth:null,maxEntries:null}});
  assert.ok(list.entries.some(e=>e.path==='z'));
  assert.ok(list.entries.some(e=>e.path==='a/nested/deep/file.mjs'));
  const partial=await runFilesystem({tool:'files_list',arguments:{dirPath:root,maxDepth:1,maxEntries:200}});
  assert.ok(partial.entries.some(e=>e.path==='z/empty'));
  assert.equal(partial.depthTruncated,true);
  await fs.promises.rm(path.join(root,'a'),{recursive:true});
  const complete=await runFilesystem({tool:'files_list',arguments:{dirPath:root,maxDepth:1,maxEntries:200}});
  assert.equal(complete.truncated,false);
});

async function mutationFixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fs-ownership-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'file');
  await fs.promises.writeFile(filePath, 'alpha beta');
  return { root, filePath, run: (tool, args) => runFilesystem({ tool, arguments: { filePath, ...args } }) };
}

test('same-path edits serialize and preserve both acknowledged non-overlapping changes', async t => {
  const { filePath, run } = await mutationFixture(t);
  const results = await Promise.all([
    run('files_edit', { oldText: 'alpha', newText: 'ALPHA' }),
    run('files_edit', { oldText: 'beta', newText: 'BETA' }),
  ]);
  assert.deepEqual(results.map(r => r.ok), [true, true]);
  assert.equal(await fs.promises.readFile(filePath, 'utf8'), 'ALPHA BETA');
});

test('conflicting edits and stale write preconditions fail rather than lose an acknowledged edit', async t => {
  const { filePath, run } = await mutationFixture(t);
  const initial = await run('files_read', {});
  const results = await Promise.all([
    run('files_edit', { oldText: 'alpha', newText: 'ALPHA' }),
    run('files_edit', { oldText: 'alpha', newText: 'other' }),
    run('files_write', { content: 'stale', expectedContentHash: initial.contentHash }),
  ]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results[2].error, 'content_version_conflict');
  const winningEdit = results[0].ok ? 'ALPHA beta' : 'other beta';
  assert.equal(results[0].ok ? results[1].error : results[0].error, 'old_text_not_found');
  assert.equal(await fs.promises.readFile(filePath, 'utf8'), winningEdit);
});

test('write and edit share the same queue, including symlink aliases', async t => {
  const { root, filePath, run } = await mutationFixture(t);
  const alias = path.join(root, 'alias');
  await fs.promises.symlink(filePath, alias);
  const results = await Promise.all([
    run('files_write', { content: 'new beta' }),
    runFilesystem({ tool: 'files_edit', arguments: { filePath: alias, oldText: 'beta', newText: 'BETA' } }),
  ]);
  assert.deepEqual(results.map(r => r.ok), [true, true]);
  assert.equal(await fs.promises.readFile(filePath, 'utf8'), 'new BETA');
  assert.equal((await fs.promises.lstat(alias)).isSymbolicLink(), true);
});

for (const failure of ['external', 'stage', 'rename', 'abort']) {
  test(`atomic mutation preserves prior content on ${failure}`, async t => {
    const { root, filePath, run } = await mutationFixture(t);
    const abort = new AbortController();
    const originalWrite = fs.promises.writeFile;
    const originalRename = fs.promises.rename;
    t.after(() => { fs.promises.writeFile = originalWrite; fs.promises.rename = originalRename; });
    fs.promises.writeFile = async (target, ...args) => {
      if (String(target).includes('.node-goblin-')) {
        if (failure === 'stage') throw Object.assign(new Error('fixture'), { code: 'ENOSPC' });
        await originalWrite(target, ...args);
        if (failure === 'external') await originalWrite(filePath, 'outside writer');
        if (failure === 'abort') abort.abort();
        return;
      }
      return originalWrite(target, ...args);
    };
    if (failure === 'rename') fs.promises.rename = async () => { throw Object.assign(new Error('fixture'), { code: 'EACCES' }); };
    const result = await runFilesystem({ tool: 'files_edit', arguments: { filePath, oldText: 'alpha', newText: 'ALPHA' } }, { signal: abort.signal });
    assert.equal(result.ok, false);
    if (failure === 'external') assert.equal(result.error, 'content_version_conflict');
    assert.equal(await fs.promises.readFile(filePath, 'utf8'), failure === 'external' ? 'outside writer' : 'alpha beta');
    assert.deepEqual(await fs.promises.readdir(root), ['file']);
    fs.promises.writeFile = originalWrite;
    fs.promises.rename = originalRename;
    assert.equal((await run('files_write', { content: 'recovered' })).ok, true);
  });
}
