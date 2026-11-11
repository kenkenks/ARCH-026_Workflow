'use strict';
const {randomUUID}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const {CMemoryHistoryStore}=require('../../../dist/src/prototype/workflow');
const copy=x=>structuredClone(x);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const text=x=>typeof x==='string'&&!!x.trim()&&x.length<=256;
function json(x,seen=new Set()){
 if(x===null||typeof x==='boolean'||typeof x==='string')return;
 if(typeof x==='number'&&Number.isFinite(x))return;
 if(!x||typeof x!=='object'||seen.has(x)||seen.size>=40||(!Array.isArray(x)&&![Object.prototype,null].includes(Object.getPrototypeOf(x))))fail('INVALID_ARGUMENT');
 if(Array.isArray(x)&&Object.keys(x).length!==x.length)fail('INVALID_ARGUMENT');
 seen.add(x);for(const k of Reflect.ownKeys(x)){if(Array.isArray(x)&&k==='length')continue;const d=Object.getOwnPropertyDescriptor(x,k);if(typeof k!=='string'||!d||!('value'in d))fail('INVALID_ARGUMENT');json(d.value,seen);}seen.delete(x);
}
function operation(value,runId){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='expectedRevision,expectedWaitGeneration,operationId,result,runId'||
   value.runId!==runId||!text(value.operationId)||!Number.isSafeInteger(value.expectedWaitGeneration)||value.expectedWaitGeneration<1||
   !Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1)fail('INVALID_ARGUMENT');
 json(value.result);if(Buffer.byteLength(JSON.stringify(value),'utf8')>65536)fail('INVALID_ARGUMENT');return copy(value);
}
function snapshot(value){const m=new CMemoryHistoryStore();m.save(value);const s=m.load(value.runId);if(s.history.some((h,i)=>h.order!==i+1))fail('DATA_CORRUPT');return s;}
/** Small synchronous atomic backend. No execution callbacks inside transactions. */
class MemoryLifecycleBackend {
 constructor({now=Date.now}={}){this.rows=new Map();this.now=now;}
 read(id){return copy(this.rows.get(id));}
 update(id,action,hooks={}){const row=copy(this.rows.get(id));const next=action(row,this.now());hooks.beforeCommit?.();this.rows.set(id,copy(next));hooks.afterCommit?.();return copy(next);}
 close(){}
}
/** Per-host capability. A shared backend does not share credentials across hosts. */
class WaitingHistoryStore {
 constructor(backend,{runId,definitionId,definitionVersion,definitionDigest,ownerId=randomUUID(),leaseMs=5000,hooks={}}){
  if(![runId,definitionId,definitionVersion,definitionDigest,ownerId].every(text)||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>3600000)fail('INVALID_ARGUMENT');
  Object.assign(this,{backend,runId,definitionId,definitionVersion,definitionDigest,ownerId,leaseMs,hooks});this.credential=null;this.revision=0;this.poisoned=false;
  this.products={has:key=>this.read()?.products.some(p=>p.key===key)||false,get:key=>copy(this.read()?.products.find(p=>p.key===key)?.value),put:(key,value)=>{
   if(!text(key))fail('INVALID_ARGUMENT');json(value);const detached=copy(value);
   const row=this.mutate((r,now)=>{this.guarded(r,now);const p=r.products.find(p=>p.key===key);if(p)p.value=detached;else r.products.push({key,value:detached});r.revision++;r.updatedAt=new Date(now).toISOString();return r;});this.revision=row.revision;
  }};
 }
 validate(row){
  if(!row)return row;
  if(row.schemaVersion!==1||row.runId!==this.runId||row.definitionId!==this.definitionId||row.definitionVersion!==this.definitionVersion||row.definitionDigest!==this.definitionDigest||
    !Number.isSafeInteger(row.revision)||row.revision<0||!row.owner||!Number.isSafeInteger(row.owner.fence)||row.owner.fence<1||
    !['ACTIVE','RELEASED'].includes(row.owner.state)||!text(row.owner.token)||!text(row.owner.ownerId)||!Number.isSafeInteger(row.owner.expiresAt)||
    !Array.isArray(row.operations)||!Array.isArray(row.events)||!Array.isArray(row.products)||!text(row.updatedAt))fail('DATA_CORRUPT');
  const ids=new Set();
  for(const op of row.operations){if(!op||!text(op.operationId)||ids.has(op.operationId)||!['START','RESUME_WAITING','RESUME_LIMIT'].includes(op.kind)||!['RUNNING','FINISHED'].includes(op.status))fail('DATA_CORRUPT');ids.add(op.operationId);
   if(op.kind==='RESUME_WAITING'){try{operation(op.request,this.runId);if(op.request.operationId!==op.operationId)fail('DATA_CORRUPT');}catch{fail('DATA_CORRUPT');}}
   if(op.status==='FINISHED'&&(!op.snapshot||!Number.isSafeInteger(op.revision)||op.revision<1||op.revision>row.revision))fail('DATA_CORRUPT');
   if(op.snapshot){const s=snapshot(op.snapshot);if(s.runId!==this.runId||s.status==='RUNNING')fail('DATA_CORRUPT');}
  }
  if(!ids.has(row.activeOperationId)||row.events.some((e,i)=>!e||e.sequence!==i+1||!text(e.kind)||!text(e.at))||row.products.some(p=>!p||!text(p.key))||new Set(row.products.map(p=>p.key)).size!==row.products.length)fail('DATA_CORRUPT');
  try{for(const p of row.products)json(p.value);json(row.input);}catch{fail('DATA_CORRUPT');}
  if(row.snapshot){const s=snapshot(row.snapshot);if(s.runId!==this.runId||s.status==='WAITING'&&row.owner.state!=='RELEASED'||s.status==='RUNNING'&&row.owner.state!=='ACTIVE')fail('DATA_CORRUPT');}
  return row;
 }
 read(){return copy(this.validate(this.backend.read(this.runId)));}
 load(id){if(id!==this.runId)fail('RUN_MISMATCH');return this.read()?.snapshot;}
 event(row,kind,now,extra={}){row.events.push({sequence:row.events.length+1,kind,at:new Date(now).toISOString(),...extra});}
 guarded(row,now){
  const o=row?.owner,c=this.credential;
  if(!o||!c||o.state!=='ACTIVE'||o.ownerId!==this.ownerId||o.token!==c.token||o.fence!==c.fence)fail('FENCED');
  if(o.expiresAt<=now)fail('LEASE_EXPIRED');if(row.revision!==this.revision)fail('REVISION_CONFLICT');
 }
 mutate(action){
  if(this.poisoned)fail('PERSISTENCE_UNCERTAIN');let wrote=false;
  try{return this.backend.update(this.runId,(row,now)=>{this.validate(row);return action(row,now);},{
   beforeCommit:()=>this.hooks.beforeCommit?.(),afterCommit:()=>{wrote=true;this.hooks.afterCommit?.();}
  });}catch(e){
   if(wrote||e?.code==='OUTCOME_UNKNOWN'){this.poisoned=true;fail('OUTCOME_UNKNOWN');}throw e;
  }
 }
 newOwner(old,now){const fence=(old?.fence||0)+1;if(!Number.isSafeInteger(fence))fail('FENCE_EXHAUSTED');return {state:'ACTIVE',ownerId:this.ownerId,token:randomUUID(),fence,expiresAt:now+this.leaseMs};}
 adopt(row){this.credential=copy(row.owner);this.revision=row.revision;return copy(row);}
 claimStart(operationId=randomUUID()){
  if(!text(operationId))fail('INVALID_ARGUMENT');
  return this.adopt(this.mutate((old,now)=>{
   if(old)fail('RUN_EXISTS');const row={schemaVersion:1,runId:this.runId,definitionId:this.definitionId,definitionVersion:this.definitionVersion,definitionDigest:this.definitionDigest,
    revision:0,snapshot:null,owner:this.newOwner(null,now),updatedAt:new Date(now).toISOString(),input:null,
    operations:[{operationId,kind:'START',status:'RUNNING'}],activeOperationId:operationId,events:[],products:[]};this.event(row,'START_CLAIMED',now);return row;
  }));
 }
 save(value){
  const s=snapshot(value);if(s.runId!==this.runId)fail('RUN_MISMATCH');
  const observed=this.read();
  if(s.status!=='RUNNING'&&observed?.owner.state==='RELEASED'&&observed.owner.token===this.credential?.token&&
    observed.owner.fence===this.credential?.fence&&observed.revision===this.revision&&equal(observed.snapshot,s))return;
  const row=this.mutate((row,now)=>{
   this.guarded(row,now);
   const prior=row.snapshot?.history||[];if(s.history.length<prior.length||!equal(s.history.slice(0,prior.length),prior))fail('HISTORY_CONFLICT');
   if(s.status==='WAITING'&&(s.waiting.generation!==(row.snapshot?.waitSequence||0)+1||s.history.at(-1)?.nextStepNo!==s.currentStepNo&&s.history.length>0))fail('WAIT_CONFLICT');
   row.snapshot=copy(s);row.revision++;row.updatedAt=new Date(now).toISOString();
   if(s.status!=='RUNNING'){
    row.owner={...row.owner,state:'RELEASED',expiresAt:now};
    if(s.status==='WAITING')this.event(row,'WAIT_ENTERED',now,{generation:s.waiting.generation,reason:s.waiting.reason,nextStepNo:s.waiting.nextStepNo,operationId:row.activeOperationId});
    const op=row.operations.find(x=>x.operationId===row.activeOperationId);if(op){op.status='FINISHED';op.snapshot=copy(s);op.revision=row.revision;}
   }
   return row;
  });this.revision=row.revision;
 }
 /** Caller has already authorized this operation; payload and concurrency remain checked here. */
 async claimWaiting(saved,request){
  const value=operation(request,this.runId),s=snapshot(saved);if(s.status!=='WAITING')fail('NOT_WAITING');
  const observed=this.read(),prior=observed?.operations.find(x=>x.operationId===value.operationId);
  if(prior){if(!equal(prior.request,value))fail('OPERATION_CONFLICT');if(prior.status!=='FINISHED')fail('OPERATION_IN_PROGRESS');return {replayed:true,snapshot:copy(prior.snapshot)};}
  let replay,row;
  try{row=this.mutate((row,now)=>{
   // Recheck receipts after taking the backend's write reservation.
   const op=row?.operations.find(x=>x.operationId===value.operationId);
   if(op){if(!equal(op.request,value))fail('OPERATION_CONFLICT');if(op.status==='FINISHED'){replay=copy(op.snapshot);fail('OPERATION_ALREADY_APPLIED');}fail('OPERATION_IN_PROGRESS');}
   if(!row)fail('RUN_NOT_FOUND');
   if((row.snapshot?.waitSequence||0)!==value.expectedWaitGeneration)fail('STALE_WAIT_GENERATION');
   if(row.snapshot?.status!=='WAITING')fail('NOT_WAITING');
   if(row.revision!==value.expectedRevision)fail('REVISION_CONFLICT');
   if(!equal(row.snapshot,s))fail('RESUME_STATE_CHANGED');
   if(row.owner.state!=='RELEASED')fail('CLAIM_BUSY');
   row.owner=this.newOwner(row.owner,now);row.input=copy(value.result);row.revision++;row.updatedAt=new Date(now).toISOString();
   row.operations.push({operationId:value.operationId,kind:'RESUME_WAITING',request:value,status:'RUNNING'});row.activeOperationId=value.operationId;
   const {waiting,...rest}=row.snapshot;row.snapshot={...rest,status:'RUNNING',currentStepNo:waiting.nextStepNo};
   this.event(row,'WAIT_RESOLVED',now,{generation:waiting.generation,operationId:value.operationId});return row;
  });}catch(e){if(e.code==='OPERATION_ALREADY_APPLIED'&&replay)return {replayed:true,snapshot:replay};throw e;}
  this.adopt(row);return {replayed:false,snapshot:copy(row.snapshot)};
 }
 claimLimit(saved,operationId=randomUUID()){
  if(!text(operationId))fail('INVALID_ARGUMENT');const s=snapshot(saved);
  return this.adopt(this.mutate((row,now)=>{if(!row||s.status!=='LIMIT_REACHED'||!equal(row.snapshot,s)||row.owner.state!=='RELEASED')fail('RESUME_STATE_CHANGED');
   if(row.operations.some(x=>x.operationId===operationId))fail('OPERATION_CONFLICT');row.owner=this.newOwner(row.owner,now);row.activeOperationId=operationId;
   row.operations.push({operationId,kind:'RESUME_LIMIT',status:'RUNNING'});return row;
  }));
 }
 getInput(){return copy(this.read()?.input);}
 heartbeat(){const row=this.mutate((r,now)=>{this.guarded(r,now);r.owner.expiresAt=Math.max(r.owner.expiresAt+1,now+this.leaseMs);r.updatedAt=new Date(now).toISOString();return r;});return copy(row.owner);}
 close(){this.backend.close();}
}
module.exports={MemoryLifecycleBackend,WaitingHistoryStore};
