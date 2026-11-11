'use strict';
const {randomUUID}=require('node:crypto');
const {reconstructWorkflow,validatePrototypeDefinition}=require('../../../dist/src/prototype/definition');
const {createMemoryProductShelf}=require('../../../dist/src/prototype/job-form');
const {diagnoseSavedRun}=require('../../../dist/src/prototype/diagnosis');
const {hash}=require('./store.cjs');
const {fail}=require('./emulator.cjs');
// No alternate execution loop: existing CWorkflow and native CJob own all transitions.
async function createExecution(store,definition,forms,checks=new Map(),{resume=false,observe}={}){
 const d=validatePrototypeDefinition(definition),state=await store.inspect();
 store.revision=state.head?.revision||0;
 if(state.head&&(state.head.definitionDigest!==hash(d)||state.head.definitionId!==d.definitionId||state.head.definitionVersion!==d.definitionVersion))fail('DEFINITION_CONFLICT');
 if(store.poisoned)fail('PERSISTENCE_UNCERTAIN');
 if(resume){
  const diagnostic=diagnoseSavedRun({runId:store.runId,run:state.head?{definitionId:d.definitionId,definitionVersion:d.definitionVersion,snapshot:state.head.snapshot}:null,
   traceRows:state.history,jobExecutions:state.jobs,jobArtifacts:state.artifacts,definition:d});
  if(diagnostic.classification!=='RESUMABLE_CANDIDATE')fail('RESUME_REJECTED');
 }
 const products=createMemoryProductShelf(),bindings=[],artifacts=[];let current;
 for(const a of state.artifacts)if(a.kind==='PUBLISHED')products.put(a.artifactKey,a.value);
 const identity={definitionId:d.definitionId,definitionVersion:d.definitionVersion,definitionDigest:hash(d)};
 const rows=()=>bindings.map(b=>({...b.identity,...b.job.getState()}));
 const save=async(snapshot,extra=[])=>store.commit({...identity,...(snapshot?{snapshot}:{}),jobs:rows(),artifacts:extra});
 const shelf={has:k=>products.has(k),get:k=>products.get(k),put:async(key,value)=>{
  if(!current)fail('JOB_BINDING_MISSING');
  const recorded=current.job.getRecorded();if(!recorded)fail('INTERNAL_MISSING');
  const base={jobExecutionId:current.identity.jobExecutionId,artifactKey:key,type:value===null?'null':Array.isArray(value)?'array':typeof value};
  const internal={...base,kind:'INTERNAL',value:recorded.value,publicationEvidence:null};
  await save(null,[internal]);if(observe)await observe({phase:'recorded',key,value:recorded.value,published:products.has(key)});
  const published={...base,kind:'PUBLISHED',value,publicationEvidence:'RETURNED'};
  await save(null,[published]);products.put(key,value);artifacts.push(internal,published);
 }};
 const wrapped=new Map();
 for(const [id,r] of forms){const original=r.form;wrapped.set(id,{artifactKey:r.artifactKey,form:{name:original.name,
  collect:async reader=>{await save();return original.collect(reader);},make:input=>original.make(input),
  ...(original.record?{record:output=>original.record(output)}:{})}});}
 const historyStore={load:id=>store.load(id),save:snapshot=>save(snapshot)};
 const graph=reconstructWorkflow(d,{jobs:new Map(),checks,jobForms:{definitions:wrapped,products:shelf,onCreate:(job,ctx)=>{
  current={job,identity:{jobExecutionId:randomUUID(),runId:store.runId,...ctx}};delete current.identity.definitionId;delete current.identity.definitionVersion;bindings.push(current);
 }}},historyStore,resume?{history:state.history}:undefined);
 return {products,graph,bindings,artifacts,run:async(max=100)=>resume?
  graph.workflow.resume(state.head.snapshot,max):graph.workflow.run(store.runId,graph.startStepNo,max)};
}
module.exports={createExecution};
