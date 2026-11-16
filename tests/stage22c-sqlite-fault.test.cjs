'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{fork}=require('node:child_process');
const {api,definition,options,registry,start,request,WaitingHistoryStore,SQLiteLifecycleBackend}=require('./workflow-artifact-resume/scenario.cjs');
const project=c=>{const {token,...owner}=c.owner;return {...c,owner:{...owner,tokenSha256:crypto.createHash('sha256').update(token).digest('hex')}};};
const cause=e=>e?{code:e.code,sqliteCode:e.sqliteCode,transactionPhase:e.transactionPhase,rollbackConfirmed:e.rollbackConfirmed}:undefined;
async function fixture(fn){
 const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'arch-c04-c07-')),file=path.join(dir,'workflow.sqlite'),d=definition('LIMIT_REACHED');SQLiteLifecycleBackend.initialize(file);
 const setup=new WaitingHistoryStore(new SQLiteLifecycleBackend(file),options(d,'run','setup'));try{await start(setup,d);}finally{setup.close();}
 const read=()=>{const s=new WaitingHistoryStore(new SQLiteLifecycleBackend(file),options(d));try{return s.readCheckpoint();}finally{s.close();}};
 try{await fn({dir,file,d,read});}finally{if(path.dirname(path.resolve(dir))!==parent||!path.basename(dir).startsWith('arch-c04-c07-'))throw Error('UNSAFE_FIXTURE');fs.rmSync(dir,{recursive:true,force:true});}
}
for(const boundary of ['before-transaction','updated-before-commit','after-commit'])test('C04: real process termination '+boundary,()=>fixture(async({dir,file,read})=>{
 const marker=path.join(dir,'barrier.json');let child,watcher,timer,readyResolve,readyReject,stderr='';
 const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});
 watcher=fs.watch(dir,()=>{if(fs.existsSync(marker)){try{const m=JSON.parse(fs.readFileSync(marker,'utf8'));clearTimeout(timer);watcher.close();readyResolve(m);}catch(e){readyReject(e);}}});
 timer=setTimeout(()=>readyReject(Error('BARRIER_TIMEOUT '+stderr)),10000);
 child=fork(path.join(__dirname,'stage22c-sqlite-fault/child.cjs'),[JSON.stringify({file,marker,boundary})],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});child.stdout.resume();child.stderr.on('data',b=>stderr+=b);
 const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{if(!fs.existsSync(marker))readyReject(Error('CHILD_EXIT_BEFORE_BARRIER '+stderr));resolve({code,signal});});});done.catch(()=>{});
 try{
  const observed=await ready,beforeKill=project(read());a.deepEqual(observed.counts,{started:1,completed:1});
  a.equal(observed.transactionActive,boundary==='updated-before-commit');
  if(boundary==='after-commit')a.deepEqual(beforeKill,observed.visibleCheckpoint);else a.deepEqual(beforeKill,observed.oldCheckpoint);
  if(boundary!=='before-transaction'){a.equal(observed.visibleCheckpoint.revision,observed.oldCheckpoint.revision+1);a.deepEqual(observed.visibleCheckpoint.workflowSnapshot,observed.intendedWorkflow);a.deepEqual(observed.visibleCheckpoint.artifactSnapshot,observed.intendedArtifacts);}
  a.equal(child.kill(),true);const exit=await done;a.ok(exit.code!==0||exit.signal);
  const reopened=read(),after=project(reopened),old=boundary!=='after-commit';a.deepEqual(after,old?observed.oldCheckpoint:observed.visibleCheckpoint);
  api.validateArtifactSnapshot(after.artifactSnapshot);const products=api.ArtifactManager.fromSnapshot(after.artifactSnapshot);
  a.equal(after.workflowSnapshot.status,old?'RUNNING':'COMPLETED');a.equal(products.reader().has('RESULT'),!old);a.equal(after.workflowSnapshot.history.filter(h=>h.stepNo===40).length,old?0:1);a.equal(after.owner.state,old?'ACTIVE':'RELEASED');
  a.deepEqual(after.artifactSnapshot,old?observed.oldCheckpoint.artifactSnapshot:observed.intendedArtifacts);
  console.log('STAGE22C_SQLITE_OBSERVATION '+JSON.stringify({scenario:'C04',boundary,result:'PASS',environment:{node:process.version,platform:process.platform,arch:process.arch},synchronization:'Atomic marker rename at an existing synchronous save hook, then parent child.kill(); no timing sleep.',observed,committedViewBeforeKill:beforeKill,afterRestart:after,exit,jobCounts:observed.counts,mixedGenerationAccepted:false,readAndValidator:'PASS',limit:'Three exact boundaries only; not native COMMIT-internal interruption, power loss, or arbitrary semantic tampering.'}));
 }finally{clearTimeout(timer);watcher.close();if(child.exitCode===null&&child.signalCode===null){const stopped=new Promise(r=>child.once('exit',r));child.kill();await stopped;}}
}));
for(const mode of ['ownership-connection-closed','ownership-write-lock','save-connection-closed','save-write-lock'])test('C07: '+mode,()=>fixture(async({file,d,read})=>{
 const backend=new SQLiteLifecycleBackend(file),store=new WaitingHistoryStore(backend,options(d,'run','host-A')),locker=new SQLiteLifecycleBackend(file);let locked=false,error,boundary,jobStarted=0,jobCompleted=0;
 try{
  class Probe extends api.CJobForm{async execute(context){jobStarted++;await super.execute(context);jobCompleted++;}collect(){return {generation:'new'};}make(v){return v;}}
  const r=registry(store);r.nativeForms.set('q',{form:new Probe('q'),artifactKey:'RESULT'});const g=await api.restoreWorkflowCheckpoint(d,r,store),save=store.saveCheckpoint.bind(store);
  const inject=()=>{boundary=project(read());if(mode.endsWith('connection-closed'))store.close();else{locker.database.connection.exec('BEGIN IMMEDIATE');locked=true;}};
  if(mode.startsWith('save-'))store.saveCheckpoint=(s,v)=>{if(s.history.some(h=>h.stepNo===40&&h.result==='DONE'))inject();return save(s,v);};
  try{await g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint,'operation-A'),100,mode.startsWith('ownership-')?inject:undefined);}catch(e){error={code:e.code,outcome:e.outcome,cause:cause(e.cause),storageCause:cause(e.storageCause),observationState:e.observation?.state};}
  a.ok(error);a.equal(error.code,mode.startsWith('ownership-')?'EXECUTION_OWNERSHIP_UNKNOWN':'HISTORY_SAVE_OUTCOME_UNKNOWN');a.equal(error.outcome,'UNKNOWN');
  const primary=mode.startsWith('ownership-')?error.cause:error.storageCause;a.equal(primary.code,'UNAVAILABLE');
  if(mode.endsWith('write-lock')){a.equal(primary.sqliteCode&255,5);a.equal(primary.transactionPhase,'BEGIN');}
  if(locked){locker.database.connection.exec('ROLLBACK');locked=false;}
  const after=project(read());a.deepEqual(after,boundary);a.equal(after.workflowSnapshot.status,'RUNNING');
  const shouldRun=mode.startsWith('save-');a.equal(jobStarted,shouldRun?1:0);a.equal(jobCompleted,shouldRun?1:0);a.equal(api.ArtifactManager.fromSnapshot(after.artifactSnapshot).reader().has('RESULT'),false);a.equal(g.artifacts.reader().has('RESULT'),shouldRun);
  console.log('STAGE22C_SQLITE_OBSERVATION '+JSON.stringify({scenario:'C07',mode,result:'PASS',environment:{node:process.version,platform:process.platform,arch:process.arch},injection:mode.endsWith('write-lock')?'Separate SQLite connection holds BEGIN IMMEDIATE; production bounded busy timeout is unchanged.':'Real Host A connection closed at an acknowledged hook/save boundary.',jobCounts:{started:jobStarted,completed:jobCompleted},error,beforeFault:boundary,afterFault:after,checkpointUnchanged:true,persistedResult:false,memoryResult:g.artifacts.reader().has('RESULT'),fallbackObserved:false,note:shouldRun?'Job had already succeeded before the save failed; its normal Memory publication is not a fallback. Workflow returned UNKNOWN, not success.':'Ownership could not be verified: Job never started. No Memory execution or automatic reconnection/retry.'}));
 }finally{if(locked)locker.database.connection.exec('ROLLBACK');locker.close();store.close();}
}));
