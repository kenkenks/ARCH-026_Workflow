'use strict';
const fs=require('node:fs'),{randomUUID}=require('node:crypto');
const {SimpleDB,SimpleDBError}=require('../simpledb/database.cjs');
function schema(lease){return Object.freeze({applicationId:0x41525243,version:lease?2:1,sql:`
CREATE TABLE binding(history_file TEXT NOT NULL${lease?',lease_ms INTEGER NOT NULL CHECK(lease_ms>0)':''}) STRICT;
CREATE TABLE claims(run_id TEXT PRIMARY KEY NOT NULL,owner_id TEXT NOT NULL,claim_token TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('CLAIMED','ACTIVE','STOPPED','FINISHED')),fingerprint TEXT NOT NULL
 ${lease?',fencing_token INTEGER NOT NULL CHECK(fencing_token>0),lease_expires_at INTEGER NOT NULL,updated_at INTEGER NOT NULL':''}) STRICT;
CREATE TABLE resume_events(event_id INTEGER PRIMARY KEY,run_id TEXT NOT NULL,owner_id TEXT NOT NULL,
 claim_token TEXT NOT NULL,event TEXT NOT NULL,history_length INTEGER NOT NULL,step_no INTEGER,at TEXT NOT NULL) STRICT;`});}
const CONTROL_SCHEMA=schema(false),LEASE_SCHEMA=schema(true);
const EFFECT_SCHEMA=Object.freeze({applicationId:LEASE_SCHEMA.applicationId,version:3,sql:LEASE_SCHEMA.sql+`
CREATE TABLE external_requests(
 request_id TEXT PRIMARY KEY NOT NULL,run_id TEXT NOT NULL,job_execution_id TEXT NOT NULL,operation_key TEXT NOT NULL,
 service_id TEXT NOT NULL,idempotent INTEGER NOT NULL CHECK(idempotent IN (0,1)),payload_json TEXT NOT NULL,payload_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PREPARED','IN_FLIGHT','CONFIRMED','UNKNOWN','REJECTED')),
 attempt_no INTEGER NOT NULL CHECK(attempt_no>=0),result_json TEXT,diagnostic_code TEXT,
 UNIQUE(run_id,job_execution_id,operation_key)
) STRICT;`});
const fail=code=>{throw new SimpleDBError(code);};
const text=x=>typeof x==='string'&&!!x.trim();
function now(db){const n=db.get("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS n").n;if(!Number.isSafeInteger(n))fail('CLOCK_UNAVAILABLE');return n;}
function initializeResumeControl(controlFile,historyFile,{lease=false,leaseMs=30000,effects=false}={}){
 if(effects&&!lease)fail('LEASE_REQUIRED');
 if(lease&&(!Number.isSafeInteger(leaseMs)||leaseMs<1||leaseMs>3600000))fail('INVALID_ARGUMENT');
 const real=fs.realpathSync(historyFile),s=effects?EFFECT_SCHEMA:lease?LEASE_SCHEMA:CONTROL_SCHEMA;SimpleDB.initialize(controlFile,s);const db=SimpleDB.open(controlFile,s);
 try{db.transaction(()=>db.run(lease?'INSERT INTO binding VALUES (?,?)':'INSERT INTO binding VALUES (?)',...lease?[real,leaseMs]:[real]));}finally{db.close();}
}
function openControl(options){if(options.effects&&!options.lease)fail('LEASE_REQUIRED');const db=SimpleDB.open(options.controlFile,options.effects?EFFECT_SCHEMA:options.lease?LEASE_SCHEMA:CONTROL_SCHEMA);try{const rows=db.connection.prepare('SELECT * FROM binding').all();if(rows.length!==1||rows[0].history_file!==fs.realpathSync(options.historyFile))fail('RESUME_STORAGE_MISMATCH');if(options.lease&&db.get('PRAGMA journal_mode').journal_mode!=='delete')fail('UNSAFE_JOURNAL_MODE');return db;}catch(e){db.close();throw e;}}
/** Shared ownership predicate: invoked inside the SAME transaction as protected writes. */
function guardOwnership(db,prefix,options,ownership,states){
 if(ownership?.runId!==options.runId||!text(ownership.ownerId)||!text(ownership.claimToken))fail('INVALID_ARGUMENT');
 if(options.lease&&prefix==='resume_control.')for(const name of ['main','resume_control']){if(db.get(`PRAGMA ${name}.journal_mode`).journal_mode!=='delete')fail('UNSAFE_JOURNAL_MODE');if(db.get(`PRAGMA ${name}.synchronous`).synchronous!==2)fail('UNSAFE_SYNCHRONOUS');}
 const row=db.get(`SELECT * FROM ${prefix}claims WHERE run_id=?`,options.runId);
 if(!row||row.owner_id!==ownership.ownerId||row.claim_token!==ownership.claimToken||!states.includes(row.state))fail('CLAIM_TOKEN_INVALID');
 if(options.lease){if(!Number.isSafeInteger(ownership.fencingToken)||row.fencing_token!==ownership.fencingToken)fail('FENCING_REJECTED');if(row.lease_expires_at<=now(db))fail('LEASE_EXPIRED');}
 db.run(`UPDATE ${prefix}claims SET state=state WHERE run_id=? AND claim_token=?`,options.runId,ownership.claimToken);return row;
}
function acquireClaim(options,inspection,ownerId,takeover=false){
 if(!text(ownerId)||inspection.runId!==options.runId)fail('INVALID_ARGUMENT');if(takeover&&!options.lease)fail('LEASE_REQUIRED');
 const db=openControl(options),token=randomUUID();let result;
 try{db.transaction(()=>{const old=db.get('SELECT * FROM claims WHERE run_id=?',options.runId),t=options.lease?now(db):null;
  if(takeover){if(!old||!['CLAIMED','ACTIVE'].includes(old.state))fail('TAKEOVER_NOT_AVAILABLE');if(old.lease_expires_at>t)fail('LEASE_ACTIVE');}
  else if(old&&old.state!=='STOPPED')fail('RUN_CLAIMED');
  if(options.lease){const fence=(old?.fencing_token??0)+1;if(!Number.isSafeInteger(fence))fail('FENCING_EXHAUSTED');const duration=db.get('SELECT lease_ms FROM binding').lease_ms,expires=t+duration;
   if(old)db.run("UPDATE claims SET owner_id=?,claim_token=?,state='CLAIMED',fingerprint=?,fencing_token=?,lease_expires_at=?,updated_at=? WHERE run_id=?",ownerId,token,inspection.fingerprint,fence,expires,t,options.runId);
   else db.run("INSERT INTO claims VALUES (?,?,?,'CLAIMED',?,?,?,?)",options.runId,ownerId,token,inspection.fingerprint,fence,expires,t);
   result={fencingToken:fence,leaseExpiresAt:expires,updatedAt:t};
  }else if(old)db.run("UPDATE claims SET owner_id=?,claim_token=?,state='CLAIMED',fingerprint=? WHERE run_id=? AND state='STOPPED'",ownerId,token,inspection.fingerprint,options.runId);
  else db.run("INSERT INTO claims VALUES (?,?,?,'CLAIMED',?)",options.runId,ownerId,token,inspection.fingerprint);
 });return {runId:options.runId,ownerId,claimToken:token,policy:inspection.policy,...result};}finally{db.close();}
}
function heartbeat(options,ownership){if(!options.lease)fail('LEASE_REQUIRED');const db=openControl(options);try{return db.transaction(()=>{const row=guardOwnership(db,'',options,ownership,['CLAIMED','ACTIVE']),t=now(db),ms=db.get('SELECT lease_ms FROM binding').lease_ms,expires=Math.max(row.lease_expires_at+1,t+ms);
 db.run('UPDATE claims SET lease_expires_at=?,updated_at=? WHERE run_id=?',expires,t,options.runId);return {leaseExpiresAt:expires,updatedAt:t,fencingToken:row.fencing_token};});}finally{db.close();}}
