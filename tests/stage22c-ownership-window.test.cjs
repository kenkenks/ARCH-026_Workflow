'use strict';
// C02/C06 characterization only. No production hooks, automatic takeover or DB schema changes.
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {api,definition,options,registry,start,request,WaitingHistoryStore,SQLiteLifecycleBackend}=require('./workflow-artifact-resume/scenario.cjs');
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
function gate(){let release;const ready=new Promise(r=>{release=r;});return {ready,release};}
async function bounded(p){let timer;try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('BARRIER_TIMEOUT')),10000);})]);}finally{clearTimeout(timer);}}
function failure(e){return {code:e.code,causeCode:e.cause?.code,storageCode:e.storageCause?.code,outcome:e.outcome,attemptedStatus:e.attemptedSnapshot?.status};}
function project(row){return {revision:row.revision,snapshot:row.snapshot,artifactSnapshot:row.checkpoint.artifactSnapshot,operationIdentifier:row.activeOperationId,
 owner:{...row.owner,token:undefined,tokenSha256:hash(row.owner.token)},operations:row.operations.map(o=>({operationId:o.operationId,kind:o.kind,status:o.status,revision:o.revision}))};}
async function characterize(id){
 const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'arch-c02-c06-')),file=path.join(dir,'run.sqlite'),effectFile=path.join(dir,'synthetic-effects.jsonl');
 const entered=gate(),continueA=gate(),stores=[],d=definition('LIMIT_REACHED'),counts={A:{started:0,completed:0,effects:0},B:{started:0,completed:0,effects:0}},events=[];
 let execution,finished;
 try{
  SQLiteLifecycleBackend.initialize(file);
  const setup=new WaitingHistoryStore(new SQLiteLifecycleBackend(file),options(d,'run','setup'));stores.push(setup);await start(setup,d);
  const aBackend=new SQLiteLifecycleBackend(file),bBackend=new SQLiteLifecycleBackend(file),A=new WaitingHistoryStore(aBackend,options(d,'run','host-A')),B=new WaitingHistoryStore(bBackend,options(d,'run','host-B'));stores.push(A,B);
  const dbNow=()=>aBackend.database.get("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS n").n;
  const event=(kind,details={})=>events.push({sequence:events.length+1,kind,sqliteTime:dbNow(),...details});
  function registrations(store,host){
   class Probe extends api.CJobForm{
    async execute(context){counts[host].started++;event(host+'_JOB_STARTED',{leaseValidAtObservedStart:store.read().owner.expiresAt>dbNow()});await super.execute(context);counts[host].completed++;event(host+'_JOB_COMPLETED');}
    async collect(){if(id==='C02'&&host==='A'){event('JOB_INTERNAL_BARRIER');entered.release();await continueA.ready;}return {synthetic:true};}
    make(v){return v;}
    record(){const row=store.read();fs.appendFileSync(effectFile,JSON.stringify({host,runId:'run',stepNo:40,scenario:id,operationIdentifier:row.activeOperationId,fence:row.owner.fence,leaseExpiredAtEffect:row.owner.expiresAt<=dbNow()})+'\n');counts[host].effects++;event(host+'_EXTERNAL_SYNTHETIC_EFFECT');}
    async post(value,context){await super.post(value,context);event(host+'_ARTIFACT_PUBLISHED');}
   }
   const r=registry(store);r.nativeForms.set('q',{form:new Probe('probe-q'),artifactKey:'RESULT'});return r;
  }
  const graph=await api.restoreWorkflowCheckpoint(d,registrations(A,'A'),A),operationA=request(graph.checkpoint,'operation-A'),inspect=A.assertCanExecuteStep.bind(A);let inspections=0;
  A.assertCanExecuteStep=async snapshot=>{
   inspect(snapshot);inspections++;event('A_OWNERSHIP_VERIFIED',{inspection:inspections,stepNo:snapshot.currentStepNo});
   // The committed loop checks before Factory and again immediately before execute.
   // Delay the second *successful* Port response, not the validation itself.
   if(id==='C06'&&inspections===2){event('FINAL_VERIFICATION_RESPONSE_BARRIER');entered.release();await continueA.ready;}
  };
  event('A_RESUME_REQUESTED');execution=graph.workflow.resumeCheckpoint(graph.checkpoint,operationA);
  finished=execution.then(snapshot=>({ok:true,status:snapshot.status}),error=>({ok:false,error:failure(error)}));
  await bounded(entered.ready);
  const claimed=A.read();a.equal(claimed.owner.ownerId,'host-A');a.equal(claimed.owner.state,'ACTIVE');a.equal(claimed.snapshot.status,'RUNNING');a.ok(claimed.owner.expiresAt>dbNow());
  a.equal(counts.A.started,id==='C02'?1:0);a.equal(inspections,2);
  const beforeExpiry=project(claimed);
  // Controlled expiry in the temporary DB only. Keep owner/token/fence/Revision/operation unchanged.
  // This models time expiry deterministically; it is NOT a successful Host B takeover.
  aBackend.database.transaction(()=>{const row=aBackend.read('run');row.owner.expiresAt=dbNow()-1;aBackend.database.run('UPDATE waiting_runs SET state_json=? WHERE run_id=?',JSON.stringify(row),'run');});
  event('LEASE_EXPIRY_INJECTED');const expired=A.read();a.ok(expired.owner.expiresAt<dbNow());a.equal(expired.revision,claimed.revision);a.equal(expired.owner.fence,claimed.owner.fence);a.equal(expired.activeOperationId,claimed.activeOperationId);
  const other=await api.restoreWorkflowCheckpoint(d,registrations(B,'B'),B),operationB={kind:'LIMIT_REACHED',operationId:'operation-B',expectedRevision:other.checkpoint.revision};let bError;
  try{await other.workflow.resumeCheckpoint(other.checkpoint,operationB);}catch(e){bError=failure(e);}
  event('B_CLAIM_RESULT',{code:bError?.code||'UNEXPECTED_SUCCESS'});a.equal(bError?.code,'CLAIM_BUSY');a.equal(counts.B.started,0);a.deepEqual(A.read(),expired);
  continueA.release();const outcome=await bounded(finished);event('A_WORKFLOW_RESULT',outcome);
  a.equal(outcome.ok,false);a.equal(outcome.error.code,'HISTORY_SAVE_OUTCOME_UNKNOWN');a.equal(outcome.error.storageCode,'LEASE_EXPIRED');a.equal(outcome.error.attemptedStatus,'COMPLETED');
  a.equal(counts.A.started,1);a.equal(counts.A.completed,1);a.equal(counts.A.effects,1);a.deepEqual(counts.B,{started:0,completed:0,effects:0});
  a.equal(events.find(e=>e.kind==='A_JOB_STARTED').leaseValidAtObservedStart,id==='C02');
  const final=A.read();a.deepEqual(final,expired);a.equal(final.snapshot.status,'RUNNING');a.equal(final.operations.find(o=>o.operationId==='operation-A').status,'RUNNING');
  a.equal(final.snapshot.history.filter(h=>h.stepNo===40).length,0);a.equal(graph.artifacts.reader().has('RESULT'),true);a.equal(api.ArtifactManager.fromSnapshot(final.checkpoint.artifactSnapshot).reader().has('RESULT'),false);
  const retry=await api.restoreWorkflowCheckpoint(d,registrations(B,'B'),B);let retryError;
  try{await retry.workflow.resumeCheckpoint(retry.checkpoint,operationA);}catch(e){retryError=failure(e);}
  a.equal(retryError?.code,'OPERATION_IN_PROGRESS');a.deepEqual(A.read(),final);a.equal(counts.A.effects+counts.B.effects,1);
  const effects=fs.readFileSync(effectFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));a.equal(effects.length,1);
  const result={scenario:id,result:'LIMITATION',environment:{node:process.version,platform:process.platform,arch:process.arch,sqlite:aBackend.database.get('SELECT sqlite_version() AS v').v},scope:'One Node process, separate SQLite connections and Host capabilities; no real service and no successful ownership replacement.',
   expiryMethod:'Temporary SQLite expiresAt set to DB-time minus 1 after an acknowledged barrier; no sleep, Date.now override, token/fence/Revision rewrite or production code change.',
   guardInspections:inspections,jobCounts:counts,externalEffectCount:effects.length,hostBClaim:{result:'PASS',error:bError,meaning:'Expired ACTIVE/RUNNING is not claimable; no takeover.'},
   afterSuccessfulHostBTakeover:{result:'INCONCLUSIVE',reason:'Normal protocol refused Host B; successful replacement was not forced or observed.'},
   hostAJobResult:'COMPLETED',workflowResult:outcome,checkpointSave:{result:'PASS',accepted:false,reason:'LEASE_EXPIRED',rowUnchangedAfterExpiry:true},
   duplicateReplay:{result:'PASS',error:retryError,extraEffects:0},beforeExpiry,afterExpiry:project(expired),finalCheckpoint:project(final),memoryArtifactPresent:true,persistedArtifactPresent:false,effects,events};
  console.log('STAGE22C_OBSERVATION '+JSON.stringify(result));return result;
 }finally{
  continueA.release();if(finished)await bounded(finished).catch(()=>{});
  for(const s of stores)s.close();
  if(path.dirname(path.resolve(dir))!==parent||!path.basename(dir).startsWith('arch-c02-c06-'))throw Error('UNSAFE_FIXTURE');fs.rmSync(dir,{recursive:true,force:true});
 }
}
test('C02: lease expires inside Job; characterize continuation, refused claim/save and no replay',async()=>{await characterize('C02');});
test('C06: successful ownership check precedes expiry; characterize Job start in the response window',async()=>{await characterize('C06');});
