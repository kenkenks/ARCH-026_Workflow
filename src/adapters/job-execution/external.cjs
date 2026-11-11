'use strict';
const {randomUUID,createHash}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const {SimpleDB,SCHEMA}=require('./simpledb.cjs');
const {SimpleDBError}=require('../simpledb/database.cjs');
const {EFFECT_SCHEMA,openControl,attachControl,fencedTransaction}=require('./ownership.cjs');
class ExternalError extends SimpleDBError{constructor(code){super(code);this.name='ExternalError';}}
const fail=code=>{throw new ExternalError(code);};
const text=x=>typeof x==='string'&&!!x.trim();
function normalize(x){if(x===null||typeof x==='string'||typeof x==='boolean')return x;if(typeof x==='number'&&Number.isFinite(x))return x;if(Array.isArray(x))return x.map(normalize);
 if(x&&typeof x==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(x)))return Object.fromEntries(Object.keys(x).sort().map(k=>[k,normalize(x[k])]));fail('INVALID_EXTERNAL_DATA');}
function encode(x){try{return JSON.stringify(normalize(x));}catch{fail('INVALID_EXTERNAL_DATA');}}
const hash=x=>createHash('sha256').update(encode(x)).digest('hex');
function decode(row){if(!row)return null;try{const payload=JSON.parse(row.payload_json);if(hash(payload)!==row.payload_hash||!text(row.request_id)||!text(row.operation_key)||!['PREPARED','IN_FLIGHT','CONFIRMED','UNKNOWN','REJECTED'].includes(row.state))fail('EXTERNAL_DATA_CORRUPT');const result=row.result_json===null?null:JSON.parse(row.result_json);if(['CONFIRMED','REJECTED'].includes(row.state)&&(!result||result.requestId!==row.request_id||result.payloadHash!==row.payload_hash||result.status!==row.state))fail('EXTERNAL_DATA_CORRUPT');
 if(['CONFIRMED','REJECTED'].includes(row.state))response({requestId:row.request_id,payloadHash:row.payload_hash},result);
 return {requestId:row.request_id,runId:row.run_id,jobExecutionId:row.job_execution_id,operationKey:row.operation_key,serviceId:row.service_id,idempotent:row.idempotent===1,payload,payloadHash:row.payload_hash,state:row.state,attemptNo:row.attempt_no,result,diagnosticCode:row.diagnostic_code};}catch{fail('EXTERNAL_DATA_CORRUPT');}}
