'use strict';
const {reconstructWorkflow}=require('../../dist/src/prototype/definition');
const definition={schemaVersion:'prototype-workflow/2',definitionId:'waiting-test',definitionVersion:'2',startStepId:'a',steps:[
 {stepId:'a',stepNo:10,kind:'JOB',jobId:'a',nextStepId:'wait'},
 {stepId:'wait',stepNo:20,kind:'WAIT',reason:'authorized-input',nextStepId:'check'},
 {stepId:'check',stepNo:30,kind:'CHECK_BOOL',checkId:'approved',trueStepId:'b',falseStepId:'return'},
 {stepId:'b',stepNo:40,kind:'JOB',jobId:'b'},
 {stepId:'return',stepNo:50,kind:'JOB',jobId:'return',nextStepId:'wait'}]};
const config={runId:'run',definitionId:definition.definitionId,definitionVersion:'2',definitionDigest:require('node:crypto').createHash('sha256').update(JSON.stringify(definition)).digest('hex')};
function graph(store,calls=[],{fail=false,hold}={}){
 const jobForms={products:store.products,definitions:new Map(['a','b','return'].map(id=>[id,{artifactKey:id,form:{name:id,
  collect:reader=>{calls.push(id+':collect');return id==='a'?10:reader.get('a');},
  make:async n=>{calls.push(id+':make');if(id==='b'&&hold)await hold;if(id==='b'&&fail)throw Error('technical');return id==='a'?n:n+20;},
  record:()=>calls.push(id+':record')}}]))};
 return reconstructWorkflow(definition,{jobs:new Map(),jobForms,checks:new Map([['approved',()=>({evaluate:()=>{calls.push('check');return store.getInput().approved===true;}})]])},store,{history:store.load(config.runId)?.history||[]}).workflow;
}
function request(store,operationId='resume-1',approved=true){const r=store.read();return {runId:config.runId,operationId,expectedWaitGeneration:r.snapshot.waiting.generation,expectedRevision:r.revision,result:{approved}};}
module.exports={config,definition,graph,request};
