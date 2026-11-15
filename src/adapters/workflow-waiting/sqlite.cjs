'use strict';
const {SimpleDB}=require('../simpledb/database.cjs');
const {WaitingHistoryStore}=require('./lifecycle.cjs');
// Separate explicit storage. No Open path migrates legacy history/control DBs.
const SCHEMA=Object.freeze({applicationId:0x41525754,version:1,sql:'CREATE TABLE waiting_runs(run_id TEXT PRIMARY KEY NOT NULL, state_json TEXT NOT NULL) STRICT;'});
class SQLiteLifecycleBackend {
 static initialize(file){SimpleDB.initialize(file,SCHEMA);}
 constructor(file){this.database=SimpleDB.open(file,SCHEMA);}
 read(id){const r=this.database.get('SELECT state_json FROM waiting_runs WHERE run_id=?',id);if(!r)return undefined;try{return JSON.parse(r.state_json);}catch{throw Object.assign(Error('DATA_CORRUPT'),{code:'DATA_CORRUPT'});}}
 inspect(id,action){
  let result,primary;
  try{this.database.transaction(()=>{
   const now=this.database.get("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS n").n;
   try{result=action(this.read(id),now);}catch(e){primary=e;throw e;}
  });}catch(e){throw primary||e;}return result;
 }
 update(id,action,hooks={}){
  let next,primary;try{this.database.transaction(()=>{
   const now=this.database.get("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS n").n;
   try{next=action(this.read(id),now);}catch(e){primary=e;throw e;}const encoded=JSON.stringify(next);
   this.database.run('INSERT INTO waiting_runs VALUES (?,?) ON CONFLICT(run_id) DO UPDATE SET state_json=excluded.state_json',id,encoded);
   hooks.beforeCommit?.();
  });}catch(e){throw primary||e;}hooks.afterCommit?.();return structuredClone(next);
 }
 close(){this.database.close();}
}
module.exports={SQLiteLifecycleBackend,WaitingHistoryStore,SCHEMA};
