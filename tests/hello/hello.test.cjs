'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {createHello}=require('../../src/composition/hello.cjs');
const {openLocalFile}=require('../../src/adapters/hello/local-file.cjs');
const {repositoryContract}=require('./contract.cjs');
const child=path.join(__dirname,'child.cjs');
async function temporary(action) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arch026-hello-'));
  try { return await action(dir); } finally { await fs.rm(dir,{recursive:true,force:true}); }
}
function run(mode,dir) {
  const r=spawnSync(process.execPath,[child,mode,dir],{encoding:'utf8',windowsHide:true,timeout:15000});
  if(r.error) throw r.error; return r;
}
repositoryContract('memory',()=>createHello({provider:'memory'}));
repositoryContract('local-file',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arch026-hello-'));
  try {
    const f=await createHello({provider:'local-file',directory:dir});
    return {...f,async close(){await f.close();await fs.rm(dir,{recursive:true,force:true});}};
  } catch(e){await fs.rm(dir,{recursive:true,force:true});throw e;}
});
test('A7 persistence across two distinct processes including Revision',()=>temporary(async dir=>{
  const seed=run('seed',dir); assert.equal(seed.status,0,seed.stderr);
  const read=run('read',dir); assert.equal(read.status,0,read.stderr);
  assert.deepEqual(JSON.parse(read.stdout),JSON.parse(seed.stdout));
}));
test('A8 same Core instance class and unchanged shared sources across provider exchange',async()=>{
  const sources=['src/hello/core.ts','src/hello/schema.ts','src/hello/contracts.ts','tests/hello/contract.cjs'];
  async function hashes(){return Promise.all(sources.map(async file=>createHash('sha256').update(await fs.readFile(path.join(__dirname,'../..',file))).digest('hex')));}
  const before=await hashes();
  await temporary(async dir=>{
    const a=await createHello({provider:'memory'}),b=await createHello({provider:'local-file',directory:dir});
    try {
      assert.equal(a.core.constructor,b.core.constructor);
      for(const f of [a,b]){await f.core.add({id:'x',message:'same'});assert.equal((await f.core.read('x')).record.message,'same');}
    }finally{await a.close();await b.close();}
  });
  assert.deepEqual(await hashes(),before);
});
test('A12 second process and same-process second owner rejected',()=>temporary(async dir=>{
  const f=await createHello({provider:'local-file',directory:dir});
  try {
    await assert.rejects(createHello({provider:'local-file',directory:dir}),{code:'UNAVAILABLE'});
    const second=run('open',dir); assert.equal(second.status,2); assert.equal(JSON.parse(second.stdout).diagnostic,'LOCK_PRESENT_NO_AUTOMATIC_RECOVERY');
  }finally{await f.close();}
}));
test('A12 Schema metadata and stored corruption rejected without repair',async()=>{
  for(const [code,change] of [
    ['SCHEMA_MISMATCH',d=>{d.schema.version='2';}],
    ['SCHEMA_MISMATCH',d=>{d.schema.id='other';}],
    ['SCHEMA_MISMATCH',d=>{d.schema.fingerprint='changed';}],
    ['DATA_CORRUPT',d=>{d.rows=[{record:{id:'x',message:7},revision:'r'}];}],
    ['DATA_CORRUPT',d=>{delete d.schema;}],
  ]) {
    await temporary(async dir=>{
      const f=await createHello({provider:'local-file',directory:dir});await f.close();
      const file=path.join(dir,'records.json'),data=JSON.parse(await fs.readFile(file,'utf8'));change(data);
      const text=JSON.stringify(data);await fs.writeFile(file,text);
      await assert.rejects(createHello({provider:'local-file',directory:dir}),{code});
      assert.equal(await fs.readFile(file,'utf8'),text);
    });
  }
  await temporary(async dir=>{await fs.writeFile(path.join(dir,'records.json'),'{');await assert.rejects(createHello({provider:'local-file',directory:dir}),{code:'DATA_CORRUPT'});});
});
test('abnormal exit leaves diagnosable lock, never automatically stolen',()=>temporary(async dir=>{
  assert.equal(run('crash',dir).status,0);
  const before=await fs.readFile(path.join(dir,'owner.lock'),'utf8');
  await assert.rejects(createHello({provider:'local-file',directory:dir}),e=>e.diagnostic==='LOCK_PRESENT_NO_AUTOMATIC_RECOVERY');
  assert.equal(await fs.readFile(path.join(dir,'owner.lock'),'utf8'),before);
}));
test('capability mismatch rejected before storage initialization',()=>temporary(async dir=>{
  await assert.rejects(createHello({provider:'memory',required:[{name:'storage.restart-persistence',version:1}]}),{code:'UNSUPPORTED_CONFIGURATION'});
  await assert.rejects(createHello({provider:'unknown'}),{code:'UNSUPPORTED_CONFIGURATION'});
  await assert.rejects(createHello({provider:'local-file',directory:dir,required:[{name:'unknown',version:1}]}),{code:'UNSUPPORTED_CONFIGURATION'});
  await assert.rejects(createHello({provider:'local-file',directory:dir,required:[{name:'repository.atomic-create',version:2}]}),{code:'UNSUPPORTED_CONFIGURATION'});
  assert.deepEqual(await fs.readdir(dir),[]);
}));
test('save failure and uncertain rename never return success',async()=>{
  for(const stage of ['before','after'])await temporary(async dir=>{
    let fail=false;
    const io={...fs,async open(file,flags){
      if(fail&&stage==='before'&&String(file).includes('records.tmp-'))throw Error('injected');
      return fs.open(file,flags);
    },async rename(from,to){await fs.rename(from,to);if(fail&&stage==='after')throw Error('lost completion');}};
    const f=await openLocalFile(dir,io);
    try{
      fail=true;await assert.rejects(f.port.add({id:'x',message:'hello'}),{code:stage==='after'?'OUTCOME_UNKNOWN':'UNAVAILABLE'});
      if(stage==='before')assert.equal(await f.port.read('x'),null);
      else await assert.rejects(f.port.read('x'),{code:'OUTCOME_UNKNOWN'});
    }finally{await f.close();}
    const reopened=await openLocalFile(dir);try{assert.equal((await reopened.port.read('x'))?.record.message,stage==='after'?'hello':undefined);}finally{await reopened.close();}
  });
});
test('close drains queued operations, is idempotent, rejects later access',()=>temporary(async dir=>{
  const f=await createHello({provider:'local-file',directory:dir});
  const add=f.repository.add({id:'x',message:''});const close=f.close();await add;await close;await f.close();
  await assert.rejects(f.repository.read('x'),{code:'UNAVAILABLE'});
}));

