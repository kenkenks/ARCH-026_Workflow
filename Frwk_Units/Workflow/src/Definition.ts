export const DEFINITION_SCHEMA_VERSION = 'prototype-workflow/1' as const;
export const WAITING_DEFINITION_SCHEMA_VERSION = 'prototype-workflow/2' as const;
interface StepIdentity { stepId: string; stepNo: number }
export type SavedStep =
  | (StepIdentity & { kind: 'JOB'; jobId: string; nextStepId?: string })
  | (StepIdentity & { kind: 'CHECK_BOOL'; checkId: string; trueStepId: string; falseStepId: string })
  | (StepIdentity & { kind: 'WAIT'; reason:string; nextStepId:string });
export interface PrototypeDefinition {
  schemaVersion: typeof DEFINITION_SCHEMA_VERSION | typeof WAITING_DEFINITION_SCHEMA_VERSION;
  definitionId: string;
  definitionVersion: string;
  startStepId: string;
  steps: SavedStep[];
}
export class DefinitionError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'DefinitionError'; }
}
export function validateDefinitionKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new DefinitionError('INVALID_DEFINITION');
  // Preserve the caller's identity. Reject malformed Unicode rather than silently normalizing it.
  try { encodeURIComponent(value); } catch { throw new DefinitionError('INVALID_DEFINITION'); }
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, unknown>, fields: string[]): boolean {
  const names = Reflect.ownKeys(value);
  return names.length === fields.length && fields.every(field => Object.hasOwn(value, field));
}
/** Strict, serializable prototype-only schema. GUI CHECK_FINAL/PROVISIONAL/WAIT are not coerced. */
export function validatePrototypeDefinition(input: unknown): PrototypeDefinition {
  if (!object(input) || ![DEFINITION_SCHEMA_VERSION,WAITING_DEFINITION_SCHEMA_VERSION].includes(input.schemaVersion as typeof DEFINITION_SCHEMA_VERSION)) throw new DefinitionError('SCHEMA_MISMATCH');
  if (!exact(input, ['schemaVersion', 'definitionId', 'definitionVersion', 'startStepId', 'steps']) ||
      !Array.isArray(input.steps) || !input.steps.length) throw new DefinitionError('INVALID_DEFINITION');
  validateDefinitionKey(input.definitionId); validateDefinitionKey(input.definitionVersion); validateDefinitionKey(input.startStepId);
  const ids = new Set<string>(), numbers = new Set<number>();
  const steps: SavedStep[] = [];
  for (const value of input.steps) {
    if (!object(value)) throw new DefinitionError('INVALID_DEFINITION');
    validateDefinitionKey(value.stepId);
    if (!Number.isSafeInteger(value.stepNo) || ids.has(value.stepId) || numbers.has(value.stepNo as number)) throw new DefinitionError('INVALID_DEFINITION');
    ids.add(value.stepId); numbers.add(value.stepNo as number);
    const identity = { stepId: value.stepId, stepNo: value.stepNo as number };
    if (value.kind === 'JOB') {
      const fields = ['stepId', 'stepNo', 'kind', 'jobId', ...(Object.hasOwn(value, 'nextStepId') ? ['nextStepId'] : [])];
      if (!exact(value, fields)) throw new DefinitionError('INVALID_DEFINITION');
      validateDefinitionKey(value.jobId);
      if (Object.hasOwn(value, 'nextStepId')) validateDefinitionKey(value.nextStepId);
      steps.push({ ...identity, kind: 'JOB', jobId: value.jobId, ...(Object.hasOwn(value, 'nextStepId') ? { nextStepId: value.nextStepId as string } : {}) });
    } else if (value.kind === 'CHECK_BOOL') {
      if (!exact(value, ['stepId', 'stepNo', 'kind', 'checkId', 'trueStepId', 'falseStepId'])) throw new DefinitionError('INVALID_DEFINITION');
      validateDefinitionKey(value.checkId); validateDefinitionKey(value.trueStepId); validateDefinitionKey(value.falseStepId);
      steps.push({ ...identity, kind: 'CHECK_BOOL', checkId: value.checkId, trueStepId: value.trueStepId, falseStepId: value.falseStepId });
    } else if(value.kind==='WAIT'&&input.schemaVersion===WAITING_DEFINITION_SCHEMA_VERSION){
      if(!exact(value,['stepId','stepNo','kind','reason','nextStepId']))throw new DefinitionError('INVALID_DEFINITION');
      validateDefinitionKey(value.reason);validateDefinitionKey(value.nextStepId);
      steps.push({...identity,kind:'WAIT',reason:value.reason,nextStepId:value.nextStepId});
    } else throw new DefinitionError('UNSUPPORTED_STEP_KIND');
  }
  if (!ids.has(input.startStepId)) throw new DefinitionError('INVALID_DEFINITION');
  const byId = new Map(steps.map(step => [step.stepId, step]));
  const targets = (step: SavedStep) => step.kind === 'CHECK_BOOL' ? [step.trueStepId, step.falseStepId] : step.nextStepId === undefined ? [] : [step.nextStepId];
  for (const step of steps) for (const target of targets(step)) if (!ids.has(target)) throw new DefinitionError('INVALID_DEFINITION');
  const reached = new Set<string>(), pending = [input.startStepId];
  while (pending.length) { const id = pending.pop()!; if (reached.has(id)) continue; reached.add(id); pending.push(...targets(byId.get(id)!)); }
  if (reached.size !== steps.length || !steps.some(step => step.kind === 'JOB' && step.nextStepId === undefined)) throw new DefinitionError('INVALID_DEFINITION');
  return { schemaVersion: input.schemaVersion as PrototypeDefinition['schemaVersion'], definitionId: input.definitionId, definitionVersion: input.definitionVersion, startStepId: input.startStepId, steps };
}

/** Minimal immutable-definition repository boundary; implementations remain outside the Unit. */
export interface DefinitionRepository<TDefinition=PrototypeDefinition> {
  get(id:string,version:string):Promise<TDefinition|null>;
  add(definition:TDefinition):Promise<void>;
}
