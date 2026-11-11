'use strict';
const {SQLiteLifecycleBackend,WaitingHistoryStore}=require('../../src/adapters/workflow-waiting/sqlite.cjs');
const {config,graph}=require('./scenario.cjs');
const o=JSON.parse(process.argv[2]),backend=new SQLiteLifecycleBackend(o.file);let last;
function hit(stage){
 const r=backend.read(config.runId),status=r?.snapshot?.status;
 if(o.crash==='before-wait'&&stage==='before'&&status==='WAITING')process.exit(91);
 if(o.crash==='after-wait'&&stage==='after'&&status==='WAITING')process.exit(92);
 if(r?.activeOperationId===o.request?.operationId&&status==='RUNNING'){
  if(o.crash==='before-claim'&&stage==='before')process.exit(93);
  if(o.crash==='after-claim'&&stage==='after')process.exit(94);
 }
 if(o.crash==='before-result'&&stage==='before'&&status==='COMPLETED')process.exit(95);
}
const s=new WaitingHistoryStore(backend,{...config,ownerId:o.owner||'child',hooks:{beforeCommit:()=>hit('before'),afterCommit:()=>hit('after')}});
async function run(){try{
 if(o.action==='read')last=s.read();
 else if(o.action==='start'){s.claimStart('start');last=await graph(s).run(config.runId,10);}
 else {if(o.crash==='after-receive')process.exit(90);last=await graph(s).resumeWaiting(o.saved||s.load(config.runId),o.request);}
 process.send?.({ok:true,value:last});
 }catch(e){process.send?.({ok:false,code:e.code||'UNEXPECTED'});}finally{s.close();process.disconnect?.();}}
if(o.barrier){process.once('message',run);process.send({ready:true});}else run();
