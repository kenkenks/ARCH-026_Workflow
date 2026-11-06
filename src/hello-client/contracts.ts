import type { HelloRecord, Revision, Stored } from '../hello/contracts';

export interface HelloApplicationClient {
  read(id: string): Promise<Stored<HelloRecord> | null>;
  add(record: HelloRecord): Promise<Stored<HelloRecord>>;
  write(record: HelloRecord, expectedRevision: Revision): Promise<Stored<HelloRecord>>;
}
export type HelloRequest =
  | { operation: 'read'; id: string }
  | { operation: 'add'; record: HelloRecord }
  | { operation: 'write'; record: HelloRecord; expectedRevision: Revision };
export const failureCodes = [
  'INVALID_ARGUMENT', 'VALIDATION_FAILED', 'NOT_FOUND', 'ALREADY_EXISTS', 'CONFLICT',
  'UNAUTHENTICATED', 'FORBIDDEN', 'UNAVAILABLE', 'OUTCOME_UNKNOWN',
  'SCHEMA_MISMATCH', 'DATA_CORRUPT', 'UNSUPPORTED_CONFIGURATION', 'INTERNAL',
] as const;
export type FailureCode = typeof failureCodes[number];
export interface Failure { code: FailureCode; issues?: { path: string; rule: string }[] }
export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };
export interface CredentialSource {
  getCredential(refresh: boolean): Promise<string | null>;
}
/** Public errors contain only a bounded code, never response bodies or underlying causes. */
export class CommunicationError extends Error {
  constructor(public readonly code: FailureCode) {
    super(code); this.name = 'CommunicationError'; delete this.stack;
  }
}
