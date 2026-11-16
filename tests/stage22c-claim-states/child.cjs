'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {api,definition,options,registry,request,WaitingHistoryStore,SQLiteLifecycleBackend}=require('../workflow-artifact-resume/scenario.cjs');
const input=JSON.parse(process.argv[2]),d=definition(input.kind),store=new WaitingHistoryStore(new SQLiteLifecycleBackend(input.file),options(d,'run',input.host));
const counts={started:0,completed:0,effects:0},calls=[];
const project=c=>{const {token,...owner}=c.owner;return {...c,owner:{...owner,tokenSha256:crypto.createHash('sha256').update(token).digest('hex')}};};
const wait=()=>new Promise(resolve=>process.once('message',resolve));
const note=kind=>fs.appendFileSync(input.ledger,JSON.stringify({kind,host:input.host,operationIdentifier:store.read().activeOperationId})+'\n');
(async()=>{
 try{
  class Probe extends api.CJobForm{async execute(context){counts.started++;note('JOB_STARTED');await super.execute(context);counts.completed++;note('JOB_SUCCEEDED');}collect(){calls.push('q');return {synthetic:true};}make(v){return v;}record(){counts.effects++;note('EXTERNAL_EFFECT');}}
  const r=registry(store,calls);r.nativeForms.set('q',{form:new Probe('q'),artifactKey:'RESULT'});
  const graph=await api.restoreWorkflowCheckpoint(d,r,store),q=input.request||request(graph.checkpoint,input.operationId||'resume');
  if(input.barrier){process.send({phase:'READY',checkpoint:project(graph.checkpoint)});await wait();}
  const result=await graph.workflow.resumeCheckpoint(graph.checkpoint,q,100,input.hold?async()=>{process.send({phase:'CLAIMED',checkpoint:project(store.readCheckpoint()),credential:{ownerId:store.ownerId,fence:store.credential.fence,tokenSha256:crypto.createHash('sha256').update(store.credential.token).digest('hex')}});await wait();}:undefined);
  process.send({ok:true,snapshot:result,counts,calls,checkpoint:project(store.readCheckpoint()),credentialPresent:store.credential!==null});
 }catch(e){process.send({ok:false,code:e.code,causeCode:e.cause?.code,storageCode:e.storageCause?.code,counts,calls,credentialPresent:store.credential!==null});}
 finally{store.close();process.disconnect?.();}
})().catch(e=>{process.send?.({ok:false,code:e.code||e.name,counts,calls});process.exitCode=1;process.disconnect?.();});
