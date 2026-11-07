'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CWorkflow,CDummyJob,CCheckJob,CSequenceBool,CMemoryHistoryStore,CWorkflowMonitor,WorkflowValidationError}=require('../dist/src/prototype/workflow');
const invalid=e=>e instanceof WorkflowValidationError&&e.code==='INVALID_ARGUMENT';
const snapshot=()=>({runId:'saved',status:'RUNNING',currentStepNo:1,history:[{order:1,stepNo:1,job:'job',result:'DONE',nextStepNo:2,at:'2026-11-07T00:00:00Z'}],failure:{code:'BEFORE_STEP_FAILED',stepNo:2,summary:'hook failed'}});
function fixture(){const store=new CMemoryHistoryStore();let saves=0,loads=0;const save=store.save.bind(store),load=store.load.bind(store);store.save=x=>{saves++;return save(x);};store.load=id=>{loads++;return load(id);};return {store,saves:()=>saves,loads:()=>loads};}
for(const value of ['', ' ',null,undefined,42,true,[],{}])test(`runId rejects ${JSON.stringify(value)} before Store access`,async()=>{
 const f=fixture(),wf=new CWorkflow([{no:1,job:new CDummyJob('job')}],f.store);
 await assert.rejects(wf.run(value,1),invalid);assert.equal(f.saves(),0);assert.equal(f.loads(),0);
 assert.equal((await wf.run('valid',1)).status,'COMPLETED');
});
for(const value of [null,42,true,[],{},'job',{name:'job',execute:null},{name:'job'},{name:42,execute(){}},{name:' ',execute(){}}])test(`invalid Job ${JSON.stringify(value)} rejected by constructor`,()=>{
 const f=fixture();assert.throws(()=>new CWorkflow([{no:1,job:value}],f.store),invalid);assert.equal(f.saves(),0);
});
test('Job name, callback and Check condition contracts reject invalid construction',()=>{
 for(const name of [null,42,[],{},'', ' '])assert.throws(()=>new CDummyJob(name),invalid);
 for(const action of [null,42,[],{},'callback'])assert.throws(()=>new CDummyJob('job',action),invalid);
 for(const condition of [null,42,[],{}, {evaluate:42}])assert.throws(()=>new CCheckJob('check',condition,1,2),invalid);
 assert.doesNotThrow(()=>new CDummyJob('default callback'));
});
test('invalid hook or Job mutated before run never leaves RUNNING history',async()=>{
 const f=fixture(),job=new CDummyJob('job'),wf=new CWorkflow([{no:1,job}],f.store);
 for(const hook of [null,42,[],{}])await assert.rejects(wf.run('r',1,100,hook),invalid);
 job.name=null;await assert.rejects(wf.run('r',1),invalid);assert.equal(f.saves(),0);
 job.name='job';assert.equal((await wf.run('r',1)).status,'COMPLETED');
});
for(const value of [null,undefined,42,true,'false',{},[],[true,0],[false,'true'],new Array(2)])test(`sequence rejects ${JSON.stringify(value)}`,()=>assert.throws(()=>new CSequenceBool(value),invalid));
test('sequence boolean order and last value, isolated from subsequent source mutations',()=>{
 const source=[false,false,true],seq=new CSequenceBool(source);source[0]='invalid';source.length=0;
 assert.deepEqual([seq.evaluate(),seq.evaluate(),seq.evaluate(),seq.evaluate()],[false,false,true,true]);
});
const mutations=[
 ['runId',x=>x.runId=42],['empty runId',x=>x.runId=' '],['status',x=>x.status='WAITING'],['missing status',x=>delete x.status],['currentStepNo',x=>x.currentStepNo={}],['missing currentStepNo',x=>delete x.currentStepNo],
 ['history null',x=>x.history=null],['history object',x=>x.history={}],['null entry',x=>x.history=[null]],['array entry',x=>x.history=[[]]],
 ['order',x=>x.history[0].order=0],['fractional order',x=>x.history[0].order=1.5],['stepNo',x=>x.history[0].stepNo='1'],['job',x=>x.history[0].job={}],['result',x=>x.history[0].result='COMPLETED'],['nextStepNo',x=>x.history[0].nextStepNo=false],['at',x=>x.history[0].at=42],['error',x=>x.history[0].error={}],
 ['failure null',x=>x.failure=null],['failure array',x=>x.failure=[]],['failure code',x=>x.failure.code='UNKNOWN'],['failure step',x=>x.failure.stepNo='2'],['failure summary',x=>x.failure.summary={}]
];
for(const [name,mutate] of mutations)test(`Store invalid ${name} preserves previously saved DTO`,()=>{
 const store=new CMemoryHistoryStore(),good=snapshot();store.save(good);const bad=structuredClone(good);mutate(bad);assert.throws(()=>store.save(bad),invalid);assert.deepEqual(store.load('saved'),good);
});
test('Store root and required fields; load and Monitor IDs',async()=>{
 const store=new CMemoryHistoryStore(),monitor=new CWorkflowMonitor(store);
 for(const value of [null,undefined,42,true,[],{},'snapshot'])assert.throws(()=>store.save(value),invalid);
 for(const key of ['runId','status','currentStepNo','history']){const x=snapshot();delete x[key];assert.throws(()=>store.save(x),invalid);}
 for(const key of ['order','stepNo','job','result','nextStepNo','at']){const x=snapshot();delete x.history[0][key];assert.throws(()=>store.save(x),invalid);}
 for(const value of [null,42,{},[], '']){assert.throws(()=>store.load(value),invalid);await assert.rejects(monitor.get(value),invalid);}
});
test('normal DTO boundaries, optional failure/error, metadata and reference independence',async()=>{
 const store=new CMemoryHistoryStore();
 for(const status of ['RUNNING','COMPLETED','FAILED','LIMIT_REACHED']){const x=snapshot();x.status=status;x.currentStepNo=null;x.history[0].nextStepNo=null;x.history[0].error='error';x.executionMode='DEMO';store.save(x);const a=store.load('saved'),b=store.load('saved');a.history[0].job='modified';a.failure.summary='changed';assert.deepEqual(b,x);assert.deepEqual(store.load('saved'),x);}
 const x=snapshot();delete x.failure;x.history=[];store.save(x);assert.deepEqual(store.load('saved'),x);
 const wf=new CWorkflow([{no:-1,job:{name:'structural job',async execute(){}}}],store);assert.equal((await wf.run('negative-step',-1)).status,'COMPLETED');
});
test('cycle FALSE FALSE TRUE, limit and Job failure remain valid DTOs',async()=>{
 const store=new CMemoryHistoryStore();const steps=()=>[{no:1,job:new CDummyJob('job'),nextStepNo:2},{no:2,job:new CCheckJob('check',new CSequenceBool([false,false,true]),1,3)},{no:3,job:new CDummyJob('end')}];
 const done=await new CWorkflow(steps(),store).run('done',1);assert.equal(done.status,'COMPLETED');assert.deepEqual(done.history.filter(x=>x.stepNo===2).map(x=>x.result),['FALSE','FALSE','TRUE']);
 assert.equal((await new CWorkflow(steps(),store).run('limit',1,2)).status,'LIMIT_REACHED');
 const failed=await new CWorkflow([{no:1,job:new CDummyJob('failure',()=>{throw Error('expected');})}],store).run('failed',1);assert.equal(failed.status,'FAILED');assert.equal(failed.history[0].result,'ERROR');assert.equal(store.load('failed').status,'FAILED');
});
