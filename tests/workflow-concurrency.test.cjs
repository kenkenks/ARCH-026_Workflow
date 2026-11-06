'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WorkflowRuntime}=require('../gui/workflow-runtime');
const {CWorkflow,CJob,CDummyJob,CCheckJob,CSequenceBool,CMemoryHistoryStore}=require('../dist/src/prototype/workflow');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
const def={id:'concurrency',version:'1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId:'job',nextStepId:'END'},{id:'END',type:'END'}]};
function blockedWorkflow(store=new CMemoryHistoryStore()){
 const gate=deferred(),entered=deferred();let calls=0;
 class Job extends CJob{async execute(){calls++;entered.resolve();await gate.promise;}}
 return {store,gate,entered,get calls(){return calls;},workflow:new CWorkflow([{no:1,job:new Job('blocked')}],store)};
}

for(const outcome of ['COMPLETED','WAITING','FAILED','THROW'])test(`Runtime single flight: ${outcome}, duplicate calls leave state/history untouched`,async()=>{
 const gate=deferred();let calls=0;
 const r=new WorkflowRuntime(def,{job:async()=>{calls++;if(calls>1)return {status:'COMPLETED'};await gate.promise;if(outcome==='THROW')throw Error('handler fault');return {status:outcome};}});
 const first=r.advance();const before=r.snapshot();
 for(let i=0;i<2;i++)await assert.rejects(r.advance(),{code:'RUNTIME_BUSY',status:409});
 assert.equal(calls,1);assert.deepEqual(r.snapshot(),before);
 const done=outcome==='THROW'?assert.rejects(first,/handler fault/):first;
 gate.resolve();await done;
 if(outcome==='WAITING'){
  assert.equal(r.status,'WAITING');assert.equal(r.history.length,0);
  await r.advance();assert.equal(calls,2);await r.advance();assert.equal(r.status,'COMPLETED');
 }else if(outcome==='COMPLETED'){
  await r.advance();assert.equal(r.status,'COMPLETED');assert.deepEqual(r.history.map(x=>x.stepId),['J','END']);
 }else{
  assert.equal(r.status,'FAILED');assert.equal(r.history.length,1);assert.equal(r.history[0].result,outcome==='THROW'?'ERROR':'FAILED');
 }
 // A rejected duplicate cannot later return success/WAITING and overwrite a terminal state.
 const terminal=r.snapshot();await assert.rejects(r.advance(),/終了/);assert.deepEqual(r.snapshot(),terminal);assert.equal(r.advancing,false);
});

test('Runtime validation exception releases guard and permits corrected Check input',async()=>{
 const d={...def,startStepId:'C',steps:[{id:'C',type:'CHECK_FINAL',nextStepId:'END'},{id:'END',type:'END'}]};
 const r=new WorkflowRuntime(d);await assert.rejects(r.advance({checkResult:'INVALID'}),/不正/);await r.advance({checkResult:'PASS'});await r.advance();assert.equal(r.status,'COMPLETED');
});

test('independent Runtime objects run concurrently without sharing state',async()=>{
 const a=deferred(),b=deferred();let calls=0;
 const r1=new WorkflowRuntime(def,{job:async()=>{calls++;await a.promise;return {status:'COMPLETED'};}}),r2=new WorkflowRuntime(def,{job:async()=>{calls++;await b.promise;return {status:'COMPLETED'};}});
 const p=r1.advance(),q=r2.advance();assert.equal(calls,2);b.resolve();await q;assert.equal(r1.history.length,0);a.resolve();await p;await r1.advance();await r2.advance();assert.equal(r1.status,'COMPLETED');assert.equal(r2.status,'COMPLETED');
});

test('CWorkflow same-object same Store/runId reservation precedes first await',async()=>{
 const x=blockedWorkflow();const p=x.workflow.run('one',1);
 // No wait for load/save: this is the previously vulnerable start interval.
 await assert.rejects(x.workflow.run('one',1),{code:'RUN_BUSY'});
 await x.entered.promise;assert.equal(x.calls,1);assert.equal(x.store.load('one').history.length,0);
 x.gate.resolve();await p;assert.equal(x.store.load('one').history.length,1);await assert.rejects(x.workflow.run('one',1),/already exists/);
});

test('different CWorkflow objects reserve the same Store/runId before load',async()=>{
 const a=blockedWorkflow(),b=blockedWorkflow(a.store);const p=a.workflow.run('shared',1);
 await assert.rejects(b.workflow.run('shared',1),{code:'RUN_BUSY'});assert.equal(b.calls,0);
 await a.entered.promise;a.gate.resolve();await p;
 await assert.rejects(b.workflow.run('shared',1),/already exists/);assert.equal(a.store.load('shared').history.length,1);
});

test('same CWorkflow different runIds is explicitly rejected, then may run sequentially',async()=>{
 const x=blockedWorkflow();const p=x.workflow.run('first',1);
 await assert.rejects(x.workflow.run('second',1),{code:'WORKFLOW_BUSY'});assert.equal(x.store.load('second'),undefined);
 await x.entered.promise;x.gate.resolve();await p;assert.equal((await x.workflow.run('second',1)).status,'COMPLETED');
});

test('independent CWorkflow objects/different runIds sharing one Store retain parallelism',async()=>{
 const a=blockedWorkflow(),b=blockedWorkflow(a.store);const p=a.workflow.run('a',1),q=b.workflow.run('b',1);
 await Promise.all([a.entered.promise,b.entered.promise]);assert.equal(a.calls,1);assert.equal(b.calls,1);
 b.gate.resolve();await q;assert.equal(a.store.load('a').status,'RUNNING');a.gate.resolve();await p;assert.equal(a.store.load('a').status,'COMPLETED');assert.equal(a.store.load('b').status,'COMPLETED');
});

test('stateful Check is isolated by fresh per-run graphs',async()=>{
 const store=new CMemoryHistoryStore();
 const create=()=>new CWorkflow([{no:1,job:new CDummyJob('A'),nextStepNo:2},{no:2,job:new CCheckJob('check',new CSequenceBool([false,false,true]),1,3)},{no:3,job:new CDummyJob('END')}],store);
 const [a,b]=await Promise.all([create().run('a',1),create().run('b',1)]);
 for(const s of [a,b]){assert.equal(s.status,'COMPLETED');assert.deepEqual(s.history.filter(h=>h.stepNo===2).map(h=>h.result),['FALSE','FALSE','TRUE']);}
});

test('existing definition reconstruction factories produce independent parallel run graphs',async()=>{
 const {reconstructWorkflow}=require('../dist/src/prototype/definition');
 const {definition,registry}=require('./workflow-definition/fixture.cjs');
 const store=new CMemoryHistoryStore(),reg=registry([false,false,true]);
 const a=reconstructWorkflow(definition(),reg,store),b=reconstructWorkflow(definition(),reg,store);
 assert.notEqual(a.workflow,b.workflow);
 const runs=await Promise.all([a.workflow.run('definition-a',a.startStepNo),b.workflow.run('definition-b',b.startStepNo)]);
 for(const run of runs){assert.equal(run.status,'COMPLETED');assert.deepEqual(run.history.filter(h=>h.stepNo===20).map(h=>h.result),['FALSE','FALSE','TRUE']);}
});

test('stateful same graph cannot consume Check state from a second concurrent run',async()=>{
 const gate=deferred(),entered=deferred();const wf=new CWorkflow([{no:1,job:new CCheckJob('check',new CSequenceBool([false,true]),1,2)},{no:2,job:new CDummyJob('END')}],new CMemoryHistoryStore());
 const p=wf.run('a',1,10,async()=>{entered.resolve();await gate.promise;});await entered.promise;
 await assert.rejects(wf.run('b',1),{code:'WORKFLOW_BUSY'});gate.resolve();assert.deepEqual((await p).history.filter(h=>h.stepNo===1).map(h=>h.result),['FALSE','TRUE']);
});

for(const stage of ['load','save','beforeStep'])test(`CWorkflow ${stage} exception releases object and Store reservation`,async()=>{
 const store=new CMemoryHistoryStore();const baseLoad=store.load.bind(store),baseSave=store.save.bind(store);let fail=true;
 if(stage==='load')store.load=id=>{if(fail){fail=false;throw Error('load fault');}return baseLoad(id);};
 if(stage==='save')store.save=s=>{if(fail){fail=false;throw Error('save fault');}baseSave(s);};
 const wf=new CWorkflow([{no:1,job:new CDummyJob('A')}],store);
 await assert.rejects(wf.run('failed',1,10,stage==='beforeStep'?async()=>{throw Error('before fault');}:undefined),/fault/);
 if(stage!=='beforeStep')assert.equal((await wf.run('failed',1)).status,'COMPLETED');
 else await assert.rejects(wf.run('failed',1),/already exists/); // Existing RUNNING history must not be silently resumed.
 assert.equal((await wf.run('next',1)).status,'COMPLETED');
});

test('CWorkflow handler failure releases guards but preserves failed runId history',async()=>{
 class Job extends CJob{async execute(){throw Error('job failure');}}
 const store=new CMemoryHistoryStore(),wf=new CWorkflow([{no:1,job:new Job('fails')}],store);
 assert.equal((await wf.run('a',1)).status,'FAILED');await assert.rejects(wf.run('a',1),/already exists/);assert.equal((await wf.run('b',1)).status,'FAILED');
 const other=new CWorkflow([{no:1,job:new CDummyJob('new')}],store);await assert.rejects(other.run('a',1),/already exists/);
});
