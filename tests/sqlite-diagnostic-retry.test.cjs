'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process');
const {SimpleDB,SCHEMA}=require('../src/adapters/job-execution/simpledb.cjs');
const {STORAGE_SCHEMA}=require('../src/adapters/workflow-definition/simpledb.cjs');
const {readDiagnosticInput}=require('../src/adapters/job-execution/diagnostic.cjs');
const resume=require('../src/adapters/job-execution/resume.cjs');
async function fixture(action){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch022-diagnostic-')),historyFile=path.join(dir,'history.sqlite'),definitionFile=path.join(dir,'definitions.sqlite');SimpleDB.initialize(historyFile,SCHEMA);SimpleDB.initialize(definitionFile,STORAGE_SCHEMA);const db=SimpleDB.open(historyFile,SCHEMA);
 try{await action({o:{historyFile,definitionFile,runId:'run'},db});}finally{try{db.connection.exec('ROLLBACK');}catch{}db.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});}}
test('actual EXCLUSIVE lock is retried as whole read and recovers on release',()=>fixture(async({o,db})=>{db.connection.exec('BEGIN EXCLUSIVE');let n=0;const r=await readDiagnosticInput(o,{attempts:3,delayMs:1,wait:async ms=>{assert.equal(ms,1);n++;db.connection.exec('ROLLBACK');}});assert.equal(n,1);assert.deepEqual(r.readIssues,[]);assert.equal(r.run,null);}));
test('bounded retries exhaust and discard partial DTO; inspect never calls ownership',()=>fixture(async({o,db})=>{db.connection.exec('BEGIN EXCLUSIVE');let waits=0;const r=await readDiagnosticInput(o,{attempts:3,delayMs:0,wait:async()=>waits++});assert.equal(waits,2);assert.deepEqual(r.readIssues,[{kind:'unavailable',code:'HISTORY_READ_BUSY'}]);assert.deepEqual(r.traceRows,[]);const i=await resume.inspect(o,{sideEffectFree:true});assert.equal(i.ready,false);assert.deepEqual(i.reasons,['DIAGNOSTIC_READ_BUSY']);await assert.rejects(resume.claim(o,i,'host'),e=>e.code==='DIAGNOSTIC_UNAVAILABLE');}));
test('schema failure is not a transient retry',()=>fixture(async({o,db})=>{db.connection.exec('PRAGMA user_version=999');let waits=0;const r=await readDiagnosticInput(o,{wait:async()=>waits++});assert.equal(waits,0);assert.equal(r.readIssues[0].code,'HISTORY_READ_UNAVAILABLE');}));
test('retry policy has finite hard limits',()=>fixture(async({o})=>{for(const p of [{attempts:0},{attempts:11},{deadlineMs:1001},{delayMs:101}])await assert.rejects(readDiagnosticInput(o,p),e=>e.code==='INVALID_ARGUMENT');}));
test('process-held lock releases at observed retry, not by arbitrary test delay',()=>fixture(async({o})=>{
 const script=`const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');process.on('message',()=>{db.exec('ROLLBACK');db.close();process.send({released:true});process.disconnect();});process.send({ready:true});`;
 const c=fork('-e',[script,o.historyFile],{execArgv:[],windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});c.stderr.on('data',()=>{});const exit=new Promise(r=>c.once('exit',r));await new Promise(r=>c.once('message',r));
 let released=false;
 try{let waited=0;const result=await readDiagnosticInput(o,{attempts:3,delayMs:1,wait:async()=>{waited++;await new Promise(r=>{c.once('message',()=>{released=true;r();});c.send({release:true});});}});assert.equal(waited,1);assert.deepEqual(result.readIssues,[]);}finally{if(!released&&c.connected)c.send({release:true});await exit;}
}));
