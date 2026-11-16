'use strict';
// Dedicated C03 fixture. The real save method is never called at the crash boundary.
const {DatabaseSync}=require('node:sqlite');
const {api,definition,options,registry,request,WaitingHistoryStore,SQLiteLifecycleBackend}=require('../workflow-artifact-resume/scenario.cjs');
const input=JSON.parse(process.argv[2]),d=definition('LIMIT_REACHED'),store=new WaitingHistoryStore(new SQLiteLifecycleBackend(input.file),options(d,'run',input.host)),effects=new DatabaseSync(input.effects);
effects.exec('PRAGMA synchronous=FULL');
const note=(kind,payload={})=>effects.prepare('INSERT INTO events(kind,host,payload) VALUES(?,?,?)').run(kind,input.host,JSON.stringify(payload));
process.on('message',()=>{}); // Keep IPC referenced while the pre-save Promise is deliberately held.
(async()=>{
 try{
  class Probe extends api.CJobForm{
   async execute(context){note('JOB_STARTED');await super.execute(context);note('JOB_SUCCEEDED',{cmrpStatus:api.getExecutionState(context).status});}
   collect(){return {synthetic:true};}
   make(value){return value;}
   record(){note('EXTERNAL_EFFECT',{operationIdentifier:store.read().activeOperationId});}
  }
  const r=registry(store);r.nativeForms.set('q',{form:new Probe('q'),artifactKey:'RESULT'});
  const g=await api.restoreWorkflowCheckpoint(d,r,store),q=input.request||request(g.checkpoint,'operation-B'),save=store.saveCheckpoint.bind(store);
  if(input.crashBoundary)store.saveCheckpoint=(snapshot,artifacts)=>{
   if(snapshot.history.some(h=>h.stepNo===40&&h.result==='DONE')){
    const checkpoint=store.readCheckpoint();note('BEFORE_CHECKPOINT_SAVE',{checkpoint,attemptedSnapshot:snapshot,memoryArtifactPresent:g.artifacts.reader().has('RESULT')});
    process.send({barrier:'JOB_SUCCEEDED_BEFORE_CHECKPOINT',checkpoint,attemptedSnapshot:snapshot,memoryArtifactPresent:g.artifacts.reader().has('RESULT')});
    return new Promise(()=>{});
   }
   return save(snapshot,artifacts);
  };
  const done=await g.workflow.resumeCheckpoint(g.checkpoint,q);
  process.send?.({ok:true,snapshot:done});
 }catch(e){process.send?.({ok:false,code:e.code,causeCode:e.cause?.code,storageCode:e.storageCause?.code});}
 finally{store.close();effects.close();process.disconnect?.();}
})().catch(e=>{process.send?.({ok:false,code:e.code||e.name});process.exitCode=1;process.disconnect?.();});
