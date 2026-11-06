import type { HelloRecord, Stored } from '../hello/contracts';
import { validateId, validateRecord, validateRevision } from '../hello/schema';
import { CommunicationError, failureCodes, HelloRequest, Result, FailureCode } from './contracts';

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function requestValue(value: unknown): HelloRequest {
  if (!object(value)) throw new CommunicationError('INVALID_ARGUMENT');
  if (value.operation === 'read' && keys(value, ['operation', 'id'])) {
    validateId(value.id); return { operation: 'read', id: value.id };
  }
  if (value.operation === 'add' && keys(value, ['operation', 'record'])) {
    return { operation: 'add', record: validateRecord(value.record) };
  }
  if (value.operation === 'write' && keys(value, ['operation', 'record', 'expectedRevision'])) {
    const record = validateRecord(value.record); validateRevision(value.expectedRevision);
    return { operation: 'write', record, expectedRevision: value.expectedRevision };
  }
  throw new CommunicationError('INVALID_ARGUMENT');
}
export function validateHelloRequest(value: unknown): HelloRequest {
  try { return requestValue(value); }
  catch (error) {
    // Shared Schema errors are translated rather than exposing their stack or arbitrary causes.
    if (error instanceof CommunicationError) throw error;
    throw new CommunicationError(
      object(error) && error.code === 'VALIDATION_FAILED' ? 'VALIDATION_FAILED' : 'INVALID_ARGUMENT',
    );
  }
}
export function statusMatches(code: FailureCode, status: number): boolean {
  switch (code) {
    case 'INVALID_ARGUMENT': return [400, 405, 413, 415].includes(status);
    case 'VALIDATION_FAILED': return status === 400;
    case 'UNAUTHENTICATED': return status === 401;
    case 'FORBIDDEN': return status === 403;
    case 'NOT_FOUND': return status === 404;
    case 'ALREADY_EXISTS': case 'CONFLICT': return status === 409;
    case 'UNAVAILABLE': case 'OUTCOME_UNKNOWN': return status === 503;
    default: return status === 500;
  }
}
/** Reject malformed or contradictory results; the HTTP adapter assigns operation-specific certainty. */
export function validateHelloResult(value: unknown, request: HelloRequest, status: number): Result<Stored<HelloRecord> | null> {
  const invalid = () => new CommunicationError('INTERNAL');
  if (!object(value)) throw invalid();
  if (value.ok === false && keys(value, ['ok', 'error']) && object(value.error)) {
    const error = value.error;
    if (!keys(error, error.issues === undefined ? ['code'] : ['code', 'issues']) ||
        !failureCodes.includes(error.code as FailureCode) || !statusMatches(error.code as FailureCode, status)) throw invalid();
    if (error.issues !== undefined && (!Array.isArray(error.issues) || error.issues.some(issue =>
      !object(issue) || !keys(issue, ['path', 'rule']) || typeof issue.path !== 'string' || typeof issue.rule !== 'string'))) throw invalid();
    // Remote messages/issues are not copied into public client errors.
    return { ok: false, error: { code: error.code as FailureCode } };
  }
  if (value.ok !== true || !keys(value, ['ok', 'value']) || status !== 200) throw invalid();
  if (value.value === null) {
    if (request.operation !== 'read') throw invalid();
    return { ok: true, value: null };
  }
  if (!object(value.value) || !keys(value.value, ['record', 'revision'])) throw invalid();
  try {
    const record = validateRecord(value.value.record); validateRevision(value.value.revision);
    if (record.id !== (request.operation === 'read' ? request.id : request.record.id)) throw invalid();
    return { ok: true, value: { record, revision: value.value.revision } };
  } catch { throw invalid(); }
}
