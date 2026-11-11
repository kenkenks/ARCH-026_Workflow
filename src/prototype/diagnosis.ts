import { CMemoryHistoryStore } from './workflow';
import type { RunSnapshot, TraceEntry } from './workflow';
import { validatePrototypeDefinition } from './definition';
import type { PrototypeDefinition } from './definition';

export type DiagnosisClass='COMPLETED'|'RESUMABLE_CANDIDATE'|'REVIEW_REQUIRED'|'INCONSISTENT';
export interface SavedJobObservation {
  jobExecutionId:string;runId:string;stepNo:number;stepId:string;jobFormId:string;iterationNo:number;status:string;phase:string|null;
}
export interface SavedArtifactObservation {
  artifactId:number;jobExecutionId:string;artifactKey:string;kind:string;type:string;value:unknown;publicationEvidence:string|null;
}
export interface SavedDiagnosticInput {
  runId:string;
  run:{definitionId:string;definitionVersion:string;snapshot:RunSnapshot}|null;
  traceRows:TraceEntry[];jobExecutions:SavedJobObservation[];jobArtifacts:SavedArtifactObservation[];
  definition?:unknown;
  readIssues?:Array<{kind:'invalid'|'unavailable';code:string}>;
}
export interface DiagnosisEvidence {code:string;details?:Record<string,unknown>}
export interface RunDiagnosis {
  runId:string;classification:DiagnosisClass;observedWorkflowStatus:string|null;
  observed:{definitionId:string|null;definitionVersion:string|null;currentStepNo:number|null;history:TraceEntry[];jobs:SavedJobObservation[];artifacts:Array<Omit<SavedArtifactObservation,'value'>>};
  inferred:{jobVisits:Array<{jobExecutionId:string;stepNo:number;iterationNo:number;historyOrder:number|null}>;currentPublications:Array<{artifactKey:string;artifactId:number;jobExecutionId:string}>};
  evidence:DiagnosisEvidence[];warnings:string[];unresolved:string[];recommendedNextAction:string;
}
const text=(x:unknown):x is string=>typeof x==='string'&&!!x.trim();
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const trace=(h:TraceEntry)=>[h.order,h.stepNo,h.job,h.result,h.nextStepNo,h.at,h.error??null];
function artifactType(value:unknown){return value===null?'null':Array.isArray(value)?'array':typeof value;}
/** Pure diagnosis of persisted observations. Never executes, resumes or repairs a Job. */
export function diagnoseSavedRun(input:SavedDiagnosticInput):RunDiagnosis {
  const evidence:DiagnosisEvidence[]=[],warnings:string[]=[],unresolved:string[]=[];
  const bad=(code:string,details?:Record<string,unknown>)=>{inconsistent=true;evidence.push({code,...(details?{details}:{})});};
  const review=(code:string)=>{needsReview=true;if(!unresolved.includes(code))unresolved.push(code);};
  let inconsistent=false,needsReview=false;
  const result:RunDiagnosis={runId:text(input?.runId)?input.runId:'',classification:'REVIEW_REQUIRED',observedWorkflowStatus:null,
    observed:{definitionId:null,definitionVersion:null,currentStepNo:null,history:[],jobs:[],artifacts:[]},
    inferred:{jobVisits:[],currentPublications:[]},evidence,warnings,unresolved,recommendedNextAction:'INVESTIGATE_WITHOUT_REEXECUTION'};
  function finish(){
    if(inconsistent){result.classification='INCONSISTENT';result.recommendedNextAction='INVESTIGATE_INCONSISTENCY_WITHOUT_REPAIR';}
    else if(needsReview){result.classification='REVIEW_REQUIRED';}
    return structuredClone(result);
  }
  if(!object(input)||!text(input.runId)||!Array.isArray(input.traceRows)||!Array.isArray(input.jobExecutions)||!Array.isArray(input.jobArtifacts)){
    bad('DIAGNOSTIC_INPUT_INVALID');return finish();
  }
  if(input.readIssues!==undefined&&(!Array.isArray(input.readIssues)||input.readIssues.some(x=>!object(x)||!['invalid','unavailable'].includes(x.kind)||!text(x.code)))){bad('READ_ISSUES_INVALID');return finish();}
  for(const issue of input.readIssues??[]){if(issue.kind==='invalid')bad(issue.code);else review(issue.code);}
  if(input.run===null){
    if(input.jobExecutions.length||input.jobArtifacts.length||input.traceRows.length)bad('ORPHAN_RECORDS_WITHOUT_RUN');else review(input.readIssues?.some(x=>x.kind==='unavailable')?'RUN_EXISTENCE_UNCONFIRMED':'RUN_NOT_FOUND');return finish();
  }
  if(!object(input.run)||!text(input.run.definitionId)||!text(input.run.definitionVersion)){bad('RUN_METADATA_INVALID');return finish();}
  const run=input.run, snapshot=run.snapshot;
  result.observed.definitionId=run.definitionId;result.observed.definitionVersion=run.definitionVersion;
  if(object(snapshot)&&typeof snapshot.status==='string')result.observedWorkflowStatus=snapshot.status;
  try{const validator=new CMemoryHistoryStore();validator.save(snapshot);}catch{bad('SNAPSHOT_SCHEMA_INVALID');return finish();}
  if(snapshot.runId!==input.runId)bad('SNAPSHOT_RUN_MISMATCH');
  result.observed.currentStepNo=snapshot.currentStepNo;result.observed.history=structuredClone(snapshot.history) as TraceEntry[];
  evidence.push({code:'WORKFLOW_STATUS_SAVED',details:{status:snapshot.status,currentStepNo:snapshot.currentStepNo}});
  if(snapshot.history.some((h,i)=>h.order!==i+1))bad('HISTORY_ORDER_INVALID');
  try{const validator=new CMemoryHistoryStore();validator.save({...snapshot,history:input.traceRows});
    if(JSON.stringify(snapshot.history.map(trace))!==JSON.stringify(input.traceRows.map(trace)))bad('HISTORY_PROJECTION_MISMATCH');
  }catch{bad('HISTORY_ROWS_INVALID');}
  let definition:PrototypeDefinition|undefined;
  if(input.definition===undefined)review('DEFINITION_UNAVAILABLE');
  else try{definition=validatePrototypeDefinition(input.definition);if(definition.definitionId!==run.definitionId||definition.definitionVersion!==run.definitionVersion)bad('DEFINITION_IDENTITY_MISMATCH');}
  catch{bad('DEFINITION_SCHEMA_INVALID');}
  const steps=new Map(definition?.steps.map(s=>[s.stepNo,s])??[]),byId=new Map(definition?.steps.map(s=>[s.stepId,s])??[]);
  if(definition){
    let expected:number|null=byId.get(definition.startStepId)!.stepNo;
    for(const h of snapshot.history){const step=steps.get(h.stepNo);if(!step||h.stepNo!==expected){bad('HISTORY_PATH_MISMATCH',{historyOrder:h.order});break;}
      let next:number|null=null;
      if(step.kind==='JOB'){
        if(!['DONE','ERROR'].includes(h.result))bad('JOB_TRACE_RESULT_INVALID',{historyOrder:h.order});
        if(h.result==='DONE'&&step.nextStepId!==undefined)next=byId.get(step.nextStepId)!.stepNo;
      }else if(step.kind==='CHECK_BOOL'){
        if(!['TRUE','FALSE','ERROR'].includes(h.result))bad('CHECK_TRACE_RESULT_INVALID',{historyOrder:h.order});
        if(h.result==='TRUE'||h.result==='FALSE')next=byId.get(h.result==='TRUE'?step.trueStepId:step.falseStepId)!.stepNo;
      }else{
        bad('WAIT_CONTROL_EVIDENCE_REQUIRED',{historyOrder:h.order});
      }
      if(h.nextStepNo!==next)bad('HISTORY_TARGET_MISMATCH',{historyOrder:h.order});
      expected=h.result==='ERROR'?h.stepNo:next;
    }
    if(expected!==snapshot.currentStepNo)bad('SNAPSHOT_POSITION_MISMATCH');
  }
  const errors=snapshot.history.filter(h=>h.result==='ERROR');
  if(errors.length&&snapshot.status!=='FAILED')bad('ERROR_TRACE_WITH_NONFAILED_WORKFLOW');
  if(snapshot.status==='COMPLETED'&&snapshot.currentStepNo!==null)bad('COMPLETED_POSITION_INVALID');
  if(snapshot.status!=='COMPLETED'&&snapshot.currentStepNo===null)bad('NONTERMINAL_POSITION_MISSING');
  const jobs=new Map<string,SavedJobObservation>(),visits=new Set<string>();
  for(const job of input.jobExecutions){
    if(!object(job)||!text(job.jobExecutionId)||!text(job.runId)||!text(job.stepId)||!text(job.jobFormId)||!Number.isSafeInteger(job.stepNo)||!Number.isSafeInteger(job.iterationNo)||job.iterationNo<1||
      !['READY','RUNNING','COMPLETED','FAILED'].includes(job.status)||!['collect','make','record','post',null].includes(job.phase)){
      bad('JOB_SCHEMA_INVALID');continue;
    }
    if(job.runId!==input.runId)bad('JOB_RUN_MISMATCH',{jobExecutionId:job.jobExecutionId});
    if(jobs.has(job.jobExecutionId))bad('DUPLICATE_JOB_EXECUTION_ID');
    const visit=JSON.stringify([job.stepNo,job.iterationNo]);if(visits.has(visit))bad('DUPLICATE_JOB_VISIT');visits.add(visit);jobs.set(job.jobExecutionId,job);
    if((job.status==='READY'&&job.phase!==null)||(job.status!=='READY'&&job.phase===null)||(job.status==='COMPLETED'&&job.phase!=='post'))bad('JOB_STATE_PHASE_MISMATCH',{jobExecutionId:job.jobExecutionId});
    const step=steps.get(job.stepNo);
    if(definition&&(!step||step.kind!=='JOB'||step.stepId!==job.stepId||step.jobId!==job.jobFormId))bad('JOB_DEFINITION_MISMATCH',{jobExecutionId:job.jobExecutionId});
    const history=snapshot.history.filter(h=>h.stepNo===job.stepNo),matched=history[job.iterationNo-1];
    result.inferred.jobVisits.push({jobExecutionId:job.jobExecutionId,stepNo:job.stepNo,iterationNo:job.iterationNo,historyOrder:matched?.order??null});
    if(matched){
      if(matched.result==='DONE'&&job.status!=='COMPLETED')bad('JOB_HISTORY_STATE_MISMATCH',{jobExecutionId:job.jobExecutionId,historyOrder:matched.order});
      if(matched.result==='ERROR'&&job.status!=='FAILED')review('ERROR_TRACE_NOT_PROOF_OF_JOB_FAILURE');
      evidence.push({code:'JOB_HISTORY_MATCH',details:{jobExecutionId:job.jobExecutionId,stepNo:job.stepNo,iterationNo:job.iterationNo,historyOrder:matched.order}});
    }else{
      if(history.length<job.iterationNo-1)bad('JOB_VISIT_GAP',{jobExecutionId:job.jobExecutionId});
      review('JOB_WITHOUT_SAVED_TRACE');
    }
    if(snapshot.status==='COMPLETED'&&job.status!=='COMPLETED')bad('COMPLETED_WORKFLOW_WITH_NONCOMPLETED_JOB',{jobExecutionId:job.jobExecutionId});
    if(job.status==='READY'||job.status==='RUNNING')review('JOB_ACTUAL_PROGRESS_UNKNOWN');
  }
  for(const stepNo of new Set([...jobs.values()].map(j=>j.stepNo))){const numbers=[...jobs.values()].filter(j=>j.stepNo===stepNo).map(j=>j.iterationNo).sort((a,b)=>a-b);if(numbers.some((n,i)=>n!==i+1))bad('JOB_ITERATION_SEQUENCE_INVALID',{stepNo});}
  result.observed.jobs=structuredClone([...jobs.values()]);
  const artifactIds=new Set<number>(),artifactKeys=new Set<string>(),artifacts:SavedArtifactObservation[]=[];
  for(const a of input.jobArtifacts){
    if(!object(a)||!Number.isSafeInteger(a.artifactId)||a.artifactId<1||!text(a.jobExecutionId)||!text(a.artifactKey)||!['INTERNAL','PUBLISHED'].includes(a.kind)||a.type!==artifactType(a.value)){
      bad('ARTIFACT_SCHEMA_INVALID');continue;
    }
    if(artifactIds.has(a.artifactId))bad('DUPLICATE_ARTIFACT_ID');artifactIds.add(a.artifactId);
    const key=JSON.stringify([a.jobExecutionId,a.artifactKey,a.kind]);if(artifactKeys.has(key))bad('DUPLICATE_JOB_ARTIFACT');artifactKeys.add(key);
    const job=jobs.get(a.jobExecutionId);if(!job)bad('ORPHAN_ARTIFACT',{artifactId:a.artifactId});
    else if(job.phase!=='post')bad('ARTIFACT_BEFORE_RECORD_COMPLETION',{artifactId:a.artifactId});
    if(a.kind==='INTERNAL'&&a.publicationEvidence!==null)bad('INTERNAL_WITH_PUBLICATION_EVIDENCE');
    if(a.kind==='PUBLISHED'){
      if(!['RETURNED','OBSERVED_AFTER_ERROR'].includes(a.publicationEvidence??''))bad('PUBLICATION_EVIDENCE_INVALID',{artifactId:a.artifactId});
      if(a.publicationEvidence==='OBSERVED_AFTER_ERROR')review('PUBLICATION_OPERATION_UNCONFIRMED');
      evidence.push({code:'PUBLICATION_OBSERVED',details:{artifactId:a.artifactId,artifactKey:a.artifactKey,jobExecutionId:a.jobExecutionId,evidence:a.publicationEvidence}});
    }
    artifacts.push(a);
  }
  result.observed.artifacts=artifacts.map(({value,...a})=>({...a}));
  const latest=new Map<string,SavedArtifactObservation>();
  for(const a of [...artifacts].sort((a,b)=>a.artifactId-b.artifactId))if(a.kind==='PUBLISHED')latest.set(a.artifactKey,a);
  result.inferred.currentPublications=[...latest.values()].map(a=>({artifactKey:a.artifactKey,artifactId:a.artifactId,jobExecutionId:a.jobExecutionId}));
  for(const job of jobs.values()){
    const internal=artifacts.filter(a=>a.jobExecutionId===job.jobExecutionId&&a.kind==='INTERNAL'),published=artifacts.filter(a=>a.jobExecutionId===job.jobExecutionId&&a.kind==='PUBLISHED');
    if(job.phase==='post'&&!internal.length)bad('POST_WITHOUT_INTERNAL_RECORD',{jobExecutionId:job.jobExecutionId});
    if(internal.length&&!published.length)review('PUBLICATION_NOT_RECORDED_NOT_PROOF_OF_NONEXECUTION');
  }
  const untracked=snapshot.history.filter(h=>steps.get(h.stepNo)?.kind==='JOB'&&![...jobs.values()].some(j=>j.stepNo===h.stepNo));
  if(untracked.length)warnings.push('SOME_TASKS_HAVE_TRACE_ONLY_NO_CJOB_OBSERVATION');
  if(snapshot.status==='FAILED'){review('SAVED_FAILURE_REQUIRES_REVIEW');warnings.push('FAILED_IS_NOT_AUTOMATICALLY_RESUMABLE');}
  if(snapshot.status==='RUNNING')review('RUNNING_IS_LAST_SAVED_STATUS_NOT_PROOF_OF_LIVENESS');
  warnings.push('BUSINESS_RESULT_AND_FINAL_OUTPUT_ACCEPTANCE_NOT_EVALUATED');
  if(snapshot.status==='COMPLETED'){
    result.classification='COMPLETED';result.recommendedNextAction='NO_RESUME_NEEDED';evidence.push({code:'CONTROL_FLOW_COMPLETION_SAVED'});
  }else if(snapshot.status==='LIMIT_REACHED'&&!needsReview&&!inconsistent){
    result.classification='RESUMABLE_CANDIDATE';result.recommendedNextAction='REVIEW_OWNERSHIP_AND_SIDE_EFFECTS_BEFORE_ANY_RESUME';
    evidence.push({code:'LIMIT_REACHED_AT_SAVED_BOUNDARY'});unresolved.push('EXECUTION_OWNERSHIP_NOT_PROVEN','EXTERNAL_EFFECTS_NOT_PROVEN');warnings.push('CANDIDATE_IS_NOT_PERMISSION_TO_RESUME');
  }else if(!needsReview)review('INSUFFICIENT_SAVED_EVIDENCE');
  if(needsReview)result.recommendedNextAction='INVESTIGATE_WITHOUT_REEXECUTION';
  return finish();
}
