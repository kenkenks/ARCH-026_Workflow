'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {reconstructWorkflow}=require('../dist/src/prototype/definition');
const {CDummyJob}=require('../dist/src/prototype/workflow');
const {createMemoryProductShelf}=require('../dist/src/prototype/job-form');
const {SCHEMA,SimpleDB,SimpleDBError,SQLiteJobRunStore}=require('../src/adapters/job-execution/simpledb.cjs');
const {SCHEMA:OLD_SCHEMA}=require('../src/adapters/workflow-history/simpledb.cjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const form=Object.freeze({name:'work',collect:r=>({value:r.get('INPUT'),failAt:r.get('FAIL_AT')}),make:x=>{if(x.failAt===x.value)throw Error('make failed');return x.value;}});
function definition(limit){return {schemaVersion:'prototype-workflow/1',definitionId:'014',definitionVersion:'1',startStepId:'work',steps:[{stepId:'work',stepNo:10,kind:'JOB',jobId:'shared',...(limit>1?{nextStepId:'check'}:{})},...(limit>1?[{stepId:'check',stepNo:20,kind:'CHECK_BOOL',checkId:'more',trueStepId:'end',falseStepId:'work'},{stepId:'end',stepNo:30,kind:'JOB',jobId:'finish'}]:[])]};}
async function fixture(run){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-exp014-')),file=path.join(dir,'jobs.sqlite'),connections=[];SimpleDB.initialize(file,SCHEMA);
 function open(){const db=SimpleDB.open(file,SCHEMA);connections.push(db);return db;}
 try{await run({file,dir,open,database:open()});}finally{for(const db of connections.reverse())db.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});}}
