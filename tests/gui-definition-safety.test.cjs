'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process');
const {DefinitionStore}=require('../gui/workflow-definitions.js');
const def=(id='draft',version='v1',title='original')=>({id,version,title,startStepId:'E',eventRoutes:[],steps:[{id:'E',type:'END'}]});
async function temporary(action){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-gui-safe-'));
  try{await action(dir,new DefinitionStore(dir));}
  finally{
    if(path.dirname(path.resolve(dir))!==path.resolve(os.tmpdir())||!path.basename(dir).startsWith('arch026-gui-safe-'))throw Error('unsafe test cleanup');
    fs.rmSync(dir,{recursive:true,force:true});
  }
}
function clean(dir){assert.equal(fs.readdirSync(dir).some(f=>f.includes('.tmp-')||f==='.definition-write.lock'),false);}
function child(dir,d,overwrite=false,hold=false){
  const proc=fork(path.join(__dirname,'gui-definition-safety/child.cjs'),[dir,d.id,d.version,String(overwrite),hold?'hold':'normal'],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  let readyResolve,readyReject,lockedResolve,lockedReject,value;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const locked=new Promise((resolve,reject)=>{lockedResolve=resolve;lockedReject=reject;});locked.catch(()=>{});
  const timer=setTimeout(()=>{readyReject(Error('child timeout'));lockedReject(Error('child timeout'));proc.kill();},15000);
  proc.on('message',m=>{if(m.type==='READY')readyResolve();else if(m.type==='LOCKED')lockedResolve();else if(m.type==='RESULT')value=m;});
  const done=new Promise((resolve,reject)=>{proc.on('error',reject);proc.on('exit',code=>{clearTimeout(timer);readyReject(Error('early exit'));lockedReject(Error('early exit'));code===0?resolve(value):reject(Error('child failed'));});});
  return {proc,ready,locked,done};
}
async function finish(children){children.forEach(c=>{if(c.proc.exitCode===null)c.proc.kill();});await Promise.allSettled(children.map(c=>c.done));}
test('normal GUI save/list/read/explicit overwrite/delete retain existing JSON format',()=>temporary(async(dir,store)=>{
  const original=def();assert.deepEqual(store.save(original),original);assert.deepEqual(store.get('draft','v1'),original);assert.equal(store.list().length,1);
  assert.equal(path.basename(store.file('draft','v1')),'draft__v1.json');assert.deepEqual(JSON.parse(fs.readFileSync(store.file('draft','v1'),'utf8')),original);
  assert.throws(()=>store.save(original),{code:'DEFINITION_ALREADY_EXISTS',status:409});
  assert.throws(()=>store.save(def('draft','v1','edited')),{code:'DEFINITION_ALREADY_EXISTS',status:409});
  store.save(def('draft','v1','edited'),{overwrite:true});assert.equal(store.get('draft','v1').title,'edited');
  store.save(def('draft','v2'));assert.equal(store.list().length,2);assert.equal(store.remove('draft','v1'),true);assert.equal(store.get('draft','v1'),null);assert.equal(store.remove('draft','v1'),false);clean(dir);
}));
test('P0 reproduction: separator collisions cannot overwrite, read or delete another definition',()=>temporary(async(dir,store)=>{
  const first=def('a__b','c'),other=def('a','b__c');assert.equal(store.file(first.id,first.version),store.file(other.id,other.version));
  store.save(first);const file=store.file(first.id,first.version),before=fs.readFileSync(file);
  for(const overwrite of [false,true])assert.throws(()=>store.save(other,{overwrite}),{code:'DEFINITION_STORAGE_COLLISION',status:409});
  assert.throws(()=>store.get(other.id,other.version),{code:'DEFINITION_STORAGE_COLLISION'});
  assert.throws(()=>store.remove(other.id,other.version),{code:'DEFINITION_STORAGE_COLLISION'});
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(store.get(first.id,first.version),first);clean(dir);
}));
test('case-insensitive path aliases are refused by content identity even with overwrite',()=>temporary(async(dir,store)=>{
  const file=store.file.bind(store);store.file=(id,v)=>path.join(dir,path.basename(file(id,v)).toLowerCase());
  store.save(def('Case','V1'));const before=fs.readFileSync(store.file('Case','V1'));
  for(const [id,v]of [['case','V1'],['Case','v1']]){
    assert.throws(()=>store.save(def(id,v),{overwrite:true}),{code:'DEFINITION_STORAGE_COLLISION'});
    assert.throws(()=>store.remove(id,v),{code:'DEFINITION_STORAGE_COLLISION'});
  }
  assert.deepEqual(fs.readFileSync(store.file('Case','V1')),before);clean(dir);
}));
test('unreadable JSON and missing identity are preserved rather than overwritten or deleted',()=>temporary(async(dir,store)=>{
  const file=store.file('draft','v1');
  for(const bytes of ['{','null','[]','{}',JSON.stringify({id:'draft'})]){
    fs.writeFileSync(file,bytes);
    for(const action of [()=>store.get('draft','v1'),()=>store.save(def(),{overwrite:true}),()=>store.remove('draft','v1')])assert.throws(action,{code:'DEFINITION_DATA_CORRUPT'});
    assert.equal(fs.readFileSync(file,'utf8'),bytes);clean(dir);
  }
}));
test('same-process simultaneous requests cannot implicitly replace an existing draft',()=>temporary(async(dir,store)=>{
  const results=await Promise.allSettled([Promise.resolve().then(()=>store.save(def('draft','v1','first'))),Promise.resolve().then(()=>store.save(def('draft','v1','second')))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'DEFINITION_ALREADY_EXISTS');assert.equal(store.get('draft','v1').title,'first');clean(dir);
}));
test('separate processes race on same identity or colliding identities: only one save succeeds',()=>temporary(async(dir)=>{
  for(const collision of [false,true]){
    const sub=path.join(dir,collision?'collision':'duplicate');fs.mkdirSync(sub);const first=collision?def('a__b','c'):def(),second=collision?def('a','b__c'):def();
    const children=[child(sub,first),child(sub,second,collision)];
    try{
      await Promise.all(children.map(c=>c.ready));children.forEach(c=>c.proc.send('GO'));const results=await Promise.all(children.map(c=>c.done));
      assert.equal(results.filter(x=>x.code==='SAVED').length,1);
      assert.ok(['DEFINITION_STORE_BUSY','DEFINITION_ALREADY_EXISTS','DEFINITION_STORAGE_COLLISION'].includes(results.find(x=>x.code!=='SAVED').code));
      const files=fs.readdirSync(sub);assert.equal(files.length,1);const stored=JSON.parse(fs.readFileSync(path.join(sub,files[0]),'utf8'));const winner=results[0].code==='SAVED'?first:second;
      assert.equal(stored.id,winner.id);assert.equal(stored.version,winner.version);clean(sub);
    }finally{await finish(children);}
  }
}));
test('overlapping second-process overwrite is refused while first publication holds the lock',()=>temporary(async(dir)=>{
  const first=def('a__b','c'),other=def('a','b__c'),children=[child(dir,first,false,true),child(dir,other,true)];
  try{
    await Promise.all(children.map(c=>c.ready));children[0].proc.send('GO');await children[0].locked;
    children[1].proc.send('GO');assert.equal((await children[1].done).code,'DEFINITION_STORE_BUSY');
    fs.writeFileSync(path.join(dir,'release-save'),'release');assert.equal((await children[0].done).code,'SAVED');
    const store=new DefinitionStore(dir);assert.throws(()=>store.save(other,{overwrite:true}),{code:'DEFINITION_STORAGE_COLLISION'});assert.equal(store.get(first.id,first.version).id,first.id);clean(dir);
  }finally{fs.writeFileSync(path.join(dir,'release-save'),'release');await finish(children);}
}));
test('write/fsync/close/rename failures preserve prior bytes and release lock',()=>temporary(async(dir,store)=>{
  store.save(def());const before=fs.readFileSync(store.file('draft','v1'));
  for(const method of ['writeFileSync','fsyncSync','closeSync','renameSync']){
    const native=fs[method];let once=false;
    fs[method]=(...args)=>{if(!once){once=true;throw Object.assign(Error('private OS path'),{code:'EIO'});}return native(...args);};
    try{assert.throws(()=>store.save(def('draft','v1','edited'),{overwrite:true}),e=>e.code===(method==='renameSync'?'OUTCOME_UNKNOWN':'DEFINITION_STORE_UNAVAILABLE')&&!e.message.includes('private'));}
    finally{fs[method]=native;}
    assert.deepEqual(fs.readFileSync(store.file('draft','v1')),before);clean(dir);
  }
}));
test('failed new save never publishes incomplete JSON',()=>temporary(async(dir,store)=>{
  const write=fs.writeFileSync;
  fs.writeFileSync=(...args)=>{write(args[0],'{','utf8');throw Object.assign(Error('full'),{code:'ENOSPC'});};
  try{assert.throws(()=>store.save(def()),{code:'DEFINITION_STORE_UNAVAILABLE'});}finally{fs.writeFileSync=write;}
  assert.equal(store.get('draft','v1'),null);assert.deepEqual(fs.readdirSync(dir),[]);
}));
test('lock cleanup failure retains primary error; committed save remains successful',()=>temporary(async(dir,store)=>{
  const write=fs.writeFileSync,remove=fs.rmdirSync,lock=path.join(dir,'.definition-write.lock');
  fs.writeFileSync=()=>{throw Object.assign(Error('primary'),{code:'ENOSPC'});};fs.rmdirSync=()=>{throw Error('cleanup');};
  try{assert.throws(()=>store.save(def()),e=>e.code==='DEFINITION_STORE_UNAVAILABLE'&&e.cleanupDiagnostics.includes('LOCK_RELEASE_FAILED'));}
  finally{fs.writeFileSync=write;fs.rmdirSync=remove;}
  assert.equal(store.get('draft','v1'),null);assert.throws(()=>store.save(def()),{code:'DEFINITION_STORE_BUSY'});remove(lock);
  fs.rmdirSync=()=>{throw Error('cleanup');};
  try{assert.deepEqual(store.save(def()),def());}finally{fs.rmdirSync=remove;}
  assert.deepEqual(store.get('draft','v1'),def());assert.ok(store.diagnostics.includes('LOCK_RELEASE_FAILED'));remove(lock);clean(dir);
}));
test('temporary-file cleanup faults preserve primary error and never publish failed data',()=>temporary(async(dir,store)=>{
  store.save(def());const before=fs.readFileSync(store.file('draft','v1')),write=fs.writeFileSync,unlink=fs.unlinkSync;
  fs.writeFileSync=()=>{throw Error('private primary');};fs.unlinkSync=()=>{throw Error('private cleanup');};
  try{assert.throws(()=>store.save(def('draft','v1','edited'),{overwrite:true}),e=>e.code==='DEFINITION_STORE_UNAVAILABLE'&&e.cleanupDiagnostics.includes('TEMP_UNLINK_FAILED'));}
  finally{fs.writeFileSync=write;fs.unlinkSync=unlink;}
  assert.deepEqual(fs.readFileSync(store.file('draft','v1')),before);assert.equal(fs.existsSync(path.join(dir,'.definition-write.lock')),false);
}));
test('publication response loss is unknown, complete same-identity data is retained',()=>temporary(async(dir,store)=>{
  store.save(def());const rename=fs.renameSync;
  fs.renameSync=(...args)=>{rename(...args);throw Error('response lost');};
  try{assert.throws(()=>store.save(def('draft','v1','edited'),{overwrite:true}),{code:'OUTCOME_UNKNOWN'});}finally{fs.renameSync=rename;}
  assert.equal(store.get('draft','v1').title,'edited');clean(dir);
}));