// All injected causes deliberately contain sensitive-looking text. None may escape.
function injected() { const e=Error('PRIVATE_PATH SECRET_RAW_STACK'); e.code='EACCES'; return e; }
function safeFailure(code, diagnostics) {
  return error=>{
    const {RepositoryError}=require('../../dist/src/hello/contracts');
    assert.ok(error instanceof RepositoryError);assert.equal(error.code,code);
    assert.equal(error.message,code);
    assert.doesNotMatch(JSON.stringify(error)+error.stack,/PRIVATE_PATH|SECRET_RAW_STACK|EACCES/);
    assert.equal(error.cause,undefined);
    if(diagnostics)assert.deepEqual(error.cleanupDiagnostics,diagnostics);
    return true;
  };
}
function wrapHandle(handle, overrides) {
  return new Proxy(handle,{get(target,key){
    if(Object.hasOwn(overrides,key))return overrides[key];
    const v=target[key];return typeof v==='function'?v.bind(target):v;
  }});
}
test('I/O setup errors are normalized: mkdir realpath lock open read readdir lock write/sync',async()=>{
  for(const stage of ['mkdir','realpath','open','readFile','readdir','lock-write','lock-sync'])await temporary(async dir=>{
    const io={...fs};
    if(stage.startsWith('lock-'))io.open=async(file,flags)=>{
      const h=await fs.open(file,flags);
      return wrapHandle(h,{[stage==='lock-write'?'writeFile':'sync']:async()=>{throw injected();}});
    };
    else io[stage]=async()=>{throw injected();};
    await assert.rejects(openLocalFile(dir,io),safeFailure('UNAVAILABLE'));
  });
});
test('initialization keeps OUTCOME_UNKNOWN or DATA_CORRUPT when lock cleanup also fails',async()=>{
  for(const primary of ['rename','corrupt'])for(const cleanup of ['close','unlink'])await temporary(async dir=>{
    if(primary==='corrupt')await fs.writeFile(path.join(dir,'records.json'),'{');
    const io={...fs,async rename(a,b){await fs.rename(a,b);throw injected();}};
    if(cleanup==='close')io.open=async(file,flags)=>{
      const h=await fs.open(file,flags);
      return String(file).endsWith('owner.lock')?wrapHandle(h,{async close(){await h.close();throw injected();}}):h;
    };
    else io.unlink=async file=>{if(String(file).endsWith('owner.lock'))throw injected();return fs.unlink(file);};
    await assert.rejects(openLocalFile(dir,io),safeFailure(primary==='rename'?'OUTCOME_UNKNOWN':'DATA_CORRUPT',[
      cleanup==='close'?'LOCK_CLOSE_FAILED':'LOCK_UNLINK_FAILED',
    ]));
    assert.ok(await fs.readFile(path.join(dir,'owner.lock'),'utf8'));
    if(primary==='rename')assert.ok(JSON.parse(await fs.readFile(path.join(dir,'records.json'),'utf8')));
  });
});
test('save write/sync/close failures preserve existing bytes and classify cleanup separately',async()=>{
  for(const stage of ['writeFile','sync','close'])await temporary(async dir=>{
    let fail=false;
    const io={...fs,async open(file,flags){
      const h=await fs.open(file,flags);
      if(!String(file).includes('records.tmp-'))return h;
      return wrapHandle(h,{[stage]:async(...args)=>{if(fail){if(stage==='close')await h.close();throw injected();}return h[stage](...args);}});
    },async unlink(file){if(fail&&String(file).includes('records.tmp-'))throw injected();return fs.unlink(file);}};
    const f=await openLocalFile(dir,io);
    try{
      const a=await f.port.add({id:'x',message:'original'});
      const before=await fs.readFile(path.join(dir,'records.json'),'utf8');fail=true;
      await assert.rejects(f.port.write({id:'x',message:'changed'},a.revision),safeFailure('UNAVAILABLE',
        stage==='close'?['TEMP_CLOSE_FAILED','TEMP_UNLINK_FAILED']:['TEMP_UNLINK_FAILED']));
      assert.equal(await fs.readFile(path.join(dir,'records.json'),'utf8'),before);
      assert.deepEqual(await f.port.read('x'),a);
    }finally{await f.close();}
  });
});
test('rename failure before replacement is conservative OUTCOME_UNKNOWN; old bytes remain',()=>temporary(async dir=>{
  let fail=false;
  const f=await openLocalFile(dir,{...fs,async rename(a,b){if(fail)throw injected();return fs.rename(a,b);}});
  try{
    const a=await f.port.add({id:'x',message:'original'});fail=true;
    const before=await fs.readFile(path.join(dir,'records.json'),'utf8');
    await assert.rejects(f.port.write({id:'x',message:'changed'},a.revision),safeFailure('OUTCOME_UNKNOWN'));
    assert.equal(await fs.readFile(path.join(dir,'records.json'),'utf8'),before);
  }finally{await f.close();}
}));
test('runtime read errors and normal close errors are sanitized without altering saved data',async()=>{
  for(const stage of ['read','close','unlink'])await temporary(async dir=>{
    let fail=false;
    const io={...fs,async readFile(...args){if(fail&&stage==='read')throw injected();return fs.readFile(...args);},
      async unlink(file){if(fail&&stage==='unlink'&&String(file).endsWith('owner.lock'))throw injected();return fs.unlink(file);},
      async open(file,flags){const h=await fs.open(file,flags);return String(file).endsWith('owner.lock')?wrapHandle(h,{async close(){await h.close();if(fail&&stage==='close')throw injected();}}):h;}};
    const f=await openLocalFile(dir,io);const added=await f.port.add({id:'x',message:'saved'});fail=true;
    if(stage==='read'){await assert.rejects(f.port.read('x'),safeFailure('UNAVAILABLE'));await f.close();}
    else {
      await assert.rejects(f.close(),safeFailure('UNAVAILABLE',[stage==='close'?'LOCK_CLOSE_FAILED':'LOCK_UNLINK_FAILED']));
      await assert.rejects(f.close(),safeFailure('UNAVAILABLE'));
    }
    const data=JSON.parse(await fs.readFile(path.join(dir,'records.json'),'utf8'));
    assert.deepEqual(data.rows,[added]);
  });
});
