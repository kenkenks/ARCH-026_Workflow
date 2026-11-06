'use strict';
const {validate}=require('./workflow-definitions');
/** Domain-neutral, manually stepped runtime. Business payloads stay inside registered handlers. */
class WorkflowRuntime {
 constructor(def,handlers={}, {executionMode='NORMAL',simulatedJobIds=[]}={}) {
  if(!['NORMAL','DEMO'].includes(executionMode)||!Array.isArray(simulatedJobIds)||(executionMode==='NORMAL'&&simulatedJobIds.length))throw Error('実行モードが不正です');
  this.executionMode=executionMode;this.simulatedJobIds=new Set(simulatedJobIds);this.simulatedJobUsed=false;
  const errors=validate(def);if(errors.length)throw Error(errors.join(' / '));
  this.definition=JSON.parse(JSON.stringify(def));
  this.steps=new Map(this.definition.steps.map(s=>[s.id,s]));
  this.handlers=handlers;
  this.currentStepId=def.startStepId;this.status='READY';this.history=[];
  this.pending=null;this.maxSteps=1000;
 }
 snapshot(){return {executionMode:this.executionMode,simulatedJobUsed:this.simulatedJobUsed,resultKind:this.status==='COMPLETED'?(this.executionMode==='DEMO'?'DEMO_COMPLETED':'CONTROL_FLOW_COMPLETED'):this.status,definitionId:this.definition.id,definitionVersion:this.definition.version,currentStepId:this.currentStepId,status:this.status,pending:this.pending?{...this.pending}:null,history:this.history.map(h=>({...h}))};}
 record(step,result,next){this.history.push({executionMode:this.executionMode,simulated:step.type==='JOB'&&this.simulatedJobIds.has(step.jobId),order:this.history.length+1,stepId:step.id,type:step.type,result,nextStepId:next,at:new Date().toISOString()});}
 async advance({checkResult}={}){
  if(['COMPLETED','FAILED'].includes(this.status))throw Error('実行は終了しています');
  if(this.history.length>=this.maxSteps){this.status='FAILED';throw Error('実行上限に達しました');}
  const s=this.steps.get(this.currentStepId);
  if(s.type==='END'){this.record(s,'DONE',null);this.currentStepId=null;this.status='COMPLETED';this.pending=null;return this.snapshot();}
  if(s.type==='JOB'){
   const handler=this.handlers[s.jobId];
   if(typeof handler!=='function'){this.status='FAILED';this.pending=null;throw Error(`実装未登録のJOB: ${s.jobId}`);}
   let result;
   try {
    if(this.simulatedJobIds.has(s.jobId))this.simulatedJobUsed=true;
    result=await handler({stepId:s.id,definitionId:this.definition.id});
    if(!result||!['COMPLETED','WAITING','FAILED'].includes(result.status))throw Error('JOBの戻り値が不正です');
   }catch(error){this.record(s,'ERROR',null);this.status='FAILED';this.pending=null;throw error;}
   if(result.status==='WAITING'){this.status='WAITING';this.pending={stepId:s.id,kind:'JOB'};return this.snapshot();}
   if(result.status==='FAILED'){this.record(s,'FAILED',null);this.status='FAILED';this.pending=null;return this.snapshot();}
   this.record(s,'DONE',s.nextStepId);this.currentStepId=s.nextStepId;this.status='ACTIVE';this.pending=null;return this.snapshot();
  }
  if(!['CHECK_FINAL','CHECK_PROVISIONAL','CHECK_WAIT'].includes(s.type))throw Error(`未対応工程: ${s.type}`);
  if(checkResult===undefined){this.status='WAITING';this.pending={stepId:s.id,kind:'CHECK',type:s.type};return this.snapshot();}
  if(!['PASS','WAIT','REJECT','ERROR'].includes(checkResult))throw Error('判定結果が不正です');
  if(checkResult==='WAIT'){this.status='WAITING';this.pending={stepId:s.id,kind:'CHECK',type:s.type};return this.snapshot();}
  if(checkResult==='ERROR'){this.record(s,'ERROR',null);this.status='FAILED';this.pending=null;return this.snapshot();}
  if(checkResult==='REJECT'&&!s.retryTargetStepId){this.record(s,'REJECT',null);this.status='FAILED';this.pending=null;return this.snapshot();}
  const next=checkResult==='PASS'?s.nextStepId:s.retryTargetStepId;
  this.record(s,checkResult,next);this.currentStepId=next;this.status='ACTIVE';this.pending=null;return this.snapshot();
 }
}
module.exports={WorkflowRuntime};