function response(row,value){if(!value||typeof value!=='object'||value.requestId!==row.requestId||value.payloadHash!==row.payloadHash||!['CONFIRMED','REJECTED'].includes(value.status)||!value.result||typeof value.result!=='object'||Array.isArray(value.result)||(value.status==='CONFIRMED'&&!text(value.result.notificationId))||(value.status==='REJECTED'&&!text(value.result.code)))fail('INVALID_EXTERNAL_RESULT');return JSON.parse(encode(value));}
const firstDispatch=new WeakMap();
/** Fenced operation ledger. External calls never run inside a SQLite transaction. */
class ExternalOperations{
 constructor(options,ownership){if(!options.effects||!options.lease)fail('EFFECT_STORE_REQUIRED');const c=openControl(options);c.close();this.options={...options};this.ownership={...ownership};this.database=SimpleDB.open(options.historyFile,SCHEMA);try{attachControl(this.database,options);}catch(e){this.database.close();throw e;}}
 tx(action){return fencedTransaction(this.database,this.options,this.ownership,action,['CLAIMED','ACTIVE']);}
 read(requestId){return decode(this.database.get('SELECT * FROM resume_control.external_requests WHERE run_id=? AND request_id=?',this.options.runId,requestId));}
 get(requestId){return this.tx(()=>this.read(requestId));}
 prepare({jobExecutionId,operationKey,serviceId,idempotent,payload}){
  if(!text(jobExecutionId)||!text(operationKey)||!text(serviceId)||typeof idempotent!=='boolean')fail('INVALID_EXTERNAL_ARGUMENT');const json=encode(payload),digest=hash(payload);let created=false;
  const value=this.tx(()=>{const job=this.database.get('SELECT * FROM job_executions WHERE job_execution_id=? AND run_id=?',jobExecutionId,this.options.runId);if(!job)fail('EXTERNAL_JOB_NOT_FOUND');
   const old=decode(this.database.get('SELECT * FROM resume_control.external_requests WHERE run_id=? AND job_execution_id=? AND operation_key=?',this.options.runId,jobExecutionId,operationKey));
   if(old){if(old.serviceId!==serviceId||old.idempotent!==idempotent||old.payloadHash!==digest)fail('EXTERNAL_REQUEST_CONFLICT');return old;}
   const id=randomUUID();this.database.run("INSERT INTO resume_control.external_requests VALUES (?,?,?,?,?,?,?,?, 'PREPARED',0,NULL,NULL)",id,this.options.runId,jobExecutionId,operationKey,serviceId,idempotent?1:0,json,digest);created=true;return this.read(id);
  });if(created)firstDispatch.set(value,{requestId:value.requestId,claimToken:this.ownership.claimToken});return value;
 }
 client(row,client){if(!client||client.id!==row.serviceId||client.idempotent!==row.idempotent||typeof client.send!=='function'||typeof client.lookup!=='function')fail('EXTERNAL_SERVICE_MISMATCH');}
 unknown(id,reason,attempt){return this.tx(()=>{const r=this.read(id);if(!r)fail('EXTERNAL_REQUEST_NOT_FOUND');if(['CONFIRMED','REJECTED'].includes(r.state)||(attempt!==undefined&&r.attemptNo!==attempt))return r;
  this.database.run("UPDATE resume_control.external_requests SET state='UNKNOWN',diagnostic_code=? WHERE request_id=?",reason,id);return this.read(id);});}
 saveResult(id,value,attempt){return this.tx(()=>{const r=this.read(id);if(!r||r.attemptNo!==attempt)fail('EXTERNAL_ATTEMPT_CHANGED');const v=response(r,value);if(['CONFIRMED','REJECTED'].includes(r.state)){if(encode(r.result)!==encode(v))fail('EXTERNAL_RESULT_CONFLICT');return r;}this.database.run('UPDATE resume_control.external_requests SET state=?,result_json=?,diagnostic_code=NULL WHERE request_id=?',v.status,encode(v),id);return this.read(id);});}
 async dispatch(prepared,client){const capability=firstDispatch.get(prepared);const r=this.get(prepared?.requestId);if(!r)fail('EXTERNAL_REQUEST_NOT_FOUND');if(['CONFIRMED','REJECTED'].includes(r.state))return r;
  if(!capability||capability.requestId!==r.requestId||capability.claimToken!==this.ownership.claimToken)fail('PREPARED_REQUIRES_RECONCILIATION');firstDispatch.delete(prepared);return this.send(r,client,'PREPARED');}
 async resend(requestId,client){const r=this.get(requestId);if(!r)fail('EXTERNAL_REQUEST_NOT_FOUND');if(['CONFIRMED','REJECTED'].includes(r.state))return r;if(!r.idempotent||r.state!=='UNKNOWN')fail('EXTERNAL_RESEND_REFUSED');return this.send(r,client,'UNKNOWN');}
 async send(row,client,expected){this.client(row,client);const started=this.tx(()=>{const r=this.read(row.requestId);if(!r||r.state!==expected||r.attemptNo!==row.attemptNo)fail('EXTERNAL_ATTEMPT_CHANGED');this.database.run("UPDATE resume_control.external_requests SET state='IN_FLIGHT',attempt_no=attempt_no+1,diagnostic_code=NULL WHERE request_id=?",r.requestId);return this.read(r.requestId);});
  // Last local ownership check. Ownership can still change after this and before remote receipt.
  this.tx(()=>{const r=this.read(row.requestId);if(r.attemptNo!==started.attemptNo||r.state!=='IN_FLIGHT')fail('EXTERNAL_ATTEMPT_CHANGED');});
  let received;try{received=await client.send({requestId:started.requestId,payloadHash:started.payloadHash,payload:structuredClone(started.payload),fencingToken:this.ownership.fencingToken});response(started,received);}
  catch{try{this.unknown(started.requestId,'EXTERNAL_OUTCOME_UNKNOWN',started.attemptNo);}catch{/* retain saved IN_FLIGHT if storage/ownership is unavailable */}fail('EXTERNAL_OUTCOME_UNKNOWN');}
  try{return this.saveResult(started.requestId,received,started.attemptNo);}catch{fail('EXTERNAL_RESULT_SAVE_UNKNOWN');}
 }
 async reconcile(requestId,client){const r=this.get(requestId);if(!r)fail('EXTERNAL_REQUEST_NOT_FOUND');this.client(r,client);if(['CONFIRMED','REJECTED'].includes(r.state))return r;
  let found;try{found=await client.lookup(r.requestId);if(found!==null)response(r,found);}catch{return this.unknown(requestId,r.idempotent?'RESULT_LOOKUP_UNAVAILABLE':'MANUAL_REVIEW_NON_IDEMPOTENT',r.attemptNo);}
  if(found===null)return this.unknown(requestId,'ABSENCE_NOT_PROOF_OF_NONEXECUTION',r.attemptNo);
  return this.saveResult(requestId,found,r.attemptNo);
 }
 close(){this.database.close();}
}
/** Dedicated read-only projection; does not replace or repair Workflow diagnosis. */
function inspectRows(raw){const rows=raw.map(decode),unresolved=rows.filter(r=>r.state!=='CONFIRMED');return {classification:unresolved.length?'REVIEW_REQUIRED':'CLEAR',operations:rows.map(r=>({requestId:r.requestId,jobExecutionId:r.jobExecutionId,operationKey:r.operationKey,state:r.state,diagnosticCode:r.diagnosticCode,nextAction:r.state==='CONFIRMED'?'DO_NOT_RESEND':r.state==='REJECTED'?'REVIEW_REJECTION':r.idempotent?'QUERY_RESULT_FIRST':'MANUAL_REVIEW_NO_AUTOMATIC_RESEND'}))};}
function checkReferences(history,rows,runId){for(const row of rows)if(!history.get('SELECT job_execution_id FROM job_executions WHERE run_id=? AND job_execution_id=?',runId,row.job_execution_id))fail('EXTERNAL_DATA_CORRUPT');}
function assertExternalClear(db,options){const rows=db.connection.prepare('SELECT * FROM resume_control.external_requests WHERE run_id=? ORDER BY rowid').all(options.runId);checkReferences(db,rows,options.runId);if(inspectRows(rows).classification!=='CLEAR')fail('EXTERNAL_REVIEW_REQUIRED');}
function inspectExternal(options){let db,history;try{db=new SimpleDB(new DatabaseSync(options.controlFile,{readOnly:true}));if(db.get('PRAGMA application_id').application_id!==EFFECT_SCHEMA.applicationId||db.get('PRAGMA user_version').user_version!==EFFECT_SCHEMA.version)fail('EFFECT_SCHEMA_MISMATCH');
 const binding=db.connection.prepare('SELECT * FROM binding').all();if(binding.length!==1||binding[0].history_file!==fs.realpathSync(options.historyFile))fail('EFFECT_STORE_MISMATCH');
 const rows=db.connection.prepare('SELECT * FROM external_requests WHERE run_id=? ORDER BY rowid').all(options.runId);history=new SimpleDB(new DatabaseSync(options.historyFile,{readOnly:true}));checkReferences(history,rows,options.runId);return inspectRows(rows);
 }catch(e){return {classification:e?.code==='EXTERNAL_DATA_CORRUPT'?'INCONSISTENT':'REVIEW_REQUIRED',operations:[],diagnosticCode:e?.code==='EXTERNAL_DATA_CORRUPT'?'EXTERNAL_DATA_CORRUPT':'EXTERNAL_READ_UNAVAILABLE'};}finally{if(history)history.close();if(db)db.close();}}
module.exports={ExternalOperations,ExternalError,inspectExternal,assertExternalClear,encode,hash};
