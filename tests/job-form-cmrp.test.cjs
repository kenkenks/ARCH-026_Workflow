'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CWorkflow,CMemoryHistoryStore}=require('../dist/src/prototype/workflow');
const {createMemoryProductShelf,bindJobForm}=require('../dist/src/prototype/job-form');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function numberInput(reader,key){if(!reader.has(key))throw Error('missing '+key);const v=reader.get(key);if(typeof v!=='number'||!Number.isFinite(v))throw Error('invalid '+key);return v;}
// Shared definitions contain no per-run record or output state.
const formA=Object.freeze({name:'A',collect:r=>numberInput(r,'seed'),make:x=>x});
const formB=Object.freeze({name:'B',collect:r=>numberInput(r,'X'),make:x=>x+20});
function runFixture(id,seed,history,pause=false){
 const products=createMemoryProductShelf();products.put('seed',seed);
 const entered=deferred(),release=deferred();
 const shelf=pause?{has:k=>products.has(k),get:k=>products.get(k),put:async(k,v)=>{if(k==='X'){entered.resolve();await release.promise;}await products.put(k,v);}}:products;
 const a=bindJobForm(formA,shelf,'X'),b=bindJobForm(formB,shelf,'Z');
 return {id,products,a,b,entered,release,workflow:new CWorkflow([{no:10,job:a.job,nextStepNo:20},{no:20,job:b.job}],history)};
}
test('collect -> make -> record -> post order; record complete but X invisible until publication',async()=>{
 const events=[],raw=createMemoryProductShelf(),history=new CMemoryHistoryStore(),entered=deferred(),release=deferred();let execution;
 raw.put('seed',10);
 const shelf={has:k=>raw.has(k),get:k=>raw.get(k),put:async(k,v)=>{events.push('post');assert.deepEqual(execution.getRecorded(),{value:10});assert.equal(raw.has('X'),false);entered.resolve();await release.promise;await raw.put(k,v);}};
 const form={name:'observed',collect:r=>{events.push('collect');assert.equal(r.put,undefined);return numberInput(r,'seed');},make:v=>{events.push('make');assert.equal(raw.has('X'),false);return v;},record:v=>{events.push('record');assert.equal(v,10);assert.equal(raw.has('X'),false);assert.equal(execution.getRecorded(),null);}};
 execution=bindJobForm(form,shelf,'X');const promise=new CWorkflow([{no:10,job:execution.job}],history).run('boundary',10);
 await entered.promise;assert.deepEqual(events,['collect','make','record','post']);assert.deepEqual(execution.getRecorded(),{value:10});assert.equal(raw.has('X'),false);assert.equal(history.load('boundary').status,'RUNNING');assert.deepEqual(history.load('boundary').history,[]);
 release.resolve();const result=await promise;assert.equal(raw.get('X'),10);assert.equal(result.status,'COMPLETED');assert.equal(result.history[0].result,'DONE');
});
test('A and B exchange X by key only and produce X=10/Z=30',async()=>{
 const history=new CMemoryHistoryStore(),r=runFixture('normal',10,history);const result=await r.workflow.run(r.id,10);
 assert.equal(r.products.get('X'),10);assert.equal(r.products.get('Z'),30);assert.deepEqual(r.a.getRecorded(),{value:10});assert.deepEqual(r.b.getRecorded(),{value:30});
 assert.equal(result.status,'COMPLETED');assert.deepEqual(result.history.map(h=>[h.stepNo,h.job,h.result]),[[10,'A','DONE'],[20,'B','DONE']]);
});
test('shared forms with fresh sequential bindings do not retain previous inputs or internal records',async()=>{
 const history=new CMemoryHistoryStore();for(const [i,seed]of [10,100].entries()){const r=runFixture('sequential-'+i,seed,history);assert.equal(r.a.getRecorded(),null);assert.equal(r.b.getRecorded(),null);assert.equal(r.products.has('Z'),false);await r.workflow.run(r.id,10);assert.equal(r.products.get('X'),seed);assert.equal(r.products.get('Z'),seed+20);}
});
for(const order of ['first','second'])test(`parallel fresh bindings, ${order} completes first`,async()=>{
 const history=new CMemoryHistoryStore(),a=runFixture(order+'-a',10,history,true),b=runFixture(order+'-b',100,history,true),pa=a.workflow.run(a.id,10),pb=b.workflow.run(b.id,10);
 await Promise.all([a.entered.promise,b.entered.promise]);assert.deepEqual(a.a.getRecorded(),{value:10});assert.deepEqual(b.a.getRecorded(),{value:100});assert.equal(a.products.has('X'),false);assert.equal(b.products.has('X'),false);
 const [first,second,pf,ps]=order==='first'?[a,b,pa,pb]:[b,a,pb,pa];first.release.resolve();await pf;assert.equal(history.load(first.id).status,'COMPLETED');assert.equal(history.load(second.id).status,'RUNNING');assert.equal(second.b.getRecorded(),null);second.release.resolve();await ps;
 assert.equal(a.products.get('X'),10);assert.equal(a.products.get('Z'),30);assert.equal(b.products.get('X'),100);assert.equal(b.products.get('Z'),120);assert.equal(history.load(a.id).history.length,2);assert.equal(history.load(b.id).history.length,2);
});
for(const stage of ['missing','invalid','make','record'])test(`${stage} failure: FAILED/ERROR, no post and later Job never executes`,async()=>{
 const events=[],products=createMemoryProductShelf(),history=new CMemoryHistoryStore();if(stage!=='missing')products.put('input',stage==='invalid'?{bad:true}:10);
 const before=products.get('input');let makeCalls=0,recordCalls=0,postCalls=0;
 const shelf={has:k=>products.has(k),get:k=>products.get(k),put:(k,v)=>{postCalls++;return products.put(k,v);}};
 const form={name:'fault',collect:r=>{events.push('collect');return numberInput(r,'input');},make:x=>{makeCalls++;events.push('make');if(stage==='make')throw Error('make failed');return {value:x};},record:async()=>{recordCalls++;events.push('record');if(stage==='record')throw Error('record failed');}};
 const binding=bindJobForm(form,shelf,'new-product'),later=bindJobForm({name:'later',collect:()=>{throw Error('must not run');},make:()=>0},shelf,'later');
 const result=await new CWorkflow([{no:10,job:binding.job,nextStepNo:20},{no:20,job:later.job}],history).run('fault-'+stage,10);
 assert.equal(result.status,'FAILED');assert.equal(result.currentStepNo,10);assert.equal(result.history.length,1);assert.equal(result.history[0].result,'ERROR');assert.match(result.history[0].error,stage==='missing'?/missing input/:stage==='invalid'?/invalid input/:new RegExp(stage+' failed'));
 assert.equal(products.has('new-product'),false);assert.equal(products.has('later'),false);assert.deepEqual(products.get('input'),before);assert.equal(binding.getRecorded(),null);assert.equal(later.getRecorded(),null);assert.equal(postCalls,0);
 assert.equal(makeCalls,['missing','invalid'].includes(stage)?0:1);assert.equal(recordCalls,stage==='record'?1:0);assert.deepEqual(events,stage==='record'?['collect','make','record']:stage==='make'?['collect','make']:['collect']);assert.equal(history.load('fault-'+stage).status,'FAILED');
});
test('business FAIL is a valid result: collected, recorded and posted with COMPLETED/DONE',async()=>{
 const products=createMemoryProductShelf(),source={memberId:'M002',result:'FAIL',score:45};products.put('exam',source);
 const form={name:'exam-result',collect:r=>{if(!r.has('exam'))throw Error('missing');const v=r.get('exam');if(!v||typeof v.memberId!=='string'||!v.memberId.trim()||!['PASS','FAIL'].includes(v.result)||typeof v.score!=='number'||!Number.isFinite(v.score)||v.score<0||v.score>100)throw Error('invalid');return v;},make:v=>({...v})};
 const e=bindJobForm(form,products,'result'),history=new CMemoryHistoryStore(),result=await new CWorkflow([{no:10,job:e.job}],history).run('business-fail',10);
 assert.equal(result.status,'COMPLETED');assert.equal(result.history[0].result,'DONE');assert.deepEqual(e.getRecorded(),{value:source});assert.deepEqual(products.get('result'),source);
});
test('record and published values have independent nested references',async()=>{
 const source={nested:{value:10},items:[1]},products=createMemoryProductShelf();products.put('input',source);source.nested.value=99;
 const e=bindJobForm({name:'detached',collect:r=>r.get('input'),make:v=>v,record:v=>{v.nested.value=999;}},products,'output');
 await new CWorkflow([{no:10,job:e.job}],new CMemoryHistoryStore()).run('copies',10);
 assert.equal(products.get('output').nested.value,10);const internal=e.getRecorded();internal.value.nested.value=5;const external=products.get('output');external.nested.value=6;assert.equal(e.getRecorded().value.nested.value,10);assert.equal(products.get('output').nested.value,10);assert.equal(products.get('input').nested.value,10);
});
test('binding is single-use; a new binding is required even for a new runId',async()=>{
 const products=createMemoryProductShelf(),e=bindJobForm({name:'once',collect:()=>1,make:x=>x},products,'output'),history=new CMemoryHistoryStore(),wf=new CWorkflow([{no:10,job:e.job}],history);
 assert.equal((await wf.run('once-1',10)).status,'COMPLETED');assert.equal((await wf.run('once-2',10)).status,'FAILED');assert.match(history.load('once-2').history[0].error,/binding already used/);assert.equal(products.get('output'),1);
});
