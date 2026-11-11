'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CWorkflow,CCheckJob,CDummyJob,CMemoryHistoryStore,CWorkflowMonitor}=require('../dist/src/prototype/workflow');
const {bindJobForm,createMemoryProductShelf}=require('../dist/src/prototype/job-form');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function key(mode,n){return mode==='same'?'X':'X_'+n;}
const forms=Object.freeze({
 A:Object.freeze({name:'A-work',collect:r=>r.get('ITERATION'),make:n=>n*10}),
 B:Object.freeze({name:'B-work',collect:r=>{const n=r.get('ITERATION'),value=r.get(key(r.get('MODE'),n));if(typeof value!=='number')throw Error('missing X');return {n,value,failAt:r.get('FAIL_AT')};},make:x=>{if(x.n===x.failAt)throw Error('B failed on iteration '+x.n);return x.value;}})
});
const conditions=Object.freeze({entry:(limit,count)=>limit>0,continue:(limit,count)=>count<limit});
function fixture(id,limit,{mode='generation',failAt=0,entry=true,pause=false,history=new CMemoryHistoryStore()}={}){
 const products=createMemoryProductShelf();products.put('MODE',mode);products.put('FAIL_AT',failAt);products.put('ITERATION',0);products.put('PREVIOUS',999);
 const entered=deferred(),release=deferred(),events=[],records=[],checks=[],seen=[],final=[];let count=0,aCalls=0,bCalls=0,cCalls=0;
 // These reusable CDummyJobs create a fresh SINGLE-USE CMRP binding on every visit.
 // Mutable round state is owned only by this test execution, never by shared forms.
 const a=new CDummyJob('A',async()=>{aCalls++;if(pause&&aCalls===1){entered.resolve();await release.promise;}count++;products.put('ITERATION',count);events.push('A'+count);const binding=bindJobForm(forms.A,products,key(mode,count));records.push({job:'A',iteration:count,binding});await binding.job.execute();});
 const b=new CDummyJob('B',async()=>{bCalls++;events.push('B'+count);seen.push(products.get(key(mode,count)));const binding=bindJobForm(forms.B,products,'B_'+count);records.push({job:'B',iteration:count,binding});await binding.job.execute();});
 const reader=Object.freeze({get:k=>products.get(k)});
 function condition(name){return {evaluate:()=>{const n=reader.get('ITERATION'),before=products.get(key(mode,n));assert.equal(history.load(id).status,'RUNNING');const result=conditions[name](limit,n);checks.push({name,iteration:n,result});assert.equal(products.get(key(mode,n)),before);return result;}};}
 const entryCheck=new CCheckJob('entry?',condition('entry'),40,10),continueCheck=new CCheckJob('continue?',condition('continue'),40,10);
 const c=new CDummyJob('C',()=>{cCalls++;events.push('C');if(mode==='same'){if(count)final.push(products.get('X'));}else for(let n=1;n<=count;n++)final.push(products.get('X_'+n));});
 const steps=[...(entry?[{no:5,job:entryCheck}]:[]),{no:10,job:a,nextStepNo:20},{no:20,job:b,nextStepNo:30},{no:30,job:continueCheck},{no:40,job:c}];
 return {id,products,history,workflow:new CWorkflow(steps,history),start:entry?5:10,entered,release,events,records,checks,seen,final,entryCheck,continueCheck,counts:()=>({A:aCalls,B:bCalls,C:cCalls}),iteration:()=>count};
}
function verifyCompleted(f,result,n){assert.equal(result.status,'COMPLETED');assert.deepEqual(f.counts(),{A:n,B:n,C:1});assert.deepEqual(f.events,[...Array.from({length:n},(_,i)=>['A'+(i+1),'B'+(i+1)]).flat(),'C']);assert.deepEqual(f.history.load(f.id),result);assert.equal(f.products.get('PREVIOUS'),999);}
test('A: A/B repeat three times using existing backward targets, C once',async()=>{
 const f=fixture('011-A',3,{entry:false}),r=await f.workflow.run(f.id,f.start);verifyCompleted(f,r,3);
 assert.deepEqual(r.history.map(h=>h.stepNo),[10,20,30,10,20,30,10,20,30,40]);assert.deepEqual(f.checks.map(x=>x.result),[true,true,false]);
 assert.deepEqual(r.history.filter(h=>h.stepNo===30).map(h=>[h.result,h.nextStepNo]),[['TRUE',10],['TRUE',10],['FALSE',40]]);
 const summary=await new CWorkflowMonitor(f.history).summary(f.id);assert.equal(summary.find(x=>x.stepNo===10).executions,3);assert.equal(summary.find(x=>x.stepNo===20).executions,3);
});
for(const n of [0,1,3])test(`B: entry condition allows ${n} body iterations`,async()=>{
 const f=fixture('011-B-'+n,n),r=await f.workflow.run(f.id,f.start);verifyCompleted(f,r,n);assert.equal(f.records.length,n*2);assert.equal(r.history[0].result,n?'TRUE':'FALSE');assert.equal(r.history.length,n?2+n*3:2);
 if(!n){assert.deepEqual(r.history.map(h=>h.stepNo),[5,40]);assert.equal(f.products.has('X_1'),false);}
});
for(const mode of ['same','generation'])test(`C: ${mode} keys, values and later consumer observations`,async()=>{
 const f=fixture('011-C-'+mode,3,{mode}),r=await f.workflow.run(f.id,f.start);verifyCompleted(f,r,3);assert.deepEqual(f.seen,[10,20,30]);
 if(mode==='same'){assert.equal(f.products.get('X'),30);assert.equal(f.products.has('X_1'),false);assert.deepEqual(f.final,[30]);}
 else{assert.deepEqual([1,2,3].map(n=>f.products.get('X_'+n)),[10,20,30]);assert.equal(f.products.has('X'),false);assert.deepEqual(f.final,[10,20,30]);}
 assert.deepEqual(f.records.filter(x=>x.job==='A').map(x=>x.binding.getRecorded().value),[10,20,30]);
 assert.deepEqual(r.history.filter(h=>h.stepNo===10).map(h=>h.order),[2,5,8]);
});
for(const mode of ['same','generation'])test(`D: B iteration two fails; preserve public products, ${mode}`,async()=>{
 const f=fixture('011-D-'+mode,3,{mode,failAt:2}),r=await f.workflow.run(f.id,f.start);assert.equal(r.status,'FAILED');assert.equal(r.currentStepNo,20);assert.deepEqual(f.counts(),{A:2,B:2,C:0});assert.deepEqual(f.events,['A1','B1','A2','B2']);
 assert.deepEqual(r.history.map(h=>[h.stepNo,h.result]),[[5,'TRUE'],[10,'DONE'],[20,'DONE'],[30,'TRUE'],[10,'DONE'],[20,'ERROR']]);assert.equal(r.history.at(-1).error,'Error: B failed on iteration 2');assert.equal(r.history.at(-1).order,6);
 assert.equal(f.products.get('B_1'),10);assert.equal(f.products.has('B_2'),false);assert.equal(f.products.has('X_3'),false);assert.equal(f.products.get('PREVIOUS'),999);
 if(mode==='generation'){assert.equal(f.products.get('X_1'),10);assert.equal(f.products.get('X_2'),20);}else{assert.equal(f.products.get('X'),20);}
 const b2=f.records.find(x=>x.job==='B'&&x.iteration===2);assert.equal(b2.binding.getRecorded(),null);assert.deepEqual(f.history.load(f.id),r);
 // Round is reconstructed from occurrence counts, not a new Core history field.
 assert.equal(r.history.filter(h=>h.stepNo===20).length,2);assert.equal(r.history.at(-1).iteration,undefined);
});
for(const order of ['sequential','one-three-fail','fail-three-one'])test(`E: independent loop state and fresh Check instances, ${order}`,async()=>{
 const history=new CMemoryHistoryStore(),runs={one:fixture('011-E-'+order+'-one',1,{history,pause:order!=='sequential'}),three:fixture('011-E-'+order+'-three',3,{history,pause:order!=='sequential'}),fail:fixture('011-E-'+order+'-fail',3,{history,pause:order!=='sequential',failAt:2})};
 assert.notStrictEqual(runs.one.continueCheck,runs.three.continueCheck);assert.notStrictEqual(runs.three.continueCheck,runs.fail.continueCheck);
 const results={};if(order==='sequential'){for(const [name,f]of Object.entries(runs))results[name]=await f.workflow.run(f.id,f.start);}
 else{const promises=Object.fromEntries(Object.entries(runs).map(([name,f])=>[name,f.workflow.run(f.id,f.start)]));await Promise.all(Object.values(runs).map(f=>f.entered.promise));for(const name of order.split('-')){const f=runs[name];f.release.resolve();results[name]=await promises[name];for(const other of Object.keys(runs)){if(!results[other])assert.equal(history.load(runs[other].id).status,'RUNNING');}}}
 verifyCompleted(runs.one,results.one,1);verifyCompleted(runs.three,results.three,3);assert.equal(results.fail.status,'FAILED');assert.deepEqual(runs.fail.counts(),{A:2,B:2,C:0});
 assert.equal(runs.one.products.has('X_2'),false);assert.equal(runs.three.products.get('X_3'),30);assert.equal(runs.fail.products.has('X_3'),false);
 const view=history.load(runs.fail.id);view.history.at(-1).error='modified';assert.equal(history.load(runs.fail.id).history.at(-1).error,'Error: B failed on iteration 2');assert.equal(history.load(runs.one.id).status,'COMPLETED');
});
test('F: finite ten-round condition, existing global execution limit stops at five entries',async()=>{
 const f=fixture('011-F',10),r=await f.workflow.run(f.id,f.start,5);assert.equal(r.status,'LIMIT_REACHED');assert.equal(r.history.length,5);assert.equal(r.currentStepNo,20);assert.deepEqual(f.counts(),{A:2,B:1,C:0});assert.equal(r.history.some(h=>h.result==='ERROR'),false);assert.equal(f.products.get('X_2'),20);assert.equal(f.products.has('B_2'),false);
});
test('existing single-use binding cannot itself be revisited by a loop; adapter is required',async()=>{
 const products=createMemoryProductShelf(),history=new CMemoryHistoryStore(),binding=bindJobForm({name:'single-use',collect:()=>10,make:x=>x},products,'X');let visits=0;
 const check=new CCheckJob('continue?',{evaluate:()=>++visits<2},30,10);
 const wf=new CWorkflow([{no:10,job:binding.job,nextStepNo:20},{no:20,job:check},{no:30,job:new CDummyJob('end')}],history),r=await wf.run('011-single-use',10);
 assert.equal(r.status,'FAILED');assert.deepEqual(r.history.map(h=>h.result),['DONE','TRUE','ERROR']);assert.match(r.history.at(-1).error,/binding already used/);assert.equal(products.get('X'),10);assert.deepEqual(binding.getRecorded(),{value:10});
});
