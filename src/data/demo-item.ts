// Reuse the existing asynchronous read/add/CAS-write contract, without Hello validators.
import type { Repository, Stored, Revision } from '../hello/contracts';
export type { Stored, Revision };
export type DemoItem =
  | { id: string; schemaVersion: '1'; name: string; enabled: boolean }
  | { id: string; schemaVersion: '2'; label: string; enabled: boolean };
export type DataRepository = Repository<DemoItem> & { readonly collection: string };
export class DataError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'DataError'; }
}
export function validateDataId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new DataError('INVALID_ARGUMENT');
  try { encodeURIComponent(value); } catch { throw new DataError('INVALID_ARGUMENT'); }
}
export function validateDataRevision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value) throw new DataError('INVALID_ARGUMENT');
}
export function validateDemoItem(input: unknown): DemoItem {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DataError('VALIDATION_FAILED');
  const d = input as Record<string, unknown>;
  if (d.schemaVersion !== '1' && d.schemaVersion !== '2') throw new DataError('SCHEMA_MISMATCH');
  const field = d.schemaVersion === '1' ? 'name' : 'label';
  const fields = ['id', 'schemaVersion', field, 'enabled'];
  if (Reflect.ownKeys(d).length !== fields.length || !fields.every(f => Object.hasOwn(d, f)) ||
      typeof d[field] !== 'string' || typeof d.enabled !== 'boolean') throw new DataError('VALIDATION_FAILED');
  validateDataId(d.id);
  return d.schemaVersion === '1'
    ? { id: d.id, schemaVersion: '1', name: d.name as string, enabled: d.enabled }
    : { id: d.id, schemaVersion: '2', label: d.label as string, enabled: d.enabled };
}
export const DEMO_TRANSFORM = 'demo-name-to-label/1';
export function transformDemoItem(input: unknown, version: string): DemoItem {
  if (version !== DEMO_TRANSFORM) throw new DataError('UNKNOWN_TRANSFORM');
  const d = validateDemoItem(input);
  return d.schemaVersion === '1'
    ? { id: d.id, schemaVersion: '2', label: d.name, enabled: d.enabled }
    : d;
}
