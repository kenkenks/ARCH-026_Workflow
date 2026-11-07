'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {WorkflowRuntime}=require('../gui/workflow-runtime');
const {CWorkflow,CJob,CDummyJob,CMemoryHistoryStore,WorkflowRunError}=require('../dist/src/prototype/workflow');
const def={id:'exception',version:'1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId:'job',nextStepId:'END'},{id:'END',type:'END'}]};
const secret='TEST_PRIVATE_VALUE C:\\private\\test-path';
for(const [name,value] of [['Error',Error(secret)],['null',null],['string',secret],['number',12345],['object',{secret,stack:secret}],['unstringifiable',{toString(){throw Error(secret);}}]]){
 test(`Runtime ${name} exception preserves safe diagnostics and releases guard`,async()=>{
  const r=new WorkflowRuntime(def,{job:()=>{throw value;}},{runId:'run-1'});
  await assert.rejects(r.advance(),e=>e===value);
  const s=r.snapshot();assert.equal(s.status,'FAILED');assert.equal(s.pending,null);assert.equal(r.advancing,false);
  assert.deepEqual(s.error,{code:'HANDLER_EXCEPTION',stepId:'J',summary:'JOB Handlerで例外が発生しました',executionMode:'NORMAL',runId:'run-1'});
  assert.deepEqual(s.history[0].diagnostic,s.error);assert.equal(s.history[0].result,'ERROR');assert.ok(!JSON.stringify(s).includes(secret));
  s.error.code='changed';s.history[0].diagnostic.summary='changed';assert.equal(r.snapshot().error.code,'HANDLER_EXCEPTION');assert.notEqual(r.snapshot().history[0].diagnostic.summary,'changed');
  const before=r.snapshot();await assert.rejects(r.advance(),/終了/);assert.deepEqual(r.snapshot(),before);
 });
}
test('Runtime Promise rejection, invalid result, explicit ERROR and WAITING diagnostics',async()=>{
 const cause=Error(secret),r=new WorkflowRuntime(def,{job:()=>Promise.reject(cause)},{runId:'async'});
 await assert.rejects(r.advance(),e=>e===cause);assert.equal(r.snapshot().error.code,'HANDLER_EXCEPTION');
 const invalid=new WorkflowRuntime(def,{job:async()=>({status:'UNKNOWN'})},{executionMode:'DEMO',runId:'invalid'});
 await assert.rejects(invalid.advance(),/戻り値/);assert.equal(invalid.snapshot().error.code,'INVALID_JOB_RESULT');assert.equal(invalid.snapshot().error.executionMode,'DEMO');
 const check=new WorkflowRuntime({...def,startStepId:'C',steps:[{id:'C',type:'CHECK_FINAL',nextStepId:'END'},{id:'END',type:'END'}]}, {},{runId:'check'});
 await check.advance({checkResult:'ERROR'});assert.equal(check.snapshot().error.code,'CHECK_ERROR');assert.deepEqual(check.snapshot().error,check.snapshot().history[0].diagnostic);
 let calls=0;const waiting=new WorkflowRuntime(def,{job:async()=>{if(++calls===1)return {status:'WAITING'};throw cause;}},{runId:'waiting'});
 await waiting.advance();await assert.rejects(waiting.advance(),e=>e===cause);assert.equal(waiting.pending,null);assert.equal(waiting.status,'FAILED');assert.equal(waiting.advancing,false);
});

for(const cause of [Error('before step root'),null])test(`beforeStep failure keeps original cause (${cause===null?'null':'Error'}) without fake Job failure`,async()=>{
 const store=new CMemoryHistoryStore();let calls=0;
 const wf=new CWorkflow([{no:1,job:new CDummyJob('job',()=>{calls++;})}],store);
 await assert.rejects(wf.run('hook',1,10,async()=>{throw cause;}),e=>{
  assert.ok(e instanceof WorkflowRunError);assert.equal(e.code,'BEFORE_STEP_FAILED');assert.equal(e.cause,cause);assert.equal(e.outcome,'FAILED');return true;
 });
 const s=store.load('hook');assert.equal(s.status,'FAILED');assert.equal(s.failure.code,'BEFORE_STEP_FAILED');assert.equal(s.failure.stepNo,1);assert.deepEqual(s.history,[]);assert.equal(calls,0);
 await assert.rejects(wf.run('hook',1),/already exists/);assert.equal((await wf.run('new',1)).status,'COMPLETED');assert.equal(calls,1);
});
test('beforeStep immediately before terminal Job preserves real prior DONE only',async()=>{
 const store=new CMemoryHistoryStore();let terminal=0,count=0;
 const wf=new CWorkflow([{no:1,job:new CDummyJob('first'),nextStepNo:2},{no:2,job:new CDummyJob('terminal',()=>{terminal++;})}],store);
 await assert.rejects(wf.run('near-end',1,10,async()=>{if(++count===2)throw Error('hook');}),{code:'BEFORE_STEP_FAILED'});
 const s=store.load('near-end');assert.equal(s.status,'FAILED');assert.equal(s.currentStepNo,2);assert.equal(s.failure.stepNo,2);assert.deepEqual(s.history.map(h=>h.result),['DONE']);assert.equal(terminal,0);
});

for(const after of [false,true])for(const failAt of [1,2,3])test(`history save ${after?'after':'before'} write #${failAt} is UNKNOWN, never automatically retried`,async()=>{
 const store=new CMemoryHistoryStore(),save=store.save.bind(store);const fault=Error('storage fault');let writes=0,calls=0;
 store.save=s=>{writes++;if(writes===failAt){if(after)save(s);throw fault;}save(s);};
 const wf=new CWorkflow([{no:1,job:new CDummyJob('job',()=>{calls++;})}],store);
 await assert.rejects(wf.run('save',1),e=>{
  assert.equal(e.code,'HISTORY_SAVE_OUTCOME_UNKNOWN');assert.equal(e.outcome,'UNKNOWN');assert.equal(e.cause,fault);assert.equal(e.storageCause,fault);
  assert.equal(e.observation.state,failAt===1&&!after?'ABSENT':'AVAILABLE');if(e.observation.snapshot){const expected=failAt===1||failAt===2&&!after?'RUNNING':'COMPLETED';assert.equal(e.observation.snapshot.status,expected);e.observation.snapshot.status='FAILED';assert.equal(store.load('save').status,expected);}return true;
 });
 assert.equal(writes,failAt);assert.equal(calls,failAt===1?0:1);
 const previousCalls=calls;
 if(store.load('save')){await assert.rejects(wf.run('save',1),/already exists/);assert.equal(calls,previousCalls);}
 else assert.equal((await wf.run('save',1)).status,'COMPLETED');
 assert.equal((await wf.run('different',1)).status,'COMPLETED');
});

for(const after of [false,true])test(`Handler fault plus FAILED save fault (${after?'after':'before'} write) preserves both causes`,async()=>{
 const root=Error('handler root'),storage=Error('storage secondary');const store=new CMemoryHistoryStore(),save=store.save.bind(store);
 store.save=s=>{if(s.status==='FAILED'){if(after)save(s);throw storage;}save(s);};
 class Job extends CJob{async execute(){throw root;}}
 const wf=new CWorkflow([{no:1,job:new Job('fail')}],store);
 await assert.rejects(wf.run('double',1),e=>{assert.equal(e.code,'HISTORY_SAVE_OUTCOME_UNKNOWN');assert.equal(e.cause,root);assert.equal(e.storageCause,storage);assert.equal(e.attemptedSnapshot.status,'FAILED');assert.equal(e.attemptedSnapshot.history[0].result,'ERROR');assert.match(e.attemptedSnapshot.history[0].error,/handler root/);return true;});
 assert.equal(store.load('double').status,after?'FAILED':'RUNNING');await assert.rejects(wf.run('double',1),/already exists/);
 const other=new CWorkflow([{no:1,job:new CDummyJob('new')}],store);assert.equal((await other.run('new',1)).status,'COMPLETED');
});

test('beforeStep and FAILED history save errors remain separate when read-back also fails',async()=>{
 const root=Error('hook root'),storage=Error('store root'),store=new CMemoryHistoryStore();const save=store.save.bind(store),load=store.load.bind(store);let unreadable=false;
 store.save=s=>{if(s.status==='FAILED'){unreadable=true;throw storage;}save(s);};store.load=id=>{if(unreadable)throw Error('read unavailable');return load(id);};
 const wf=new CWorkflow([{no:1,job:new CDummyJob('job')}],store);
 await assert.rejects(wf.run('unknown',1,10,async()=>{throw root;}),e=>{assert.equal(e.code,'HISTORY_SAVE_OUTCOME_UNKNOWN');assert.equal(e.cause,root);assert.equal(e.storageCause,storage);assert.equal(e.observation.state,'UNAVAILABLE');assert.deepEqual(e.attemptedSnapshot.history,[]);return true;});
 unreadable=false;assert.equal((await wf.run('new',1)).status,'COMPLETED');
});
