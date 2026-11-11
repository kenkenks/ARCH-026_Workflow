import {CJobForm,createExecutionContext,getExecutionState,getRecorded,executeLegacyForm} from './CJobForm';
import type {JobFormDefinition,ProductShelf,ExecutionContext} from './CJobForm';
/** Framework Workflow execution implementation. Legacy imports re-export this module. */
export class WorkflowValidationError extends Error {
  readonly code='INVALID_ARGUMENT';
  constructor(){super('Invalid workflow input');this.name='WorkflowValidationError';}
}
function requireText(value:unknown):void{if(typeof value!=='string'||!value.trim())throw new WorkflowValidationError();}
function requireObject(value:unknown):asserts value is Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkflowValidationError();}
function requireJob(value:unknown):asserts value is CWorkflowTask{
  requireObject(value);requireText(value.name);
  if(typeof value.execute!=='function')throw new WorkflowValidationError();
  if(value instanceof CCheckJob&&typeof value.evaluateBranch!=='function')throw new WorkflowValidationError();
}
export type StepNo = number;
export type TraceStatus = 'COMPLETED' | 'FAILED' | 'LIMIT_REACHED';
export interface IBool { evaluate(): boolean | Promise<boolean>; }
export abstract class CWorkflowTask {
  constructor(public readonly name: string) { requireText(name); }
  abstract execute(): Promise<void>;
}
/** Deprecated execution binding. All CMRP work delegates to CJobForm's pipeline. */
export class CJob<Input,Output> extends CWorkflowTask {
  private readonly context:ExecutionContext;
  constructor(public readonly form:JobFormDefinition<Input,Output>,products:ProductShelf,public readonly artifactKey:string){
    super(form?.name);
    if(!form||typeof form.collect!=='function'||typeof form.make!=='function'||(form.record!==undefined&&typeof form.record!=='function')||!products||typeof products.has!=='function'||typeof products.get!=='function'||typeof products.put!=='function'||typeof artifactKey!=='string'||!artifactKey.trim())throw new WorkflowValidationError();
    this.context=createExecutionContext({products,artifactKey});
  }
  getState(){return getExecutionState(this.context);}
  getRecorded():{value:Output}|null{return getRecorded<Output>(this.context);}
  execute():Promise<void>{return executeLegacyForm(this.form,this.context);}
}
export class CDummyJob extends CWorkflowTask {
  /** Synchronous and asynchronous callbacks both complete before the Job completes. */
  constructor(name: string, private readonly action: () => void | Promise<void> = () => {}) { super(name); if(typeof action!=='function')throw new WorkflowValidationError(); }
  async execute(): Promise<void> { await this.action(); }
}
export class CCheckJob extends CWorkflowTask {
  constructor(name: string, private readonly condition: IBool,
    public readonly returnStepNo: StepNo, public readonly nextStepNo: StepNo) { super(name); requireObject(condition);if(typeof condition.evaluate!=='function'||!Number.isSafeInteger(returnStepNo)||!Number.isSafeInteger(nextStepNo))throw new WorkflowValidationError(); }
  async execute(): Promise<void> { /* workflow invokes evaluateBranch instead */ }
  async evaluateBranch(): Promise<{result: boolean; target: StepNo}> {
    const result = await this.condition.evaluate();
    if (typeof result !== 'boolean') throw new Error('IBool must return boolean');
    return {result, target: result ? this.nextStepNo : this.returnStepNo};
  }
}
export class CSequenceBool implements IBool {
  private index = 0;
  constructor(private readonly values: readonly boolean[]) {
    if(!Array.isArray(values)||values.length===0||Array.from(values).some(value=>typeof value!=='boolean'))throw new WorkflowValidationError();
    this.values=[...values];
  }
  evaluate(): boolean { return this.values[Math.min(this.index++, this.values.length - 1)]; }
}
export interface Step { no: StepNo; job: CWorkflowTask; nextStepNo?: StepNo; products?:ProductShelf; artifactKey?:string; }
/** The factory is evaluated on each visit, never at graph validation time. */
export interface JobFactoryStep { no:StepNo; createJob:()=>CWorkflowTask; nextStepNo?:StepNo; products?:ProductShelf; artifactKey?:string; }
/** A durable inter-step boundary, never a partially executed Job. */
export interface WaitStep { no:StepNo; waitReason:string; nextStepNo:StepNo; }
export type WorkflowStep = Step | JobFactoryStep | WaitStep;
export interface WaitingOperation {
  runId:string; operationId:string; expectedWaitGeneration:number; expectedRevision:number; result:unknown;
}
export interface WaitingBoundary { reason:string; generation:number; nextStepNo:StepNo; }
export interface TraceEntry {
  order: number; stepNo: StepNo; job: string; result: 'DONE' | 'TRUE' | 'FALSE' | 'ERROR';
  nextStepNo: StepNo | null; at: string; error?: string;
}
export interface RunSnapshot {
  runId: string; currentStepNo: StepNo | null; status: TraceStatus | 'RUNNING' | 'WAITING';
  history: readonly TraceEntry[];
  waitSequence?:number;
  waiting?:WaitingBoundary;
  failure?: {code:'BEFORE_STEP_FAILED'; stepNo:StepNo; summary:string};
}
/** Validate known DTO fields only; extension metadata remains compatible. */
function validateSnapshot(value:unknown):asserts value is RunSnapshot{
  requireObject(value);requireText(value.runId);
  if(!['RUNNING','COMPLETED','FAILED','LIMIT_REACHED','WAITING'].includes(value.status as string)||
    (value.currentStepNo!==null&&!Number.isSafeInteger(value.currentStepNo))||!Array.isArray(value.history))throw new WorkflowValidationError();
  for(const entry of value.history){
    requireObject(entry);requireText(entry.job);requireText(entry.at);
    if(!Number.isSafeInteger(entry.order)||(entry.order as number)<1||!Number.isSafeInteger(entry.stepNo)||
      !['DONE','TRUE','FALSE','ERROR'].includes(entry.result as string)||
      (entry.nextStepNo!==null&&!Number.isSafeInteger(entry.nextStepNo))||
      (entry.error!==undefined&&typeof entry.error!=='string'))throw new WorkflowValidationError();
  }
  if(value.failure!==undefined){
    requireObject(value.failure);requireText(value.failure.summary);
    if(value.failure.code!=='BEFORE_STEP_FAILED'||!Number.isSafeInteger(value.failure.stepNo))throw new WorkflowValidationError();
  }
  if(value.waitSequence!==undefined&&(!Number.isSafeInteger(value.waitSequence)||(value.waitSequence as number)<0))throw new WorkflowValidationError();
  if(value.status==='WAITING'){
    requireObject(value.waiting);requireText(value.waiting.reason);
    if(value.currentStepNo===null||!Number.isSafeInteger(value.waiting.generation)||(value.waiting.generation as number)<1||
      value.waitSequence!==value.waiting.generation||!Number.isSafeInteger(value.waiting.nextStepNo)||value.failure||
      value.history.some((h:unknown)=>(h as TraceEntry).result==='ERROR'))throw new WorkflowValidationError();
  }else if(value.waiting!==undefined)throw new WorkflowValidationError();
}
/** Copy the current snapshot DTO: TraceEntry and failure contain scalar fields. */
function copySnapshot(snapshot: RunSnapshot): RunSnapshot {
  return {...snapshot, history:snapshot.history.map(entry => ({...entry})),
    ...(snapshot.waiting?{waiting:{...snapshot.waiting}}:{}),
    ...(snapshot.failure ? {failure:{...snapshot.failure}} : {})};
}
/** Local diagnostic error. Causes/snapshots must not be blindly serialized to HTTP. */
export class WorkflowRunError extends Error {
  readonly code: 'BEFORE_STEP_FAILED' | 'HISTORY_SAVE_OUTCOME_UNKNOWN';
  readonly outcome: 'FAILED' | 'UNKNOWN';
  constructor(code: WorkflowRunError['code'], public readonly attemptedSnapshot: RunSnapshot,
    cause: unknown, public readonly storageCause?: unknown,
    public readonly observation?: {state:'AVAILABLE'|'ABSENT'|'UNAVAILABLE'; snapshot?:RunSnapshot}) {
    super(code === 'BEFORE_STEP_FAILED' ? 'Workflow beforeStep failed' : 'History save outcome is unknown', {cause});
    this.name='WorkflowRunError';this.code=code;this.outcome=code==='BEFORE_STEP_FAILED'?'FAILED':'UNKNOWN';
  }
}
export interface IWorkflowHistoryStore { save(snapshot: RunSnapshot): void | Promise<void>; load(runId: string): RunSnapshot | undefined | Promise<RunSnapshot | undefined>; }
/** The caller authorizes operations; this Port atomically owns CAS, receipt and Lease. */
export interface IWaitingHistoryStore extends IWorkflowHistoryStore {
  claimWaiting(snapshot:RunSnapshot,operation:WaitingOperation):Promise<{replayed:boolean;snapshot:RunSnapshot}>;
}
export class CMemoryHistoryStore implements IWorkflowHistoryStore {
  private snapshots = new Map<string, RunSnapshot>();
  save(snapshot: RunSnapshot): void {
    validateSnapshot(snapshot);
    this.snapshots.set(snapshot.runId, copySnapshot(snapshot));
  }
  load(runId: string): RunSnapshot | undefined {
    requireText(runId);
    const snapshot=this.snapshots.get(runId);
    return snapshot ? copySnapshot(snapshot) : undefined;
  }
}
// Process-local reservations; the public history Store contract remains unchanged.
const activeRuns = new WeakMap<IWorkflowHistoryStore, Set<string>>();
export class CWorkflow {
  private readonly steps = new Map<StepNo, WorkflowStep>();
  private running = false;
  constructor(steps: readonly WorkflowStep[], private readonly store: IWorkflowHistoryStore) {
    if(!Array.isArray(steps)||!store||typeof store.save!=='function'||typeof store.load!=='function')throw new WorkflowValidationError();
    for (const step of steps) {
      requireObject(step as unknown);
      if ('waitReason' in step) {
        requireText(step.waitReason);
        if('job' in step||'createJob' in step||!Number.isSafeInteger(step.nextStepNo))throw new WorkflowValidationError();
      } else if ('createJob' in step) {
        if ('job' in step || typeof step.createJob!=='function')throw new WorkflowValidationError();
      } else {requireJob(step.job);if(step.job instanceof CJobForm)createExecutionContext({products:step.products,artifactKey:step.artifactKey});}
      if (!Number.isSafeInteger(step.no) || this.steps.has(step.no)) throw new Error(`Invalid or duplicate step: ${step.no}`);
      this.steps.set(step.no, step);
    }
    if (!steps.length) throw new Error('Workflow needs steps');
    for (const step of steps) {
      const job='job' in step?step.job:undefined;
      const targets = job instanceof CCheckJob
        ? [job.returnStepNo, job.nextStepNo] : step.nextStepNo === undefined ? [] : [step.nextStepNo];
      for (const target of targets) if (!this.steps.has(target)) throw new Error(`Unknown target ${target} from ${step.no}`);
      if (!(job instanceof CCheckJob) && step.nextStepNo === undefined && step !== steps[steps.length - 1]) {
        // Terminal is explicit through absence of nextStepNo; any step can be terminal.
      }
    }
  }
  /** One active run per object. Independent runs need fresh Job/Check instances;
   * sequential reuse does not reset their internal state. Not a resume API. */
  async run(runId: string, startStepNo: StepNo, maxExecutions = 100, beforeStep?: () => Promise<void>): Promise<RunSnapshot> {
    return this.executeRun(runId,startStepNo,maxExecutions,beforeStep);
  }
  /** Explicit continuation of an unchanged saved boundary. Ownership is a Host/Store responsibility. */
  async resume(saved:RunSnapshot,maxExecutions=100,beforeStep?:()=>Promise<void>):Promise<RunSnapshot>{
    validateSnapshot(saved);
    if(saved.status!=='LIMIT_REACHED'||saved.currentStepNo===null||saved.failure||saved.history.some(h=>h.result==='ERROR')||
      saved.history.some((h,i)=>h.order!==i+1)||!saved.history.length||saved.history[saved.history.length-1].nextStepNo!==saved.currentStepNo)throw new WorkflowValidationError();
    const seed=copySnapshot(saved);
    return this.executeRun(seed.runId,seed.currentStepNo!,maxExecutions,beforeStep,seed);
  }
  async resumeWaiting(saved:RunSnapshot,operation:WaitingOperation,maxExecutions=100,beforeStep?:()=>Promise<void>):Promise<RunSnapshot>{
    validateSnapshot(saved);
    requireObject(operation);
    if(saved.status!=='WAITING'||!saved.waiting||typeof (this.store as IWaitingHistoryStore).claimWaiting!=='function')throw new WorkflowValidationError();
    const step=this.steps.get(saved.currentStepNo!);
    if(!step||!('waitReason' in step)||step.nextStepNo!==saved.waiting.nextStepNo||step.waitReason!==saved.waiting.reason)throw new WorkflowValidationError();
    return this.executeRun(saved.runId,saved.waiting.nextStepNo,maxExecutions,beforeStep,copySnapshot(saved),operation);
  }
  private async executeRun(runId:string,startStepNo:StepNo,maxExecutions:number,beforeStep?:()=>Promise<void>,seed?:RunSnapshot,operation?:WaitingOperation):Promise<RunSnapshot>{
    requireText(runId);
    if(beforeStep!==undefined&&typeof beforeStep!=='function')throw new WorkflowValidationError();
    for(const step of this.steps.values()){if('job' in step)requireJob(step.job);else if('createJob' in step&&typeof step.createJob!=='function')throw new WorkflowValidationError();}
    if([...this.steps.values()].some(s=>'waitReason' in s)&&typeof (this.store as IWaitingHistoryStore).claimWaiting!=='function')throw new WorkflowValidationError();
    if (!this.steps.has(startStepNo)) throw new Error(`Unknown start step: ${startStepNo}`);
    if (!Number.isSafeInteger(maxExecutions) || maxExecutions < 1) throw new Error('Invalid execution limit');
    let reserved = activeRuns.get(this.store);
    if (reserved?.has(runId)) throw Object.assign(new Error(`Run ID is executing: ${runId}`), {code:'RUN_BUSY'});
    // Registered Jobs/Checks may be stateful. Use a fresh graph for each independent run.
    if (this.running) throw Object.assign(new Error('CWorkflow object is executing'), {code:'WORKFLOW_BUSY'});
    if (!reserved) { reserved = new Set<string>(); activeRuns.set(this.store, reserved); }
    reserved.add(runId); this.running = true;
    try {
    const existing=await this.store.load(runId);
    if(operation){
      const claimed=await (this.store as IWaitingHistoryStore).claimWaiting(seed!,operation);
      if(claimed.replayed)return copySnapshot(claimed.snapshot);
      seed=copySnapshot(claimed.snapshot);startStepNo=seed.currentStepNo!;
    }else if(seed){if(JSON.stringify(existing)!==JSON.stringify(seed))throw Object.assign(new Error('Saved boundary changed'),{code:'RESUME_STATE_CHANGED'});}
    else if(existing)throw new Error(`Run ID already exists: ${runId}`);
    let current: StepNo | null = startStepNo;
    const history: TraceEntry[] = seed?seed.history.map(h=>({...h})):[];
    const initialHistoryLength=history.length;
    let failure: RunSnapshot['failure'];
    let waitSequence=seed?.waitSequence??0;
    const snapshot = (status: RunSnapshot['status']): RunSnapshot => copySnapshot({runId, currentStepNo: current, status, history,
      ...(waitSequence?{waitSequence}:{}),...(failure?{failure}:{})});
    const persist = async (value: RunSnapshot, primary?: {cause:unknown}): Promise<void> => {
      // A Store may retain its input. Keep Core-owned results/diagnostics separate.
      try { await this.store.save(copySnapshot(value)); }
      catch (storageCause) {
        let observation: NonNullable<WorkflowRunError['observation']>;
        try { const stored=await this.store.load(runId); observation=stored?{state:'AVAILABLE',snapshot:structuredClone(stored)}:{state:'ABSENT'}; }
        catch { observation={state:'UNAVAILABLE'}; }
        // Read-back observes state; even a match does not prove that save succeeded.
        throw new WorkflowRunError('HISTORY_SAVE_OUTCOME_UNKNOWN',value,primary?primary.cause:storageCause,storageCause,observation);
      }
    };
    await persist(snapshot('RUNNING'));
    while (current !== null && history.length-initialHistoryLength < maxExecutions) {
      if (beforeStep) {
        try { await beforeStep(); }
        catch (cause) {
          failure={code:'BEFORE_STEP_FAILED',stepNo:current,summary:'beforeStepで例外が発生しました'};
          const failed=snapshot('FAILED');await persist(failed,{cause});
          throw new WorkflowRunError('BEFORE_STEP_FAILED',failed,cause);
        }
      }
      const step: WorkflowStep = this.steps.get(current)!;
      if('waitReason' in step){
        waitSequence++;
        const waiting={...snapshot('WAITING'),waiting:{reason:step.waitReason,generation:waitSequence,nextStepNo:step.nextStepNo}};
        await persist(waiting);return copySnapshot(waiting);
      }
      let job: CWorkflowTask | undefined;
      let jobName = 'step-'+current;
      let next: StepNo | null = null;
      let result: TraceEntry['result'] = 'DONE';
      try {
        job='createJob' in step?step.createJob():step.job;
        requireJob(job);
        if('createJob' in step && !(job instanceof CJob) && !(job instanceof CJobForm))throw new WorkflowValidationError();
        jobName=job.name;
        if (job instanceof CCheckJob) {
          const branch = await job.evaluateBranch();
          result = branch.result ? 'TRUE' : 'FALSE'; next = branch.target;
        } else {
          if(job instanceof CJobForm)await job.execute(createExecutionContext({runId,stepNo:current,products:step.products,artifactKey:step.artifactKey}));
          else await job.execute();
          next = step.nextStepNo ?? null;
        }
      } catch (e) {
        history.push({order: history.length + 1, stepNo: current, job: jobName, result: 'ERROR',
          nextStepNo: null, at: new Date().toISOString(), error: String(e)});
        await persist(snapshot('FAILED'),{cause:e}); return snapshot('FAILED');
      }
      history.push({order: history.length + 1, stepNo: current, job: jobName, result,
        nextStepNo: next, at: new Date().toISOString()});
      current = next;
      await persist(snapshot(current === null ? 'COMPLETED' : 'RUNNING'));
    }
    const final = snapshot(current === null ? 'COMPLETED' : 'LIMIT_REACHED');
    await persist(final); return final;
    } finally {
      reserved.delete(runId); this.running = false;
      if (!reserved.size) activeRuns.delete(this.store);
    }
  }
}
/** Read-only operational projection. Never modifies workflow state. */
export class CWorkflowMonitor {
  constructor(private readonly store: IWorkflowHistoryStore) {}
  async get(runId: string): Promise<RunSnapshot | undefined> { return this.store.load(runId); }
  async summary(runId: string): Promise<Array<{stepNo: number; executions: number; lastResult: string}>> {
    const snapshot = await this.get(runId);
    if (!snapshot) return [];
    const map = new Map<number, {stepNo: number; executions: number; lastResult: string}>();
    for (const e of snapshot.history) {
      const row = map.get(e.stepNo) ?? {stepNo: e.stepNo, executions: 0, lastResult: ''};
      row.executions++; row.lastResult = e.result; map.set(e.stepNo, row);
    }
    return [...map.values()].sort((a,b) => a.stepNo-b.stepNo);
  }
}
