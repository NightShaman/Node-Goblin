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
