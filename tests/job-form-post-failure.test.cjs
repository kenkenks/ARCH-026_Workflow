'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CWorkflow,CDummyJob,CMemoryHistoryStore,CWorkflowMonitor}=require('../dist/src/prototype/workflow');
const {bindJobForm,createMemoryProductShelf}=require('../dist/src/prototype/job-form');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const form=Object.freeze({name:'producer',collect:r=>{if(!r.has('INPUT'))throw Error('missing input');const value=r.get('INPUT');if(value&&typeof value==='object'&&Object.hasOwn(value,'memberId')){if(typeof value.memberId!=='string'||!value.memberId.trim()||!['PASS','FAIL'].includes(value.result)||typeof value.score!=='number'||!Number.isFinite(value.score)||value.score<0||value.score>100)throw Error('invalid exam result');}return value;},make:v=>structuredClone(v)});
function fixture(id,mode,{input=10,history=new CMemoryHistoryStore(),pause=false}={}){
 const products=createMemoryProductShelf();products.put('INPUT',input);products.put('PREVIOUS',999);
 const root=new TypeError('injected publication failure',{cause:Error('local cause only')});root.code='TEST_FAULT';
 const entered=deferred(),release=deferred();let binding,postCalls=0,laterCalls=0,phase=null;
 const publish=async(key,value)=>{
  postCalls++;phase='post';assert.deepEqual(binding.getRecorded(),{value:input});
  if(pause){entered.resolve();await release.promise;}
  if(mode==='before-register')throw root;
  if(mode==='partial'){
   // Test-only fan-out. Core bindJobForm still posts ONE outputKey/value.
   for(const key of ['X','Y','Z']){if(key==='Z')throw root;await products.put(key,value[key]);}
  }else{await products.put(key,value);if(mode==='after-register')throw root;}
 };
 const destination={has:k=>products.has(k),get:k=>products.get(k),get put(){
  // Property resolution happens after internal record, BEFORE publish is called.
  // During bind-time validation binding is still undefined.
  if(mode==='before-post'&&binding?.getRecorded()!==null&&binding!==undefined){phase='before-post';assert.deepEqual(binding.getRecorded(),{value:input});throw root;}
  return publish;
 }};
 binding=bindJobForm(form,destination,mode==='partial'?'bundle':'X');
 const next=new CDummyJob('next',()=>{laterCalls++;});
 const workflow=new CWorkflow([{no:10,job:binding.job,nextStepNo:20},{no:20,job:next}],history);
 return {id,mode,products,binding,history,root,entered,release,run:()=>workflow.run(id,10),postCalls:()=>postCalls,laterCalls:()=>laterCalls,phase:()=>phase};
}
function verifyError(f,result){
 assert.equal(result.status,'FAILED');assert.equal(result.currentStepNo,10);assert.equal(result.history.length,1);assert.equal(f.laterCalls(),0);assert.equal(f.products.get('PREVIOUS'),999);
 const stored=f.history.load(f.id);assert.deepEqual(stored,result);assert.equal(stored.runId,f.id);
 const entry=stored.history[0];assert.deepEqual(Object.keys(entry).sort(),['order','stepNo','job','result','nextStepNo','at','error'].sort());
 assert.equal(entry.stepNo,10);assert.equal(entry.job,'producer');assert.equal(entry.result,'ERROR');assert.equal(entry.nextStepNo,null);assert.equal(entry.error,String(f.root));assert.ok(Number.isFinite(Date.parse(entry.at)));
 assert.equal(entry.phase,undefined);assert.equal(entry.stack,undefined);assert.equal(entry.cause,undefined);assert.equal(entry.code,undefined);assert.equal(typeof entry.error,'string');
 assert.ok(f.root instanceof TypeError);assert.equal(typeof f.root.stack,'string');assert.equal(f.root.code,'TEST_FAULT');assert.equal(f.products.has('error'),false);assert.equal(f.products.has('ERROR'),false);
}
for(const [caseId,mode]of [['A','before-post'],['B','before-register'],['C','after-register']])test(`${caseId}: ${mode}, internal/public/error observations`,async()=>{
 const f=fixture('009-'+caseId,mode),result=await f.run();verifyError(f,result);assert.deepEqual(f.binding.getRecorded(),{value:10});
 assert.equal(f.products.has('X'),caseId==='C');if(caseId==='C')assert.equal(f.products.get('X'),10);
 assert.equal(f.postCalls(),caseId==='A'?0:1);assert.equal(f.phase(),caseId==='A'?'before-post':'post');
 assert.deepEqual(await new CWorkflowMonitor(f.history).get(f.id),result);
 // Source exception identity/stack/code exist only at the fault injector, not in stored TraceEntry.
 assert.equal(JSON.stringify(result).includes('TEST_FAULT'),false);assert.equal(JSON.stringify(result).includes('local cause only'),false);
});
test('D: test Adapter partially publishes X/Y then fails Z; internal bundle remains complete',async()=>{
 const input={X:10,Y:20,Z:30},f=fixture('009-D','partial',{input}),result=await f.run();verifyError(f,result);
 assert.deepEqual(f.binding.getRecorded(),{value:input});assert.equal(f.products.get('X'),10);assert.equal(f.products.get('Y'),20);assert.equal(f.products.has('Z'),false);assert.equal(f.products.has('bundle'),false);assert.equal(f.postCalls(),1);
 const published=['X','Y','Z'].filter(k=>f.products.has(k)),missing=['X','Y','Z'].filter(k=>!f.products.has(k));assert.deepEqual(published,['X','Y']);assert.deepEqual(missing,['Z']);
 assert.equal(result.history[0].published,undefined);assert.equal(result.history[0].phase,undefined);
});
for(const mode of ['before-register','after-register','partial'])test(`E: PREVIOUS survives ${mode}; history recording never publishes error products`,async()=>{
 const f=fixture('009-E-'+mode,mode,{input:mode==='partial'?{X:10,Y:20,Z:30}:10}),previous=f.products.get('PREVIOUS');
 await f.run();assert.equal(f.products.get('PREVIOUS'),previous);
 assert.equal(f.products.has('error'),false);assert.equal(f.products.has('stack'),false);assert.equal(f.products.has('009-E-'+mode),false);
 assert.equal(f.history.load(f.id).history[0].result,'ERROR');
});
for(const order of ['sequential','success-first','failure-first'])test(`F: same form, distinct execution data: ${order}`,async()=>{
 const history=new CMemoryHistoryStore(),ok=fixture('009-F-ok-'+order,'success',{input:10,history,pause:order!=='sequential'}),bad=fixture('009-F-bad-'+order,'after-register',{input:100,history,pause:order!=='sequential'});let good,failed;
 if(order==='sequential'){good=await ok.run();failed=await bad.run();}else{
  const p=ok.run(),q=bad.run();await Promise.all([ok.entered.promise,bad.entered.promise]);assert.equal(history.load(ok.id).status,'RUNNING');assert.equal(history.load(bad.id).status,'RUNNING');
  const [first,second,pf,ps]=order==='success-first'?[ok,bad,p,q]:[bad,ok,q,p];first.release.resolve();await pf;assert.equal(history.load(second.id).status,'RUNNING');assert.equal(second.laterCalls(),0);second.release.resolve();await ps;good=await p;failed=await q;
 }
 assert.equal(good.status,'COMPLETED');assert.equal(failed.status,'FAILED');assert.deepEqual(ok.binding.getRecorded(),{value:10});assert.deepEqual(bad.binding.getRecorded(),{value:100});assert.equal(ok.products.get('X'),10);assert.equal(bad.products.get('X'),100);
 assert.deepEqual(good.history.map(h=>h.result),['DONE','DONE']);assert.deepEqual(failed.history.map(h=>h.result),['ERROR']);assert.equal(good.history.some(h=>Object.hasOwn(h,'error')),false);assert.equal(ok.laterCalls(),1);assert.equal(bad.laterCalls(),0);
 const view=history.load(bad.id);view.history[0].error='changed';assert.equal(history.load(bad.id).history[0].error,String(bad.root));assert.equal(history.load(ok.id).history[0].result,'DONE');
});
test('G: accepted business FAIL is published normally; technical post error is history only',async()=>{
 const input={memberId:'M002',result:'FAIL',score:45},ok=fixture('009-G-business','success',{input}),bad=fixture('009-G-technical','before-register',{input});
 const normal=await ok.run(),failed=await bad.run();assert.equal(normal.status,'COMPLETED');assert.deepEqual(normal.history.map(h=>h.result),['DONE','DONE']);assert.deepEqual(ok.products.get('X'),input);assert.deepEqual(ok.binding.getRecorded(),{value:input});
 verifyError(bad,failed);assert.deepEqual(bad.binding.getRecorded(),{value:input});assert.equal(bad.products.has('X'),false);assert.equal(bad.products.has('error'),false);assert.deepEqual(bad.products.get('INPUT'),input);
});
