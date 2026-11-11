'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const {connectEmulator,FieldValue}=require('./emulator.cjs');
const {FirestoreExperimentStore,hash}=require('./store.cjs');
const {createExecution}=require('./composition.cjs');
const {CMemoryHistoryStore}=require('../../../dist/src/prototype/workflow');
const {createMemoryProductShelf}=require('../../../dist/src/prototype/job-form');
const {ExamApplication,DemoError,definition,labels,exact,validatePayload,members,grades,gates,actionNames}=require('../../../demo/exam-application/application.cjs');
const {createForms,checks}=require('../../../demo/exam-application/job-forms.cjs');
const fail=(code,status=409)=>{throw new DemoError(code,status);};
const appId=(actor,id)=>'DEMO-'+createHash('sha256').update(JSON.stringify([actor,id])).digest('hex').slice(0,24);
const conflictCodes=new Set(['CLAIM_BUSY','FENCED','LEASE_EXPIRED','RUN_CHANGED','HISTORY_CONFLICT','DEFINITION_CONFLICT','ADMINISTRATIVE_TAKEOVER_REQUIRED']);
class FirestoreExamApplication extends ExamApplication {
 constructor(connection,config,options={}){super(options);this.connection=connection;this.settings=config;this.ownerId='host-'+randomUUID();this.hooks=options;}
 async initialize(){
  const store=this.store('definition-bootstrap');let d=await store.get(definition.definitionId,definition.definitionVersion);
  if(!d){try{await store.add(definition);}catch(e){if(e.code!=='DEFINITION_ALREADY_EXISTS')throw e;}d=await store.get(definition.definitionId,definition.definitionVersion);}
  if(!equal(d,definition))fail('DEFINITION_CONFLICT');
  const config=this.connection.root.collection('demo').doc('config'),session=randomUUID();
  this.bootSessionId=await this.connection.db.runTransaction(async tx=>{const existing=await tx.get(config);if(existing.exists){const v=existing.data();if(v.schemaVersion!==1||v.definitionDigest!==hash(definition)||typeof v.sessionId!=='string'||!v.sessionId)fail('DEFINITION_CONFLICT');return v.sessionId;}
   tx.create(config,{schemaVersion:1,definitionDigest:hash(definition),sessionId:session});return session;});
 }
 config(){return {storage:'emulator',emulator:true,bootSessionId:this.bootSessionId,members,grades,namespace:this.settings.namespace,
  warning:'Firestore Emulator：同じEmulator・namespaceでHost再起動後に復元できます。Emulator終了後の保持は未保証。自動Takeoverなし。'};}
 store(id){return new FirestoreExperimentStore(this.connection,'run-'+id);}
 refs(store,commandId){return {metadata:store.run.collection('demo').doc('application'),command:store.run.collection('commands').doc(commandId)};}
 async read(id){
  const store=this.store(id);
  // The parent/head and all children share one read-only transaction snapshot.
  return this.connection.db.runTransaction(async tx=>{
   const md=await tx.get(this.refs(store,'unused').metadata),head=await tx.get(store.run),hs=await tx.get(store.run.collection('history').orderBy('order')),
    js=await tx.get(store.run.collection('jobs')),as=await tx.get(store.run.collection('artifacts').orderBy('artifactId')),cs=await tx.get(store.run.collection('commands').orderBy('sequence'));
   if(!md.exists)fail('NOT_FOUND',404);const metadata=md.data();
   if(metadata.schemaVersion!==1||metadata.applicationId!==id||metadata.runId!==store.runId||metadata.definitionDigest!==hash(definition)||!Number.isSafeInteger(metadata.apiRevision)||metadata.apiRevision<0||!Number.isSafeInteger(metadata.commandSequence)||metadata.commandSequence<1)fail('SAVED_STATE_INVALID',503);
   const history=hs.docs.map(d=>d.data()),h=head.data(),snapshot=h?{...h.snapshot,history}:undefined;
   if(h){const validator=new CMemoryHistoryStore();validator.save(snapshot);if(h.schemaVersion!==1||h.runId!==store.runId||h.definitionDigest!==hash(definition)||h.historyLength!==history.length||h.historyDigest!==hash(history)||history.some((t,i)=>t.order!==i+1))fail('SAVED_STATE_INVALID',503);}
   return {metadata,head:h||null,snapshot,jobs:js.docs.map(d=>d.data()),artifacts:as.docs.map(d=>d.data()),commands:cs.docs.map(d=>d.data())};
  },{readOnly:true}).catch(e=>{if(e instanceof DemoError)throw e;throw new DemoError('STORAGE_UNAVAILABLE',503);});
 }
 project(model,p,{settled=false}={}){
  const m=model.metadata,memory=createMemoryProductShelf();for(const artifact of model.artifacts)if(artifact.kind==='PUBLISHED')memory.put(artifact.artifactKey,artifact.value);
  const store=new CMemoryHistoryStore();if(model.snapshot)store.save(model.snapshot);
  const artifacts=model.artifacts.filter(a=>a.kind==='PUBLISHED').map(a=>({jobExecutionId:a.jobExecutionId,key:a.artifactKey,published:a.value,internal:model.artifacts.find(i=>i.jobExecutionId===a.jobExecutionId&&i.kind==='INTERNAL'&&i.artifactKey===a.artifactKey)?.value??null}));
  const blocked=m.blocked||!!m.pendingCommandId;
  const view=super.view({id:m.applicationId,runId:m.runId,createdBy:m.createdBy,createdAt:m.createdAt,store,memory,commands:new Map(model.commands.map(c=>[c.public.commandId,c])),jobs:model.jobs,artifacts,revision:m.apiRevision,blocked},p);
  view.storage='emulator';view.pendingCommandId=m.pendingCommandId;view.operationStatus=m.pendingCommandId?(model.commands.find(c=>c.public.commandId===m.pendingCommandId)?.public.status||'UNKNOWN'):'IDLE';
  // APPLIED+release is already committed. The finishing request's local guard
  // must not make its response pretend the finalized run is still executing.
  if(settled&&!blocked){view.busy=false;view.waitingFor=model.snapshot?.status==='LIMIT_REACHED'?(gates[model.snapshot.currentStepNo]||null):null;
   view.allowedOperations=(view.waitingFor||[]).filter(kind=>{try{this.authorize(p,m,kind);return true;}catch{return false;}});}
  // Never serialize a lease token or SDK Timestamp/exception to the Browser.
  return view;
 }
 async get(id,p){const model=await this.read(id);this.authorize(p,model.metadata);return this.project(model,p);}
 async lookupCommand(id,commandId,p){const model=await this.read(id);this.authorize(p,model.metadata);const c=model.commands.find(c=>c.public.commandId===commandId);if(!c)fail('NOT_FOUND',404);return structuredClone(c.public);}
 async lookupStart(commandId,p){this.authorize(p);const id=appId(p.id,commandId);return {operation:await this.lookupCommand(id,commandId,p),state:await this.get(id,p)};}
 same(prior,body,p){if(prior.actorId!==p.id||!equal(prior.request,body))fail('COMMAND_CONFLICT');}
 async replay(id,prior,body,p){this.same(prior,body,p);const model=await this.read(id);return {replayed:true,operation:structuredClone(prior.public),state:this.project(model,p,{settled:prior.public.status==='APPLIED'})};}
 async start(body,p){exact(body,['commandId','bootSessionId','memberId','grade']);this.base(body);this.authorize(p,null,'START');if(!members.includes(body.memberId)||!grades.includes(body.grade))fail('INVALID_ARGUMENT',400);
  return this.execute(appId(p.id,body.commandId),body,p,{kind:'START',payload:{memberId:body.memberId,grade:body.grade}});
 }
 async command(id,body,p){exact(body,['commandId','bootSessionId','expectedRevision','expectedStepNo','kind','payload']);this.base(body);this.authorize(p,null,body.kind);validatePayload(body);
  return this.execute(id,body,p,body);
 }
 async execute(id,body,p,command){
  return this.guard(id,async()=>{
   const store=this.store(id),refs=this.refs(store,body.commandId);
   let observed;
   try{observed=await this.read(id);}catch(e){if(e.code!=='NOT_FOUND')throw new DemoError('STORAGE_UNAVAILABLE',503);}
   if(observed){this.authorize(p,observed.metadata,command.kind);const prior=observed.commands.find(c=>c.public.commandId===body.commandId);if(prior)return this.replay(id,prior,body,p);}
   if(command.kind!=='START'&&!observed)fail('NOT_FOUND',404);
   let accepted=false,claimed=false;
   const at=new Date().toISOString();
   try{
    await store.claim(this.ownerId);claimed=true;
    if(this.hooks.beforeAccept)await this.hooks.beforeAccept({id,store});
    const entry=await this.connection.db.runTransaction(async tx=>{
     const owner=await tx.get(store.owner);store.guard(owner);
     const md=await tx.get(refs.metadata),old=await tx.get(refs.command),head=await tx.get(store.run);const meta=md.data(),h=head.data();
     if(old.exists){this.same(old.data(),body,p);return {existing:old.data()};}
     if(command.kind==='START'){if(meta||h)fail('APPLICATION_EXISTS');}
     else{
      if(!meta)fail('NOT_FOUND',404);this.authorize(p,meta,command.kind);
      if(meta.pendingCommandId||meta.blocked||!h||h.snapshot.status!=='LIMIT_REACHED')fail('STATE_CONFLICT');
      if(meta.definitionDigest!==hash(definition)||h.definitionDigest!==hash(definition))fail('DEFINITION_CONFLICT');
      if(!Number.isSafeInteger(body.expectedRevision)||!Number.isSafeInteger(body.expectedStepNo)||body.expectedRevision!==meta.apiRevision||body.expectedStepNo!==h.snapshot.currentStepNo)fail('STALE_STATE');
      if(!(gates[h.snapshot.currentStepNo]||[]).includes(command.kind))fail('INVALID_OPERATION');
      if(h.historyLength+4>100)fail('EXECUTION_LIMIT');
     }
     const metadata=meta||{schemaVersion:1,applicationId:id,runId:store.runId,createdBy:p.id,createdAt:at,definitionDigest:hash(definition),definitionId:definition.definitionId,definitionVersion:definition.definitionVersion,apiRevision:0,commandSequence:0,blocked:false,businessStage:'受付処理中',waitingFor:null};
     const operation={actorId:p.id,request:structuredClone(body),sequence:metadata.commandSequence+1,public:{commandId:body.commandId,applicationId:id,actorId:p.id,kind:command.kind,operation:actionNames[command.kind],at,fromStep:h?.snapshot.currentStepNo??null,fromStage:h?labels[h.snapshot.currentStepNo]:'未申請',toStep:null,toStage:null,status:'ACCEPTED'}};
     tx.set(refs.metadata,{...metadata,commandSequence:operation.sequence,pendingCommandId:body.commandId});tx.create(refs.command,operation);return {operation,metadata};
    });
    if(entry.existing){await store.release();claimed=false;return this.replay(id,entry.existing,body,p);}
    accepted=true;
    if(this.hooks.afterAccept)await this.hooks.afterAccept({id,store});
    // Read persisted accepted input, not a mutable HTTP request or shared JobForm state.
    const savedCommand=(await refs.command.get()).data();this.same(savedCommand,body,p);
    const persistedKind=savedCommand.public.kind,payload=persistedKind==='START'?{memberId:savedCommand.request.memberId,grade:savedCommand.request.grade}:savedCommand.request.payload;
    const context=structuredClone({applicationId:id,createdAt:entry.metadata.createdAt,kind:persistedKind,payload,commandId:savedCommand.public.commandId,actorId:savedCommand.actorId});
    for(let i=0;i<4;i++){
     const before=await store.inspect();if(before.head&&before.head.snapshot.status!=='LIMIT_REACHED')fail('UNSAFE_BOUNDARY',503);
     let reader;const proxy={has:key=>reader.has(key),get:key=>reader.get(key)};
     const execution=await createExecution(store,definition,createForms(context),checks(proxy),{resume:!!before.head});reader=execution.products;
     if(this.hooks.beforeSlice)await this.hooks.beforeSlice({kind:command.kind,step:before.head?.snapshot.currentStepNo??10,store});
     const result=await execution.run(1);
     if(result.status==='FAILED')fail('WORKFLOW_FAILED',503);
     if(result.status==='COMPLETED'||gates[result.currentStepNo])break;
     if(i===3)fail('AUTO_STEP_LIMIT',503);
     await store.heartbeat();
    }
    const state=await store.inspect();
    if(this.hooks.beforeFinalize)await this.hooks.beforeFinalize({id,store});
    await this.finalize(store,refs,body.commandId,state);
    claimed=false; // release was part of the same atomic finalization.
    if(this.hooks.afterFinalize)await this.hooks.afterFinalize({id,store});
    return {replayed:false,operation:await this.lookupCommand(id,body.commandId,p),state:this.project(await this.read(id),p,{settled:true})};
   }catch(error){
    if(!accepted&&error?.code==='NOT_ACCEPTED'){if(claimed)try{await store.release();}catch{/* primary pre-accept failure remains */}throw new DemoError('NOT_ACCEPTED',503);}
    if(!accepted&&error instanceof DemoError){if(claimed)try{await store.release();}catch{/* preserve original rejection */}throw error;}
    if(!accepted&&conflictCodes.has(error?.code))throw new DemoError(error.code,409);
    if(accepted){
     // A finalization acknowledgement can be lost after APPLIED+release committed.
     try{const model=await this.read(id),op=model.commands.find(c=>c.public.commandId===body.commandId);if(op?.public.status==='APPLIED'){this.same(op,body,p);return {replayed:true,operation:op.public,state:this.project(model,p,{settled:true})};}}catch{/* readback is unavailable, not proof of failure */}
     try{await this.markUnknown(store,refs,error?.code==='WORKFLOW_FAILED'?'FAILED':'UNKNOWN');}catch{/* stale/expired Host may not modify even diagnostics */}
    }
    throw new DemoError(error?.code==='WORKFLOW_FAILED'?'WORKFLOW_FAILED':(!accepted&&error?.code==='NOT_ACCEPTED'?'NOT_ACCEPTED':'OUTCOME_UNKNOWN'),503);
   }
  });
 }
 async finalize(store,refs,commandId,observed){
  if(!observed.head)fail('SAVED_STATE_INVALID',503);const snapshot=observed.head.snapshot;
  if(snapshot.status!=='COMPLETED'&&!(snapshot.status==='LIMIT_REACHED'&&gates[snapshot.currentStepNo]))fail('UNSAFE_BOUNDARY',503);
  const finishedAt=new Date().toISOString();
  return this.connection.db.runTransaction(async tx=>{
   const owner=await tx.get(store.owner);store.guard(owner);const md=await tx.get(refs.metadata),cmd=await tx.get(refs.command),head=await tx.get(store.run);
   const meta=md.data(),c=cmd.data(),h=head.data();
   if(!meta||meta.pendingCommandId!==commandId||c?.public.status!=='ACCEPTED'||h?.revision!==observed.head.revision||h.historyDigest!==observed.head.historyDigest)fail('STATE_CONFLICT');
   const stage=snapshot.currentStepNo===null?'結果登録済み':labels[snapshot.currentStepNo];
   tx.update(refs.command,{public:{...c.public,status:'APPLIED',result:'正常',toStep:snapshot.currentStepNo,toStage:snapshot.currentStepNo===null?'完了':stage,finishedAt},proof:{runRevision:h.revision,historyLength:h.historyLength,historyDigest:h.historyDigest}});
   tx.update(refs.metadata,{apiRevision:meta.apiRevision+1,pendingCommandId:null,blocked:false,businessStage:stage,currentStepNo:snapshot.currentStepNo,waitingFor:gates[snapshot.currentStepNo]||null});
   tx.update(store.owner,{state:'RELEASED',updatedAt:FieldValue.serverTimestamp()});
  });
 }
 async markUnknown(store,refs,status){return this.connection.db.runTransaction(async tx=>{
  const owner=await tx.get(store.owner);store.guard(owner);const md=await tx.get(refs.metadata),cmd=await tx.get(refs.command);
  if(cmd.data()?.public.status!=='ACCEPTED'||md.data()?.pendingCommandId!==cmd.data()?.public.commandId)return;
  tx.update(refs.command,{public:{...cmd.data().public,status,result:status==='FAILED'?'Workflow実行失敗':'結果確認が必要'}});tx.update(refs.metadata,{blocked:true,businessStage:'要確認'});
 });}
 async close(){await super.close();await this.connection.close();}
}
async function createFirestoreExamApplication(config,options){const connection=await connectEmulator(config);try{const app=new FirestoreExamApplication(connection,config,options);await app.initialize();return app;}catch(e){await connection.close();throw e;}}
module.exports={createFirestoreExamApplication,FirestoreExamApplication};
