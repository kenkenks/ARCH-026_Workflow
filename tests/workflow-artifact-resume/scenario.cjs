'use strict';
const {createHash}=require('node:crypto');
const api={...require('../../dist/src/prototype/workflow'),...require('../../dist/src/prototype/definition'),...require('../../dist/Frwk_Units/Workflow/src/CJobForm'),...require('../../dist/Frwk_Units/Workflow/src/ArtifactSnapshot'),ArtifactManager:require('../../dist/Frwk_Units/Workflow/src/ArtifactManager').ArtifactManager};
const {WaitingHistoryStore,SQLiteLifecycleBackend}=require('../../src/adapters/workflow-waiting/sqlite.cjs');
const {definitionDigest}=require('../../src/adapters/workflow-waiting/lifecycle.cjs');
function definition(kind='WAITING'){
 const steps=[{stepId:'p',stepNo:10,kind:'JOB',jobId:'p',output:{box:'review'},nextStepId:kind==='WAITING'?'w':'q'}];
 if(kind==='WAITING')steps.push({stepId:'w',stepNo:20,kind:'WAIT',reason:'teacher-approval',nextStepId:'check'},{stepId:'check',stepNo:30,kind:'CHECK_BOOL',checkId:'approve',trueStepId:'q',falseStepId:'p'});
 steps.push({stepId:'q',stepNo:40,kind:'JOB',jobId:'q'});
 return api.validatePrototypeDefinition({schemaVersion:'prototype-workflow/3',definitionId:'restore-synthetic',definitionVersion:'1',startStepId:'p',artifactBoxes:['review','empty'],steps});
}
function options(d,runId='run',ownerId='host-a'){return {runId,ownerId,definitionId:d.definitionId,definitionVersion:d.definitionVersion,definitionDigest:definitionDigest(d),leaseMs:60000};}
function registry(store,calls=[],hooks={}){
 class Produce extends api.CJobForm{constructor(){super('producer');}collect(){calls.push('p');return {n:7};}make(v){return v;}post(v,c){c.products.put('U',undefined);return super.post(v,c);}}
 class Consume extends api.CJobForm{constructor(){super('consumer');}collect(p,c){calls.push('q');return {value:c.artifacts.box('review').get('X'),hasUndefined:p.has('U'),undefinedValue:p.get('U'),hasEmpty:c.artifacts.hasBox('empty')};}make(v){return v;}record(v){return hooks.record?.(v,store);}post(v,c){return hooks.post?hooks.post(v,c):super.post(v,c);}}
 return {jobs:new Map(),checks:new Map([['approve',()=>({evaluate:()=>{calls.push('check');return store.getInput().approved;}})]]),nativeForms:new Map([['p',{form:new Produce(),artifactKey:'X'}],['q',{form:new Consume(),artifactKey:'RESULT'}]])};
}
async function start(store,d=definition(),calls=[]){store.claimStart('start');const g=api.reconstructWorkflow(d,registry(store,calls),store);const saved=await g.workflow.run(store.runId,g.startStepNo,d.steps.some(s=>s.kind==='WAIT')?100:1);return {g,saved};}
function request(c,id='resume',approved=true){return c.workflowSnapshot.status==='WAITING'?{kind:'WAITING',operation:{runId:c.runId,operationId:id,expectedRevision:c.revision,expectedWaitGeneration:c.workflowSnapshot.waiting.generation,result:{approved}}}:{kind:'LIMIT_REACHED',operationId:id,expectedRevision:c.revision};}
function raw(backend,id='run'){return JSON.parse(backend.database.get('SELECT state_json FROM waiting_runs WHERE run_id=?',id).state_json);}
module.exports={api,definition,definitionDigest,options,registry,start,request,raw,WaitingHistoryStore,SQLiteLifecycleBackend,referenceDigest:d=>createHash('sha256').update(JSON.stringify(api.validatePrototypeDefinition(d))).digest('hex')};