function setup(f,{id='run',limit=1,definitionForm=form,memory=createMemoryProductShelf(),products,outputKey='X',failAt=null}={}){
 memory.put('FAIL_AT',failAt);const store=new SQLiteJobRunStore(f.database,'014','1',id,memory),jobs=[];let visits=0;
 const loaded=reconstructWorkflow(definition(limit),{jobs:new Map([['finish',()=>new CDummyJob('END')]]),checks:new Map([['more',()=>({evaluate:()=>visits>=limit})]]),jobForms:{definitions:new Map([['shared',{form:definitionForm,artifactKey:()=>{visits++;memory.put('INPUT',visits*10);return outputKey;}}]]),products:products?products(store):store.products,onCreate:(job,context)=>{jobs.push(job);store.onCreate(job,context);}}},store);
 return {store,jobs,memory,workflow:loaded.workflow,start:loaded.startStepNo,id};
}
function reader(f,id){return new SQLiteJobRunStore(f.open(),'014','1',id);}
function artifacts(run,kind){return run.jobArtifacts.filter(a=>a.kind===kind);}
test('A/D/F three visits share form but get stable UUIDs, internal/public records and current X=30 after close',()=>fixture(async f=>{
 const r=setup(f,{id:'three',limit:3}),result=await r.workflow.run(r.id,r.start);assert.equal(result.status,'COMPLETED');assert.equal(r.jobs.length,3);assert.ok(r.jobs.every(j=>j.form===form));const ids=r.jobs.map(j=>r.store.getIdentity(j).jobExecutionId);assert.equal(new Set(ids).size,3);assert.ok(ids.every(x=>/^[0-9a-f-]{36}$/.test(x)));
 f.database.close();const other=reader(f,r.id),saved=other.readRun();assert.deepEqual(saved.snapshot,result);assert.deepEqual(saved.jobExecutions.map(j=>j.jobExecutionId),ids);assert.deepEqual(saved.jobExecutions.map(j=>j.iterationNo),[1,2,3]);assert.ok(saved.jobExecutions.every(j=>j.stepNo===10&&j.jobFormId==='shared'&&j.status==='COMPLETED'&&j.phase==='post'));
 assert.deepEqual(artifacts(saved,'INTERNAL').map(a=>a.value),[10,20,30]);assert.deepEqual(artifacts(saved,'PUBLISHED').map(a=>a.value),[10,20,30]);assert.ok(saved.jobArtifacts.every(a=>ids.includes(a.jobExecutionId)));assert.deepEqual(other.currentProducts().map(x=>[x.artifactKey,x.value]),[['X',30]]);
 assert.deepEqual(saved.snapshot.history.map(h=>h.stepNo),[10,20,10,20,10,20,30]);
}));
test('B READY and RUNNING collect/make/record observations use existing Job getters only',()=>fixture(async f=>{
 const enter={collect:deferred(),make:deferred(),record:deferred()},release={collect:deferred(),make:deferred(),record:deferred()};
 const shared={name:'observed',collect:async()=>{enter.collect.resolve();await release.collect.promise;return 10;},make:async x=>{enter.make.resolve();await release.make.promise;return x;},record:async()=>{enter.record.resolve();await release.record.promise;}};
 const r=setup(f,{id:'states',definitionForm:shared});const original=r.store.onCreate;r.store.onCreate=(job,ctx)=>{original(job,ctx);assert.equal(reader(f,r.id).readRun().jobExecutions[0].status,'READY');};
 const running=r.workflow.run(r.id,r.start);
 for(const phase of ['collect','make','record']){await enter[phase].promise;r.store.checkpoint();const saved=reader(f,r.id).readRun();assert.equal(saved.jobExecutions[0].status,'RUNNING');assert.equal(saved.jobExecutions[0].phase,phase);assert.deepEqual(artifacts(saved,'INTERNAL'),[]);release[phase].resolve();}
 assert.equal((await running).status,'COMPLETED');
}));
test('C internal record is persisted BEFORE memory publication and readable from another connection',()=>fixture(async f=>{
 const raw=createMemoryProductShelf(),entered=deferred(),release=deferred(),memory={has:k=>raw.has(k),get:k=>raw.get(k),put:async(k,v)=>{if(k==='X'){entered.resolve();await release.promise;}raw.put(k,v);}};
 const r=setup(f,{id:'boundary',memory}),running=r.workflow.run(r.id,r.start);await entered.promise;
 const saved=reader(f,r.id).readRun();assert.equal(saved.snapshot.status,'RUNNING');assert.equal(saved.jobExecutions[0].phase,'post');assert.equal(saved.jobExecutions[0].status,'RUNNING');assert.deepEqual(artifacts(saved,'INTERNAL').map(a=>a.value),[10]);assert.deepEqual(artifacts(saved,'PUBLISHED'),[]);assert.equal(raw.has('X'),false);
 release.resolve();await running;f.database.close();const after=reader(f,r.id).readRun();assert.deepEqual(artifacts(after,'PUBLISHED').map(a=>a.value),[10]);assert.equal(after.jobExecutions[0].status,'COMPLETED');
}));
for(const phase of ['collect','make','record','post'])test(`B/E ${phase} failure, stored Job FAILED differs from Workflow snapshot`,()=>fixture(async f=>{
 const root=Error(phase+' failed'),shared={name:'failed',collect:()=>{if(phase==='collect')throw root;return 10;},make:x=>{if(phase==='make')throw root;return x;},record:()=>{if(phase==='record')throw root;}},raw=createMemoryProductShelf(),memory={has:k=>raw.has(k),get:k=>raw.get(k),put:(k,v)=>{if(k==='X'&&phase==='post')throw root;raw.put(k,v);}};
 const r=setup(f,{id:phase,definitionForm:shared,memory}),result=await r.workflow.run(r.id,r.start);assert.equal(result.status,'FAILED');f.database.close();const saved=reader(f,r.id).readRun();assert.equal(saved.snapshot.history[0].result,'ERROR');assert.equal(saved.jobExecutions[0].status,'FAILED');assert.equal(saved.jobExecutions[0].phase,phase);assert.deepEqual(artifacts(saved,'INTERNAL').map(a=>a.value),phase==='post'?[10]:[]);assert.deepEqual(artifacts(saved,'PUBLISHED'),[]);
}));
test('E business FAIL stays data, Job and Workflow COMPLETED',()=>fixture(async f=>{
 const value={memberId:'M002',result:'FAIL',score:45},r=setup(f,{id:'business',definitionForm:{name:'business',collect:()=>value,make:x=>x}});await r.workflow.run(r.id,r.start);f.database.close();const saved=reader(f,r.id).readRun();assert.equal(saved.snapshot.status,'COMPLETED');assert.equal(saved.jobExecutions[0].status,'COMPLETED');assert.deepEqual(artifacts(saved,'PUBLISHED')[0].value,value);
}));
test('E LIMIT_REACHED is Workflow-only; finished Jobs remain COMPLETED and unvisited Jobs do not exist',()=>fixture(async f=>{
 const r=setup(f,{id:'limit',limit:10}),result=await r.workflow.run(r.id,r.start,3);assert.equal(result.status,'LIMIT_REACHED');f.database.close();const saved=reader(f,r.id).readRun();assert.equal(saved.jobExecutions.length,2);assert.ok(saved.jobExecutions.every(j=>j.status==='COMPLETED'));assert.deepEqual(artifacts(saved,'PUBLISHED').map(a=>a.value),[10,20]);
}));
test('E publication then throw: failed Job keeps public value, evidence is observation not operation success',()=>fixture(async f=>{
 const raw=createMemoryProductShelf(),memory={has:k=>raw.has(k),get:k=>raw.get(k),put:(k,v)=>{raw.put(k,v);if(k==='X')throw Error('after-publication');}};
 const r=setup(f,{id:'after',memory});assert.equal((await r.workflow.run(r.id,r.start)).status,'FAILED');f.database.close();const saved=reader(f,r.id).readRun();assert.equal(saved.jobExecutions[0].status,'FAILED');assert.deepEqual(artifacts(saved,'INTERNAL').map(a=>a.value),[10]);assert.deepEqual(artifacts(saved,'PUBLISHED').map(a=>[a.value,a.publicationEvidence]),[[10,'OBSERVED_AFTER_ERROR']]);
}));
test('E partial post persists X/Y, not Z, and the full internal bundle',()=>fixture(async f=>{
 const value={X:10,Y:20,Z:30},r=setup(f,{id:'partial',outputKey:'bundle',definitionForm:{name:'bundle',collect:()=>value,make:x=>x},products:store=>({has:k=>store.products.has(k),get:k=>store.products.get(k),put:async(k,bundle)=>{await store.products.put('X',bundle.X);await store.products.put('Y',bundle.Y);throw Error('Z failed');}})});
 assert.equal((await r.workflow.run(r.id,r.start)).status,'FAILED');f.database.close();const saved=reader(f,r.id).readRun();assert.deepEqual(artifacts(saved,'INTERNAL').map(a=>a.value),[value]);assert.deepEqual(artifacts(saved,'PUBLISHED').map(a=>[a.artifactKey,a.value]),[['X',10],['Y',20]]);assert.equal(saved.jobExecutions[0].status,'FAILED');
}));
for(const order of ['success-first','failure-first'])test(`A/F independent runs/UUIDs and artifact keys, ${order}`,()=>fixture(async f=>{
 const aEntered=deferred(),bEntered=deferred(),aRelease=deferred(),bRelease=deferred();
 function memory(entered,release){const raw=createMemoryProductShelf();let first=true;return {has:k=>raw.has(k),get:k=>raw.get(k),put:async(k,v)=>{if(k==='X'&&first){first=false;entered.resolve();await release.promise;}raw.put(k,v);}};}
 const a=setup(f,{id:'one',memory:memory(aEntered,aRelease)}),secondDB=f.open(),b=setup({...f,database:secondDB},{id:'bad',limit:3,failAt:20,memory:memory(bEntered,bRelease)});
 const pa=a.workflow.run(a.id,a.start),pb=b.workflow.run(b.id,b.start);await Promise.all([aEntered.promise,bEntered.promise]);
 if(order==='success-first'){aRelease.resolve();await pa;assert.equal(reader(f,b.id).readRun().snapshot.status,'RUNNING');bRelease.resolve();}else{bRelease.resolve();await pb;assert.equal(reader(f,a.id).readRun().snapshot.status,'RUNNING');aRelease.resolve();}
 assert.equal((await pa).status,'COMPLETED');assert.equal((await pb).status,'FAILED');f.database.close();secondDB.close();const one=reader(f,a.id).readRun(),bad=reader(f,b.id).readRun();assert.equal(one.snapshot.status,'COMPLETED');assert.equal(bad.snapshot.status,'FAILED');assert.equal(one.jobExecutions.length,1);assert.equal(bad.jobExecutions.length,2);assert.equal(new Set([...one.jobExecutions,...bad.jobExecutions].map(j=>j.jobExecutionId)).size,3);assert.equal(bad.jobExecutions[1].phase,'make');assert.equal(bad.jobExecutions[1].status,'FAILED');assert.ok(one.jobArtifacts.every(x=>x.value===10));
}));
for(const operation of ['job-execution','internal-artifact','published-artifact','workflow-history'])test(`G ${operation} write failure rolls back, blocks retry and preserves other run`,()=>fixture(async f=>{
 const good=setup(f,{id:'good'});await good.workflow.run(good.id,good.start);const before=reader(f,'good').readRun();const bad=setup(f,{id:'bad'});const original=f.database.run.bind(f.database);let faults=0;
 f.database.run=(sql,...params)=>{
  const hit=operation==='job-execution'?sql.startsWith('INSERT INTO job_executions'):operation==='workflow-history'?sql.startsWith('INSERT INTO workflow_history'):sql.startsWith('INSERT INTO job_artifacts')&&params[2]===(operation==='internal-artifact'?'INTERNAL':'PUBLISHED');
  if(hit){faults++;throw new SimpleDBError('UNAVAILABLE');}return original(sql,...params);
 };
 try{await assert.rejects(bad.workflow.run(bad.id,bad.start),e=>{assert.equal(e.code,'HISTORY_SAVE_OUTCOME_UNKNOWN');assert.ok(e.attemptedSnapshot);return true;});assert.equal(faults,1);assert.ok(bad.store.getPersistenceFailure());assert.throws(()=>bad.store.checkpoint());assert.equal(faults,1);}finally{f.database.run=original;}
 const saved=reader(f,'bad').readRun();assert.equal(saved.snapshot.status,'RUNNING');assert.deepEqual(saved.snapshot.history,[]);assert.deepEqual(reader(f,'good').readRun(),before);
 if(operation==='job-execution'){assert.deepEqual(saved.jobExecutions,[]);assert.deepEqual(saved.jobArtifacts,[]);assert.equal(bad.memory.has('X'),false);}
 if(operation==='internal-artifact'){assert.equal(saved.jobExecutions[0].status,'READY');assert.deepEqual(saved.jobArtifacts,[]);assert.equal(bad.memory.has('X'),false);}
 if(operation==='published-artifact'){assert.deepEqual(artifacts(saved,'INTERNAL').map(a=>a.value),[10]);assert.deepEqual(artifacts(saved,'PUBLISHED'),[]);assert.equal(saved.jobExecutions[0].status,'RUNNING');assert.equal(bad.memory.get('X'),10);}
 if(operation==='workflow-history'){assert.equal(saved.jobExecutions[0].status,'RUNNING');assert.deepEqual(artifacts(saved,'PUBLISHED').map(a=>a.value),[10]);assert.equal(bad.jobs[0].getState().status,'COMPLETED');}
}));
test('G real query_only storage failure is detected and no execution artifacts are claimed',()=>fixture(async f=>{
 const r=setup(f,{id:'readonly'});f.database.connection.exec('PRAGMA query_only=ON');await assert.rejects(r.workflow.run(r.id,r.start),e=>e.code==='HISTORY_SAVE_OUTCOME_UNKNOWN');assert.equal(reader(f,r.id).readRun(),undefined);assert.equal(r.jobs.length,0);
}));
test('v1 history DB requires explicit migration; opening with v2 never changes it',()=>fixture(async f=>{
 const old=path.join(f.dir,'old.sqlite');SimpleDB.initialize(old,OLD_SCHEMA);const bytes=fs.readFileSync(old);assert.throws(()=>SimpleDB.open(old,SCHEMA),e=>e.code==='MIGRATION_REQUIRED');assert.deepEqual(fs.readFileSync(old),bytes);
}));
test('unsupported artifact serialization is rejected instead of silently changing data',()=>fixture(async f=>{
 const r=setup(f,{id:'unsupported',definitionForm:{name:'unsupported',collect:()=>NaN,make:x=>x}});await assert.rejects(r.workflow.run(r.id,r.start),e=>e.code==='HISTORY_SAVE_OUTCOME_UNKNOWN');assert.equal(r.store.getPersistenceFailure().code,'UNSUPPORTED_ARTIFACT');assert.equal(r.memory.has('X'),false);assert.deepEqual(reader(f,r.id).readRun().jobArtifacts,[]);
}));
test('same-value throwing post does not falsely attribute an unchanged public value to the failed Job',()=>fixture(async f=>{
 const raw=createMemoryProductShelf();let publications=0;
 const memory={has:k=>raw.has(k),get:k=>raw.get(k),put:(k,v)=>{raw.put(k,v);if(k==='X'&&++publications===2)throw Error('same-value publication uncertain');}};
 const r=setup(f,{id:'same-value',limit:2,memory,definitionForm:{name:'constant',collect:()=>10,make:x=>x}});assert.equal((await r.workflow.run(r.id,r.start)).status,'FAILED');f.database.close();
 const other=reader(f,r.id),saved=other.readRun();assert.equal(saved.jobExecutions.length,2);assert.deepEqual(artifacts(saved,'INTERNAL').map(a=>a.value),[10,10]);assert.equal(artifacts(saved,'PUBLISHED').length,1);assert.equal(other.currentProducts()[0].jobExecutionId,saved.jobExecutions[0].jobExecutionId);assert.equal(other.currentProducts()[0].value,10);
}));
