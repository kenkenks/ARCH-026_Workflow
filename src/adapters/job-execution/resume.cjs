'use strict';
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
const {SimpleDB,SimpleDBError,SCHEMA:HISTORY_SCHEMA,SQLiteJobRunStore}=require('./simpledb.cjs');
const {readDiagnosticInput}=require('./diagnostic.cjs');
const {diagnoseSavedRun}=require('../../../dist/src/prototype/diagnosis');
const {reconstructWorkflow}=require('../../../dist/src/prototype/definition');
const {createMemoryProductShelf}=require('../../../dist/src/prototype/job-form');
const {CONTROL_SCHEMA,LEASE_SCHEMA,initializeResumeControl,openControl,guardOwnership,acquireClaim,heartbeat,release,releaseWithin,attachControl}=require('./ownership.cjs');
const fail=code=>{throw new SimpleDBError(code);};
const text=x=>typeof x==='string'&&!!x.trim();
function canonical(x){if(Array.isArray(x))return x.map(canonical);if(x&&typeof x==='object')return Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])]));return x;}
const fingerprint=x=>createHash('sha256').update(JSON.stringify(canonical(x))).digest('hex');
/** A bounded simulation policy is an explicit prerequisite, not proof of arbitrary external safety. */
async function inspectWorkflow(options,policy){
 const input=await readDiagnosticInput(options),diagnosis=diagnoseSavedRun(input),reasons=[];
 if(input.readIssues.some(i=>i.code==='HISTORY_READ_BUSY'))return {runId:options.runId,ready:false,reasons:['DIAGNOSTIC_READ_BUSY'],diagnosis,policy:structuredClone(policy),fingerprint:fingerprint({input,policy})};
 if(diagnosis.classification!=='RESUMABLE_CANDIDATE')return {runId:options.runId,ready:false,reasons:[diagnosis.classification],diagnosis,policy:structuredClone(policy),fingerprint:fingerprint({input,policy})};
 if(!policy||!(policy.sideEffectFree===true||(options.effects&&policy.externalEffects==='LEDGER_CONTROLLED_MOCK'))||!text(policy.definitionId)||!text(policy.definitionVersion)||!Array.isArray(policy.jobFormIds)||!Array.isArray(policy.checkIds)||!Array.isArray(policy.requiredArtifacts)||[...policy.jobFormIds,...policy.checkIds,...policy.requiredArtifacts].some(x=>!text(x)))reasons.push('SIMULATION_POLICY_REQUIRED');
 else{
  if(input.run?.definitionId!==policy.definitionId||input.run?.definitionVersion!==policy.definitionVersion)reasons.push('DEFINITION_VERSION_MISMATCH');
  if(input.definition){for(const step of input.definition.steps??[]){if(step.kind==='JOB'&&!policy.jobFormIds.includes(step.jobId))reasons.push('UNKNOWN_JOB_FORM');if(step.kind==='CHECK_BOOL'&&!policy.checkIds.includes(step.checkId))reasons.push('UNKNOWN_CHECK');}}
  const latest=new Map(input.jobArtifacts.filter(a=>a.kind==='PUBLISHED').map(a=>[a.artifactKey,a]));
  if(policy.requiredArtifacts.some(k=>!latest.has(k)))reasons.push('REQUIRED_ARTIFACT_MISSING');
 }
 if(input.run){
  const traces=input.run.snapshot?.history??[];
  if(!traces.length||traces.at(-1).nextStepNo!==input.run.snapshot.currentStepNo)reasons.push('TRANSITION_UNCONFIRMED');
  for(const trace of traces){const step=input.definition?.steps.find(s=>s.stepNo===trace.stepNo);if(step?.kind==='JOB'&&!diagnosis.inferred.jobVisits.some(v=>v.historyOrder===trace.order))reasons.push('JOB_COMPLETION_UNCONFIRMED');}
  for(const job of input.jobExecutions){const a=input.jobArtifacts.filter(a=>a.jobExecutionId===job.jobExecutionId),internal=a.filter(a=>a.kind==='INTERNAL'),published=a.filter(a=>a.kind==='PUBLISHED');
   if(job.status!=='COMPLETED'||internal.length!==1||published.length!==1||published[0].artifactKey!==internal[0].artifactKey||published[0].publicationEvidence!=='RETURNED'||!isDeepStrictEqual(published[0].value,internal[0].value))reasons.push('PUBLICATION_UNCONFIRMED');}
 }
 return {runId:options.runId,ready:reasons.length===0,reasons:[...new Set(reasons)],diagnosis,policy:structuredClone(policy),fingerprint:fingerprint({input,policy})};
}
async function inspect(options,policy){const result=await inspectWorkflow(options,policy);if(!options.effects)return result;const external=require('./external.cjs').inspectExternal(options);return {...result,external,...(external.classification==='CLEAR'?{}:{ready:false,reasons:[...result.reasons,'EXTERNAL_'+external.classification]})};}
async function claim(options,inspection,ownerId){
 if(!text(ownerId)||inspection?.runId!==options.runId)fail('INVALID_ARGUMENT');
 const fresh=await inspect(options,inspection.policy);if(!fresh.ready)fail(fresh.reasons.includes('DIAGNOSTIC_READ_BUSY')?'DIAGNOSTIC_UNAVAILABLE':'RESUME_REFUSED');if(fresh.fingerprint!==inspection.fingerprint)fail('RESUME_STATE_CHANGED');
 return acquireClaim(options,fresh,ownerId);
}
async function takeover(options,policy,ownerId){return acquireClaim(options,await inspect(options,policy),ownerId,true);}
/** Caller supplies fresh simulation factories; no live previous Job, Check or shelf is reused. */
async function resume(options,ownership,registryFactory,{maxExecutions=100}={}){
 if(ownership?.runId!==options.runId||!text(ownership.ownerId)||!text(ownership.claimToken)||typeof registryFactory!=='function'||!Number.isSafeInteger(maxExecutions)||maxExecutions<1)fail('INVALID_ARGUMENT');
 const control=openControl(options);control.close();
 const db=SimpleDB.open(options.historyFile,HISTORY_SCHEMA);let attached=false;
 try{
  attachControl(db,options);attached=true;
  const guard=state=>guardOwnership(db,'resume_control.',options,ownership,[state]);
  db.transaction(()=>guard('CLAIMED'));
  // Inspection uses independent read-only connections. Revalidate after acquiring write reservations.
  let fresh,input;
  const preliminary=await inspect(options,ownership.policy);if(!preliminary.ready)fail(preliminary.reasons.includes('DIAGNOSTIC_READ_BUSY')?'DIAGNOSTIC_UNAVAILABLE':'RESUME_REFUSED');
  db.transaction(()=>{if(guard('CLAIMED').fingerprint!==preliminary.fingerprint)fail('RESUME_STATE_CHANGED');});
  input=await readDiagnosticInput(options);
  if(input.readIssues.some(i=>i.code==='HISTORY_READ_BUSY'))fail('DIAGNOSTIC_UNAVAILABLE');
  const shelf=createMemoryProductShelf(),latest=new Map();for(const a of input.jobArtifacts)if(a.kind==='PUBLISHED')latest.set(a.artifactKey,a.value);
  for(const [key,value]of latest)shelf.put(key,value);
  const store=new SQLiteJobRunStore(db,input.run.definitionId,input.run.definitionVersion,options.runId,shelf);
  const transaction=store.transaction.bind(store);store.transaction=action=>transaction(()=>{guard('ACTIVE');return action();});
  // Validate every registered name without executing any Job. Checks are freshly constructed.
  const registry=registryFactory({products:store.products,onCreate:store.onCreate});
  if(!registry?.jobForms||registry.jobs?.size!==0||registry.jobForms.products!==store.products||registry.jobForms.onCreate!==store.onCreate)fail('INVALID_RESUME_REGISTRY');
  const loaded=reconstructWorkflow(input.definition,registry,store,{history:input.run.snapshot.history});
  db.transaction(()=>{const row=guard('CLAIMED');
   if(options.effects)require('./external.cjs').assertExternalClear(db,options);
   // No await inside the transaction. Inspect DTO must still match the actual snapshot/tables.
   const now=store.readRun();const expected={definitionId:input.run.definitionId,definitionVersion:input.run.definitionVersion,snapshot:input.run.snapshot,jobExecutions:input.jobExecutions,jobArtifacts:input.jobArtifacts};
   if(fingerprint(now)!==fingerprint(expected)||row.fingerprint!==preliminary.fingerprint)fail('RESUME_STATE_CHANGED');
   fresh=preliminary;db.run("UPDATE resume_control.claims SET state='ACTIVE' WHERE run_id=?",options.runId);
   db.run('INSERT INTO resume_control.resume_events(run_id,owner_id,claim_token,event,history_length,step_no,at) VALUES (?,?,?,?,?,?,?)',options.runId,ownership.ownerId,ownership.claimToken,'STARTED',input.run.snapshot.history.length,input.run.snapshot.currentStepNo,new Date().toISOString());
  });
  const result=await loaded.workflow.resume(input.run.snapshot,maxExecutions,async()=>{db.transaction(()=>guard('ACTIVE'));});
  db.transaction(()=>{releaseWithin(db,'resume_control.',options,ownership,result.status==='LIMIT_REACHED'?'STOPPED':'FINISHED',['ACTIVE']);
   db.run('INSERT INTO resume_control.resume_events(run_id,owner_id,claim_token,event,history_length,step_no,at) VALUES (?,?,?,?,?,?,?)',options.runId,ownership.ownerId,ownership.claimToken,result.status,result.history.length,result.currentStepNo,new Date().toISOString());});
  return {snapshot:result,products:store.currentProducts(),diagnosisBeforeResume:fresh.diagnosis};
 }finally{if(attached)try{db.connection.exec('DETACH DATABASE resume_control');}catch{/* close retains original failure */}db.close();}
}
module.exports={CONTROL_SCHEMA,LEASE_SCHEMA,initializeResumeControl,inspect,claim,takeover,heartbeat,release,resume};
