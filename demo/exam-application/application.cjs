'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {CMemoryHistoryStore}=require('../../dist/src/prototype/workflow');
const {createMemoryProductShelf}=require('../../dist/src/prototype/job-form');
const {reconstructWorkflow,validatePrototypeDefinition}=require('../../dist/src/prototype/definition');
const {createForms,checks,labels}=require('./job-forms.cjs');
const definition=validatePrototypeDefinition(require('./definition.json'));
const members=Object.freeze(['T001','T002','T003']),grades=Object.freeze(['初段（合成）','二段（合成）','三級（合成）']);
const gates={20:['APPROVE','RETURN'],40:['CONFIRM_EXAM'],50:['REGISTER_RESULT'],95:['RESUBMIT']};
const actionNames={START:'申請開始',APPROVE:'承認',RETURN:'差し戻し',RESUBMIT:'再申請',CONFIRM_EXAM:'審査実施確認',REGISTER_RESULT:'結果登録'};
class DemoError extends Error{constructor(code,status=400){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new DemoError(code,status);};
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const exact=(x,keys)=>{if(!object(x)||Object.keys(x).length!==keys.length||keys.some(k=>!Object.hasOwn(x,k)))fail('INVALID_ARGUMENT');};
const text=(x,max=200)=>{if(typeof x!=='string'||!x.trim()||x.length>max)fail('INVALID_ARGUMENT');};
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail('INVALID_DATE');const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)fail('INVALID_DATE');}
function validatePayload(body){
 if(body.kind==='APPROVE')exact(body.payload,[]);
 if(body.kind==='RETURN'){exact(body.payload,['reason']);text(body.payload.reason);}
 if(body.kind==='CONFIRM_EXAM'){exact(body.payload,['examDate']);date(body.payload.examDate);}
 if(body.kind==='REGISTER_RESULT'){exact(body.payload,['result','score']);if(!['PASS','FAIL'].includes(body.payload.result)||typeof body.payload.score!=='number'||!Number.isFinite(body.payload.score)||body.payload.score<0||body.payload.score>100)fail('INVALID_ARGUMENT');}
 if(body.kind==='RESUBMIT'){exact(body.payload,['grade','note']);if(!grades.includes(body.payload.grade))fail('INVALID_ARGUMENT');if(typeof body.payload.note!=='string'||body.payload.note.length>200)fail('INVALID_ARGUMENT');}
}
const credentials=Object.freeze({
 'demo-applicant':Object.freeze({id:'demo-applicant',role:'APPLICANT'}),
 'demo-teacher':Object.freeze({id:'demo-teacher',role:'TEACHER'}),
 'demo-admin':Object.freeze({id:'demo-admin',role:'ADMIN'})
});
function principal(header){const key=typeof header==='string'&&header.startsWith('Bearer ')?header.slice(7):'';const p=credentials[key];if(!p)fail('UNAUTHENTICATED',401);return p;}
class ExamApplication {
 constructor({beforeSlice,afterOperation}={}){this.bootSessionId=randomUUID();this.apps=new Map();this.busy=new Set();this.beforeSlice=beforeSlice;this.afterOperation=afterOperation;this.closing=false;this.inflight=new Set();}
 config(){return {storage:'memory',emulator:false,bootSessionId:this.bootSessionId,members,grades,warning:'Memory方式：プロセス終了で全データ消失。再起動復元・分散所有権は保証しません。'};}
 authorize(p,a,writeKind){if(!p||!Object.values(credentials).includes(p))fail('UNAUTHENTICATED',401);if(a&&p.role==='APPLICANT'&&p.id!==a.createdBy)fail('FORBIDDEN',403);if(writeKind&& !((['START','RESUBMIT'].includes(writeKind)&&['APPLICANT','ADMIN'].includes(p.role))||(!['START','RESUBMIT'].includes(writeKind)&&['TEACHER','ADMIN'].includes(p.role))))fail('FORBIDDEN',403);}
 base(body){if(body.bootSessionId!==this.bootSessionId)fail('SESSION_CHANGED',409);if(typeof body.commandId!=='string'||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.commandId))fail('INVALID_COMMAND_ID');}
 get(id,p){const a=this.apps.get(id);if(!a)fail('NOT_FOUND',404);this.authorize(p,a);return this.view(a,p);}
 lookupCommand(id,commandId,p){const a=this.apps.get(id);if(!a)fail('NOT_FOUND',404);this.authorize(p,a);const c=a.commands.get(commandId);if(!c)fail('NOT_FOUND',404);return structuredClone(c.public);}
 lookupStart(commandId,p){this.authorize(p);const id='DEMO-'+createHash('sha256').update(JSON.stringify([p.id,commandId])).digest('hex').slice(0,24);return {operation:this.lookupCommand(id,commandId,p),state:this.get(id,p)};}
 guard(id,action){if(this.closing)fail('SHUTTING_DOWN',503);if(this.busy.has(id))fail('EXECUTION_BUSY',409);this.busy.add(id);
 const pending=(async()=>{try{return await action();}finally{this.busy.delete(id);}})();this.inflight.add(pending);pending.then(()=>this.inflight.delete(pending),()=>this.inflight.delete(pending));return pending;}
 async close(){this.closing=true;await Promise.allSettled([...this.inflight]);}
 async start(body,p){exact(body,['commandId','bootSessionId','memberId','grade']);this.base(body);this.authorize(p,null,'START');if(!members.includes(body.memberId)||!grades.includes(body.grade))fail('INVALID_ARGUMENT');
 const id='DEMO-'+createHash('sha256').update(JSON.stringify([p.id,body.commandId])).digest('hex').slice(0,24);
 return this.guard(id,async()=>{let a=this.apps.get(id);const prior=a?.commands.get(body.commandId);if(prior)return this.replay(a,prior,body,p);
 if(a)fail('APPLICATION_EXISTS',409);a={id,runId:'run-'+id,createdBy:p.id,createdAt:new Date().toISOString(),store:new CMemoryHistoryStore(),memory:createMemoryProductShelf(),commands:new Map(),jobs:[],artifacts:[],revision:0,blocked:false};this.apps.set(id,a);
 return this.apply(a,{kind:'START',payload:{memberId:body.memberId,grade:body.grade},...body},p,body);});
 }
 async command(id,body,p){exact(body,['commandId','bootSessionId','expectedRevision','expectedStepNo','kind','payload']);this.base(body);
 const a=this.apps.get(id);if(!a)fail('NOT_FOUND',404);this.authorize(p,a,body.kind);
 return this.guard(id,async()=>{const prior=a.commands.get(body.commandId);if(prior)return this.replay(a,prior,body,p);
 const s=a.store.load(a.runId);if(a.blocked||s?.status!=='LIMIT_REACHED')fail('STATE_CONFLICT',409);
 if(!Number.isSafeInteger(body.expectedRevision)||!Number.isSafeInteger(body.expectedStepNo)||body.expectedRevision!==a.revision||body.expectedStepNo!==s.currentStepNo)fail('STALE_STATE',409);
 if(!(gates[s.currentStepNo]||[]).includes(body.kind))fail('INVALID_OPERATION',409);
 if(s.history.length+4>100)fail('EXECUTION_LIMIT',409);
 validatePayload(body);
 return this.apply(a,body,p,body);});
 }
 replay(a,c,body,p){if(c.actorId!==p.id||!isDeepStrictEqual(c.request,body))fail('COMMAND_CONFLICT',409);return {replayed:true,operation:structuredClone(c.public),state:this.view(a,p)};}
 async apply(a,command,p,request){
 const before=a.store.load(a.runId),entry={actorId:p.id,request:structuredClone(request),public:{commandId:command.commandId,applicationId:a.id,actorId:p.id,kind:command.kind,operation:actionNames[command.kind],at:new Date().toISOString(),fromStep:before?.currentStepNo??null,fromStage:before?labels[before.currentStepNo]:'未申請',toStep:null,toStage:null,status:'ACCEPTED'}};
 a.commands.set(command.commandId,entry);
 const context=structuredClone({applicationId:a.id,createdAt:a.createdAt,kind:command.kind,payload:command.payload,commandId:command.commandId,actorId:p.id});
 try{
  for(let i=0;i<4;i++){
   const saved=a.store.load(a.runId);if(saved&&saved.status!=='LIMIT_REACHED')fail('UNSAFE_BOUNDARY',503);
   const sliceJobs=[];let current;
   const products={has:k=>a.memory.has(k),get:k=>a.memory.get(k),put:async(key,value)=>{const recorded=current.job.getRecorded();if(!recorded)throw Error('INTERNAL_REQUIRED');a.artifacts.push({jobExecutionId:current.id,commandId:command.commandId,key,internal:recorded.value,published:structuredClone(value)});a.memory.put(key,value);}};
   const graph=reconstructWorkflow(definition,{jobs:new Map(),checks:checks(products),jobForms:{definitions:createForms(context),products,onCreate:(job,visit)=>{current={id:randomUUID(),job,visit};sliceJobs.push(current);}}},a.store,saved?{history:saved.history}:undefined);
   if(this.beforeSlice)await this.beforeSlice({kind:command.kind,step:saved?.currentStepNo??10});
   let result;
   try{result=saved?await graph.workflow.resume(saved,1):await graph.workflow.run(a.runId,graph.startStepNo,1);}finally{for(const j of sliceJobs)a.jobs.push({jobExecutionId:j.id,...j.visit,...j.job.getState(),commandId:command.commandId});}
   a.revision++;
   if(result.status==='FAILED'){entry.public.status='FAILED';a.blocked=true;fail('WORKFLOW_FAILED',503);}
   if(result.status==='COMPLETED'||gates[result.currentStepNo])break;
   if(i===3)fail('AUTO_STEP_LIMIT',503);
  }
  if(this.afterOperation)await this.afterOperation();
  const after=a.store.load(a.runId);entry.public.toStep=after.currentStepNo;entry.public.toStage=after.currentStepNo===null?'完了':labels[after.currentStepNo];entry.public.status='APPLIED';entry.public.result='正常';entry.public.finishedAt=new Date().toISOString();
  return {replayed:false,operation:structuredClone(entry.public),state:this.view(a,p)};
 }catch(error){a.blocked=true;if(entry.public.status!=='FAILED')entry.public.status='UNKNOWN';entry.public.result=entry.public.status==='FAILED'?'Workflow実行失敗':'結果確認が必要';throw new DemoError(entry.public.status==='FAILED'?'WORKFLOW_FAILED':'OUTCOME_UNKNOWN',503);}
 }
 view(a,p){const s=a.store.load(a.runId),next=s?.currentStepNo??null,application=a.memory.get('application')||{};
 const terminal=s?.status==='COMPLETED';const allowed=!a.blocked&&s?.status==='LIMIT_REACHED'&&!this.busy.has(a.id)?(gates[next]||[]):[];
 const permitted=allowed.filter(kind=>{try{this.authorize(p,a,kind);return true;}catch{return false;}});
 return structuredClone({applicationId:a.id,runId:a.runId,memberId:application.memberId||null,grade:application.grade||null,createdAt:a.createdAt,note:application.note||'',
  storage:'memory',revision:a.revision,bootSessionId:this.bootSessionId,workflowStatus:s?.status||'NOT_STARTED',currentStepNo:next,currentStep:terminal?'完了':labels[next]||'処理確認中',waitingFor:a.blocked||this.busy.has(a.id)||s?.status!=='LIMIT_REACHED'?null:(gates[next]||null),
  businessStage:a.blocked?'要確認':terminal?'結果登録済み':labels[next]||'受付処理中',blocked:a.blocked,busy:this.busy.has(a.id),allowedOperations:permitted,
  result:a.memory.get('applicationOutcome')||null,review:a.memory.get('review')||null,
  history:(s?.history||[]).map(h=>({order:h.order,stepNo:h.stepNo,step:labels[h.stepNo],result:h.result,nextStepNo:h.nextStepNo,at:h.at})),
  operations:[...a.commands.values()].map(c=>c.public),jobs:a.jobs,artifacts:a.artifacts,
  definition:{id:definition.definitionId,version:definition.definitionVersion}});
 }
}
module.exports={ExamApplication,DemoError,principal,definition,labels,exact,validatePayload,members,grades,gates,actionNames};
