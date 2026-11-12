'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const api=require('@arch026/workflow');
const {CJobForm,CJob,CDummyJob,CWorkflow,CMemoryHistoryStore,CSequenceBool,createMemoryProductShelf,reconstructWorkflow,loadWorkflow,validatePrototypeDefinition}=api;
const definition=()=>({schemaVersion:'prototype-workflow/1',definitionId:'builder',definitionVersion:'1',startStepId:'work',steps:[
 {stepId:'work',stepNo:10,kind:'JOB',jobId:'add',nextStepId:'check'},
 {stepId:'check',stepNo:20,kind:'CHECK_BOOL',checkId:'done',trueStepId:'end',falseStepId:'work'},
 {stepId:'end',stepNo:30,kind:'JOB',jobId:'finish'}]});
function registry(sequence=[false,false,true],input=10){
 const products=createMemoryProductShelf();products.put('input',input);
 const calls={fixed:0,checks:0,evaluated:0,made:0,visits:[]};
 const form={name:'add',collect:p=>p.get('input'),make:n=>{calls.made++;return n+20;}};
 const value={jobs:new Map([['finish',()=>{calls.fixed++;return new CDummyJob('end');}]]),checks:new Map([['done',()=>{calls.checks++;const s=new CSequenceBool(sequence);return {evaluate(){calls.evaluated++;return s.evaluate();}};}]]),
  jobForms:{products,definitions:new Map([['add',{form,artifactKey:(_ctx,i)=>'X_'+i}]]),onCreate:(job,ctx)=>calls.visits.push({job,iteration:ctx.iterationNo})}};
 return {value,calls,products};
}
test('public Builder constructs fixed Jobs and Checks once, defers visit Jobs and never executes work',async()=>{
 const r=registry(),input=definition(),before=structuredClone(input),g=reconstructWorkflow(input,r.value,new CMemoryHistoryStore());
 assert.ok(g.workflow instanceof CWorkflow);assert.equal(g.startStepNo,10);assert.deepEqual(input,before);
 assert.equal(r.calls.fixed,1);assert.equal(r.calls.checks,1);assert.equal(r.calls.evaluated,0);assert.equal(r.calls.made,0);assert.deepEqual(r.calls.visits,[]);
 assert.equal((await g.workflow.run('timing',10)).status,'COMPLETED');assert.equal(r.calls.checks,1);assert.equal(r.calls.evaluated,3);
 assert.deepEqual(r.calls.visits.map(v=>v.iteration),[1,2,3]);assert.equal(new Set(r.calls.visits.map(v=>v.job)).size,3);assert.ok(r.calls.visits.every(v=>v.job instanceof CJob));
});
test('public Builder rejects missing or ambiguous registrations before any factory runs',()=>{
 for(const kind of ['job','check','ambiguous']){const d=definition(),r=registry();if(kind==='job')d.steps[0].jobId='unknown';if(kind==='check')d.steps[1].checkId='unknown';if(kind==='ambiguous')r.value.jobs.set('add',()=>{throw Error('must not call');});
  assert.throws(()=>reconstructWorkflow(d,r.value,new CMemoryHistoryStore()),{code:kind==='job'?'UNSUPPORTED_JOB':kind==='check'?'UNSUPPORTED_CHECK':'AMBIGUOUS_JOB'});
  assert.equal(r.calls.fixed,0);assert.equal(r.calls.checks,0);assert.equal(r.calls.visits.length,0);
 }
});
test('unvisited visit Factory stays uncalled while existing fixed Job construction is retained',async()=>{
 const d=definition();d.startStepId='check';const r=registry([true]),g=reconstructWorkflow(d,r.value,new CMemoryHistoryStore());
 const result=await g.workflow.run('skip',g.startStepNo);assert.deepEqual(result.history.map(h=>h.stepNo),[20,30]);assert.equal(r.calls.visits.length,0);assert.equal(r.calls.fixed,1);
});
test('rebuilding a LIMIT boundary continues history and visit numbering without redoing prior Jobs',async()=>{
 const d=definition(),store=new CMemoryHistoryStore(),first=registry([false]);const g=reconstructWorkflow(d,first.value,store),saved=await g.workflow.run('continue',10,2);
 assert.equal(saved.status,'LIMIT_REACHED');assert.equal(first.calls.visits.length,1);
 const second=registry([true]),next=reconstructWorkflow(d,second.value,store,{history:saved.history}),done=await next.workflow.resume(saved);
 assert.equal(done.status,'COMPLETED');assert.deepEqual(second.calls.visits.map(v=>v.iteration),[2]);assert.deepEqual(done.history.slice(0,2),saved.history);assert.deepEqual(done.history.map(h=>h.order),[1,2,3,4,5]);
});
test('public Builder preserves WAIT boundary and resumes with newly constructed Check state',async()=>{
 const d=definition();d.schemaVersion='prototype-workflow/2';d.steps[0].nextStepId='wait';d.steps.splice(1,0,{stepId:'wait',stepNo:15,kind:'WAIT',reason:'approval',nextStepId:'check'});
 const store=new CMemoryHistoryStore();store.claimWaiting=async(saved,operation)=>{assert.deepEqual(store.load(saved.runId),saved);assert.equal(operation.expectedWaitGeneration,saved.waiting.generation);const next={...saved,status:'RUNNING',currentStepNo:saved.waiting.nextStepNo};delete next.waiting;store.save(next);return {replayed:false,snapshot:next};};
 const first=registry([true]),saved=await reconstructWorkflow(d,first.value,store).workflow.run('wait',10);assert.equal(saved.status,'WAITING');assert.equal(first.calls.evaluated,0);
 const second=registry([true]),done=await reconstructWorkflow(d,second.value,store,{history:saved.history}).workflow.resumeWaiting(saved,{runId:'wait',operationId:'approve',expectedWaitGeneration:1,expectedRevision:1,result:true});
 assert.equal(done.status,'COMPLETED');assert.equal(second.calls.visits.length,0);assert.equal(second.calls.checks,1);assert.equal(second.calls.evaluated,1);assert.deepEqual(done.history.map(h=>h.stepNo),[10,20,30]);
});
test('parallel Builder results isolate visit counters, products and saved histories',async()=>{
 const d=definition(),store=new CMemoryHistoryStore(),a=registry([true],10),b=registry([false,true],100);
 const ga=reconstructWorkflow(d,a.value,store),gb=reconstructWorkflow(d,b.value,store);const [ra,rb]=await Promise.all([ga.workflow.run('A',10),gb.workflow.run('B',10)]);
 assert.equal(ra.status,'COMPLETED');assert.equal(rb.status,'COMPLETED');assert.deepEqual(a.calls.visits.map(v=>v.iteration),[1]);assert.deepEqual(b.calls.visits.map(v=>v.iteration),[1,2]);assert.equal(a.products.get('X_1'),30);assert.equal(b.products.get('X_1'),120);assert.equal(a.products.has('X_2'),false);assert.deepEqual(store.load('A'),ra);assert.deepEqual(store.load('B'),rb);
});
test('native Form from the existing jobs Factory still executes six phases on each loop visit',async()=>{
 const d=definition(),r=registry([false,true]),phases=[];let created=0;
 class Native extends CJobForm{constructor(){super('native');}prepare(){phases.push('prepare');}collect(){phases.push('collect');return 1;}make(n){phases.push('make');return n;}record(){phases.push('record');}post(){phases.push('post');}cleanup(){phases.push('cleanup');}}
 r.value.jobForms.definitions.delete('add');r.value.jobs.set('add',()=>{created++;return new Native();});const g=reconstructWorkflow(d,r.value,new CMemoryHistoryStore());assert.equal(created,1);
 assert.equal((await g.workflow.run('native',10)).status,'COMPLETED');assert.equal(created,1);assert.deepEqual(phases,[...['prepare','collect','make','record','post','cleanup'],...['prepare','collect','make','record','post','cleanup']]);
});
test('public loadWorkflow uses the minimal repository contract and preserves identity errors',async()=>{
 const d=definition(),r=registry([true]);let reads=0;const repository={async get(id,version){reads++;assert.equal(id,d.definitionId);assert.equal(version,d.definitionVersion);return structuredClone(d);},async add(){throw Error('read only');}};
 assert.equal((await loadWorkflow(repository,d.definitionId,d.definitionVersion,r.value,new CMemoryHistoryStore())).startStepNo,10);assert.equal(reads,1);
 await assert.rejects(loadWorkflow({...repository,get:async()=>null},'x','1',r.value,new CMemoryHistoryStore()),{code:'DEFINITION_NOT_FOUND'});
 await assert.rejects(loadWorkflow({...repository,get:async()=>({...d,definitionVersion:'other'})},'x','1',r.value,new CMemoryHistoryStore()),{code:'DEFINITION_IDENTITY_MISMATCH'});
 assert.throws(()=>validatePrototypeDefinition({...d,artifactBoxes:[]}),{code:'INVALID_DEFINITION'});
});