function releaseWithin(db,prefix,options,ownership,state,states=['CLAIMED','ACTIVE']){guardOwnership(db,prefix,options,ownership,states);if(options.lease){const t=now(db);db.run(`UPDATE ${prefix}claims SET state=?,lease_expires_at=?,updated_at=? WHERE run_id=?`,state,t,t,options.runId);}else db.run(`UPDATE ${prefix}claims SET state=? WHERE run_id=?`,state,options.runId);}
function release(options,ownership){const db=openControl(options);try{db.transaction(()=>releaseWithin(db,'',options,ownership,'STOPPED'));return {released:true};}finally{db.close();}}
function attachControl(db,options){db.connection.prepare('ATTACH DATABASE ? AS resume_control').run(fs.realpathSync(options.controlFile));
 if(options.lease){for(const name of ['main','resume_control']){if(db.get(`PRAGMA ${name}.journal_mode`).journal_mode!=='delete')fail('UNSAFE_JOURNAL_MODE');db.connection.exec(`PRAGMA ${name}.synchronous=FULL`);if(db.get(`PRAGMA ${name}.synchronous`).synchronous!==2)fail('UNSAFE_SYNCHRONOUS');}}
}
/** One checked local SQLite write boundary; action MUST be synchronous. */
function fencedTransaction(db,options,ownership,action,states=['ACTIVE']){return db.transaction(()=>{guardOwnership(db,'resume_control.',options,ownership,states);return action();});}
module.exports={CONTROL_SCHEMA,LEASE_SCHEMA,EFFECT_SCHEMA,initializeResumeControl,openControl,guardOwnership,acquireClaim,heartbeat,release,releaseWithin,attachControl,fencedTransaction};
