'use strict';
const fs=require('node:fs');
const {api,definition,options,registry,start,request,raw,WaitingHistoryStore,SQLiteLifecycleBackend}=require('./scenario.cjs');
const input=JSON.parse(process.argv[2]);
(async()=>{const d=input.definition||definition(input.kind),backend=new SQLiteLifecycleBackend(input.file),store=new WaitingHistoryStore(backend,{...options(d,input.runId||'run',input.owner||'child'),...(input.leaseMs?{leaseMs:input.leaseMs}:{}),hooks:{}}),calls=[];
 try{
  if(input.action==='start'){const r=await start(store,d,calls);process.send?.({ok:true,snapshot:r.saved,calls});return;}
  const hooks=input.effectFile?{record:()=>{fs.appendFileSync(input.effectFile,'effect\n');store.hooks.beforeCommit=()=>{throw Error('after external effect');};}}:{};
  const g=await api.restoreWorkflowCheckpoint(d,registry(store,calls,hooks),store),q=input.request||request(g.checkpoint,input.operationId||'resume');
  if(input.barrier){process.send?.({ready:true});await new Promise(resolve=>process.once('message',resolve));}
  if(input.crash==='after-claim')store.hooks.afterCommit=()=>process.exit(91);
  if(input.loss==='claim')store.hooks.afterCommit=()=>{throw Error('claim response lost');};
  const snapshot=await g.workflow.resumeCheckpoint(g.checkpoint,q,input.limit||100,input.pauseBeforeStep?()=>new Promise(r=>setTimeout(r,input.pauseBeforeStep)):undefined);
  process.send?.({ok:true,snapshot,calls,checkpoint:store.readCheckpoint(),result:g.artifacts.reader().get('RESULT')});
 }catch(e){process.send?.({ok:false,code:e.code||e.name,causeCode:e.cause?.code,storageCode:e.storageCause?.code,calls,stored:raw(backend,input.runId||'run').snapshot.status});}
 finally{store.close();}
})().catch(e=>{process.send?.({ok:false,code:e.code||e.name});process.exitCode=1;});
