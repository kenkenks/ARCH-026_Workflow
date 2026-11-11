'use strict';
const {isDeepStrictEqual}=require('node:util');
const {SimpleDB,SimpleDBError}=require('../simpledb/database.cjs');
const {CMemoryHistoryStore}=require('../../../dist/src/prototype/workflow');
const {validateDefinitionKey}=require('../../../dist/src/prototype/definition');
const SCHEMA=Object.freeze({applicationId:0x41525255,version:1,sql:`
CREATE TABLE workflow_runs (
 run_id TEXT PRIMARY KEY NOT NULL, definition_id TEXT NOT NULL, definition_version TEXT NOT NULL,
 snapshot_json TEXT NOT NULL
) STRICT;
CREATE TABLE workflow_history (
 run_id TEXT NOT NULL REFERENCES workflow_runs(run_id), trace_order INTEGER NOT NULL CHECK(trace_order>0),
 step_no INTEGER NOT NULL, job_name TEXT NOT NULL,
 result TEXT NOT NULL CHECK(result IN ('DONE','TRUE','FALSE','ERROR')),
 next_step_no INTEGER, recorded_at TEXT NOT NULL, error_text TEXT,
 PRIMARY KEY(run_id,trace_order)
) STRICT;`});
// Reuse the current public Memory DTO validator/copy boundary, not a second schema.
function snapshot(input){const validator=new CMemoryHistoryStore();validator.save(input);return validator.load(input.runId);}
class SQLiteWorkflowHistoryStore {
 constructor(database,definitionId,definitionVersion){
  validateDefinitionKey(definitionId);validateDefinitionKey(definitionVersion);
  this.database=database;this.definitionId=definitionId;this.definitionVersion=definitionVersion;
  database.connection.exec('PRAGMA foreign_keys=ON');
 }
 decode(row){
  if(!row)return undefined;
  let value;
  try{value=snapshot(JSON.parse(row.snapshot_json));}catch{throw new SimpleDBError('DATA_CORRUPT');}
  if(value.runId!==row.run_id)throw new SimpleDBError('DATA_CORRUPT');
  if(row.definition_id!==this.definitionId||row.definition_version!==this.definitionVersion)throw new SimpleDBError('HISTORY_IDENTITY_MISMATCH');
  let rows;
  try{rows=this.database.connection.prepare('SELECT * FROM workflow_history WHERE run_id=? ORDER BY trace_order').all(row.run_id);}
  catch{throw new SimpleDBError('UNAVAILABLE');}
  const history=rows.map(r=>({order:r.trace_order,stepNo:r.step_no,job:r.job_name,result:r.result,nextStepNo:r.next_step_no,at:r.recorded_at,...(r.error_text===null?{}:{error:r.error_text})}));
  const known=value.history.map(h=>({order:h.order,stepNo:h.stepNo,job:h.job,result:h.result,nextStepNo:h.nextStepNo,at:h.at,...(h.error===undefined?{}:{error:h.error})}));
  if(!isDeepStrictEqual(known,history))throw new SimpleDBError('DATA_CORRUPT');
  return value;
 }
 load(runId){
  new CMemoryHistoryStore().load(runId); // Existing identifier contract.
  const read=()=>this.decode(this.database.get('SELECT * FROM workflow_runs WHERE run_id=?',runId));
  if(this.database.active)return read();
  // A deferred READ transaction keeps both tables consistent without requiring
  // write permission (SimpleDB.transaction deliberately uses BEGIN IMMEDIATE).
  let begun=false;
  try{
   this.database.assertOpen();this.database.connection.exec('BEGIN');begun=true;
   const value=read();this.database.connection.exec('COMMIT');begun=false;return value;
  }catch(error){
   const failure=error instanceof SimpleDBError?error:new SimpleDBError('UNAVAILABLE');
   if(begun)try{this.database.connection.exec('ROLLBACK');}catch{failure.cleanupDiagnostics=['READ_ROLLBACK_FAILED'];}
   throw failure;
  }
 }
 getRun(runId){const value=this.load(runId);return value?{definitionId:this.definitionId,definitionVersion:this.definitionVersion,snapshot:value}:undefined;}
 save(input){
  const value=snapshot(input),json=JSON.stringify(value);
  if(value.history.some((h,i)=>h.order!==i+1))throw new SimpleDBError('INVALID_ARGUMENT');
  const write=()=>{
   const old=this.load(value.runId);
   if(old&&(old.history.length>value.history.length||!isDeepStrictEqual(old.history,value.history.slice(0,old.history.length))))throw new SimpleDBError('HISTORY_CONFLICT');
   if(old)this.database.run('UPDATE workflow_runs SET snapshot_json=? WHERE run_id=?',json,value.runId);
   else this.database.run('INSERT INTO workflow_runs VALUES (?,?,?,?)',value.runId,this.definitionId,this.definitionVersion,json);
   for(const h of value.history.slice(old?.history.length??0))this.database.run('INSERT INTO workflow_history VALUES (?,?,?,?,?,?,?,?)',value.runId,h.order,h.stepNo,h.job,h.result,h.nextStepNo,h.at,h.error??null);
  };
  // Participate in a caller-owned transaction when saving related Job observations.
  return this.database.active?write():this.database.transaction(write);
 }
}
module.exports={SCHEMA,SimpleDB,SQLiteWorkflowHistoryStore};
