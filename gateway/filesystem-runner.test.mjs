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

test('filesystem traversal reports depth and entry truncation without hidden default caps', async () => {
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
