/** ARCH-026 experimental runnable core. Independent of the existing engine skeleton. */
export type StepNo = number;
export type TraceStatus = 'COMPLETED' | 'FAILED' | 'LIMIT_REACHED';
export interface IBool { evaluate(): boolean | Promise<boolean>; }
export abstract class CJob {
  constructor(public readonly name: string) {}
  abstract execute(): Promise<void>;
}
export class CDummyJob extends CJob {
  /** Synchronous and asynchronous callbacks both complete before the Job completes. */
  constructor(name: string, private readonly action: () => void | Promise<void> = () => {}) { super(name); }
  async execute(): Promise<void> { await this.action(); }
}
export class CCheckJob extends CJob {
  constructor(name: string, private readonly condition: IBool,
    public readonly returnStepNo: StepNo, public readonly nextStepNo: StepNo) { super(name); }
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
    if (values.length === 0) throw new Error('At least one boolean is required');
  }
  evaluate(): boolean { return this.values[Math.min(this.index++, this.values.length - 1)]; }
}
export interface Step { no: StepNo; job: CJob; nextStepNo?: StepNo; }
export interface TraceEntry {
  order: number; stepNo: StepNo; job: string; result: 'DONE' | 'TRUE' | 'FALSE' | 'ERROR';
  nextStepNo: StepNo | null; at: string; error?: string;
}
export interface RunSnapshot {
  runId: string; currentStepNo: StepNo | null; status: TraceStatus | 'RUNNING';
  history: readonly TraceEntry[];
  failure?: {code:'BEFORE_STEP_FAILED'; stepNo:StepNo; summary:string};
}
/** Copy the current snapshot DTO: TraceEntry and failure contain scalar fields. */
function copySnapshot(snapshot: RunSnapshot): RunSnapshot {
  return {...snapshot, history:snapshot.history.map(entry => ({...entry})),
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
export class CMemoryHistoryStore implements IWorkflowHistoryStore {
  private snapshots = new Map<string, RunSnapshot>();
  save(snapshot: RunSnapshot): void {
    this.snapshots.set(snapshot.runId, copySnapshot(snapshot));
  }
  load(runId: string): RunSnapshot | undefined {
    const snapshot=this.snapshots.get(runId);
    return snapshot ? copySnapshot(snapshot) : undefined;
  }
}
// Process-local reservations; the public history Store contract remains unchanged.
const activeRuns = new WeakMap<IWorkflowHistoryStore, Set<string>>();
export class CWorkflow {
  private readonly steps = new Map<StepNo, Step>();
  private running = false;
  constructor(steps: readonly Step[], private readonly store: IWorkflowHistoryStore) {
    for (const step of steps) {
      if (!Number.isSafeInteger(step.no) || this.steps.has(step.no)) throw new Error(`Invalid or duplicate step: ${step.no}`);
      this.steps.set(step.no, step);
    }
    if (!steps.length) throw new Error('Workflow needs steps');
    for (const step of steps) {
      const targets = step.job instanceof CCheckJob
        ? [step.job.returnStepNo, step.job.nextStepNo] : step.nextStepNo === undefined ? [] : [step.nextStepNo];
      for (const target of targets) if (!this.steps.has(target)) throw new Error(`Unknown target ${target} from ${step.no}`);
      if (!(step.job instanceof CCheckJob) && step.nextStepNo === undefined && step !== steps[steps.length - 1]) {
        // Terminal is explicit through absence of nextStepNo; any step can be terminal.
      }
    }
  }
  /** One active run per object. Independent runs need fresh Job/Check instances;
   * sequential reuse does not reset their internal state. Not a resume API. */
  async run(runId: string, startStepNo: StepNo, maxExecutions = 100, beforeStep?: () => Promise<void>): Promise<RunSnapshot> {
    if (!this.steps.has(startStepNo)) throw new Error(`Unknown start step: ${startStepNo}`);
    if (!Number.isSafeInteger(maxExecutions) || maxExecutions < 1) throw new Error('Invalid execution limit');
    let reserved = activeRuns.get(this.store);
    if (reserved?.has(runId)) throw Object.assign(new Error(`Run ID is executing: ${runId}`), {code:'RUN_BUSY'});
    // Registered Jobs/Checks may be stateful. Use a fresh graph for each independent run.
    if (this.running) throw Object.assign(new Error('CWorkflow object is executing'), {code:'WORKFLOW_BUSY'});
    if (!reserved) { reserved = new Set<string>(); activeRuns.set(this.store, reserved); }
    reserved.add(runId); this.running = true;
    try {
    if (await this.store.load(runId)) throw new Error(`Run ID already exists: ${runId}`);
    let current: StepNo | null = startStepNo;
    const history: TraceEntry[] = [];
    let failure: RunSnapshot['failure'];
    const snapshot = (status: RunSnapshot['status']): RunSnapshot => copySnapshot({runId, currentStepNo: current, status, history, ...(failure?{failure}:{})});
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
    while (current !== null && history.length < maxExecutions) {
      if (beforeStep) {
        try { await beforeStep(); }
        catch (cause) {
          failure={code:'BEFORE_STEP_FAILED',stepNo:current,summary:'beforeStepで例外が発生しました'};
          const failed=snapshot('FAILED');await persist(failed,{cause});
          throw new WorkflowRunError('BEFORE_STEP_FAILED',failed,cause);
        }
      }
      const step: Step = this.steps.get(current)!;
      let next: StepNo | null = null;
      let result: TraceEntry['result'] = 'DONE';
      try {
        if (step.job instanceof CCheckJob) {
          const branch = await step.job.evaluateBranch();
          result = branch.result ? 'TRUE' : 'FALSE'; next = branch.target;
        } else { await step.job.execute(); next = step.nextStepNo ?? null; }
      } catch (e) {
        history.push({order: history.length + 1, stepNo: current, job: step.job.name, result: 'ERROR',
          nextStepNo: null, at: new Date().toISOString(), error: String(e)});
        await persist(snapshot('FAILED'),{cause:e}); return snapshot('FAILED');
      }
      history.push({order: history.length + 1, stepNo: current, job: step.job.name, result,
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
