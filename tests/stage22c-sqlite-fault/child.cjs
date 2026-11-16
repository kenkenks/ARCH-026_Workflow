'use strict';
// C04: block synchronously at existing save hooks; parent observes a marker then terminates this child.
const fs=require('node:fs'),crypto=require('node:crypto');
const {api,definition,options,registry,request,WaitingHistoryStore,SQLiteLifecycleBackend}=require('../workflow-artifact-resume/scenario.cjs');
const input=JSON.parse(process.argv[2]),d=definition('LIMIT_REACHED'),backend=new SQLiteLifecycleBackend(input.file),store=new WaitingHistoryStore(backend,options(d,'run','host-A'));
const counts={started:0,completed:0};
const project=c=>{const {token,...owner}=c.owner;return {...c,owner:{...owner,tokenSha256:crypto.createHash('sha256').update(token).digest('hex')}};};
function stop(payload){
 const marker={...payload,counts:{...counts},transactionActive:backend.database.active};
 fs.writeFileSync(input.marker+'.tmp',JSON.stringify(marker));fs.renameSync(input.marker+'.tmp',input.marker);
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);
 throw Error('PARENT_DID_NOT_TERMINATE_CHILD');
}
(async()=>{
 try{
  class Probe extends api.CJobForm{async execute(context){counts.started++;await super.execute(context);counts.completed++;}collect(){return {generation:'new',boundary:input.boundary};}make(v){return v;}}
  const r=registry(store);r.nativeForms.set('q',{form:new Probe('q'),artifactKey:'RESULT'});
  const g=await api.restoreWorkflowCheckpoint(d,r,store),save=store.saveCheckpoint.bind(store);
  store.saveCheckpoint=(snapshot,artifacts)=>{
   if(snapshot.history.some(h=>h.stepNo===40&&h.result==='DONE')){
    const old=project(store.readCheckpoint()),base={boundary:input.boundary,oldCheckpoint:old,intendedWorkflow:snapshot,intendedArtifacts:artifacts};
    if(input.boundary==='before-transaction')stop({...base,visibleCheckpoint:old});
    store.hooks.beforeCommit=()=>{if(input.boundary==='updated-before-commit')stop({...base,visibleCheckpoint:project(store.readCheckpoint())});};
    store.hooks.afterCommit=()=>{if(input.boundary==='after-commit')stop({...base,visibleCheckpoint:project(store.readCheckpoint())});};
   }
   return save(snapshot,artifacts);
  };
  await g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint,'operation-A'));process.exitCode=2;
 }catch(e){console.error(e.code||e.stack);process.exitCode=1;}finally{store.close();}
})();
