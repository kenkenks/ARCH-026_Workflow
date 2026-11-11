export interface ProductReader { has(key:string):boolean; get(key:string):unknown; }
export interface ProductShelf extends ProductReader { put(key:string,value:unknown):void|Promise<void>; }
/** Structural contract retained for existing object-based definitions. */
export interface JobFormDefinition<I,O> {readonly name:string;collect(products:ProductReader):I|Promise<I>;make(input:I):O|Promise<O>;record?(output:O):void|Promise<void>;}
export type JobStatus='READY'|'RUNNING'|'COMPLETED'|'FAILED';
export type Phase='prepare'|'collect'|'make'|'record'|'post'|'cleanup';
export interface ExecutionOptions {products?:ProductShelf;artifactKey?:string;runId?:string;stepNo?:number;}
/** One context per visit. It has no runner or transition methods. */
export interface ExecutionContext extends Readonly<ExecutionOptions> {}
interface MutableState {status:JobStatus;phase:Phase|null;recorded:{value:unknown}|null;cleanupWarning?:unknown;}
const states=new WeakMap<ExecutionContext,MutableState>();
function invalid():never{throw Object.assign(new Error('Invalid JobForm input'),{code:'INVALID_ARGUMENT'});}
function state(context:ExecutionContext){const value=states.get(context);if(!value)invalid();return value;}
export function createExecutionContext(options:ExecutionOptions={}):ExecutionContext {
  if(!options||typeof options!=='object'||Array.isArray(options))invalid();
  const {products,artifactKey,runId,stepNo}=options;
  if((products===undefined)!==(artifactKey===undefined))invalid();
  if(products!==undefined&&(!products||typeof products!=='object'||Array.isArray(products)||!['has','get','put'].every(k=>typeof products[k as keyof ProductShelf]==='function')||typeof artifactKey!=='string'||!artifactKey.trim()))invalid();
  if(runId!==undefined&&(typeof runId!=='string'||!runId.trim()))invalid();
  if(stepNo!==undefined&&!Number.isSafeInteger(stepNo))invalid();
  const context=Object.freeze({products,artifactKey,runId,stepNo});
  states.set(context,{status:'READY',phase:null,recorded:null});return context;
}
export function getExecutionState(context:ExecutionContext){const s=state(context);return {status:s.status,phase:s.phase};}
export function getRecorded<O=unknown>(context:ExecutionContext):{value:O}|null {const r=state(context).recorded;return r?structuredClone(r) as {value:O}:null;}
/** Local diagnostic only; do not serialize unknown errors to HTTP. */
export function getCleanupWarning(context:ExecutionContext):unknown{return state(context).cleanupWarning;}
const emptyReader:ProductReader=Object.freeze({has:()=>false,get:()=>undefined});
interface Phases<I,O> {prepare?:()=>void|Promise<void>;collect(reader:ProductReader):I|Promise<I>;make(input:I):O|Promise<O>;record?(output:O):void|Promise<void>;post(output:O):void|Promise<void>;cleanup?:()=>void|Promise<void>;}
/** The single CMRP implementation used by both native Forms and legacy CJob. */
async function executeCMRP<I,O>(phases:Phases<I,O>,context:ExecutionContext):Promise<void>{
  const s=state(context);if(s.status!=='READY')throw Error('JobForm binding already used');
  s.status='RUNNING';let failed=false,cause:unknown,failedPhase:Phase|null=null;
  try{
    if(phases.prepare){s.phase='prepare';await phases.prepare();}
    s.phase='collect';const input=await phases.collect(context.products?{has:k=>context.products!.has(k),get:k=>context.products!.get(k)}:emptyReader);
    s.phase='make';const made=await phases.make(input);
    s.phase='record';const candidate=structuredClone(made);if(phases.record)await phases.record(structuredClone(candidate));
    s.recorded={value:candidate};
    s.phase='post';await phases.post(structuredClone(candidate));
  }catch(error){failed=true;cause=error;failedPhase=s.phase;s.status='FAILED';}
  if(phases.cleanup){
    s.phase='cleanup';try{await phases.cleanup();}catch(error){if(failed)s.cleanupWarning=error;else{failed=true;cause=error;s.status='FAILED';failedPhase='cleanup';}}
    if(failed)s.phase=failedPhase;
  }
  if(failed)throw cause;
  s.status='COMPLETED';
}
export abstract class CJobForm<I=void,O=I> {
  constructor(public readonly name:string){if(typeof name!=='string'||!name.trim())invalid();}
  protected prepare(_context:ExecutionContext):void|Promise<void>{}
  protected collect(_products:ProductReader,_context:ExecutionContext):I|Promise<I>{return undefined as I;}
  protected make(input:I,_context:ExecutionContext):O|Promise<O>{return input as unknown as O;}
  protected record(_output:O,_context:ExecutionContext):void|Promise<void>{}
  protected post(output:O,context:ExecutionContext):void|Promise<void>{if(context.products)return context.products.put(context.artifactKey!,output);}
  protected cleanup(_context:ExecutionContext):void|Promise<void>{}
  async execute(context:ExecutionContext=createExecutionContext()):Promise<void>{
    await executeCMRP({prepare:()=>this.prepare(context),collect:r=>this.collect(r,context),make:i=>this.make(i,context),record:o=>this.record(o,context),post:o=>this.post(o,context),cleanup:()=>this.cleanup(context)},context);
  }
}
/** Compatibility function, not a second execution engine. Legacy had no cleanup. */
export function executeLegacyForm<I,O>(form:JobFormDefinition<I,O>,context:ExecutionContext):Promise<void>{
  return executeCMRP({collect:r=>form.collect(r),make:i=>form.make(i),...(form.record?{record:(o:O)=>form.record!(o)}:{}),post:o=>context.products!.put(context.artifactKey!,o)},context);
}
export function createMemoryProductShelf():ProductShelf{
  const values=new Map<string,unknown>();return {has:k=>values.has(k),get:k=>values.has(k)?structuredClone(values.get(k)):undefined,put:(k,v)=>{values.set(k,structuredClone(v));}};
}
