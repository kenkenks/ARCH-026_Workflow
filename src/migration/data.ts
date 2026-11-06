import { DataError, validateDataId, validateDataRevision, validateDemoItem, transformDemoItem } from '../data/demo-item';
import type { DataRepository, DemoItem, Stored } from '../data/demo-item';

export type DataAction = 'CREATE' | 'UPDATE' | 'NO_OP' | 'CONFLICT' | 'REJECT';
export interface State { revision: string; fingerprint: string }
export interface DataSelection { id: string; allowUpdate: boolean; expectedTarget: State | null }
export interface DataManifest {
  manifestVersion: 1; migrationId: string; collection: string; transformVersion: string; items: DataSelection[];
}
export interface DataPlanItem {
  id: string; action: DataAction; reason?: string;
  source: State | null; target: State | null; outputFingerprint: string | null;
}
export interface DataPlan { planVersion: 1; manifest: DataManifest; items: DataPlanItem[]; planFingerprint: string }
export interface DataItemResult {
  id: string; transformVersion: string;
  sourceRevision: string | null; targetRevisionBefore: string | null; targetRevisionAfter: string | null;
  status: DataAction | 'CREATED' | 'UPDATED' | 'FAILED' | 'SOURCE_CHANGED' | 'TARGET_CHANGED' | 'OUTCOME_UNKNOWN';
  writeOutcome: 'NOT_ATTEMPTED' | 'CONFIRMED_SUCCESS' | 'CONFIRMED_FAILURE' | 'UNKNOWN';
  verified: boolean; reason?: string; journalFailed?: boolean;
  reconciliation?: { state: State | null; matchesExpected: boolean };
}
export interface DataRunResult {
  migrationId: string; runId: string; planFingerprint: string;
  ok: boolean; items: DataItemResult[]; stoppedAt: number | null; unprocessedIds: string[];
  reason?: string;
}
export interface JournalEvent {
  eventVersion: 1; phase: 'PLAN' | 'INTENT' | 'RESULT' | 'SUMMARY'; migrationId: string; runId: string;
  planFingerprint: string; collection: string; index: number; item: DataPlan | DataPlanItem | DataItemResult | DataRunResult;
}
export interface MigrationJournal { append(event: JournalEvent): Promise<void> }
type Reader = Pick<DataRepository, 'read' | 'collection'>;
const errors = new Set(['INVALID_ARGUMENT', 'VALIDATION_FAILED', 'SCHEMA_MISMATCH', 'DATA_CORRUPT',
  'UNKNOWN_TRANSFORM', 'ALREADY_EXISTS', 'NOT_FOUND', 'CONFLICT', 'UNAVAILABLE', 'OUTCOME_UNKNOWN', 'STORAGE_SCHEMA_MISMATCH']);
function code(error: unknown): string {
  const value = (error as { code?: unknown } | null)?.code;
  return typeof value === 'string' && errors.has(value) ? value : 'UNAVAILABLE';
}
function canonical(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]));
  throw new DataError('INVALID_ARGUMENT');
}
async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
  return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}
