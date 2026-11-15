'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const {CMemoryHistoryStore}=require('../../../dist/src/prototype/workflow');
const {validateArtifactSnapshot}=require('../../../dist/Frwk_Units/Workflow/src/ArtifactSnapshot');
const {validatePrototypeDefinition}=require('../../../dist/src/prototype/definition');
const copy=x=>structuredClone(x);
const fail=code=>{throw Object.assign(new Error(code),{code});};
const text=x=>typeof x==='string'&&!!x.trim()&&x.length<=256;
// Existing contract: SHA-256 of JSON.stringify(validated Definition), as in Firestore composition/store.
const definitionDigest=input=>createHash('sha256').update(JSON.stringify(validatePrototypeDefinition(input))).digest('hex');
function limitOperation(value,runId){if(!value||Object.keys(value).sort().join(',')!=='expectedRevision,operationId,runId'||value.runId!==runId||!text(value.operationId)||!Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1)fail('INVALID_ARGUMENT');return copy(value);}
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
/** The Checkpoint refers to the current execution operation, not an older receipt.
 * RUNNING saves are progress; non-RUNNING saves finalize that operation atomically.
 * Legacy rows without a Checkpoint keep their existing validation contract.
 */
function validateCheckpointConsistency(row){
 if(!Object.hasOwn(row,'checkpoint'))return;
 const c=row.checkpoint;
 if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).sort().join(',')!=='artifactSnapshot,formatVersion,operationIdentifier,revision,workflowSnapshot'||
    c.formatVersion!=='workflow-checkpoint/1'||!row.snapshot||c.revision!==row.revision||c.revision<1||c.operationIdentifier!==row.activeOperationId||!equal(c.workflowSnapshot,row.snapshot))fail('DATA_CORRUPT');
 const matching=row.operations.filter(op=>op.operationId===c.operationIdentifier);
 if(matching.length!==1)fail('DATA_CORRUPT');
 const op=matching[0];
 if(row.snapshot.status==='RUNNING'){
  if(row.owner.state!=='ACTIVE'||op.status!=='RUNNING'||Object.hasOwn(op,'snapshot')||Object.hasOwn(op,'revision'))fail('DATA_CORRUPT');
 }else{
  if(row.owner.state!=='RELEASED'||op.status!=='FINISHED'||op.revision!==c.revision||!op.snapshot||!equal(snapshot(op.snapshot),snapshot(c.workflowSnapshot)))fail('DATA_CORRUPT');
 }
 try{validateArtifactSnapshot(c.artifactSnapshot);}catch{fail('DATA_CORRUPT');}
}
/** Small synchronous atomic backend. No execution callbacks inside transactions. */
class MemoryLifecycleBackend {
 constructor({now=Date.now}={}){this.rows=new Map();this.now=now;}
 read(id){return copy(this.rows.get(id));}
 inspect(id,action){return action(this.read(id),this.now());}
 update(id,action,hooks={}){const row=copy(this.rows.get(id));const next=action(row,this.now());hooks.beforeCommit?.();this.rows.set(id,copy(next));hooks.afterCommit?.();return copy(next);}
 close(){}
}
/** Per-host capability. A shared backend does not share credentials across hosts. */
class WaitingHistoryStore {
 #checkpointClaim=null;
 #executionOperationId=null;
 get requiresExecutionOwnership(){return true;}
 constructor(backend,{runId,definitionId,definitionVersion,definitionDigest,ownerId=randomUUID(),leaseMs=5000,hooks={}}){
  if(![runId,definitionId,definitionVersion,definitionDigest,ownerId].every(text)||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>3600000)fail('INVALID_ARGUMENT');
  Object.assign(this,{backend,runId,definitionId,definitionVersion,definitionDigest,ownerId,leaseMs,hooks});this.credential=null;this.revision=0;this.poisoned=false;
  this.products={has:key=>this.read()?.products.some(p=>p.key===key)||false,get:key=>copy(this.read()?.products.find(p=>p.key===key)?.value),put:(key,value)=>{
   if(!text(key))fail('INVALID_ARGUMENT');json(value);const detached=copy(value);
   const row=this.mutate((r,now)=>{this.guarded(r,now);if(r.checkpoint)fail('ARTIFACT_CHECKPOINT_REQUIRED');const p=r.products.find(p=>p.key===key);if(p)p.value=detached;else r.products.push({key,value:detached});r.revision++;r.updatedAt=new Date(now).toISOString();return r;});this.revision=row.revision;
  }};
 }
 validate(row){
  try{return this.#validateRow(row);}catch(error){
   // A malformed persisted Checkpoint is corruption, not a caller input error.
   // Preserve the legacy error contract for rows without the new Checkpoint.
   if(row&&Object.hasOwn(row,'checkpoint'))fail('DATA_CORRUPT');throw error;
  }
 }
 #validateRow(row){
  if(!row)return row;
  if(row.schemaVersion!==1||row.runId!==this.runId||row.definitionId!==this.definitionId||row.definitionVersion!==this.definitionVersion||row.definitionDigest!==this.definitionDigest||
    !Number.isSafeInteger(row.revision)||row.revision<0||!row.owner||!Number.isSafeInteger(row.owner.fence)||row.owner.fence<1||
    !['ACTIVE','RELEASED'].includes(row.owner.state)||!text(row.owner.token)||!text(row.owner.ownerId)||!Number.isSafeInteger(row.owner.expiresAt)||
    !Array.isArray(row.operations)||!Array.isArray(row.events)||!Array.isArray(row.products)||!text(row.updatedAt))fail('DATA_CORRUPT');
  const ids=new Set();
  for(const op of row.operations){if(!op||!text(op.operationId)||ids.has(op.operationId)||!['START','RESUME_WAITING','RESUME_LIMIT'].includes(op.kind)||!['RUNNING','FINISHED'].includes(op.status))fail('DATA_CORRUPT');ids.add(op.operationId);
   if(op.kind==='RESUME_WAITING'){try{operation(op.request,this.runId);if(op.request.operationId!==op.operationId)fail('DATA_CORRUPT');}catch{fail('DATA_CORRUPT');}}
   if(row.checkpoint&&op.kind==='RESUME_LIMIT'){try{limitOperation(op.request,this.runId);if(op.request.operationId!==op.operationId)fail('DATA_CORRUPT');}catch{fail('DATA_CORRUPT');}}
   if(op.status==='FINISHED'&&(!op.snapshot||!Number.isSafeInteger(op.revision)||op.revision<1||op.revision>row.revision))fail('DATA_CORRUPT');
   if(op.snapshot){const s=snapshot(op.snapshot);if(s.runId!==this.runId||s.status==='RUNNING')fail('DATA_CORRUPT');}
  }
  if(!ids.has(row.activeOperationId)||row.events.some((e,i)=>!e||e.sequence!==i+1||!text(e.kind)||!text(e.at))||row.products.some(p=>!p||!text(p.key))||new Set(row.products.map(p=>p.key)).size!==row.products.length)fail('DATA_CORRUPT');
  try{for(const p of row.products)json(p.value);json(row.input);}catch{fail('DATA_CORRUPT');}
  if(row.snapshot){const s=snapshot(row.snapshot);if(s.runId!==this.runId||s.status==='WAITING'&&row.owner.state!=='RELEASED'||s.status==='RUNNING'&&row.owner.state!=='ACTIVE')fail('DATA_CORRUPT');}
  validateCheckpointConsistency(row);
  return row;
 }
 read(){return copy(this.validate(this.backend.read(this.runId)));}
 load(id){if(id!==this.runId)fail('RUN_MISMATCH');return this.read()?.snapshot;}
 /** Inspection DTO only; this method never restores a Manager, binds runId or claims a run. */
 readCheckpoint(){const row=this.read();if(!row?.checkpoint)return undefined;const c=row.checkpoint;return copy({formatVersion:c.formatVersion,runId:row.runId,
  definition:{id:row.definitionId,version:row.definitionVersion,digest:row.definitionDigest},workflowSnapshot:row.snapshot,
  artifactSnapshot:validateArtifactSnapshot(c.artifactSnapshot),revision:row.revision,operationIdentifier:c.operationIdentifier,owner:row.owner});}
 validateCheckpointDefinition(checkpoint,input){
  if(!checkpoint||checkpoint.runId!==this.runId||checkpoint.workflowSnapshot?.runId!==this.runId)fail('RUN_MISMATCH');
  if(checkpoint.formatVersion!=='workflow-checkpoint/1'||!Number.isSafeInteger(checkpoint.revision)||checkpoint.revision<1||!text(checkpoint.operationIdentifier))fail('DATA_CORRUPT');
  snapshot(checkpoint.workflowSnapshot);
  const d=validatePrototypeDefinition(input),identity=checkpoint.definition;
  if(d.schemaVersion!=='prototype-workflow/3'||d.definitionId!==this.definitionId||d.definitionVersion!==this.definitionVersion||
    !identity||identity.id!==d.definitionId||identity.version!==d.definitionVersion||identity.digest!==this.definitionDigest||definitionDigest(d)!==identity.digest)fail('DEFINITION_CONFLICT');
  const artifacts=validateArtifactSnapshot(checkpoint.artifactSnapshot),boxes=artifacts.boxes.map(b=>b.name);
  if(boxes.length!==d.artifactBoxes.length+1||d.artifactBoxes.some(b=>!boxes.includes(b))||!boxes.includes('default'))fail('ARTIFACT_SNAPSHOT_BOX_MISMATCH');
 }
 async claimCheckpoint(checkpoint,definition,artifacts,request){
  if(this.#checkpointClaim)fail('RUN_BUSY');
  this.validateCheckpointDefinition(checkpoint,definition);
  const managerArtifacts=validateArtifactSnapshot(artifacts);
  let value;
  if(request?.kind==='WAITING'&&Object.keys(request).sort().join(',')==='kind,operation')value=operation(request.operation,this.runId);
  else if(request?.kind==='LIMIT_REACHED'&&Object.keys(request).sort().join(',')==='expectedRevision,kind,operationId')value=limitOperation({runId:this.runId,operationId:request.operationId,expectedRevision:request.expectedRevision},this.runId);
  else fail('INVALID_ARGUMENT');
  this.#checkpointClaim={checkpoint:copy(checkpoint),definition:copy(definition),artifacts:managerArtifacts,request:value,kind:request.kind};
  try{
   // Explicitly route through the existing claim API. No implicit LIMIT operation ID.
   return request.kind==='WAITING'?await this.claimWaiting(checkpoint.workflowSnapshot,value):this.claimLimit(checkpoint.workflowSnapshot,value.operationId);
  }finally{this.#checkpointClaim=null;}
 }
 #claimArtifactOperation(observed){
  const context=this.#checkpointClaim;if(!context)fail('ARTIFACT_CHECKPOINT_RESUME_UNSUPPORTED');
  const {checkpoint,definition,artifacts,request,kind}=context,id=request.operationId,operationKind=kind==='WAITING'?'RESUME_WAITING':'RESUME_LIMIT';
  const receipt=op=>{if(op.kind!==operationKind||!equal(op.request,request))fail('OPERATION_CONFLICT');if(op.status!=='FINISHED')fail('OPERATION_IN_PROGRESS');return copy(op.snapshot);};
  const prior=observed.operations.find(o=>o.operationId===id);if(prior)return {replayed:true,snapshot:receipt(prior)};
  let replay,row;
  try{row=this.mutate((row,now)=>{
   const existing=row?.operations.find(o=>o.operationId===id);if(existing){replay=receipt(existing);fail('OPERATION_ALREADY_APPLIED');}
   if(!row?.checkpoint)fail('CHECKPOINT_NOT_FOUND');
   this.validateCheckpointDefinition(checkpoint,definition);
   if(row.revision!==request.expectedRevision)fail('REVISION_CONFLICT');
   if(row.owner.state!=='RELEASED')fail('CLAIM_BUSY');
   if(kind==='WAITING'&&row.snapshot.status!=='WAITING'||kind==='LIMIT_REACHED'&&row.snapshot.status!=='LIMIT_REACHED')fail('CHECKPOINT_NOT_RESUMABLE');
   if(kind==='WAITING'&&row.snapshot.waiting.generation!==request.expectedWaitGeneration)fail('STALE_WAIT_GENERATION');
   const current={formatVersion:row.checkpoint.formatVersion,runId:row.runId,definition:{id:row.definitionId,version:row.definitionVersion,digest:row.definitionDigest},workflowSnapshot:row.snapshot,
    artifactSnapshot:validateArtifactSnapshot(row.checkpoint.artifactSnapshot),revision:row.revision,operationIdentifier:row.checkpoint.operationIdentifier,owner:row.owner};
   if(!equal(current,checkpoint))fail('RESUME_STATE_CHANGED');
   if(!equal(artifacts,checkpoint.artifactSnapshot))fail('RESUME_STATE_CHANGED');
   row.owner=this.newOwner(row.owner,now);row.revision++;row.updatedAt=new Date(now).toISOString();
   row.operations.push({operationId:id,kind:operationKind,request:copy(request),status:'RUNNING'});row.activeOperationId=id;
   if(kind==='WAITING'){row.input=copy(request.result);const {waiting,...rest}=row.snapshot;row.snapshot={...rest,status:'RUNNING',currentStepNo:waiting.nextStepNo};this.event(row,'WAIT_RESOLVED',now,{generation:waiting.generation,operationId:id});}
   else{row.snapshot={...row.snapshot,status:'RUNNING'};this.event(row,'LIMIT_RESUMED',now,{operationId:id});}
   row.checkpoint={...row.checkpoint,workflowSnapshot:copy(row.snapshot),revision:row.revision,operationIdentifier:id};
   validateCheckpointConsistency(row);return row;
  });}catch(e){if(e.code==='OPERATION_ALREADY_APPLIED'&&replay)return {replayed:true,snapshot:replay};throw e;}
  this.adopt(row);return {replayed:false,snapshot:copy(row.snapshot)};
 }
 event(row,kind,now,extra={}){row.events.push({sequence:row.events.length+1,kind,at:new Date(now).toISOString(),...extra});}
 guarded(row,now){
  const o=row?.owner,c=this.credential;
  if(!o||!c||o.state!=='ACTIVE'||o.ownerId!==this.ownerId||o.token!==c.token||o.fence!==c.fence)fail('FENCED');
  if(o.expiresAt<=now)fail('LEASE_EXPIRED');if(row.revision!==this.revision)fail('REVISION_CONFLICT');
 }
 /** Read-only validation against the backend's clock and authoritative row. No renew/claim/save. */
 assertCanExecuteStep(value){
  const expected=snapshot(value);if(expected.runId!==this.runId)fail('RUN_MISMATCH');
  if(this.poisoned)fail('PERSISTENCE_UNCERTAIN');
  if(typeof this.backend.inspect!=='function')fail('EXECUTION_OWNERSHIP_UNAVAILABLE');
  return this.backend.inspect(this.runId,(row,now)=>{
   this.validate(row);this.guarded(row,now);
   if(!this.#executionOperationId||row.activeOperationId!==this.#executionOperationId)fail('OPERATION_CONFLICT');
   const op=row.operations.find(o=>o.operationId===this.#executionOperationId);
   if(!op||op.status!=='RUNNING'||row.snapshot?.status!=='RUNNING')fail('CHECKPOINT_NOT_RESUMABLE');
   if(!equal(row.snapshot,expected))fail('RESUME_STATE_CHANGED');
  });
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
 adopt(row){this.credential=copy(row.owner);this.revision=row.revision;this.#executionOperationId=row.activeOperationId;return copy(row);}
 claimStart(operationId=randomUUID()){
  if(!text(operationId))fail('INVALID_ARGUMENT');
  return this.adopt(this.mutate((old,now)=>{
   if(old)fail('RUN_EXISTS');const row={schemaVersion:1,runId:this.runId,definitionId:this.definitionId,definitionVersion:this.definitionVersion,definitionDigest:this.definitionDigest,
    revision:0,snapshot:null,owner:this.newOwner(null,now),updatedAt:new Date(now).toISOString(),input:null,
    operations:[{operationId,kind:'START',status:'RUNNING'}],activeOperationId:operationId,events:[],products:[]};this.event(row,'START_CLAIMED',now);return row;
  }));
 }
 save(value){
  return this.#saveValue(value);
 }
 saveCheckpoint(value,artifacts){
  // Validate/detach before reading SQLite or beginning any write transaction.
  return this.#saveValue(value,validateArtifactSnapshot(artifacts));
 }
 #saveValue(value,artifacts){
  const s=snapshot(value);if(s.runId!==this.runId)fail('RUN_MISMATCH');
  const observed=this.read();
  if(observed?.checkpoint&&artifacts===undefined)fail('ARTIFACT_CHECKPOINT_REQUIRED');
  if(artifacts!==undefined&&observed&&!observed.checkpoint&&(observed.snapshot||observed.products.length))fail('ARTIFACT_CHECKPOINT_MODE_MISMATCH');
  if(s.status!=='RUNNING'&&observed?.owner.state==='RELEASED'&&observed.owner.token===this.credential?.token&&
    observed.owner.fence===this.credential?.fence&&observed.revision===this.revision&&equal(observed.snapshot,s)&&
    (artifacts===undefined||equal(observed.checkpoint?.artifactSnapshot,artifacts)))return;
  const row=this.mutate((row,now)=>{
   this.guarded(row,now);
   if(row.checkpoint&&artifacts===undefined)fail('ARTIFACT_CHECKPOINT_REQUIRED');
   if(artifacts!==undefined&&!row.checkpoint&&(row.snapshot||row.products.length))fail('ARTIFACT_CHECKPOINT_MODE_MISMATCH');
   const prior=row.snapshot?.history||[];if(s.history.length<prior.length||!equal(s.history.slice(0,prior.length),prior))fail('HISTORY_CONFLICT');
   if(s.status==='WAITING'&&(s.waiting.generation!==(row.snapshot?.waitSequence||0)+1||s.history.at(-1)?.nextStepNo!==s.currentStepNo&&s.history.length>0))fail('WAIT_CONFLICT');
   row.snapshot=copy(s);row.revision++;row.updatedAt=new Date(now).toISOString();
   if(artifacts!==undefined)row.checkpoint={formatVersion:'workflow-checkpoint/1',workflowSnapshot:copy(s),artifactSnapshot:copy(artifacts),revision:row.revision,operationIdentifier:row.activeOperationId};
   if(s.status!=='RUNNING'){
    row.owner={...row.owner,state:'RELEASED',expiresAt:now};
    if(s.status==='WAITING')this.event(row,'WAIT_ENTERED',now,{generation:s.waiting.generation,reason:s.waiting.reason,nextStepNo:s.waiting.nextStepNo,operationId:row.activeOperationId});
    const op=row.operations.find(x=>x.operationId===row.activeOperationId);if(op){op.status='FINISHED';op.snapshot=copy(s);op.revision=row.revision;}
   }
   validateCheckpointConsistency(row);
   return row;
  });this.revision=row.revision;
 }
 /** Caller has already authorized this operation; payload and concurrency remain checked here. */
 async claimWaiting(saved,request){
  const value=operation(request,this.runId),s=snapshot(saved);
  const observed=this.read(),prior=observed?.operations.find(x=>x.operationId===value.operationId);
  if(observed?.checkpoint)return this.#claimArtifactOperation(observed);
  if(s.status!=='WAITING')fail('NOT_WAITING');
  if(prior){if(!equal(prior.request,value))fail('OPERATION_CONFLICT');if(prior.status!=='FINISHED')fail('OPERATION_IN_PROGRESS');return {replayed:true,snapshot:copy(prior.snapshot)};}
  let replay,row;
  try{row=this.mutate((row,now)=>{
   // Recheck receipts after taking the backend's write reservation.
   const op=row?.operations.find(x=>x.operationId===value.operationId);
   if(op){if(!equal(op.request,value))fail('OPERATION_CONFLICT');if(op.status==='FINISHED'){replay=copy(op.snapshot);fail('OPERATION_ALREADY_APPLIED');}fail('OPERATION_IN_PROGRESS');}
   if(!row)fail('RUN_NOT_FOUND');
   if(row.checkpoint)fail('ARTIFACT_CHECKPOINT_RESUME_UNSUPPORTED');
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
  const observed=this.read();if(observed?.checkpoint)return this.#claimArtifactOperation(observed);
  return this.adopt(this.mutate((row,now)=>{if(!row||s.status!=='LIMIT_REACHED'||!equal(row.snapshot,s)||row.owner.state!=='RELEASED')fail('RESUME_STATE_CHANGED');
   if(row.checkpoint)fail('ARTIFACT_CHECKPOINT_RESUME_UNSUPPORTED');
   if(row.operations.some(x=>x.operationId===operationId))fail('OPERATION_CONFLICT');row.owner=this.newOwner(row.owner,now);row.activeOperationId=operationId;
   row.operations.push({operationId,kind:'RESUME_LIMIT',status:'RUNNING'});return row;
  }));
 }
 getInput(){return copy(this.read()?.input);}
 heartbeat(){const row=this.mutate((r,now)=>{this.guarded(r,now);r.owner.expiresAt=Math.max(r.owner.expiresAt+1,now+this.leaseMs);r.updatedAt=new Date(now).toISOString();return r;});return copy(row.owner);}
 close(){this.backend.close();}
}
module.exports={MemoryLifecycleBackend,WaitingHistoryStore,definitionDigest};
