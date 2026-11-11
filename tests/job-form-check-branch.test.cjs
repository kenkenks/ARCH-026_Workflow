'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CWorkflow,CCheckJob,CDummyJob,CMemoryHistoryStore}=require('../dist/src/prototype/workflow');
const {createMemoryProductShelf,bindJobForm}=require('../dist/src/prototype/job-form');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
const missing=Symbol('missing');
const predicates=Object.freeze({PASS:value=>value==='PASS',FAIL:value=>value==='FAIL'});
const generator=Object.freeze({name:'generate',collect:r=>r.get('INPUT'),make:x=>structuredClone(x)});
const routes=Object.freeze({if:{pass:100,otherwise:200},switch:{pass:100,fail:200,pending:300}});
function readResult(reader,allowed){
 if(!reader.has('examResult'))throw Error('examResult missing');
 const value=reader.get('examResult');
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('invalid examResult type');
 if(!Object.hasOwn(value,'result'))throw Error('result missing');
 if(!allowed.includes(value.result))throw Error('undefined result');
 return value.result;
}
function fixture(id,business,{kind='switch',history=new CMemoryHistoryStore(),pause=false,faultAt=null}={}){
 const raw=createMemoryProductShelf(),source=business===missing?missing:structuredClone(business),entered=deferred(),release=deferred();let writes=0;
 raw.put('PREVIOUS',999);if(source!==missing)raw.put('INPUT',source);
 const products={has:k=>raw.has(k),get:k=>raw.get(k),put:(k,v)=>{writes++;return raw.put(k,v);}};
 const reader=Object.freeze({has:k=>products.has(k),get:k=>products.get(k)});
 const generated=bindJobForm(generator,products,'examResult');
 const producer=source===missing?new CDummyJob('generate'):generated.job;
 const notifications=[],observed=[],comparisons=[];
 const allowed=kind==='if'?['PASS','FAIL']:['PASS','FAIL','PENDING'];
 function condition(label,no){return {evaluate:async()=>{
  const before=products.get('examResult'),count=writes;
  assert.equal(reader.put,undefined);
  if(pause&&no===20){entered.resolve();await release.promise;}
  const businessResult=readResult(reader,allowed); // Reject unknowns BEFORE predicate/default selection.
  if(faultAt===no)throw new TypeError('injected Check evaluation failure');
  comparisons.push(label);const result=predicates[label](businessResult);observed.push({check:label,businessResult,result});
  assert.deepEqual(products.get('examResult'),before);assert.equal(writes,count);return result;
 }};}
 const checks=[new CCheckJob('is-PASS',condition('PASS',20),kind==='if'?routes.if.otherwise:30,routes[kind].pass)];
 const steps=[{no:10,job:producer,nextStepNo:20},{no:20,job:checks[0]}];
 if(kind==='switch'){checks.push(new CCheckJob('is-FAIL',condition('FAIL',30),routes.switch.pending,routes.switch.fail));steps.push({no:30,job:checks[1]});}
 // Notifications are local observations only: no email, no Check reference and no shelf writes.
 for(const [name,no]of Object.entries(routes[kind]))steps.push({no,job:new CDummyJob('notify-'+name,()=>{notifications.push(name);})});
 return {id,source,products,history,checks,notifications,observed,comparisons,entered,release,writes:()=>writes,workflow:new CWorkflow(steps,history)};
}
function data(result){return {memberId:result==='PASS'?'M001':result==='FAIL'?'M002':'M003',result,score:result==='PASS'?85:result==='FAIL'?45:50};}
function verify(f,result,business){
 const chosen=business.toLowerCase();assert.equal(result.status,'COMPLETED');assert.equal(f.notifications.length,1);
 assert.equal(f.notifications[0],chosen); // Only the expected branch executes.
 assert.equal(f.writes(),1);assert.deepEqual(f.products.get('examResult'),data(business));assert.equal(f.products.get('PREVIOUS'),999);
 assert.deepEqual(f.history.load(f.id),result);
}
for(const business of ['PASS','FAIL'])test(`A IF ${business}: one notification, valid FAIL completes normally`,async()=>{
 const f=fixture('010-A-'+business,data(business),{kind:'if'}),result=await f.workflow.run(f.id,10);assert.equal(result.status,'COMPLETED');assert.deepEqual(f.notifications,[business==='PASS'?'pass':'otherwise']);
 assert.deepEqual(result.history.map(h=>[h.stepNo,h.result,h.nextStepNo]),[[10,'DONE',20],[20,business==='PASS'?'TRUE':'FALSE',business==='PASS'?100:200],[business==='PASS'?100:200,'DONE',null]]);
 assert.equal(f.writes(),1);assert.deepEqual(f.products.get('examResult'),data(business));
});
for(const business of ['PASS','FAIL','PENDING'])test(`B Switch via two boolean Checks: ${business}`,async()=>{
 const f=fixture('010-B-'+business,data(business)),r=await f.workflow.run(f.id,10);verify(f,r,business);
 const expected=business==='PASS'?[[20,'TRUE',100]]:business==='FAIL'?[[20,'FALSE',30],[30,'TRUE',200]]:[[20,'FALSE',30],[30,'FALSE',300]];
 assert.deepEqual(r.history.filter(h=>[20,30].includes(h.stepNo)).map(h=>[h.stepNo,h.result,h.nextStepNo]),expected);
 assert.deepEqual(f.observed.map(x=>x.businessResult),expected.map(()=>business));assert.deepEqual(r.history.filter(h=>[100,200,300].includes(h.stepNo)).map(h=>h.stepNo),[routes.switch[business.toLowerCase()]]);
});
const invalids=[['missing key',missing],['null',null],['no result',{memberId:'M003'}],['unknown',{result:'UNKNOWN'}],['number',42],['string','PASS'],['array',[]],['boolean',true],['result object',{result:{}}]];
for(const kind of ['if','switch'])for(const [name,value]of invalids)test(`C ${kind} rejects ${name} without FAIL/PENDING fallback`,async()=>{
 const f=fixture('010-C-'+kind+'-'+name,value,{kind}),r=await f.workflow.run(f.id,10);
 assert.equal(r.status,'FAILED');assert.equal(r.currentStepNo,20);assert.deepEqual(f.notifications,[]);assert.deepEqual(f.comparisons,[]);assert.deepEqual(f.observed,[]);
 assert.deepEqual(r.history.map(h=>[h.stepNo,h.result,h.nextStepNo]),[[10,'DONE',20],[20,'ERROR',null]]);assert.equal(r.history[1].job,'is-PASS');assert.equal(typeof r.history[1].error,'string');assert.equal(f.products.get('PREVIOUS'),999);
 if(value===missing){assert.equal(f.products.has('examResult'),false);assert.equal(f.writes(),0);}else{assert.deepEqual(f.products.get('examResult'),value);assert.equal(f.writes(),1);}
 assert.deepEqual(f.history.load(f.id),r);
});
test('C IF treats PENDING as unsupported, never as business FAIL',async()=>{
 const f=fixture('010-C-if-pending',data('PENDING'),{kind:'if'}),r=await f.workflow.run(f.id,10);assert.equal(r.status,'FAILED');assert.deepEqual(f.notifications,[]);assert.match(r.history[1].error,/undefined result/);
});
test('D read-only Check view, detached retrieved value, no output publication',async()=>{
 const f=fixture('010-D',data('PENDING'));const r=await f.workflow.run(f.id,10);verify(f,r,'PENDING');
 const view=f.products.get('examResult');view.result='PASS';assert.deepEqual(f.products.get('examResult'),data('PENDING'));assert.equal(f.writes(),1);
 assert.deepEqual(r.history.filter(h=>h.result==='FALSE').map(h=>h.job),['is-PASS','is-FAIL']);assert.equal(f.products.has('notification'),false);
});
for(const order of ['sequential','PASS-FAIL-PENDING','PENDING-FAIL-PASS'])test(`E shared definitions, fresh Check instances: ${order}`,async()=>{
 const history=new CMemoryHistoryStore(),all=Object.fromEntries(['PASS','FAIL','PENDING'].map(b=>[b,fixture('010-E-'+order+'-'+b,data(b),{history,pause:order!=='sequential'})]));
 assert.notStrictEqual(all.PASS.checks[0],all.FAIL.checks[0]);assert.notStrictEqual(all.FAIL.checks[0],all.PENDING.checks[0]);
 if(order==='sequential'){for(const b of Object.keys(all)){const f=all[b];verify(f,await f.workflow.run(f.id,10),b);}}
 else{const promises=Object.fromEntries(Object.entries(all).map(([b,f])=>[b,f.workflow.run(f.id,10)]));await Promise.all(Object.values(all).map(f=>f.entered.promise));
  for(const b of order.split('-')){const f=all[b];f.release.resolve();verify(f,await promises[b],b);for(const [other,g]of Object.entries(all)){if(!g.notifications.length)assert.equal(history.load(g.id).status,'RUNNING');}}
 }
 for(const [b,f]of Object.entries(all)){assert.deepEqual(f.products.get('examResult'),data(b));assert.equal(history.load(f.id).status,'COMPLETED');assert.equal(f.notifications.length,1);}
 const changed=history.load(all.FAIL.id);changed.history[1].result='ERROR';assert.equal(history.load(all.PASS.id).history[1].result,'TRUE');assert.equal(history.load(all.FAIL.id).history[1].result,'FALSE');
});
for(const no of [20,30])test(`F predicate exception at Check ${no}: published products preserved and notifications stopped`,async()=>{
 const f=fixture('010-F-'+no,data('FAIL'),{faultAt:no}),r=await f.workflow.run(f.id,10);assert.equal(r.status,'FAILED');assert.equal(r.currentStepNo,no);assert.deepEqual(f.notifications,[]);assert.deepEqual(f.products.get('examResult'),data('FAIL'));assert.equal(f.products.get('PREVIOUS'),999);assert.equal(f.writes(),1);
 const error=r.history.at(-1);assert.equal(error.stepNo,no);assert.equal(error.result,'ERROR');assert.equal(error.nextStepNo,null);assert.equal(error.error,'TypeError: injected Check evaluation failure');assert.equal(error.stack,undefined);assert.equal(error.phase,undefined);assert.equal(error.published,undefined);assert.deepEqual(f.history.load(f.id),r);
});
