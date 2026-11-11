import {CJob} from './workflow';
import type {JobFormDefinition,ProductShelf} from '../../Frwk_Units/Workflow/src/CJobForm';
/** Deprecated structural name retained for existing object-based definitions. */
export type CJobForm<I,O>=JobFormDefinition<I,O>;
export type {ProductReader,ProductShelf} from '../../Frwk_Units/Workflow/src/CJobForm';
export {createMemoryProductShelf} from '../../Frwk_Units/Workflow/src/CJobForm';
/** Compatibility binding. New code subclasses @arch026/workflow's CJobForm. */
export function bindJobForm<I,O>(form:JobFormDefinition<I,O>,products:ProductShelf,outputKey:string){
 const job=new CJob(form,products,outputKey);return {job,getRecorded:()=>job.getRecorded()};
}
