'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawnSync,fork}=require('node:child_process');
const syncFs=require('node:fs');
const {CMemoryHistoryStore,CJob,CCheckJob}=require('../dist/src/prototype/workflow');
const {loadWorkflow,reconstructWorkflow,validatePrototypeDefinition}=require('../dist/src/prototype/definition');
const {LocalWorkflowDefinitionRepository}=require('../src/adapters/workflow-definition/local-file.cjs');
const {definition,registry}=require('./workflow-definition/fixture.cjs');
async function temporary(action){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arch026-definition-'));try{return await action(dir,new LocalWorkflowDefinitionRepository(dir));}finally{await fs.rm(dir,{recursive:true,force:true});}}
function child(mode,dir,version='v1'){
  const r=spawnSync(process.execPath,[path.join(__dirname,'workflow-definition/child.cjs'),mode,dir,version],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.error,undefined);assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
test('definition save/read uses strict serializable data and detached copies',()=>temporary(async(dir,repo)=>{
  const input=definition();const expected=structuredClone(input);await repo.add(input);input.steps[0].jobId='mutated';
  const loaded=await repo.get(expected.definitionId,'v1');assert.deepEqual(loaded,expected);loaded.steps[0].jobId='mutated';
  assert.deepEqual(await repo.get(expected.definitionId,'v1'),expected);
  const files=await fs.readdir(dir);assert.equal(files.filter(f=>f.endsWith('.json')).length,1);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,files[0]),'utf8')),expected);
}));
test('different processes save and reconstruct CWorkflow with Check FALSE/FALSE/TRUE',()=>temporary(async(dir)=>{
  assert.deepEqual(child('save',dir),{saved:true});const read=child('run',dir);
  assert.deepEqual(read.definition,definition());assert.equal(read.result.status,'COMPLETED');
  assert.deepEqual(read.result.history.map(x=>x.stepNo),[10,20,10,20,10,20,30]);
  assert.deepEqual(read.result.history.filter(x=>x.stepNo===20).map(x=>[x.result,x.nextStepNo]),[['FALSE',10],['FALSE',10],['TRUE',30]]);
}));
test('normal linear workflow and terminal JOB retain existing execution behavior',async()=>{
  const d=definition();d.steps=[{stepId:'start',stepNo:100,kind:'JOB',jobId:'sample.work',nextStepId:'finish'},{stepId:'finish',stepNo:7,kind:'JOB',jobId:'sample.finish'}];
  const actions=[];const r=reconstructWorkflow(d,registry([true],actions),new CMemoryHistoryStore());
  assert.equal(r.startStepNo,100);assert.equal((await r.workflow.run('linear',r.startStepNo)).status,'COMPLETED');assert.deepEqual(actions,['start','finish']);
});
test('Check TRUE directly selects its explicit target',async()=>{
  const r=reconstructWorkflow(definition(),registry([true]),new CMemoryHistoryStore());
  const result=await r.workflow.run('true',r.startStepNo);assert.deepEqual(result.history.map(x=>x.stepNo),[10,20,30]);
  assert.equal(result.history[1].result,'TRUE');assert.equal(result.history[1].nextStepNo,30);
});
test('unsupported Job and Check rejected before factory calls',()=>{
  for(const type of ['job','check']){
    const d=definition();if(type==='job')d.steps[2].jobId='unknown';else d.steps[1].checkId='unknown';
    let calls=0;const reg=registry();reg.jobs.set('sample.work',()=>{calls++;throw Error();});
    assert.throws(()=>reconstructWorkflow(d,reg,new CMemoryHistoryStore()),{code:type==='job'?'UNSUPPORTED_JOB':'UNSUPPORTED_CHECK'});assert.equal(calls,0);
  }
});
test('schema mismatch and GUI Check kinds explicitly rejected, never coerced',()=>temporary(async(dir,repo)=>{
  for(const schemaVersion of ['2',undefined]){const d=definition();d.schemaVersion=schemaVersion;await assert.rejects(repo.add(d),{code:'SCHEMA_MISMATCH'});}
  for(const kind of ['CHECK_FINAL','CHECK_PROVISIONAL','CHECK_WAIT']){const d=definition();d.steps[1].kind=kind;await assert.rejects(repo.add(d),{code:'UNSUPPORTED_STEP_KIND'});}
  const gui=require('../src/definitions/exam-workflow.example.json');await assert.rejects(repo.add(gui),{code:'SCHEMA_MISMATCH'});
}));
test('identity includes definition version; versions immutable and independently loadable',()=>temporary(async(dir,repo)=>{
  await repo.add(definition('v1'));const second=definition('v2');second.steps[0].stepNo=99;await repo.add(second);
  await assert.rejects(repo.add(second),{code:'DEFINITION_ALREADY_EXISTS'});
  assert.equal((await repo.get('saved-example','v1')).steps[0].stepNo,10);assert.equal((await repo.get('saved-example','v2')).steps[0].stepNo,99);
  assert.equal(child('run',dir,'v2').result.history[0].stepNo,99);assert.equal(await repo.get('saved-example','missing'),null);
  await assert.rejects(loadWorkflow(repo,'saved-example','missing',registry(),new CMemoryHistoryStore()),{code:'DEFINITION_NOT_FOUND'});
}));
test('composite identities do not collide and HelloWorld ID restrictions are not imposed',()=>temporary(async(dir,repo)=>{
  for(const [id,version]of [['a__b','c'],['a','b__c'],['workflow/example','version with spaces']]){const d=definition(version);d.definitionId=id;await repo.add(d);assert.deepEqual(await repo.get(id,version),d);}
}));
test('invalid topology, callbacks and Job instances are rejected before save',()=>temporary(async(dir,repo)=>{
  for(const change of [d=>{d.steps[0].callback=()=>{};},d=>{d.steps[0].job=new CJob('bad');},d=>{d.steps[1].stepNo=10;},d=>{d.steps[1].stepId='start';},d=>{d.steps[0].nextStepId='missing';},d=>{d.startStepId='missing';},d=>{d.steps=[];}]){
    const d=definition();change(d);await assert.rejects(repo.add(d),{code:'INVALID_DEFINITION'});
  }
  assert.deepEqual(await fs.readdir(dir),[]);
}));
test('corrupt, wrong schema and identity-mismatched stored files rejected without repair',()=>temporary(async(dir,repo)=>{
  await repo.add(definition());const file=path.join(dir,(await fs.readdir(dir)).find(f=>f.endsWith('.json')));
  for(const [text,code]of [['{','DATA_CORRUPT'],['null','DATA_CORRUPT'],[JSON.stringify({...definition(),schemaVersion:'other'}),'SCHEMA_MISMATCH'],[JSON.stringify({...definition(),definitionId:'other'}),'DEFINITION_IDENTITY_MISMATCH']]){
    await fs.writeFile(file,text);await assert.rejects(repo.get('saved-example','v1'),{code});assert.equal(await fs.readFile(file,'utf8'),text);
  }
}));
test('reconstruction creates fresh Check state and uses factory instances, not serialized code',async()=>{
  const reg=registry();
  for(const id of ['one','two']){const r=reconstructWorkflow(definition(),reg,new CMemoryHistoryStore());const result=await r.workflow.run(id,r.startStepNo);assert.equal(result.history.filter(x=>x.result==='FALSE').length,2);}
  const bad=registry();bad.jobs.set('sample.work',()=>new CCheckJob('wrong',{evaluate:()=>true},10,30));
  assert.throws(()=>reconstructWorkflow(definition(),bad,new CMemoryHistoryStore()),{code:'INVALID_JOB_FACTORY'});
  const wrong=registry();wrong.checks.set('sample.sequence',()=>({}));assert.throws(()=>reconstructWorkflow(definition(),wrong,new CMemoryHistoryStore()),{code:'INVALID_CHECK_FACTORY'});
});
test('case-sensitive IDs/Versions, separators and long identities have fixed safe filenames and cross-process reads',()=>temporary(async(dir,repo)=>{
  const identities=[['Case','v1'],['case','v1'],['Case','V1'],['a__b','c'],['a','b__c'],['../CON/..\\escape','V1'],['長いID'.repeat(500),'Version'.repeat(500)]];
  const names=[];
  for(const[id,version]of identities){
    const d=definition(version);d.definitionId=id;await repo.add(d);names.push(path.basename(repo.file(id,version)));
    const result=spawnSync(process.execPath,[path.join(__dirname,'workflow-definition/child.cjs'),'read',dir,version,id],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),d);
    assert.equal(path.dirname(repo.file(id,version)),dir);assert.match(names.at(-1),/^definition-[0-9a-f]{64}\.json$/);
  }
  assert.equal(new Set(names.map(name=>name.toLowerCase())).size,identities.length);assert.ok(names.every(name=>name.length===80));
}));
test('legacy filename format is rejected without moving, overwriting or migration',()=>temporary(async(dir,repo)=>{
  const d=definition(),legacy=path.join(dir,encodeURIComponent(JSON.stringify([d.definitionId,d.definitionVersion]))+'.json');
  const bytes=JSON.stringify(d);await fs.writeFile(legacy,bytes);
  assert.throws(()=>new LocalWorkflowDefinitionRepository(dir),{code:'LEGACY_DEFINITION_FORMAT'});
  await assert.rejects(repo.get(d.definitionId,d.definitionVersion),{code:'LEGACY_DEFINITION_FORMAT'});
  await assert.rejects(repo.add(d),{code:'LEGACY_DEFINITION_FORMAT'});
  assert.equal(await fs.readFile(legacy,'utf8'),bytes);assert.deepEqual(await fs.readdir(dir),[path.basename(legacy)]);
}));
async function assertCompletePublication(dir,repo){
  assert.deepEqual(await repo.get('saved-example','v1'),definition());
  const files=await fs.readdir(dir);assert.equal(files.length,1);assert.ok(files[0].endsWith('.json'));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,files[0]),'utf8')),definition());
}
test('same-process parallel Add publishes exactly one complete version',()=>temporary(async(dir,repo)=>{
  const results=await Promise.allSettled([repo.add(definition()),repo.add(definition())]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'DEFINITION_ALREADY_EXISTS');
  await assertCompletePublication(dir,repo);
}));
test('two processes start Add at a shared barrier; exactly one succeeds',()=>temporary(async(dir,repo)=>{
  const children=[0,1].map(()=>{
    const proc=fork(path.join(__dirname,'workflow-definition/child.cjs'),['race',dir],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    let readyResolve,readyReject,result;
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    const timer=setTimeout(()=>{readyReject(Error('race child timeout'));proc.kill();},10000);
    proc.on('message',message=>{if(message==='READY')readyResolve();else result=message;});
    const exit=new Promise((resolve,reject)=>{proc.on('error',reject);proc.on('exit',code=>{clearTimeout(timer);readyReject(Error('child exited before barrier'));code===0?resolve(result):reject(Error('race child failed'));});});
    return{proc,ready,exit};
  });
  try{
    await Promise.all(children.map(c=>c.ready));for(const c of children)c.proc.send('GO');
    assert.deepEqual((await Promise.all(children.map(c=>c.exit))).sort(),['ADDED','DEFINITION_ALREADY_EXISTS']);
    await assertCompletePublication(dir,repo);
  }finally{for(const c of children)if(c.proc.exitCode===null)c.proc.kill();await Promise.allSettled(children.map(c=>c.exit));}
}));
test('write/fsync/link failures never publish partial JSON or overwrite existing versions',async()=>{
  for(const[method,stage,ioCode]of [['writeFileSync','WRITE_TEMP','ENOSPC'],['fsyncSync','SYNC_TEMP','EIO'],['linkSync','PUBLISH','EIO'],['linkSync','PUBLISH','ENOTSUP']]){
    await temporary(async(dir,repo)=>{
      await repo.add(definition());const before=await fs.readFile(repo.file('saved-example','v1'),'utf8');
      const original=syncFs[method];syncFs[method]=()=>{const error=Error('injected');error.code=ioCode;throw error;};
      try{await assert.rejects(repo.add(definition('failed')),e=>e.code==='UNAVAILABLE'&&e.storageStage===stage);}
      finally{syncFs[method]=original;}
      assert.equal(await repo.get('saved-example','failed'),null);assert.equal(await fs.readFile(repo.file('saved-example','v1'),'utf8'),before);
      assert.deepEqual(await fs.readdir(dir),[path.basename(repo.file('saved-example','v1'))]);
    });
  }
});
test('cleanup failure preserves the primary classification and stage; committed Add remains successful',async()=>{
  for(const primary of ['write','duplicate','none'])await temporary(async(dir,repo)=>{
    if(primary==='duplicate')await repo.add(definition());
    const write=syncFs.writeFileSync,unlink=syncFs.unlinkSync;
    syncFs.unlinkSync=()=>{const e=Error('cleanup');e.code='EPERM';throw e;};
    if(primary==='write')syncFs.writeFileSync=()=>{const e=Error('primary');e.code='ENOSPC';throw e;};
    try{
      if(primary==='none')await repo.add(definition());
      else await assert.rejects(repo.add(definition()),e=>
        e.code===(primary==='write'?'UNAVAILABLE':'DEFINITION_ALREADY_EXISTS')&&
        e.storageStage===(primary==='write'?'WRITE_TEMP':'PUBLISH')&&
        JSON.stringify(e.cleanupDiagnostics)==='["TEMP_UNLINK_FAILED"]');
    }finally{syncFs.writeFileSync=write;syncFs.unlinkSync=unlink;}
    assert.equal((await fs.readdir(dir)).filter(f=>f.includes('.tmp-')).length,1);
    if(primary==='write')assert.equal(await repo.get('saved-example','v1'),null);
    else assert.deepEqual(await repo.get('saved-example','v1'),definition());
    if(primary==='none')assert.deepEqual(repo.diagnostics,['TEMP_UNLINK_FAILED']);
  });
});
test('GUI save/overwrite/read/list/delete work without hard link support',()=>temporary(async dir=>{
  const {DefinitionStore}=require('../gui/workflow-definitions.js');const sample=require('../src/definitions/exam-workflow.example.json');
  const store=new DefinitionStore(dir);const link=syncFs.linkSync;let links=0;
  syncFs.linkSync=()=>{links++;const e=Error('not supported');e.code='ENOTSUP';throw e;};
  try{
    store.save(sample);assert.deepEqual(store.get(sample.id,sample.version),sample);assert.equal(store.list().length,1);
    assert.throws(()=>store.save(sample),{status:409});const changed=structuredClone(sample);changed.title='edited draft';
    store.save(changed,{overwrite:true});assert.deepEqual(store.get(sample.id,sample.version),changed);
    assert.equal(store.remove(sample.id,sample.version),true);assert.equal(store.get(sample.id,sample.version),null);assert.deepEqual(store.list(),[]);assert.equal(links,0);
  }finally{syncFs.linkSync=link;}
}));
