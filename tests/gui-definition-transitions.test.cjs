'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validate,DefinitionStore}=require('../gui/workflow-definitions');
const {WorkflowRuntime}=require('../gui/workflow-runtime');
const linear=()=>({id:'test',version:'1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId:'job',nextStepId:'END'},{id:'END',type:'END'}]});
const branch=type=>({...linear(),steps:[{id:'J',type:'JOB',jobId:'job',nextStepId:'C'},{id:'C',type,nextStepId:'END',retryTargetStepId:'J'},{id:'END',type:'END'}]});
const success={job:async()=>({status:'COMPLETED'})};
test('JOB -> END validator and Runtime use the same edge',async()=>{
 const d=linear();assert.deepEqual(validate(d),[]);const r=new WorkflowRuntime(d,success);
 assert.equal((await r.advance()).currentStepId,'END');assert.equal((await r.advance()).status,'COMPLETED');
 assert.deepEqual(r.history.map(x=>[x.stepId,x.nextStepId]),[['J','END'],['END',null]]);
});
for(const type of ['CHECK_FINAL','CHECK_PROVISIONAL','CHECK_WAIT'])test(`${type}: WAIT, REJECT loop, PASS and ERROR match Runtime transitions`,async()=>{
 const d=branch(type);assert.deepEqual(validate(d),[]);const r=new WorkflowRuntime(d,success);
 await r.advance();assert.equal((await r.advance({checkResult:'WAIT'})).currentStepId,'C');assert.equal(r.history.length,1);
 assert.equal((await r.advance({checkResult:'REJECT'})).currentStepId,'J');await r.advance();
 assert.equal((await r.advance({checkResult:'REJECT'})).currentStepId,'J');await r.advance();
 assert.equal((await r.advance({checkResult:'PASS'})).currentStepId,'END');assert.equal((await r.advance()).status,'COMPLETED');
 assert.deepEqual(r.history.map(x=>x.stepId),['J','C','J','C','J','C','END']);
 const failed=new WorkflowRuntime(d,success);await failed.advance();assert.equal((await failed.advance({checkResult:'ERROR'})).status,'FAILED');
});
test('CHECK without retry is allowed and REJECT fails instead of following a nonexistent edge',async()=>{
 const d=branch('CHECK_FINAL');delete d.steps[1].retryTargetStepId;assert.deepEqual(validate(d),[]);
 const r=new WorkflowRuntime(d,success);await r.advance();assert.equal((await r.advance({checkResult:'REJECT'})).status,'FAILED');assert.equal(r.history[1].nextStepId,null);
});
const bad=[];
function invalid(name,mutate){const d=linear();mutate(d);bad.push([name,d]);}
invalid('JOB self-loop has no reachable END',d=>d.steps[0].nextStepId='J');
invalid('JOB retry cannot manufacture an END path',d=>{d.steps[0].nextStepId='J';d.steps[0].retryTargetStepId='END';});
invalid('JOB retry is unused even when next points to END',d=>d.steps[0].retryTargetStepId='J');
for(const key of ['nextStepId','retryTargetStepId'])for(const value of [false,0,null,'END'])invalid(`END ${key}=${JSON.stringify(value)}`,d=>d.steps[1][key]=value);
for(const key of ['nextStepId','jobId'])for(const value of [false,0,null,[],{},'', ' '])invalid(`JOB ${key} type ${JSON.stringify(value)}`,d=>d.steps[0][key]=value);
invalid('unknown next reference',d=>d.steps[0].nextStepId='MISSING');
invalid('duplicate Step ID',d=>d.steps.push({...d.steps[0]}));
invalid('unreachable END',d=>d.steps.push({id:'OTHER',type:'END'}));
invalid('array Step',d=>d.steps[0]=[]);
invalid('null event route does not crash validator',d=>d.eventRoutes=[null]);
for(const value of [false,0,null,[],{},'', ' ','MISSING']){const d=branch('CHECK_WAIT');d.steps[1].retryTargetStepId=value;bad.push([`CHECK retry ${JSON.stringify(value)}`,d]);}
for(const [name,d] of bad)test(`reject: ${name}`,()=>{const errors=validate(d);assert.ok(errors.length>0);assert.throws(()=>new WorkflowRuntime(d,success));});
test('all rejected definitions publish no files; valid save/read/execute still works',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-transitions-'));
 try{
  const store=new DefinitionStore(dir);
  for(const [,d] of bad){assert.throws(()=>store.save(d),e=>e.status===400);assert.deepEqual(fs.readdirSync(dir),[]);}
  const d=branch('CHECK_PROVISIONAL');store.save(d);const loaded=store.get(d.id,d.version);assert.deepEqual(loaded,d);
  const r=new WorkflowRuntime(loaded,success);await r.advance();await r.advance({checkResult:'PASS'});assert.equal((await r.advance()).status,'COMPLETED');
  const bytes=fs.readFileSync(store.file(d.id,d.version));assert.throws(()=>store.save(bad[0][1],{overwrite:true}),e=>e.status===400);assert.deepEqual(fs.readFileSync(store.file(d.id,d.version)),bytes);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('unknown metadata, omitted optional fields and independent event entry points are retained',()=>{
 const d=linear();d.metadata={custom:true};d.steps[0].custom='retained';d.steps.push({id:'EVENT_END',type:'END'});
 d.eventRoutes=[{eventId:'e',eventType:'test',guardId:'g',mode:'BRANCH',targetStepId:'EVENT_END'}];assert.deepEqual(validate(d),[]);
 const sample=require('../src/definitions/exam-workflow.example.json');assert.deepEqual(validate(sample),[]);
});
test('existing runnable definition saves, loads and executes with its registered test handlers',async()=>{
 const d=require('../src/definitions/exam-two-jobs.phase4c.example.json');assert.deepEqual(validate(d),[]);
 const handlers=Object.fromEntries(d.steps.filter(x=>x.type==='JOB').map(x=>[x.jobId,async()=>({status:'COMPLETED'})]));
 const r=new WorkflowRuntime(d,handlers);for(let i=0;i<d.steps.length;i++)await r.advance();assert.equal(r.status,'COMPLETED');assert.deepEqual(r.history.map(x=>x.stepId),d.steps.map(x=>x.id));
});
