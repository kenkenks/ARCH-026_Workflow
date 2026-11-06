import { HelloRecord, RepositoryError } from './contracts';
export const helloSchema = Object.freeze({
  id: 'hello-record', version: '1', idField: 'id', additionalProperties: false,
  fields: Object.freeze({
    id: Object.freeze({ type: 'string', required: true }),
    message: Object.freeze({ type: 'string', required: true }),
  }),
});
export function validateId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id))
    throw new RepositoryError('INVALID_ARGUMENT');
}
export function validateRecord(value: unknown): HelloRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !Object.hasOwn(value, 'id') ||
      !Object.hasOwn(value, 'message') || typeof (value as HelloRecord).message !== 'string')
    throw new RepositoryError('VALIDATION_FAILED');
  const record = value as HelloRecord;
  validateId(record.id);
  return { id: record.id, message: record.message };
}
export function validateRevision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value) throw new RepositoryError('INVALID_ARGUMENT');
}
