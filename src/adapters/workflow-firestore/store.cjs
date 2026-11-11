'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const {fail,leaseValid,Timestamp,FieldValue,PersistenceError}=require('./emulator.cjs');
const {validatePrototypeDefinition}=require('../../../dist/src/prototype/definition');
const {CMemoryHistoryStore}=require('../../../dist/src/prototype/workflow');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const copy=x=>structuredClone(x);
const text=x=>typeof x==='string'&&!!x.trim();
const validateSnapshot=x=>{const s=new CMemoryHistoryStore();s.save(x);return s.load(x.runId);};
class FirestoreExperimentStore {
 constructor(connection,runId,{leaseMs=30000}={}){
  if(!text(runId)||!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>3600000)fail('INVALID_ARGUMENT');
  this.db=connection.db;this.root=connection.root;this.runId=runId;this.run=this.root.collection('runs').doc(hash(runId));
  this.owner=this.run.collection('control').doc('ownership');this.leaseMs=leaseMs;this.poisoned=false;this.credential=null;this.revision=0;
 }
 definitionRef(id,version){return this.root.collection('definitions').doc(hash([id,version]));}
 async add(definition){
  const value=validatePrototypeDefinition(definition);
  try{await this.definitionRef(value.definitionId,value.definitionVersion).create({value,digest:hash(value)});}catch(e){if(e.code===6)fail('DEFINITION_ALREADY_EXISTS');fail('DEFINITION_SAVE_UNKNOWN');}
 }
 async get(id,version){const d=await this.definitionRef(id,version).get();if(!d.exists)return null;const row=d.data(),v=validatePrototypeDefinition(row.value);
  if(v.definitionId!==id||v.definitionVersion!==version||hash(v)!==row.digest)fail('DATA_CORRUPT');return copy(v);}
 async claim(ownerId,{administrativeTakeover=false}={}){
  if(!text(ownerId))fail('INVALID_ARGUMENT');const token=randomUUID();
  const credential=await this.db.runTransaction(async tx=>{
   const d=await tx.get(this.owner),old=d.data();const now=d.readTime;if(!(now instanceof Timestamp))fail('CLOCK_UNAVAILABLE');
   if(old&&old.state==='ACTIVE'){
    if(leaseValid(old.expiresAt,now))fail('CLAIM_BUSY');
    // No automatic takeover: read-time validity does not prove commit-time expiry.
    if(!administrativeTakeover)fail('ADMINISTRATIVE_TAKEOVER_REQUIRED');
   }
   const fence=(old?.fence||0)+1;if(!Number.isSafeInteger(fence))fail('FENCE_EXHAUSTED');
   const next={ownerId,token,fence,state:'ACTIVE',expiresAt:Timestamp.fromMillis(now.toMillis()+this.leaseMs),updatedAt:FieldValue.serverTimestamp()};
   tx.set(this.owner,next);return {ownerId,token,fence};
  });this.credential=credential;return copy(credential);
 }
 guard(doc,credential=this.credential){
  const o=doc.data();if(!o||!credential||o.state!=='ACTIVE'||o.ownerId!==credential.ownerId||o.token!==credential.token||o.fence!==credential.fence)fail('FENCED');
  if(!leaseValid(o.expiresAt,doc.readTime))fail('LEASE_EXPIRED');
 }
 async heartbeat(){return this.db.runTransaction(async tx=>{const o=await tx.get(this.owner);this.guard(o);tx.update(this.owner,{expiresAt:Timestamp.fromMillis(o.readTime.toMillis()+this.leaseMs),updatedAt:FieldValue.serverTimestamp()});});}
 async release(){return this.db.runTransaction(async tx=>{const o=await tx.get(this.owner);this.guard(o);tx.update(this.owner,{state:'RELEASED',updatedAt:FieldValue.serverTimestamp()});});}
 async inspect(){
  return this.db.runTransaction(async tx=>{
   const head=await tx.get(this.run),h=await tx.get(this.run.collection('history').orderBy('order')),
    jobs=await tx.get(this.run.collection('jobs')),a=await tx.get(this.run.collection('artifacts').orderBy('artifactId')),
    owner=await tx.get(this.owner);
   if(!head.exists){if(!h.empty||!jobs.empty||!a.empty)fail('DATA_CORRUPT');return {head:null,history:[],jobs:[],artifacts:[],owner:owner.data()||null};}
   const row=head.data();if(row.schemaVersion!==1||row.runId!==this.runId)fail('SCHEMA_MISMATCH');
   const history=h.docs.map(d=>d.data()),snapshot=validateSnapshot({...row.snapshot,history});
   if(history.length!==row.historyLength||history.some((e,i)=>e.order!==i+1)||hash(history)!==row.historyDigest)fail('DATA_CORRUPT');
   return {head:{...row,snapshot},history,jobs:jobs.docs.map(d=>d.data()),artifacts:a.docs.map(d=>d.data()),owner:owner.data()||null};
  },{readOnly:true});
 }
 async load(runId){if(runId!==this.runId)fail('RUN_MISMATCH');const state=await this.inspect();this.revision=state.head?.revision||0;return state.head?.snapshot;}
 // All protected persistence paths use this single fenced atomic boundary.
 async commit(changes,{mutationId=randomUUID(),onAttempt,beforeCommit,afterCommit}={}){
  if(this.poisoned)fail('PERSISTENCE_UNCERTAIN');
  const value=copy(changes),digest=hash(value),expectedRevision=this.revision;this.lastMutationId=mutationId;
  if(!Array.isArray(value.jobs)||!Array.isArray(value.artifacts)||!text(value.definitionId)||!text(value.definitionVersion))fail('INVALID_ARGUMENT');
  if(value.snapshot){value.snapshot=validateSnapshot(value.snapshot);if(value.snapshot.runId!==this.runId||value.snapshot.history.length>100)fail('INVALID_ARGUMENT');}
  if(Buffer.byteLength(JSON.stringify(value),'utf8')>65536)fail('PAYLOAD_TOO_LARGE');
  const receipt=this.run.collection('mutations').doc(mutationId);
  try{
   const result=await this.db.runTransaction(async tx=>{
    if(onAttempt)await onAttempt();
    const owner=await tx.get(this.owner);this.guard(owner);
    const headDoc=await tx.get(this.run),prior=await tx.get(receipt),history=await tx.get(this.run.collection('history').orderBy('order'));
    const head=headDoc.data();
    if(prior.exists){if(prior.data().digest!==digest)fail('MUTATION_CONFLICT');return prior.data();}
    if((head?.revision||0)!==expectedRevision)fail('RUN_CHANGED');
    if(head&&(head.definitionId!==value.definitionId||head.definitionVersion!==value.definitionVersion||head.definitionDigest!==value.definitionDigest))fail('DEFINITION_CONFLICT');
    const oldHistory=history.docs.map(d=>d.data());
    if(head&&(oldHistory.length!==head.historyLength||hash(oldHistory)!==head.historyDigest))fail('DATA_CORRUPT');
    const proposed=value.snapshot?.history||oldHistory;
    if(proposed.length<oldHistory.length||!equal(proposed.slice(0,oldHistory.length),oldHistory))fail('HISTORY_CONFLICT');
    const jobRefs=value.jobs.map(j=>this.run.collection('jobs').doc(j.jobExecutionId));
    const oldJobs=jobRefs.length?await tx.getAll(...jobRefs):[];
    const artifactRefs=value.artifacts.map(a=>this.run.collection('artifacts').doc(hash([a.jobExecutionId,a.artifactKey,a.kind])));
    const oldArtifacts=artifactRefs.length?await tx.getAll(...artifactRefs):[];
    for(let i=0;i<value.jobs.length;i++){
     const j=value.jobs[i],old=oldJobs[i].data();
     if(j.runId!==this.runId||!text(j.jobExecutionId)||!['RUNNING','COMPLETED','FAILED'].includes(j.status))fail('INVALID_JOB');
     if(old&&(!equal([old.runId,old.stepNo,old.iterationNo,old.jobFormId],[j.runId,j.stepNo,j.iterationNo,j.jobFormId])||old.status==='COMPLETED'&&!equal(old,j)))fail('JOB_CONFLICT');
    }
    let ordinal=head?.artifactOrdinal||0;const artifactWrites=[];
    value.artifacts.forEach((a,i)=>{
     if(!['INTERNAL','PUBLISHED'].includes(a.kind)||!text(a.artifactKey)||!value.jobs.some(j=>j.jobExecutionId===a.jobExecutionId))fail('INVALID_ARTIFACT');
     const old=oldArtifacts[i].data();if(old){const {artifactId,...logical}=old;if(!equal(logical,a))fail('ARTIFACT_CONFLICT');}
     else artifactWrites.push([artifactRefs[i],{...a,artifactId:++ordinal}]);
    });
    const additions=proposed.slice(oldHistory.length);
    if(2+jobRefs.length+artifactWrites.length+additions.length>20)fail('TRANSACTION_TOO_LARGE');
    // Fault hook runs before writes; tests use only IPC barriers/errors, never business code.
    if(beforeCommit)await beforeCommit();
    const snapshot=value.snapshot?{...value.snapshot}:head?.snapshot;
    if(!snapshot)fail('INITIAL_SNAPSHOT_REQUIRED');delete snapshot.history;
    tx.set(this.run,{schemaVersion:1,runId:this.runId,definitionId:value.definitionId,definitionVersion:value.definitionVersion,
     definitionDigest:value.definitionDigest,snapshot,historyLength:proposed.length,historyDigest:hash(proposed),
     revision:(head?.revision||0)+1,artifactOrdinal:ordinal});
    value.jobs.forEach((j,i)=>tx.set(jobRefs[i],j));artifactWrites.forEach(([r,a])=>tx.create(r,a));
    additions.forEach(h=>tx.create(this.run.collection('history').doc(String(h.order).padStart(8,'0')),h));
    const result={digest,revision:(head?.revision||0)+1};tx.create(receipt,result);return result;
   });
   if(afterCommit)await afterCommit();this.revision=result.revision;return result;
  }catch(error){
   if(error instanceof PersistenceError)throw error;
   // A transport/commit error cannot establish whether writes became durable.
   this.poisoned=true;fail('OUTCOME_UNKNOWN');
  }
 }
 async observeMutation(id){const d=await this.run.collection('mutations').doc(id).get();return {state:d.exists?'PRESENT':'ABSENT',receipt:d.data()||null};}
}
module.exports={FirestoreExperimentStore,hash};
