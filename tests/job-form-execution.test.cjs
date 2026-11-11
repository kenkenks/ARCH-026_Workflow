'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CJob,CWorkflowTask,CDummyJob,CCheckJob,CWorkflow,CMemoryHistoryStore}=require('../dist/src/prototype/workflow');
const {createMemoryProductShelf,bindJobForm}=require('../dist/src/prototype/job-form');
const {reconstructWorkflow}=require('../dist/src/prototype/definition');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const form=Object.freeze({name:'shared-add',collect:r=>{if(!r.has('INPUT'))throw Error('missing');return r.get('INPUT');},make:x=>{if(x<0)throw Error('negative input');return {sum:x+20};}});
function execution(input,definition=form,shelf=createMemoryProductShelf()) {shelf.put('INPUT',input);return {shelf,job:new CJob(definition,shelf,'OUTPUT')};}
test('A shared form creates distinct single execution Jobs, sequential success and failure',async()=>{
 const good=execution(10),bad=execution(-1);assert.strictEqual(good.job.form,bad.job.form);assert.ok(good.job instanceof CWorkflowTask);assert.notStrictEqual(good.job,bad.job);
 assert.deepEqual(good.job.getState(),{status:'READY',phase:null});await good.job.execute();assert.deepEqual(good.job.getRecorded(),{value:{sum:30}});
 await assert.rejects(bad.job.execute(),/negative input/);assert.deepEqual(bad.job.getState(),{status:'FAILED',phase:'make'});assert.equal(bad.job.getRecorded(),null);assert.equal(bad.shelf.has('OUTPUT'),false);
 assert.equal(good.job.getState().status,'COMPLETED');assert.deepEqual(Object.keys(form),['name','collect','make']);
});
test('A parallel Jobs keep input/output/status apart on one shared form',async()=>{
 const gate1=deferred(),gate2=deferred(),entered1=deferred(),entered2=deferred();
 const shared=Object.freeze({name:'parallel',collect:async r=>{const v=r.get('INPUT');(v===10?entered1:entered2).resolve();await(v===10?gate1:gate2).promise;return v;},make:form.make});
 const a=execution(10,shared),b=execution(-1,shared);const history=new CMemoryHistoryStore();
 const pa=new CWorkflow([{no:1,job:a.job}],history).run('012-par-a',1),pb=new CWorkflow([{no:1,job:b.job}],history).run('012-par-b',1);await Promise.all([entered1.promise,entered2.promise]);
 assert.deepEqual(a.job.getState(),{status:'RUNNING',phase:'collect'});assert.deepEqual(b.job.getState(),{status:'RUNNING',phase:'collect'});
 gate1.resolve();assert.equal((await pa).status,'COMPLETED');assert.equal(b.job.getState().status,'RUNNING');gate2.resolve();assert.equal((await pb).status,'FAILED');
 assert.deepEqual(a.shelf.get('OUTPUT'),{sum:30});assert.equal(b.shelf.has('OUTPUT'),false);assert.equal(history.load('012-par-a').history[0].result,'DONE');assert.equal(history.load('012-par-b').history[0].result,'ERROR');
});
test('C CJob owns collect/make/record/post state and detached internal result',async()=>{
 const entered=Object.fromEntries(['collect','make','record','post'].map(k=>[k,deferred()])),release=Object.fromEntries(['collect','make','record','post'].map(k=>[k,deferred()]));
 const raw=createMemoryProductShelf();raw.put('INPUT',10);const stages=[];
 async function stage(name){stages.push(name);entered[name].resolve();await release[name].promise;}
 const shared={name:'phases',collect:async r=>{await stage('collect');return r.get('INPUT');},make:async x=>{await stage('make');return {sum:x+20};},record:async()=>stage('record')};
 const shelf={has:k=>raw.has(k),get:k=>raw.get(k),put:async(k,v)=>{await stage('post');raw.put(k,v);}};
 const job=new CJob(shared,shelf,'OUTPUT'),history=new CMemoryHistoryStore(),running=new CWorkflow([{no:1,job}],history).run('012-phases',1);
 for(const name of ['collect','make','record','post']){await entered[name].promise;assert.deepEqual(job.getState(),{status:'RUNNING',phase:name});assert.equal(raw.has('OUTPUT'),false);assert.equal(history.load('012-phases').status,'RUNNING');assert.equal(history.load('012-phases').history.length,0);assert.deepEqual(job.getRecorded(),name==='post'?{value:{sum:30}}:null);release[name].resolve();}
 assert.equal((await running).status,'COMPLETED');assert.deepEqual(stages,['collect','make','record','post']);assert.deepEqual(raw.get('OUTPUT'),{sum:30});
 const result=job.getRecorded();result.value.sum=-1;const state=job.getState();state.status='FAILED';assert.deepEqual(job.getRecorded(),{value:{sum:30}});assert.equal(job.getState().status,'COMPLETED');
});
function loop(limit,history=new CMemoryHistoryStore()){
 const shelf=createMemoryProductShelf(),jobs=[];let round=0;
 const factory=()=>{round++;shelf.put('INPUT',round*10);const job=new CJob(form,shelf,'X_'+round);jobs.push(job);return job;};
 const workflow=new CWorkflow([{no:5,job:new CCheckJob('entry',{evaluate:()=>limit>0},30,10)},{no:10,createJob:factory,nextStepNo:20},{no:20,job:new CCheckJob('continue',{evaluate:()=>round<limit},30,10)},{no:30,job:new CDummyJob('END')}],history);
 return {workflow,jobs,shelf,history};
}
test('B backward transition creates a fresh CJob per visit without bindJobForm wrappers',async()=>{
 const r=loop(3),result=await r.workflow.run('012-loop',5);assert.equal(result.status,'COMPLETED');assert.equal(r.jobs.length,3);assert.equal(new Set(r.jobs).size,3);assert.ok(r.jobs.every(j=>j.form===form));
 assert.deepEqual(r.jobs.map(j=>j.getRecorded()),[{value:{sum:30}},{value:{sum:40}},{value:{sum:50}}]);assert.deepEqual([1,2,3].map(n=>r.shelf.get('X_'+n)),[{sum:30},{sum:40},{sum:50}]);assert.ok(r.jobs.every(j=>j.getState().status==='COMPLETED'));
 assert.deepEqual(result.history.map(h=>h.stepNo),[5,10,20,10,20,10,20,30]);r.jobs[0].getRecorded().value.sum=-1;assert.equal(r.jobs[1].getRecorded().value.sum,40);
});
test('B zero visits never calls factory; global limit does not allocate unvisited Jobs',async()=>{
 const zero=loop(0);assert.equal((await zero.workflow.run('012-zero',5)).status,'COMPLETED');assert.equal(zero.jobs.length,0);
 const bounded=loop(10);const r=await bounded.workflow.run('012-limit',5,4);assert.equal(r.status,'LIMIT_REACHED');assert.equal(bounded.jobs.length,2);assert.equal(r.history.length,4);
});
test('B parallel workflows share only form; each owns its factory counter and Jobs',async()=>{
 const history=new CMemoryHistoryStore(),a=loop(1,history),b=loop(3,history);const results=await Promise.all([a.workflow.run('012-loops-a',5),b.workflow.run('012-loops-b',5)]);assert.ok(results.every(r=>r.status==='COMPLETED'));assert.equal(a.jobs.length,1);assert.equal(b.jobs.length,3);assert.notStrictEqual(a.jobs[0],b.jobs[0]);assert.equal(a.shelf.has('X_2'),false);assert.equal(b.shelf.get('X_3').sum,50);
});
for(const phase of ['collect','make','record','post'])test(`C phase ${phase} exception keeps original error and CWorkflow ERROR`,async()=>{
 const root=Error(phase+' failed'),shelf=createMemoryProductShelf();const definition={name:'failure',collect:()=>{if(phase==='collect')throw root;return 10;},make:x=>{if(phase==='make')throw root;return x;},record:()=>{if(phase==='record')throw root;}};
 const destination={has:k=>shelf.has(k),get:k=>shelf.get(k),put:(k,v)=>{if(phase==='post')throw root;shelf.put(k,v);}};const job=new CJob(definition,destination,'OUTPUT'),history=new CMemoryHistoryStore();
 const r=await new CWorkflow([{no:1,job}],history).run('012-fault-'+phase,1);assert.equal(r.status,'FAILED');assert.equal(r.history[0].error,'Error: '+phase+' failed');assert.deepEqual(job.getState(),{status:'FAILED',phase});assert.deepEqual(job.getRecorded(),phase==='post'?{value:10}:null);assert.equal(shelf.has('OUTPUT'),false);
});
test('C business FAIL remains successful data, not execution failure',async()=>{
 const value={memberId:'M002',result:'FAIL',score:45},shelf=createMemoryProductShelf(),job=new CJob({name:'business',collect:()=>value,make:x=>x},shelf,'exam');
 const r=await new CWorkflow([{no:1,job}],new CMemoryHistoryStore()).run('012-business',1);assert.equal(r.status,'COMPLETED');assert.equal(job.getState().status,'COMPLETED');assert.deepEqual(shelf.get('exam'),value);
});
test('D fixed Dummy/Check tasks and Job factory compose as IF / Switch',async()=>{
 for(const selected of ['PASS','FAIL','PENDING']){
  const shelf=createMemoryProductShelf();shelf.put('INPUT',selected);const visited=[];
  const task=name=>()=>{const job=new CJob({name,collect:r=>r.get('INPUT'),make:x=>{visited.push(name);return x;}},shelf,'notification');return job;};
  const wf=new CWorkflow([{no:1,job:new CCheckJob('PASS?',{evaluate:()=>selected==='PASS'},2,10)},{no:2,job:new CCheckJob('FAIL?',{evaluate:()=>selected==='FAIL'},30,20)},{no:10,createJob:task('PASS')},{no:20,createJob:task('FAIL')},{no:30,createJob:task('PENDING')}],new CMemoryHistoryStore());
  const r=await wf.run('012-switch-'+selected,1);assert.equal(r.status,'COMPLETED');assert.deepEqual(visited,[selected]);assert.equal(shelf.get('notification'),selected);
 }
});
test('D invalid factory return or factory throw is FAILED without a fabricated Job success',async()=>{
 for(const factory of [()=>null,()=>new CCheckJob('not a Job',{evaluate:()=>true},1,1),()=>{throw Error('factory failed');}]){
  const history=new CMemoryHistoryStore(),wf=new CWorkflow([{no:1,createJob:factory}],history),r=await wf.run('factory',1);assert.equal(r.status,'FAILED');assert.equal(r.history.length,1);assert.equal(r.history[0].result,'ERROR');assert.equal(r.history[0].job,'step-1');
 }
});
test('D factory validation has zero calls; ambiguous definitions rejected; reused execution refused',async()=>{
 let calls=0;const shelf=createMemoryProductShelf(),job=new CJob(form,shelf,'OUTPUT');shelf.put('INPUT',10);
 assert.throws(()=>new CWorkflow([{no:1,job,createJob:()=>job}],new CMemoryHistoryStore()));assert.throws(()=>new CWorkflow([{no:1,createJob:null}],new CMemoryHistoryStore()));
 const wf=new CWorkflow([{no:1,createJob:()=>{calls++;return job;},nextStepNo:2},{no:2,job:new CCheckJob('repeat',{evaluate:()=>calls<2},3,1)},{no:3,job:new CDummyJob('END')}],new CMemoryHistoryStore());assert.equal(calls,0);
 const r=await wf.run('reused',1);assert.equal(r.status,'FAILED');assert.equal(calls,2);assert.equal(job.getState().status,'COMPLETED');assert.match(r.history.at(-1).error,/binding already used/);
});
test('D existing bind entry returns the same concrete CJob pipeline, not a second executor',async()=>{
 const shelf=createMemoryProductShelf();shelf.put('INPUT',10);const bound=bindJobForm(form,shelf,'OUTPUT');assert.ok(bound.job instanceof CJob);assert.strictEqual(bound.job.form,form);await bound.job.execute();assert.deepEqual(bound.getRecorded(),bound.job.getRecorded());
});
test('D persisted single-Job definition can reconstruct new CJob without changing saved schema',async()=>{
 const definition={schemaVersion:'prototype-workflow/1',definitionId:'012-definition',definitionVersion:'1',startStepId:'work',steps:[{stepId:'work',stepNo:10,kind:'JOB',jobId:'add'}]},before=structuredClone(definition),shelf=createMemoryProductShelf();shelf.put('INPUT',10);
 const registry={jobs:new Map([['add',()=>new CJob(form,shelf,'OUTPUT')]]),checks:new Map()},history=new CMemoryHistoryStore();const loaded=reconstructWorkflow(definition,registry,history);const r=await loaded.workflow.run('012-reconstructed',loaded.startStepNo);assert.equal(r.status,'COMPLETED');assert.equal(shelf.get('OUTPUT').sum,30);assert.deepEqual(definition,before);
});
