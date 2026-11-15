import {CJob,CWorkflowTask,CCheckJob,CWorkflow} from './CWorkflow';
import {CJobForm as ExecutableJobForm} from './CJobForm';
import type {IWorkflowHistoryStore,WorkflowStep,TraceEntry} from './CWorkflow';
import type {IArtifactCheckpointStore} from './CWorkflow';
import {validatePrototypeDefinition,validateDefinitionKey,DefinitionError,ARTIFACT_DEFINITION_SCHEMA_VERSION} from './Definition';
import {ArtifactManager} from './ArtifactManager';
import type {DefinitionRepository,PrototypeDefinition} from './Definition';
import type {WorkflowRegistry} from './WorkflowRegistry';

export function reconstructWorkflow(input: unknown, registry: WorkflowRegistry, store: IWorkflowHistoryStore, continuation?:{history:readonly TraceEntry[]}, artifacts?:ArtifactManager) {
  const definition = validatePrototypeDefinition(input);
  const managed=definition.schemaVersion===ARTIFACT_DEFINITION_SCHEMA_VERSION;
  if(artifacts!==undefined&&(!managed||!(artifacts instanceof ArtifactManager)))throw new DefinitionError('INVALID_ARTIFACT_MANAGER');
  if(managed&&continuation&&!artifacts)throw new DefinitionError('ARTIFACT_RESTORE_UNSUPPORTED');
  // Resolve all names before invoking factories; an unsupported name never partially executes jobs.
  for (const step of definition.steps) {
    if(managed&&step.kind==='JOB'){
      const registration=registry.nativeForms?.get(step.jobId);
      if(!registration||!(registration.form instanceof ExecutableJobForm)||registry.jobs.has(step.jobId)||registry.jobForms?.definitions.has(step.jobId))throw new DefinitionError('UNSUPPORTED_ARTIFACT_JOB');
      validateDefinitionKey(registration.artifactKey);continue;
    }
    if (step.kind === 'JOB' && !registry.jobs.has(step.jobId) && !registry.jobForms?.definitions.has(step.jobId)) throw new DefinitionError('UNSUPPORTED_JOB');
    if(step.kind==='JOB'&&registry.jobs.has(step.jobId)&&registry.jobForms?.definitions.has(step.jobId))throw new DefinitionError('AMBIGUOUS_JOB');
    if (step.kind === 'CHECK_BOOL' && !registry.checks.has(step.checkId)) throw new DefinitionError('UNSUPPORTED_CHECK');
  }
  const manager=managed?(artifacts??new ArtifactManager(definition.artifactBoxes,registry.jobForms?.products)):undefined;
  if(manager)for(const box of definition.artifactBoxes!)if(!manager.hasBox(box))throw new DefinitionError('UNKNOWN_ARTIFACT_BOX');
  const no = new Map(definition.steps.map(step => [step.stepId, step.stepNo]));
  const steps: WorkflowStep[] = definition.steps.map(step => {
    const context = { definitionId: definition.definitionId, definitionVersion: definition.definitionVersion, stepId: step.stepId };
    if(step.kind==='WAIT')return {no:step.stepNo,waitReason:step.reason,nextStepNo:no.get(step.nextStepId)!};
    if (step.kind === 'CHECK_BOOL') {
      const condition = registry.checks.get(step.checkId)!(context);
      if (!condition || typeof condition.evaluate !== 'function') throw new DefinitionError('INVALID_CHECK_FACTORY');
      return { no: step.stepNo, job: new CCheckJob(step.stepId, condition, no.get(step.falseStepId)!, no.get(step.trueStepId)!) };
    }
    if(manager){const r=registry.nativeForms!.get(step.jobId)!;return {no:step.stepNo,createJob:()=>r.form,products:manager.shelf(),outputProducts:manager.shelf(step.output?.box),artifactKey:r.artifactKey,...(step.nextStepId===undefined?{}:{nextStepNo:no.get(step.nextStepId)!})};}
    const registration=registry.jobForms?.definitions.get(step.jobId);
    if(registration){
      const {form,artifactKey}=registration,products=registry.jobForms!.products,onCreate=registry.jobForms!.onCreate;
      if(typeof artifactKey!=='function')validateDefinitionKey(artifactKey);
      let iterationNo=continuation?.history.filter(h=>h.stepNo===step.stepNo).length??0;
      return {no:step.stepNo,createJob:()=>{
        const visit=++iterationNo;
        const key=typeof artifactKey==='function'?artifactKey(context,visit):artifactKey;
        const job=new CJob(form,products,key);
        onCreate?.(job,{...context,stepNo:step.stepNo,jobFormId:step.jobId,iterationNo:visit});
        return job;
      },...(step.nextStepId===undefined?{}:{nextStepNo:no.get(step.nextStepId)!})};
    }
    const job: CWorkflowTask | ExecutableJobForm = registry.jobs.get(step.jobId)!(context) as CWorkflowTask | ExecutableJobForm;
    if ((!(job instanceof CWorkflowTask) && !(job instanceof ExecutableJobForm)) || job instanceof CCheckJob || typeof job.execute !== 'function') throw new DefinitionError('INVALID_JOB_FACTORY');
    return { no: step.stepNo, job, ...(step.nextStepId === undefined ? {} : { nextStepNo: no.get(step.nextStepId)! }) };
  });
  return { definition, workflow: new CWorkflow(steps, store,manager,manager?structuredClone(definition):undefined), startStepNo: no.get(definition.startStepId)!,...(manager?{artifacts:manager}:{}) };
}
/** Rebuilds structure with an unbound restored manager. No claim or execution occurs here. */
export async function restoreWorkflowCheckpoint(input:unknown,registry:WorkflowRegistry,store:IArtifactCheckpointStore){
  const definition=validatePrototypeDefinition(input);
  if(definition.schemaVersion!==ARTIFACT_DEFINITION_SCHEMA_VERSION||typeof store.readCheckpoint!=='function'||typeof store.validateCheckpointDefinition!=='function'||typeof store.claimCheckpoint!=='function')throw new DefinitionError('ARTIFACT_RESTORE_UNSUPPORTED');
  if(typeof store.assertCanExecuteStep!=='function')throw new DefinitionError('EXECUTION_OWNERSHIP_REQUIRED');
  const checkpoint=await store.readCheckpoint();if(!checkpoint)throw new DefinitionError('CHECKPOINT_NOT_FOUND');
  await store.validateCheckpointDefinition(checkpoint,definition);
  const artifacts=ArtifactManager.fromSnapshot(checkpoint.artifactSnapshot,definition.artifactBoxes);
  return {...reconstructWorkflow(definition,registry,store,{history:checkpoint.workflowSnapshot.history},artifacts),checkpoint};
}
export async function loadWorkflow(repository: DefinitionRepository<PrototypeDefinition>, id: string, version: string, registry: WorkflowRegistry, store: IWorkflowHistoryStore, artifacts?:ArtifactManager) {
  validateDefinitionKey(id); validateDefinitionKey(version);
  const definition = await repository.get(id, version);
  if (!definition) throw new DefinitionError('DEFINITION_NOT_FOUND');
  if (definition.definitionId !== id || definition.definitionVersion !== version) throw new DefinitionError('DEFINITION_IDENTITY_MISMATCH');
  return reconstructWorkflow(definition, registry, store,undefined,artifacts);
}
