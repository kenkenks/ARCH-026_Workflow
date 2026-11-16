'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{fork}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const {api,definition,options,start,request,WaitingHistoryStore,SQLiteLifecycleBackend}=require('./workflow-artifact-resume/scenario.cjs');
const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function project(c){return {...c,owner:{...c.owner,token:undefined,tokenSha256:sha(c.owner.token)}};}
test('C03: kill an independent Host after Job success and external commit, before Workflow checkpoint save',async()=>{
 const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'arch-c03-process-')),file=path.join(dir,'workflow.sqlite'),effects=path.join(dir,'external-effects.sqlite'),children=[];
 const d=definition('LIMIT_REACHED');let setup;
 function launch(input){
  const child=fork(path.join(__dirname,'stage22c-c03/child.cjs'),[JSON.stringify({file,effects,...input})],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});children.push(child);
  let stderr='',message,barrierMessage,readyResolve,readyReject;child.stdout.resume();child.stderr.on('data',b=>stderr+=b);
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
  const done=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill();const e=Error('CHILD_TIMEOUT '+stderr);readyReject(e);reject(e);},10000);
   child.on('message',m=>{if(m.barrier){barrierMessage=m;readyResolve(m);}else message=m;});
   child.once('error',e=>{clearTimeout(timer);readyReject(e);reject(e);});
   child.once('exit',(code,signal)=>{clearTimeout(timer);if(!barrierMessage)readyReject(Error('NO_BARRIER '+JSON.stringify(message)));resolve({code,signal,message,stderr,pid:child.pid});});
  });done.catch(()=>{});return {child,ready,done};
 }
 function checkpoint(){const s=new WaitingHistoryStore(new SQLiteLifecycleBackend(file),options(d));try{return s.readCheckpoint();}finally{s.close();}}
 function externalRows(){const db=new DatabaseSync(effects);try{return db.prepare('SELECT rowid,kind,host,payload FROM events ORDER BY rowid').all().map(r=>({...r,payload:JSON.parse(r.payload)}));}finally{db.close();}}
 const count=(rows,kind,host)=>rows.filter(r=>r.kind===kind&&(!host||r.host===host)).length;
 try{
  SQLiteLifecycleBackend.initialize(file);const ledger=new DatabaseSync(effects);ledger.exec('PRAGMA synchronous=FULL; CREATE TABLE events(kind TEXT NOT NULL,host TEXT NOT NULL,payload TEXT NOT NULL) STRICT');ledger.close();
  setup=new WaitingHistoryStore(new SQLiteLifecycleBackend(file),options(d,'run','setup'));await start(setup,d);setup.close();setup=null;
  const initial=checkpoint(),operationA=request(initial,'operation-A'),hostA=launch({host:'host-A',request:operationA,crashBoundary:true}),barrier=await hostA.ready;
  const beforeKill=checkpoint(),rowsBefore=externalRows();a.deepEqual(beforeKill,barrier.checkpoint);a.equal(barrier.attemptedSnapshot.status,'COMPLETED');a.equal(barrier.memoryArtifactPresent,true);
  a.equal(count(rowsBefore,'JOB_STARTED','host-A'),1);a.equal(count(rowsBefore,'JOB_SUCCEEDED','host-A'),1);a.equal(count(rowsBefore,'EXTERNAL_EFFECT'),1);
  a.equal(rowsBefore.find(r=>r.kind==='JOB_SUCCEEDED').payload.cmrpStatus,'COMPLETED');a.equal(rowsBefore.at(-1).kind,'BEFORE_CHECKPOINT_SAVE');
  a.equal(beforeKill.workflowSnapshot.status,'RUNNING');a.equal(beforeKill.workflowSnapshot.history.filter(h=>h.stepNo===40).length,0);a.equal(beforeKill.owner.state,'ACTIVE');
  a.equal(hostA.child.kill(),true);const exitA=await hostA.done;a.ok(exitA.code!==0||exitA.signal);a.equal(exitA.message,undefined);
  const afterKill=checkpoint();a.deepEqual(afterKill,beforeKill);a.deepEqual(externalRows(),rowsBefore);a.equal(api.ArtifactManager.fromSnapshot(afterKill.artifactSnapshot).reader().has('RESULT'),false);
  const same=await launch({host:'host-B-same-operation',request:operationA}).done;
  a.equal(same.message?.code,'OPERATION_IN_PROGRESS');a.deepEqual(checkpoint(),afterKill);
  const different=await launch({host:'host-B-new-operation',request:{kind:'LIMIT_REACHED',operationId:'operation-B',expectedRevision:afterKill.revision}}).done;
  a.equal(different.message?.code,'CLAIM_BUSY');a.deepEqual(checkpoint(),afterKill);
  const finalRows=externalRows();a.deepEqual(finalRows,rowsBefore);a.equal(count(finalRows,'EXTERNAL_EFFECT'),1);a.equal(count(finalRows,'JOB_STARTED'),1);
  console.log('STAGE22C_C03_OBSERVATION '+JSON.stringify({scenario:'C03',result:'LIMITATION',environment:{node:process.version,platform:process.platform,arch:process.arch},
   termination:{method:'Parent child.kill() after IPC barrier; child blocked in fixture save wrapper before the real save/Transaction begins.',pid:exitA.pid,exitCode:exitA.code,signal:exitA.signal,workflowResponseReceived:false},
   counts:{hostAJobStarted:1,hostAJobSucceeded:1,hostBJobStarted:0,hostBJobSucceeded:0,externalEffects:1,duplicateEffects:0},
   checkpoints:{initial:project(initial),beforeTermination:project(beforeKill),afterRestartRead:project(afterKill),afterResumeAttempts:project(checkpoint()),unchangedAcrossTerminationAndRetry:true},
   attemptedUncommittedSnapshot:barrier.attemptedSnapshot,memoryArtifactBeforeExit:true,persistedArtifactAfterExit:false,externalLedger:finalRows.map(r=>r.kind==='BEFORE_CHECKPOINT_SAVE'?{...r,payload:{...r.payload,checkpoint:project(r.payload.checkpoint)}}:r),
   resume:{sameOperation:same.message,newOperation:different.message},workflowOutcome:'Process terminated without a Workflow response; last durable state RUNNING/ACTIVE, not proof of no external effect.',
   defenseResult:'PASS: no automatic replay/takeover and no duplicate effect observed.',limits:'External effect committed and CMRP succeeded, but completion/artifact checkpoint was not stored. No forced recovery or C04 transaction crash was tested.'}));
 }finally{
  setup?.close();for(const child of children)if(child.exitCode===null&&child.signalCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill();await ended;}
  if(path.dirname(path.resolve(dir))!==parent||!path.basename(dir).startsWith('arch-c03-process-'))throw Error('UNSAFE_FIXTURE');fs.rmSync(dir,{recursive:true,force:true});
 }
});