export async function dataFingerprint(record: unknown): Promise<string> { return digest(validateDemoItem(record)); }
function validState(input: State | null): void {
  if (input === null) return;
  if (!input || typeof input !== 'object') throw new DataError('INVALID_ARGUMENT');
  validateDataRevision(input.revision);
  if (typeof input.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(input.fingerprint)) throw new DataError('INVALID_ARGUMENT');
}
function manifestCopy(input: DataManifest): DataManifest {
  if (input?.manifestVersion !== 1 || !Array.isArray(input.items)) throw new DataError('INVALID_MANIFEST');
  validateDataId(input.migrationId); validateDataId(input.collection); validateDataId(input.transformVersion);
  const seen = new Set<string>();
  const items = input.items.map(item => {
    validateDataId(item?.id);
    if (seen.has(item.id)) throw new DataError('DUPLICATE_MANIFEST_TARGET');
    seen.add(item.id); validState(item.expectedTarget);
    if (typeof item.allowUpdate !== 'boolean') throw new DataError('INVALID_MANIFEST');
    return { id: item.id, allowUpdate: item.allowUpdate, expectedTarget: item.expectedTarget === null ? null : { ...item.expectedTarget } };
  });
  return { manifestVersion: 1, migrationId: input.migrationId, collection: input.collection, transformVersion: input.transformVersion, items };
}
function bound(manifest: DataManifest, source: Reader, target: Reader): void {
  if (source.collection !== manifest.collection || target.collection !== manifest.collection) throw new DataError('COLLECTION_MISMATCH');
}
async function observe(value: Stored<DemoItem> | null, id: string): Promise<{ record: DemoItem | null; state: State | null }> {
  if (value === null) return { record: null, state: null };
  if (!value || typeof value !== 'object') throw new DataError('DATA_CORRUPT');
  const record = validateDemoItem(value.record); validateDataRevision(value.revision);
  if (record.id !== id) throw new DataError('DATA_CORRUPT');
  return { record, state: { revision: value.revision, fingerprint: await dataFingerprint(record) } };
}
function same(a: State | null, b: State | null): boolean {
  return a === null || b === null ? a === b : a.revision === b.revision && a.fingerprint === b.fingerprint;
}
/** Pure classification: transformations and fingerprints only, no repository writes. */
export async function classifyData(
  source: Stored<DemoItem> | null, target: Stored<DemoItem> | null, selection: DataSelection, transformVersion: string
): Promise<{ action: DataAction; reason?: string }> {
  try {
    validateDataId(selection.id);
    if (typeof selection.allowUpdate !== 'boolean') throw new DataError('INVALID_ARGUMENT');
    validState(selection.expectedTarget);
    const src = await observe(source, selection.id), dst = await observe(target, selection.id);
    if (!src.record) return { action: 'REJECT', reason: 'SOURCE_NOT_FOUND' };
    const expected = await dataFingerprint(transformDemoItem(src.record, transformVersion));
    if (dst.state === null) return selection.expectedTarget === null
      ? { action: 'CREATE' } : { action: 'CONFLICT', reason: 'EXPECTED_TARGET_MISSING' };
    if (dst.state.fingerprint === expected) return { action: 'NO_OP' };
    if (!selection.allowUpdate) return { action: 'CONFLICT', reason: 'UPDATE_NOT_ALLOWED' };
    return same(dst.state, selection.expectedTarget)
      ? { action: 'UPDATE' } : { action: 'CONFLICT', reason: 'EXPECTED_TARGET_MISMATCH' };
  } catch (error) { return { action: 'REJECT', reason: code(error) }; }
}
/** Dry Run: read-only ports and no journal writes. */
export async function planDataMigration(input: DataManifest, source: Reader, target: Reader): Promise<DataPlan> {
  const manifest = manifestCopy(input); bound(manifest, source, target);
  const items: DataPlanItem[] = [];
  for (const selection of manifest.items) {
    const item: DataPlanItem = { id: selection.id, action: 'REJECT', source: null, target: null, outputFingerprint: null };
    try {
      const src = await source.read(selection.id), dst = await target.read(selection.id);
      const observed = await observe(src, selection.id); item.source = observed.state;
      item.target = (await observe(dst, selection.id)).state;
      if (observed.record) item.outputFingerprint = await dataFingerprint(transformDemoItem(observed.record, manifest.transformVersion));
      Object.assign(item, await classifyData(src, dst, selection, manifest.transformVersion));
    } catch (error) { item.reason = code(error); }
    items.push(item);
  }
  const body = { planVersion: 1 as const, manifest, items };
  return { ...body, planFingerprint: await digest(body) };
}
/** Explicit apply: caller owns repositories and the append-only journal. */
export async function executeDataMigration(
  input: DataPlan, source: Reader, target: DataRepository, runId: string, journal: MigrationJournal
): Promise<DataRunResult> {
  validateDataId(runId);
  // Snapshot before awaiting and reject modified/truncated plans before any I/O or journal event.
  let plan: DataPlan;
  try { plan = JSON.parse(JSON.stringify(input)) as DataPlan; } catch { throw new DataError('INVALID_PLAN'); }
  if (plan?.planVersion !== 1 || !Array.isArray(plan.items)) throw new DataError('INVALID_PLAN');
  const { planFingerprint, ...body } = plan;
  if (await digest(body) !== planFingerprint) throw new DataError('INVALID_PLAN');
  const manifest = manifestCopy(plan.manifest); bound(manifest, source, target);
  if (plan.items.length !== manifest.items.length) throw new DataError('INVALID_PLAN');
  for (const [i, item] of plan.items.entries()) {
    if (item.id !== manifest.items[i].id || !['CREATE', 'UPDATE', 'NO_OP', 'CONFLICT', 'REJECT'].includes(item.action)) throw new DataError('INVALID_PLAN');
    validState(item.source); validState(item.target);
  }
  const result: DataRunResult = { migrationId: manifest.migrationId, runId, planFingerprint, ok: true, items: [], stoppedAt: null, unprocessedIds: [] };
  const event = (phase: JournalEvent['phase'], index: number, item: JournalEvent['item']): JournalEvent =>
    JSON.parse(JSON.stringify({ eventVersion: 1, phase, migrationId: manifest.migrationId, runId, planFingerprint, collection: manifest.collection, index, item }));
  try { await journal.append(event('PLAN', -1, plan)); }
  catch {
    return { ...result, ok: false, reason: 'JOURNAL_UNAVAILABLE', stoppedAt: plan.items.length ? 0 : null, unprocessedIds: plan.items.map(x => x.id) };
  }
  for (const [index, item] of plan.items.entries()) {
    const row: DataItemResult = { id: item.id, transformVersion: manifest.transformVersion,
      sourceRevision: item.source?.revision ?? null, targetRevisionBefore: item.target?.revision ?? null, targetRevisionAfter: null,
      status: 'FAILED', writeOutcome: 'NOT_ATTEMPTED', verified: false };
    result.items.push(row);
    const fail = (status: DataItemResult['status'], reason: string): void => { row.status = status; row.reason = reason; };
    let intentRecorded = false;
    try {
      await journal.append(event('INTENT', index, item)); intentRecorded = true;
      if (item.action === 'REJECT' || item.action === 'CONFLICT' || item.source === null) fail(item.action === 'CONFLICT' ? 'CONFLICT' : 'REJECT', item.reason || 'PLAN_REJECTED');
      else {
        const src = await observe(await source.read(item.id), item.id);
        const dst = await observe(await target.read(item.id), item.id);
        if (!same(src.state, item.source)) fail('SOURCE_CHANGED', 'SOURCE_CHANGED');
        else if (!same(dst.state, item.target)) fail('TARGET_CHANGED', 'TARGET_CHANGED');
        else {
          const desired = transformDemoItem(src.record, manifest.transformVersion);
          if (await dataFingerprint(desired) !== item.outputFingerprint) fail('REJECT', 'TRANSFORM_CHANGED');
          else {
            const current = await classifyData(src.record && src.state ? {record: src.record, revision: src.state.revision} : null,
              dst.record && dst.state ? {record: dst.record, revision: dst.state.revision} : null, manifest.items[index], manifest.transformVersion);
            if (current.action === 'CONFLICT' || current.action === 'REJECT') fail(current.action, current.reason || 'REJECT');
            else if (current.action === 'NO_OP') { row.status = 'NO_OP'; row.verified = true; row.targetRevisionAfter = dst.state!.revision; }
            else {
              let stored: Stored<DemoItem> | undefined;
              try {
                stored = current.action === 'CREATE' ? await target.add(desired) : await target.write(desired, item.target!.revision);
                row.writeOutcome = 'CONFIRMED_SUCCESS';
              } catch (error) {
                const declared = (error as { code?: unknown } | null)?.code;
                if (declared === 'OUTCOME_UNKNOWN' || !errors.has(String(declared))) {
                  row.writeOutcome = 'UNKNOWN'; fail('OUTCOME_UNKNOWN', 'OUTCOME_UNKNOWN');
                  try {
                    const state = (await observe(await target.read(item.id), item.id)).state;
                    row.reconciliation = { state, matchesExpected: state?.fingerprint === item.outputFingerprint };
                  } catch { /* Read failure is not evidence of a definite write failure. */ }
                } else { row.writeOutcome = 'CONFIRMED_FAILURE'; fail(['CONFLICT', 'ALREADY_EXISTS', 'NOT_FOUND'].includes(code(error)) ? 'CONFLICT' : 'FAILED', code(error)); }
              }
              if (row.writeOutcome === 'CONFIRMED_SUCCESS') {
                const returned = await observe(stored!, item.id);
                row.targetRevisionAfter = returned.state?.revision ?? null;
                const after = await observe(await target.read(item.id), item.id);
                if (!returned.state || returned.state.fingerprint !== item.outputFingerprint ||
                    (current.action === 'UPDATE' && returned.state.revision === item.target!.revision) || !same(after.state, returned.state))
                  fail('FAILED', 'POST_CHECK_MISMATCH');
                else { row.status = current.action === 'CREATE' ? 'CREATED' : 'UPDATED'; row.verified = true; }
              }
            }
          }
        }
      }
    } catch (error) { fail('FAILED', intentRecorded ? code(error) : 'JOURNAL_UNAVAILABLE'); }
    if (intentRecorded) try { await journal.append(event('RESULT', index, row)); }
    catch { row.journalFailed = true; }
    if (!['CREATED', 'UPDATED', 'NO_OP'].includes(row.status) || row.journalFailed) {
      result.ok = false; result.stoppedAt = index;
      result.unprocessedIds = plan.items.slice(index + 1).map(x => x.id); break;
    }
  }
  try { await journal.append(event('SUMMARY', -1, result)); }
  catch { result.ok = false; result.reason = 'JOURNAL_UNAVAILABLE'; }
  return result;
}
