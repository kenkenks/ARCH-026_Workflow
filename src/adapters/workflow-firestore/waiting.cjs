'use strict';
const {randomUUID}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const {MemoryLifecycleBackend,WaitingHistoryStore}=require('../workflow-waiting/lifecycle.cjs');
const {hash}=require('./store.cjs');
const {validateEnvironment,Timestamp,FieldValue}=require('./emulator.cjs');
const copy=x=>structuredClone(x);
const fail=code=>{throw Object.assign(Error(code),{code});};
const DOMAIN=new Set(['INVALID_ARGUMENT','DATA_CORRUPT','RUN_EXISTS','RUN_NOT_FOUND','RUN_MISMATCH','NOT_WAITING','STALE_WAIT_GENERATION','REVISION_CONFLICT',
 'RESUME_STATE_CHANGED','CLAIM_BUSY','FENCED','FENCE_EXHAUSTED','LEASE_EXPIRED','HISTORY_CONFLICT','WAIT_CONFLICT','OPERATION_CONFLICT','OPERATION_IN_PROGRESS',
 'OPERATION_NOT_APPLIED','MUTATION_NOT_APPLIED','PAYLOAD_TOO_LARGE','RUN_BUSY','PERSISTENCE_UNCERTAIN']);
function canonical(x,seen=new Set()){
 if(x===null||typeof x==='boolean'||typeof x==='string')return x;if(typeof x==='number'&&Number.isFinite(x))return x;
 if(!x||typeof x!=='object'||seen.has(x)||seen.size>40||!Array.isArray(x)&&![Object.prototype,null].includes(Object.getPrototypeOf(x)))fail('INVALID_ARGUMENT');
 seen.add(x);const out=Array.isArray(x)?[]:{};
 if(Array.isArray(x)&&Object.keys(x).length!==x.length)fail('INVALID_ARGUMENT');
 for(const key of Object.keys(x).sort()){const d=Object.getOwnPropertyDescriptor(x,key);if(!d||!('value'in d))fail('INVALID_ARGUMENT');Object.defineProperty(out,key,{value:canonical(d.value,seen),enumerable:true,writable:true,configurable:true});}
 if(Reflect.ownKeys(x).some(k=>typeof k==='symbol'))fail('INVALID_ARGUMENT');seen.delete(x);return out;
}
function request(value,runId){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='expectedRevision,expectedWaitGeneration,operationId,result,runId'||value.runId!==runId||
  typeof value.operationId!=='string'||!value.operationId.trim()||value.operationId.length>256||!Number.isSafeInteger(value.expectedWaitGeneration)||value.expectedWaitGeneration<1||
  !Number.isSafeInteger(value.expectedRevision)||value.expectedRevision<1)fail('INVALID_ARGUMENT');
 const normalized=canonical(value);if(Buffer.byteLength(JSON.stringify(normalized),'utf8')>65536)fail('INVALID_ARGUMENT');return normalized;
}
const stateHash=value=>hash(canonical(value));
/** Firestore transactions host the SAME Lifecycle reducer; never run a Job here. */
class FirestoreWaitingStore {
 constructor(connection,options){
  const environment=validateEnvironment({FIRESTORE_EMULATOR_HOST:process.env.FIRESTORE_EMULATOR_HOST,projectId:connection.db.projectId,namespace:connection.root.id});
  const settings=connection.db._settings;
  if(settings.servicePath!=='127.0.0.1'||`${settings.servicePath}:${settings.port}`!==environment.FIRESTORE_EMULATOR_HOST||settings.ssl!==false||connection.root.parent.id!=='arch026_c2')fail('EMULATOR_REQUIRED');
  this.connection=connection;this.options={...options,ownerId:options.ownerId||randomUUID()};this.hooks=options.hooks||{};
  this.options.hooks={};new WaitingHistoryStore(new MemoryLifecycleBackend(),this.options);
  this.runId=options.runId;this.ref=connection.root.collection('waitingRuns').doc(hash(this.runId));this.credential=null;this.revision=0;this.cache=undefined;this.poisoned=false;this.busy=false;
  this.products={has:key=>!!this.cache?.products.some(p=>p.key===key),get:key=>copy(this.cache?.products.find(p=>p.key===key)?.value),put:(key,value)=>this.invoke('put',[key,value])};
 }
 worker(row,now){const backend=new MemoryLifecycleBackend({now:()=>now});if(row)backend.rows.set(this.runId,copy(row));const worker=new WaitingHistoryStore(backend,this.options);worker.credential=copy(this.credential);worker.revision=this.revision;worker.validate(row);return worker;}
 decode(doc){if(!doc.exists)return undefined;const raw=doc.data();if(!raw.value||stateHash(raw.value)!==raw.digest)fail('DATA_CORRUPT');this.worker(raw.value,0);return copy(raw.value);}
 cached(row){if(row&&(!this.cache||row.revision>=this.cache.revision))this.cache=copy(row);}
 async read(){try{const row=this.decode(await this.ref.get());this.cached(row);return row;}catch(e){if(DOMAIN.has(e.code))throw e;fail('READ_UNAVAILABLE');}}
 async load(id){if(id!==this.runId)fail('RUN_MISMATCH');return (await this.read())?.snapshot;}
 getInput(){return copy(this.cache?.input);}
 operationRef(id){return this.ref.collection('operations').doc(hash(id));}
 async invoke(kind,args){
  if(this.poisoned)fail('PERSISTENCE_UNCERTAIN');if(this.busy)fail('RUN_BUSY');
  const operation=kind==='claimWaiting'?request(args[1],this.runId):null;
  const mutationId=randomUUID(),mutationRef=this.ref.collection('mutations').doc(mutationId);this.lastMutationId=mutationId;this.busy=true;
  try{
   const applied=await this.connection.db.runTransaction(async tx=>{
    const doc=await tx.get(this.ref),row=this.decode(doc);if(!(doc.readTime instanceof Timestamp))fail('CLOCK_UNAVAILABLE');
    const previous=await tx.get(mutationRef);if(previous.exists)fail('MUTATION_ALREADY_APPLIED');
    let receipt;if(operation){receipt=await tx.get(this.operationRef(operation.operationId));if(receipt.exists){if(receipt.data().requestDigest!==hash(operation))fail('OPERATION_CONFLICT');if(receipt.data().state==='NOT_APPLIED')fail('OPERATION_NOT_APPLIED');}}
    const worker=this.worker(row,Math.floor(doc.readTime.toMillis()));let result;
    if(kind==='put')result=await worker.products.put(...args);else result=await worker[kind](...args);
    const next=worker.read(),changed=!equal(next,row);
    if(changed){
     if(Buffer.byteLength(JSON.stringify(next),'utf8')>65536)fail('PAYLOAD_TOO_LARGE');
     // Tests may inject only barriers/errors here; no business processing in callback.
     await this.hooks.beforeCommit?.({kind,row:copy(next),mutationId});
     tx.set(this.ref,{value:next,digest:stateHash(next),committedAt:FieldValue.serverTimestamp()});
     tx.create(mutationRef,{state:'APPLIED',digest:stateHash(next),revision:next.revision,kind});
     if(operation&&!receipt.exists)tx.create(this.operationRef(operation.operationId),{state:'APPLIED',requestDigest:hash(operation),claimRevision:next.revision});
    }
    return {row:next,credential:worker.credential,revision:worker.revision,result};
   });
   await this.hooks.afterCommit?.({kind,row:copy(applied.row),mutationId});
   this.cached(applied.row);this.credential=copy(applied.credential);this.revision=applied.revision;return copy(applied.result);
  }catch(e){if(DOMAIN.has(e?.code))throw e;this.poisoned=true;fail('OUTCOME_UNKNOWN');}finally{this.busy=false;}
 }
 claimStart(id){return this.invoke('claimStart',[id===undefined?randomUUID():id]);}
 save(snapshot){return this.invoke('save',[snapshot]);}
 claimWaiting(snapshot,operation){return this.invoke('claimWaiting',[snapshot,operation]);}
 claimLimit(snapshot,id){return this.invoke('claimLimit',[snapshot,id===undefined?randomUUID():id]);}
 heartbeat(){return this.invoke('heartbeat',[]);}
 async observeMutation(id){
  if(typeof id!=='string'||!id.trim()||id.includes('/'))fail('INVALID_ARGUMENT');
  try{const d=await this.ref.collection('mutations').doc(id).get();if(!d.exists)return {state:'UNKNOWN',scope:'MUTATION',reason:'ABSENCE_IS_NOT_COMMIT_PROOF'};
   const r=d.data();if(r.state!=='APPLIED'||!Number.isSafeInteger(r.revision)||r.revision<0||!/^[a-f0-9]{64}$/.test(r.digest||''))return {state:'UNKNOWN',scope:'MUTATION',reason:'RECEIPT_INVALID'};
   return {state:'APPLIED',scope:'MUTATION',receipt:r};}catch{return {state:'UNKNOWN',scope:'MUTATION',reason:'READ_UNAVAILABLE'};}
 }
 /** sealAbsent installs a durable rejection barrier; absence alone never proves NOT_APPLIED. */
 async observeOperation(value,{sealAbsent=false}={}){
  const op=request(value,this.runId),opRef=this.operationRef(op.operationId);
  try{return await this.connection.db.runTransaction(async tx=>{
   const doc=await tx.get(this.ref),r=this.decode(doc),receipt=await tx.get(opRef);
   if(receipt.exists){if(receipt.data().requestDigest!==hash(op))fail('OPERATION_CONFLICT');if(!['APPLIED','NOT_APPLIED'].includes(receipt.data().state))fail('DATA_CORRUPT');return {state:receipt.data().state,scope:'RESUME_CLAIM',reason:'DURABLE_OPERATION_RECEIPT'};}
   if(sealAbsent&&r?.snapshot?.status==='WAITING'&&r.owner.state==='RELEASED'&&r.snapshot.waiting.generation===op.expectedWaitGeneration&&r.revision===op.expectedRevision){
    tx.create(opRef,{state:'NOT_APPLIED',requestDigest:hash(op)});
    // Conflicts with any already-started claim transaction; its retry sees the tombstone.
    tx.set(this.ref,{value:r,digest:stateHash(r),observationFence:randomUUID(),committedAt:FieldValue.serverTimestamp()});
    return {state:'NOT_APPLIED',scope:'RESUME_CLAIM',reason:'DURABLE_REJECTION_BARRIER'};
   }
   return {state:'UNKNOWN',scope:'RESUME_CLAIM',reason:'NO_RECEIPT_PROOF'};
  },{readOnly:!sealAbsent});}catch(e){if(e.code==='OPERATION_CONFLICT')throw e;if(sealAbsent)this.poisoned=true;return {state:'UNKNOWN',scope:'RESUME_CLAIM',reason:'READ_OR_SEAL_UNCERTAIN'};}
 }
}
module.exports={FirestoreWaitingStore};
