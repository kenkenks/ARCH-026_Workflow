import type { DefinitionRepository } from '../ports/contracts';
import { validateDefinitionKey, validatePrototypeDefinition, reconstructWorkflow, DefinitionError } from '../prototype/definition';
import type { PrototypeDefinition, WorkflowRegistry } from '../prototype/definition';

export interface DefinitionKey { definitionId: string; definitionVersion: string }
export interface Manifest { manifestVersion: 1; definitions: DefinitionKey[] }
export type Action = 'CREATE' | 'ALREADY_EQUAL' | 'CONFLICT' | 'REJECT';
export interface Classification { action: Action; reason?: string }
export interface PlanItem extends DefinitionKey, Classification { sourceFingerprint: string | null }
export interface MigrationPlan { planVersion: 1; items: PlanItem[] }
export interface MigrationResult {
  ok: boolean;
  items: (DefinitionKey & {
    status: 'CREATED' | 'ALREADY_EQUAL' | 'CONFLICT' | 'REJECT' | 'FAILED' | 'SOURCE_CHANGED' | 'OUTCOME_UNKNOWN';
    reason?: string;
    sourceFingerprint: string | null;
    confirmedAdded: boolean;
    reconciliation?: Classification;
  })[];
  stoppedAt: number | null;
}
type Repository = DefinitionRepository<PrototypeDefinition>;
const knownReasons = new Set([
  'INVALID_DEFINITION', 'SCHEMA_MISMATCH', 'DATA_CORRUPT', 'DEFINITION_IDENTITY_MISMATCH',
  'UNSUPPORTED_JOB', 'UNSUPPORTED_CHECK', 'UNSUPPORTED_STEP_KIND', 'INVALID_JOB_FACTORY',
  'INVALID_CHECK_FACTORY', 'UNAVAILABLE', 'STORAGE_SCHEMA_MISMATCH', 'DEFINITION_NOT_FOUND',
  'DEFINITION_ALREADY_EXISTS', 'OUTCOME_UNKNOWN'
]);
function reason(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && knownReasons.has(code) ? code : 'UNAVAILABLE';
}
function key(input: unknown): DefinitionKey {
  if (!input || typeof input !== 'object') throw new DefinitionError('INVALID_MANIFEST');
  const value = input as DefinitionKey;
  validateDefinitionKey(value.definitionId); validateDefinitionKey(value.definitionVersion);
  return { definitionId: value.definitionId, definitionVersion: value.definitionVersion };
}
function keys(inputs: unknown[]): DefinitionKey[] {
  const seen = new Set<string>();
  return inputs.map(input => {
    const value = key(input), identity = JSON.stringify([value.definitionId, value.definitionVersion]);
    if (seen.has(identity)) throw new DefinitionError('DUPLICATE_MANIFEST_TARGET');
    seen.add(identity); return value;
  });
}
function validated(input: unknown, expected: DefinitionKey): PrototypeDefinition {
  if (input === null) throw new DefinitionError('DEFINITION_NOT_FOUND');
  const d = validatePrototypeDefinition(input);
  if (d.definitionId !== expected.definitionId || d.definitionVersion !== expected.definitionVersion)
    throw new DefinitionError('DEFINITION_IDENTITY_MISMATCH');
  return d;
}
function dependencies(d: PrototypeDefinition, registry: WorkflowRegistry): void {
  for (const step of d.steps) {
    if (step.kind === 'JOB' && typeof registry.jobs.get(step.jobId) !== 'function') throw new DefinitionError('UNSUPPORTED_JOB');
    if (step.kind === 'CHECK_BOOL' && typeof registry.checks.get(step.checkId) !== 'function') throw new DefinitionError('UNSUPPORTED_CHECK');
  }
}
// Validator returns a detached definition in a fixed field order. Arrays are never sorted.
export function canonicalDefinition(input: unknown): string {
  return JSON.stringify(validatePrototypeDefinition(input));
}
export async function definitionFingerprint(input: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalDefinition(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), x => x.toString(16).padStart(2, '0')).join('');
}
/** Pure: validates names but never invokes factories, performs I/O or executes jobs. */
export function classifyDefinition(source: unknown, destination: unknown, expected: DefinitionKey, registry: WorkflowRegistry): Classification {
  try {
    const d = validated(source, expected); dependencies(d, registry);
    if (destination === null) return { action: 'CREATE' };
    const target = validated(destination, expected);
    return { action: canonicalDefinition(d) === canonicalDefinition(target) ? 'ALREADY_EQUAL' : 'CONFLICT' };
  } catch (error) { return { action: 'REJECT', reason: reason(error) }; }
}
/** Dry Run entry point. Receives read-only ports; no add operation is available here. */
export async function planDefinitionMigration(
  manifest: Manifest, source: Pick<Repository, 'get'>, destination: Pick<Repository, 'get'>, registry: WorkflowRegistry
): Promise<MigrationPlan> {
  if (manifest?.manifestVersion !== 1 || !Array.isArray(manifest.definitions)) throw new DefinitionError('INVALID_MANIFEST');
  const selected = keys(manifest.definitions), items: PlanItem[] = [];
  for (const expected of selected) {
    let fingerprint: string | null = null;
    try {
      const d = validated(await source.get(expected.definitionId, expected.definitionVersion), expected);
      fingerprint = await definitionFingerprint(d);
      const target = await destination.get(expected.definitionId, expected.definitionVersion);
      items.push({ ...expected, sourceFingerprint: fingerprint, ...classifyDefinition(d, target, expected, registry) });
    } catch (error) { items.push({ ...expected, sourceFingerprint: fingerprint, action: 'REJECT', reason: reason(error) }); }
  }
  return { planVersion: 1, items };
}
function reconstruct(d: PrototypeDefinition, registry: WorkflowRegistry): void {
  reconstructWorkflow(d, registry, { save() {}, load() { return undefined; } });
}
/** Explicit apply entry. No deletion, replacement, job execution or automatic retry. */
export async function executeDefinitionMigration(
  plan: MigrationPlan, source: Pick<Repository, 'get'>, destination: Repository, registry: WorkflowRegistry
): Promise<MigrationResult> {
  if (plan?.planVersion !== 1 || !Array.isArray(plan.items)) throw new DefinitionError('INVALID_PLAN');
  const selected = keys(plan.items);
  // Snapshot caller-owned plan before the first await. Plans are trusted local artifacts, not authorization tokens.
  const items = plan.items.map((item, i) => {
    if (!['CREATE', 'ALREADY_EQUAL', 'CONFLICT', 'REJECT'].includes(item.action) ||
        (item.sourceFingerprint !== null && !/^[0-9a-f]{64}$/.test(item.sourceFingerprint))) throw new DefinitionError('INVALID_PLAN');
    return { ...selected[i], action: item.action, sourceFingerprint: item.sourceFingerprint };
  });
  const result: MigrationResult = { ok: true, items: [], stoppedAt: null };
  for (const [index, item] of items.entries()) {
    const outcome: MigrationResult['items'][number] = {
      definitionId: item.definitionId, definitionVersion: item.definitionVersion,
      sourceFingerprint: item.sourceFingerprint, status: 'FAILED', confirmedAdded: false
    };
    result.items.push(outcome);
    const stop = (status: typeof outcome.status, code?: string): MigrationResult => {
      outcome.status = status; if (code) outcome.reason = code;
      result.ok = false; result.stoppedAt = index; return result;
    };
    try {
      if (item.action === 'REJECT' || item.sourceFingerprint === null) return stop('REJECT', 'PLAN_REJECTED');
      const d = validated(await source.get(item.definitionId, item.definitionVersion), item);
      if (await definitionFingerprint(d) !== item.sourceFingerprint) return stop('SOURCE_CHANGED', 'SOURCE_CHANGED');
      const target = await destination.get(item.definitionId, item.definitionVersion);
      const current = classifyDefinition(d, target, item, registry);
      if (current.action === 'CONFLICT' || current.action === 'REJECT') return stop(current.action, current.reason);
      // Check actual factory results before publishing. Factories must have no business side effects.
      reconstruct(d, registry);
      if (current.action === 'ALREADY_EQUAL') {
        reconstruct(validated(target, item), registry); outcome.status = 'ALREADY_EQUAL'; continue;
      }
      try {
        await destination.add(validatePrototypeDefinition(d)); outcome.confirmedAdded = true;
      } catch (error) {
        const code = reason(error);
        if (code === 'DEFINITION_ALREADY_EXISTS') {
          const concurrent = await destination.get(item.definitionId, item.definitionVersion);
          const state = classifyDefinition(d, concurrent, item, registry);
          if (state.action !== 'ALREADY_EQUAL') return stop(state.action === 'CONFLICT' ? 'CONFLICT' : 'REJECT', state.reason || 'CONCURRENT_ADD_UNVERIFIED');
          reconstruct(validated(concurrent, item), registry); outcome.status = 'ALREADY_EQUAL'; continue;
        }
        // Unknown exceptions from a future adapter are not proof that a write failed.
        const declared = (error as { code?: unknown } | null)?.code;
        if (code === 'OUTCOME_UNKNOWN' || !knownReasons.has(String(declared))) {
          try { outcome.reconciliation = classifyDefinition(d, await destination.get(item.definitionId, item.definitionVersion), item, registry); }
          catch { outcome.reconciliation = { action: 'REJECT', reason: 'UNAVAILABLE' }; }
          return stop('OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN');
        }
        return stop('FAILED', code);
      }
      const after = validated(await destination.get(item.definitionId, item.definitionVersion), item);
      if (canonicalDefinition(after) !== canonicalDefinition(d)) return stop('FAILED', 'POST_CHECK_MISMATCH');
      reconstruct(after, registry); outcome.status = 'CREATED';
    } catch (error) { return stop('FAILED', reason(error)); }
  }
  return result;
}
