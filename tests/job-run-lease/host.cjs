'use strict';
const fs=require('node:fs');
const api=require('../../src/adapters/job-execution/resume.cjs');
const {SimpleDB,SCHEMA}=require('../../src/adapters/job-execution/simpledb.cjs');
const {attachControl,fencedTransaction,openControl,guardOwnership}=require('../../src/adapters/job-execution/ownership.cjs');
const options=JSON.parse(process.argv[2]);let ownership,continueJob;
function barrier(hold){fs.writeFileSync(hold.locked,'locked');const end=Date.now()+10000;while(!fs.existsSync(hold.go)){if(Date.now()>end)throw Error('test barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
function write(kind,hold){const db=SimpleDB.open(options.historyFile,SCHEMA);try{attachControl(db,options);return fencedTransaction(db,options,ownership,()=>{
 const sql={history:'UPDATE workflow_runs SET snapshot_json=snapshot_json WHERE run_id=?',job:'UPDATE job_executions SET status=status WHERE run_id=?',internal:"UPDATE job_artifacts SET artifact_json=artifact_json WHERE kind='INTERNAL'",published:"UPDATE job_artifacts SET artifact_json=artifact_json WHERE kind='PUBLISHED'"}[kind];
 if(hold?.change){db.run("UPDATE workflow_runs SET snapshot_json='uncommitted-broken' WHERE run_id=?",options.runId);db.run('UPDATE resume_control.claims SET updated_at=updated_at+123 WHERE run_id=?',options.runId);}
 if(hold)barrier(hold);
 const result=db.run(sql,...(['history','job'].includes(kind)?[options.runId]:[]));if(hold?.fail)throw Error('injected after write');return Number(result.changes);
 },['CLAIMED','ACTIVE']);}finally{db.close();}}
process.on('message',async m=>{try{let value;
 if(m.command==='claim'){ownership=await api.claim(options,await api.inspect(options,m.policy),m.owner);value=ownership;}
 else if(m.command==='takeover'){ownership=await api.takeover(options,m.policy,m.owner);value=ownership;}
 else if(m.command==='heartbeat')value=api.heartbeat(options,{...ownership,...m.override});
 else if(m.command==='heartbeat-hold'){const db=openControl(options);try{value=db.transaction(()=>{guardOwnership(db,'',options,ownership,['CLAIMED','ACTIVE']);db.run("UPDATE claims SET lease_expires_at=lease_expires_at+5000,updated_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE run_id=?",options.runId);barrier(m.hold);return true;});}finally{db.close();}}
 else if(m.command==='release')value=api.release(options,{...ownership,...m.override});
 else if(m.command==='write')value=write(m.kind,m.hold);
 else if(m.command==='inspect')value=await api.inspect(options,m.policy);
 else if(m.command==='continue'){continueJob?.();value=true;}
 else if(m.command==='resume')value=await api.resume(options,ownership,({products,onCreate})=>({jobs:new Map(),checks:new Map(),jobForms:{products,onCreate,definitions:new Map(['a','b','c'].map(name=>[name,{artifactKey:name==='c'?'Z':'X',form:{name,collect:p=>name==='a'?10:p.get('X'),make:async x=>{if(m.wait&&name==='c'){process.send({event:'waiting'});await new Promise(r=>{continueJob=r;});}return name==='a'?x:x+10;}}}]))}}));
 else throw Error('unknown command');
 if(m.command==='resume'&&process.env.ARCH026_LEASE_OBSERVATIONS){let observation;try{observation=await require('../../src/adapters/job-execution/history-observation.cjs').observeHistorySave(options,value.snapshot);}catch{observation={state:'UNKNOWN'};}record({command:m.command,ok:true,callCompleted:true,observation});}
 process.send({id:m.id,ok:true,value});
 }catch(e){
  const diagnostic={transactionPhase:e?.storageCause?.transactionPhase||e?.transactionPhase||null,sqliteCode:e?.storageCause?.sqliteCode??e?.sqliteCode??null,
   rollbackConfirmed:e?.storageCause?.rollbackConfirmed??e?.rollbackConfirmed??null,storageCode:e?.storageCause?.code||null,
   primaryCode:e?.cause?.code||null,primaryTransactionPhase:e?.cause?.transactionPhase||null,primarySqliteCode:e?.cause?.sqliteCode??null};
  let observation;try{observation=await require('../../src/adapters/job-execution/history-observation.cjs').observeHistorySave(options,e?.attemptedSnapshot,e?.storageCause||e);}catch{observation={state:'UNKNOWN'};}
  process.send({id:m.id,ok:false,code:e?.code??'INJECTED_FAILURE',diagnostic,observation});
  record({command:m.command,ok:false,code:e?.code??'INJECTED_FAILURE',diagnostic,observation});
 }});
function record(value){
 const file=process.env.ARCH026_LEASE_OBSERVATIONS;if(!file)return;
 const path=require('node:path'),root=path.resolve(__dirname,'../../logs');if(!path.resolve(file).startsWith(root+path.sep))return;
 try{fs.appendFileSync(file,JSON.stringify({runId:options.runId,...value})+'\n');}catch{/* observation must not replace the original outcome */}
}
process.send({event:'ready'});
