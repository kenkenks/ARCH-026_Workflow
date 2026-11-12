import type {JobFormDefinition as CJobForm,ProductShelf} from './CJobForm';
import type {CJob,CWorkflowTask,IBool} from './CWorkflow';

export interface ReconstructionContext { definitionId: string; definitionVersion: string; stepId: string }
export interface JobFormRegistration {
  form:CJobForm<unknown,unknown>;
  artifactKey:string | ((context:ReconstructionContext, iterationNo:number)=>string);
}
export interface JobVisitContext extends ReconstructionContext { stepNo:number; jobFormId:string; iterationNo:number }
export interface WorkflowRegistry {
  jobs: ReadonlyMap<string, (context: ReconstructionContext) => CWorkflowTask>;
  checks: ReadonlyMap<string, (context: ReconstructionContext) => IBool>;
  jobForms?: {definitions:ReadonlyMap<string,JobFormRegistration>;products:ProductShelf;
    onCreate?:(job:CJob<unknown,unknown>,context:JobVisitContext)=>void};
}
