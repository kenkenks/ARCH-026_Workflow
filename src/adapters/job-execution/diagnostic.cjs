'use strict';
const {DatabaseSync}=require('node:sqlite');
const {SimpleDB,SimpleDBError}=require('../simpledb/database.cjs');
const {SCHEMA:HISTORY_SCHEMA}=require('./simpledb.cjs');
const {STORAGE_SCHEMA:DEFINITION_SCHEMA,SimpleDBWorkflowDefinitionRepository}=require('../workflow-definition/simpledb.cjs');
const {diagnoseSavedRun}=require('../../../dist/src/prototype/diagnosis');
function openReadOnly(file,schema){
 const db=new SimpleDB(new DatabaseSync(file,{readOnly:true}));
 try{if(db.connection.prepare('PRAGMA application_id').get().application_id!==schema.applicationId||db.connection.prepare('PRAGMA user_version').get().user_version!==schema.version)throw new SimpleDBError('STORAGE_SCHEMA_MISMATCH');return db;}
 catch(error){db.close();throw error;}
}
/** Read-only diagnostic boundary; does not construct live Jobs, shelves or persistence observers. */
async function readOnce({historyFile,definitionFile,runId}){
 const input={runId,run:null,traceRows:[],jobExecutions:[],jobArtifacts:[],readIssues:[]};
 if(typeof runId!=='string'||!runId.trim()){input.readIssues.push({kind:'invalid',code:'RUN_ID_INVALID'});return input;}
 let db,begun=false;
 function json(value,code){try{return JSON.parse(value);}catch{input.readIssues.push({kind:'invalid',code});return undefined;}}
 try{
  db=openReadOnly(historyFile,HISTORY_SCHEMA);db.connection.exec('BEGIN');begun=true;
  const row=db.connection.prepare('SELECT * FROM workflow_runs WHERE run_id=?').get(runId);
  if(row)input.run={definitionId:row.definition_id,definitionVersion:row.definition_version,snapshot:json(row.snapshot_json,'SNAPSHOT_JSON_INVALID')};
  input.traceRows=db.connection.prepare('SELECT * FROM workflow_history WHERE run_id=? ORDER BY trace_order').all(runId).map(r=>({order:r.trace_order,stepNo:r.step_no,job:r.job_name,result:r.result,nextStepNo:r.next_step_no,at:r.recorded_at,...(r.error_text===null?{}:{error:r.error_text})}));
  input.jobExecutions=db.connection.prepare('SELECT * FROM job_executions WHERE run_id=? ORDER BY rowid').all(runId).map(r=>({jobExecutionId:r.job_execution_id,runId:r.run_id,stepNo:r.step_no,stepId:r.step_id,jobFormId:r.job_form_id,iterationNo:r.iteration_no,status:r.status,phase:r.phase}));
  input.jobArtifacts=db.connection.prepare('SELECT a.* FROM job_artifacts a JOIN job_executions j ON j.job_execution_id=a.job_execution_id WHERE j.run_id=? ORDER BY a.artifact_id').all(runId).map(r=>({artifactId:r.artifact_id,jobExecutionId:r.job_execution_id,artifactKey:r.artifact_key,kind:r.kind,type:r.artifact_type,value:json(r.artifact_json,'ARTIFACT_JSON_INVALID'),publicationEvidence:r.publication_evidence}));
  db.connection.exec('COMMIT');begun=false;
 }catch(error){
  input.readIssues.push({kind:'unavailable',code:[5,6].includes(error?.errcode&255)?'HISTORY_READ_BUSY':'HISTORY_READ_UNAVAILABLE'});
  if(begun)try{db.connection.exec('ROLLBACK');}catch{input.readIssues.push({kind:'unavailable',code:'READ_ROLLBACK_UNAVAILABLE'});}
 }finally{if(db)db.close();}
 if(input.run){let definitions;
  try{definitions=openReadOnly(definitionFile,DEFINITION_SCHEMA);input.definition=await new SimpleDBWorkflowDefinitionRepository(definitions).get(input.run.definitionId,input.run.definitionVersion);
   if(input.definition===null){delete input.definition;input.readIssues.push({kind:'unavailable',code:'DEFINITION_NOT_FOUND'});}}
  catch(error){input.readIssues.push({kind:['SCHEMA_MISMATCH','INVALID_DEFINITION','DATA_CORRUPT','DEFINITION_IDENTITY_MISMATCH'].includes(error?.code)?'invalid':'unavailable',code:'DEFINITION_READ_UNAVAILABLE'});}
  finally{if(definitions)definitions.close();}
 }
 return input;
}
/** Retry whole read-only snapshots only. Never retries claim, Job, write or commit. */
async function readDiagnosticInput(options,{attempts=4,delayMs=10,deadlineMs=150,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(!Number.isSafeInteger(attempts)||attempts<1||attempts>10||!Number.isSafeInteger(delayMs)||delayMs<0||delayMs>100||
   !Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>1000||typeof wait!=='function')throw new SimpleDBError('INVALID_ARGUMENT');
 const end=performance.now()+deadlineMs;let input;
 for(let i=0;i<attempts;i++){
  if(i>0&&performance.now()>=end)break;
  input=await readOnce(options);
  if(!input.readIssues.some(x=>x.code==='HISTORY_READ_BUSY'))return input;
  if(i+1===attempts||performance.now()+delayMs>=end)break;
  await wait(delayMs);
 }
 // A partial read must never masquerade as a coherent saved execution.
 return {runId:options.runId,run:null,traceRows:[],jobExecutions:[],jobArtifacts:[],readIssues:[{kind:'unavailable',code:'HISTORY_READ_BUSY'}]};
}
async function diagnoseSQLiteRun(options){return diagnoseSavedRun(await readDiagnosticInput(options));}
module.exports={readDiagnosticInput,diagnoseSQLiteRun};
