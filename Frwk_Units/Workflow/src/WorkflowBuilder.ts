import {CJob,CWorkflowTask,CCheckJob,CWorkflow} from './CWorkflow';
import {CJobForm as ExecutableJobForm} from './CJobForm';
import type {IWorkflowHistoryStore,WorkflowStep,TraceEntry} from './CWorkflow';
import {validatePrototypeDefinition,validateDefinitionKey,DefinitionError} from './Definition';
import type {DefinitionRepository,PrototypeDefinition} from './Definition';
import type {WorkflowRegistry} from './WorkflowRegistry';

export function reconstructWorkflow(input: unknown, registry: WorkflowRegistry, store: IWorkflowHistoryStore, continuation?:{history:readonly TraceEntry[]}) {
  const definition = validatePrototypeDefinition(input);
  // Resolve all names before invoking factories; an unsupported name never partially executes jobs.
  for (const step of definition.steps) {
    if (step.kind === 'JOB' && !registry.jobs.has(step.jobId) && !registry.jobForms?.definitions.has(step.jobId)) throw new DefinitionError('UNSUPPORTED_JOB');
    if(step.kind==='JOB'&&registry.jobs.has(step.jobId)&&registry.jobForms?.definitions.has(step.jobId))throw new DefinitionError('AMBIGUOUS_JOB');
    if (step.kind === 'CHECK_BOOL' && !registry.checks.has(step.checkId)) throw new DefinitionError('UNSUPPORTED_CHECK');
  }
  const no = new Map(definition.steps.map(step => [step.stepId, step.stepNo]));
  const steps: WorkflowStep[] = definition.steps.map(step => {
    const context = { definitionId: definition.definitionId, definitionVersion: definition.definitionVersion, stepId: step.stepId };
    if(step.kind==='WAIT')return {no:step.stepNo,waitReason:step.reason,nextStepNo:no.get(step.nextStepId)!};
    if (step.kind === 'CHECK_BOOL') {
      const condition = registry.checks.get(step.checkId)!(context);
      if (!condition || typeof condition.evaluate !== 'function') throw new DefinitionError('INVALID_CHECK_FACTORY');
      return { no: step.stepNo, job: new CCheckJob(step.stepId, condition, no.get(step.falseStepId)!, no.get(step.trueStepId)!) };
    }
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
  return { definition, workflow: new CWorkflow(steps, store), startStepNo: no.get(definition.startStepId)! };
}
export async function loadWorkflow(repository: DefinitionRepository<PrototypeDefinition>, id: string, version: string, registry: WorkflowRegistry, store: IWorkflowHistoryStore) {
  validateDefinitionKey(id); validateDefinitionKey(version);
  const definition = await repository.get(id, version);
  if (!definition) throw new DefinitionError('DEFINITION_NOT_FOUND');
  if (definition.definitionId !== id || definition.definitionVersion !== version) throw new DefinitionError('DEFINITION_IDENTITY_MISMATCH');
  return reconstructWorkflow(definition, registry, store);
}
