'use strict';
const {validate}=require('./workflow-definitions');
/** Domain-neutral, manually stepped runtime. Business payloads stay inside registered handlers. */
class WorkflowRuntime {
 constructor(def,handlers={}, {executionMode='NORMAL',simulatedJobIds=[],runId=null}={}) {
  if(!['NORMAL','DEMO'].includes(executionMode)||!Array.isArray(simulatedJobIds)||(executionMode==='NORMAL'&&simulatedJobIds.length))throw Error('実行モードが不正です');
  this.executionMode=executionMode;this.simulatedJobIds=new Set(simulatedJobIds);this.simulatedJobUsed=false;
  if(runId!==null&&(typeof runId!=='string'||!runId.trim()))throw Error('実行IDが不正です');
  this.runId=runId;this.error=null;
  const errors=validate(def);if(errors.length)throw Error(errors.join(' / '));
  this.definition=JSON.parse(JSON.stringify(def));
  this.steps=new Map(this.definition.steps.map(s=>[s.id,s]));
  this.handlers=handlers;
  this.currentStepId=def.startStepId;this.status='READY';this.history=[];
  this.pending=null;this.maxSteps=1000;
  this.advancing=false;
 }
 snapshot(){return {runId:this.runId,error:this.error?{...this.error}:null,executionMode:this.executionMode,simulatedJobUsed:this.simulatedJobUsed,resultKind:this.status==='COMPLETED'?(this.executionMode==='DEMO'?'DEMO_COMPLETED':'CONTROL_FLOW_COMPLETED'):this.status,definitionId:this.definition.id,definitionVersion:this.definition.version,currentStepId:this.currentStepId,status:this.status,pending:this.pending?{...this.pending}:null,history:this.history.map(h=>({...h,...(h.diagnostic?{diagnostic:{...h.diagnostic}}:{})}))};}
 record(step,result,next,diagnostic){this.history.push({...(diagnostic?{diagnostic:{...diagnostic}}:{}),executionMode:this.executionMode,simulated:step.type==='JOB'&&this.simulatedJobIds.has(step.jobId),order:this.history.length+1,stepId:step.id,type:step.type,result,nextStepId:next,at:new Date().toISOString()});}
 fail(step,code,summary,result='ERROR'){
  // Only fixed summaries are public; raw Handler exceptions are never serialized.
  this.error={code,stepId:step?.id??null,summary,executionMode:this.executionMode,runId:this.runId};
  this.status='FAILED';this.pending=null;
  if(step)this.record(step,result,null,this.error);
 }
 async advance({checkResult}={}){
  if(this.advancing)throw Object.assign(Error('同一Runtimeの工程を実行中です'),{code:'RUNTIME_BUSY',status:409});
  this.advancing=true;
  try {
  if(['COMPLETED','FAILED'].includes(this.status))throw Error('実行は終了しています');
  if(this.history.length>=this.maxSteps){this.status='FAILED';throw Error('実行上限に達しました');}
  const s=this.steps.get(this.currentStepId);
  if(s.type==='END'){this.record(s,'DONE',null);this.currentStepId=null;this.status='COMPLETED';this.pending=null;return this.snapshot();}
  if(s.type==='JOB'){
   const handler=this.handlers[s.jobId];
   if(typeof handler!=='function'){this.fail(null,'HANDLER_NOT_FOUND','JOBの実装が登録されていません');this.error.stepId=s.id;throw Error(`実装未登録のJOB: ${s.jobId}`);}
   let result;let failureCode='HANDLER_EXCEPTION';
   try {
    if(this.simulatedJobIds.has(s.jobId))this.simulatedJobUsed=true;
    result=await handler({stepId:s.id,definitionId:this.definition.id});
    if(!result||!['COMPLETED','WAITING','FAILED'].includes(result.status)){failureCode='INVALID_JOB_RESULT';throw Error('JOBの戻り値が不正です');}
   }catch(error){this.fail(s,failureCode,failureCode==='INVALID_JOB_RESULT'?'JOBの戻り値が不正です':'JOB Handlerで例外が発生しました');throw error;}
   if(result.status==='WAITING'){this.status='WAITING';this.pending={stepId:s.id,kind:'JOB'};return this.snapshot();}
   if(result.status==='FAILED'){this.fail(s,'JOB_FAILED','JOBが失敗を返しました','FAILED');return this.snapshot();}
   this.record(s,'DONE',s.nextStepId);this.currentStepId=s.nextStepId;this.status='ACTIVE';this.pending=null;return this.snapshot();
  }
  if(!['CHECK_FINAL','CHECK_PROVISIONAL','CHECK_WAIT'].includes(s.type))throw Error(`未対応工程: ${s.type}`);
  if(checkResult===undefined){this.status='WAITING';this.pending={stepId:s.id,kind:'CHECK',type:s.type};return this.snapshot();}
  if(!['PASS','WAIT','REJECT','ERROR'].includes(checkResult))throw Error('判定結果が不正です');
  if(checkResult==='WAIT'){this.status='WAITING';this.pending={stepId:s.id,kind:'CHECK',type:s.type};return this.snapshot();}
  if(checkResult==='ERROR'){this.fail(s,'CHECK_ERROR','CHECKでERRORが指定されました');return this.snapshot();}
  if(checkResult==='REJECT'&&!s.retryTargetStepId){this.record(s,'REJECT',null);this.status='FAILED';this.pending=null;return this.snapshot();}
  const next=checkResult==='PASS'?s.nextStepId:s.retryTargetStepId;
  this.record(s,checkResult,next);this.currentStepId=next;this.status='ACTIVE';this.pending=null;return this.snapshot();
  }finally{this.advancing=false;}
 }
}
module.exports={WorkflowRuntime};
