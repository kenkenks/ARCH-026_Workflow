'use strict';
const {definition,config}=require('../workflow-waiting/scenario.cjs');
const {reconstructWorkflow}=require('../../dist/src/prototype/definition');
async function graph(store,calls=[]){
 const snapshot=await store.load(config.runId);
 return reconstructWorkflow(definition,{jobs:new Map(),jobForms:{products:store.products,definitions:new Map(['a','b','return'].map(id=>[id,{artifactKey:id,form:{name:id,
  collect:p=>{calls.push(id+':collect');return id==='a'?10:p.get('a');},make:x=>{calls.push(id+':make');return id==='a'?x:x+20;},record:()=>calls.push(id+':record')}}]))},
  checks:new Map([['approved',()=>({evaluate:()=>{calls.push('check');return store.getInput().approved===true;}})]])},store,{history:snapshot?.history||[]}).workflow;
}
async function request(store,id='resume',approved=true){const r=await store.read();return {runId:config.runId,operationId:id,expectedWaitGeneration:r.snapshot.waiting.generation,expectedRevision:r.revision,result:{approved}};}
module.exports={graph,request,config,definition};
