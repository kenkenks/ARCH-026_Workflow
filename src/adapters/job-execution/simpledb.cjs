'use strict';
const {randomUUID}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {SimpleDB,SimpleDBError}=require('../simpledb/database.cjs');
const {SCHEMA:BASE_SCHEMA,SQLiteWorkflowHistoryStore}=require('../workflow-history/simpledb.cjs');
const {createMemoryProductShelf}=require('../../../dist/src/prototype/job-form');
const SCHEMA=Object.freeze({applicationId:BASE_SCHEMA.applicationId,version:2,migrationFromVersions:Object.freeze([1]),sql:BASE_SCHEMA.sql+`
CREATE TABLE job_executions (
 job_execution_id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
 step_no INTEGER NOT NULL, step_id TEXT NOT NULL, job_form_id TEXT NOT NULL, iteration_no INTEGER NOT NULL CHECK(iteration_no>0),
 status TEXT NOT NULL CHECK(status IN ('READY','RUNNING','COMPLETED','FAILED')),
 phase TEXT CHECK(phase IN ('collect','make','record','post')),
 UNIQUE(run_id,step_no,iteration_no)
) STRICT;
CREATE TABLE job_artifacts (
 artifact_id INTEGER PRIMARY KEY, job_execution_id TEXT NOT NULL REFERENCES job_executions(job_execution_id),
 artifact_key TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('INTERNAL','PUBLISHED')),
 artifact_type TEXT NOT NULL, artifact_json TEXT NOT NULL,
 publication_evidence TEXT CHECK(publication_evidence IN ('RETURNED','OBSERVED_AFTER_ERROR')),
 UNIQUE(job_execution_id,artifact_key,kind)
) STRICT;`});
function text(value){if(typeof value!=='string'||!value.trim())throw new SimpleDBError('INVALID_ARGUMENT');}
function encode(value){
 function valid(x){if(x===null||typeof x==='string'||typeof x==='boolean')return;
  if(typeof x==='number'&&Number.isFinite(x))return;
  if(Array.isArray(x)){for(const v of x)valid(v);return;}
  if(x&&typeof x==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(x))){for(const v of Object.values(x))valid(v);return;}
  throw new SimpleDBError('UNSUPPORTED_ARTIFACT');
 }
 try{valid(value);return JSON.stringify(value);}catch{throw new SimpleDBError('UNSUPPORTED_ARTIFACT');}
}
function decode(row){
 try{const value=JSON.parse(row.artifact_json);encode(value);const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  if(type!==row.artifact_type)throw new SimpleDBError('DATA_CORRUPT');
  return {artifactId:row.artifact_id,jobExecutionId:row.job_execution_id,artifactKey:row.artifact_key,kind:row.kind,type:row.artifact_type,value,publicationEvidence:row.publication_evidence};}
 catch{throw new SimpleDBError('DATA_CORRUPT');}
}
/** Per-run observation/persistence adapter. Core Job state is read, never mirrored or changed. */
class SQLiteJobRunStore {
 constructor(database,definitionId,definitionVersion,runId,memory=createMemoryProductShelf()){
  text(runId);this.database=database;this.runId=runId;this.history=new SQLiteWorkflowHistoryStore(database,definitionId,definitionVersion);
  this.memory=memory;this.jobs=new Map();this.publications=[];this.current=null;this.failure=null;this.operation=null;
  this.products={has:key=>memory.has(key),get:key=>memory.get(key),put:(key,value)=>this.publish(key,value)};
  this.onCreate=(job,context)=>this.register(job,context);
 }
 getIdentity(job){const found=this.jobs.get(job);return found?{...found}:undefined;}
 getPersistenceFailure(){return this.failure?{...this.failure}:null;}
 register(job,context){
  if(this.jobs.has(job))throw new SimpleDBError('JOB_EXECUTION_REUSED');
  if(context.definitionId!==this.history.definitionId||context.definitionVersion!==this.history.definitionVersion||!Number.isSafeInteger(context.stepNo)||!Number.isSafeInteger(context.iterationNo)||context.iterationNo<1)throw new SimpleDBError('INVALID_ARGUMENT');
  text(context.jobFormId);text(context.stepId);
  const identity=Object.freeze({jobExecutionId:randomUUID(),runId:this.runId,stepNo:context.stepNo,stepId:context.stepId,jobFormId:context.jobFormId,iterationNo:context.iterationNo});
  this.jobs.set(job,identity);this.current=job;this.checkpoint();return {...identity};
 }
 transaction(action){
  if(this.failure)throw new SimpleDBError(this.failure.code);
  this.operation='transaction';
  try{return this.database.transaction(action);}catch(error){
   this.failure={code:error?.code||'UNAVAILABLE',operation:this.operation,publicationMayHaveOccurred:this.publications.length>0};throw error;
  }
 }
 artifact(identity,key,kind,value,evidence=null){
  this.operation=kind==='INTERNAL'?'internal-artifact':'published-artifact';
  text(key);const json=encode(value),type=value===null?'null':Array.isArray(value)?'array':typeof value;
  const old=this.database.get('SELECT * FROM job_artifacts WHERE job_execution_id=? AND artifact_key=? AND kind=?',identity.jobExecutionId,key,kind);
  if(old){if(!isDeepStrictEqual(decode(old).value,value)||old.publication_evidence!==evidence)throw new SimpleDBError('ARTIFACT_CONFLICT');return;}
  this.database.run('INSERT INTO job_artifacts(job_execution_id,artifact_key,kind,artifact_type,artifact_json,publication_evidence) VALUES (?,?,?,?,?,?)',identity.jobExecutionId,key,kind,type,json,evidence);
 }
 flush(){
  for(const [job,identity]of this.jobs){
   this.operation='job-execution';const state=job.getState();
   const old=this.database.get('SELECT * FROM job_executions WHERE job_execution_id=?',identity.jobExecutionId);
   if(old)this.database.run('UPDATE job_executions SET status=?,phase=? WHERE job_execution_id=?',state.status,state.phase,identity.jobExecutionId);
   else this.database.run('INSERT INTO job_executions VALUES (?,?,?,?,?,?,?,?)',identity.jobExecutionId,identity.runId,identity.stepNo,identity.stepId,identity.jobFormId,identity.iterationNo,state.status,state.phase);
   const internal=job.getRecorded();if(internal!==null)this.artifact(identity,job.artifactKey,'INTERNAL',internal.value);
  }
  for(const p of this.publications)this.artifact(p.identity,p.key,'PUBLISHED',p.value,p.evidence);
 }
 checkpoint(){return this.transaction(()=>this.flush());}
 load(runId){return this.history.load(runId);}
 save(value){
  if(value.runId!==this.runId)throw new SimpleDBError('HISTORY_IDENTITY_MISMATCH');
  return this.transaction(()=>{this.operation='workflow-history';this.history.save(value);this.flush();});
 }
 async publish(key,value){
  const job=this.current,identity=this.jobs.get(job);if(!identity||job.getState().phase!=='post')throw new SimpleDBError('PUBLICATION_WITHOUT_JOB');
  const before={exists:this.memory.has(key),value:this.memory.get(key)};
  // record already finished: persist internal product BEFORE making it visible.
  this.checkpoint();
  try{await this.memory.put(key,value);}catch(primary){
   const changed=this.memory.has(key)&&(!before.exists||!isDeepStrictEqual(before.value,this.memory.get(key)));
   if(changed){this.publications.push({identity,key,value:this.memory.get(key),evidence:'OBSERVED_AFTER_ERROR'});try{this.checkpoint();}catch{/* history-save failure will report storage independently; keep original post error */}}
   throw primary;
  }
  if(!this.memory.has(key))throw new SimpleDBError('PUBLICATION_NOT_OBSERVED');
  this.publications.push({identity,key,value:this.memory.get(key),evidence:'RETURNED'});this.checkpoint();
 }
 readRun(runId=this.runId){
  const run=this.history.getRun(runId);if(!run)return undefined;
  let rows,artifacts;
  try{rows=this.database.connection.prepare('SELECT * FROM job_executions WHERE run_id=? ORDER BY rowid').all(runId);
   artifacts=this.database.connection.prepare('SELECT a.* FROM job_artifacts a JOIN job_executions j ON j.job_execution_id=a.job_execution_id WHERE j.run_id=? ORDER BY a.artifact_id').all(runId);
  }catch{throw new SimpleDBError('UNAVAILABLE');}
  return {...run,jobExecutions:rows.map(r=>({jobExecutionId:r.job_execution_id,runId:r.run_id,stepNo:r.step_no,stepId:r.step_id,jobFormId:r.job_form_id,iterationNo:r.iteration_no,status:r.status,phase:r.phase})),jobArtifacts:artifacts.map(decode)};
 }
 currentProducts(runId=this.runId){const run=this.readRun(runId);if(!run)return undefined;const latest=new Map();for(const a of run.jobArtifacts)if(a.kind==='PUBLISHED')latest.set(a.artifactKey,{jobExecutionId:a.jobExecutionId,value:a.value,publicationEvidence:a.publicationEvidence});return [...latest].map(([artifactKey,value])=>({artifactKey,...value}));}
}
module.exports={SCHEMA,SimpleDB,SimpleDBError,SQLiteJobRunStore};
