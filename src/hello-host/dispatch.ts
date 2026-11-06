import type { HelloApplicationClient, HelloRequest, FailureCode, Result } from '../hello-client/contracts';
import type { HelloRecord, Stored } from '../hello/contracts';
import { CommunicationError, failureCodes } from '../hello-client/contracts';
import { validateHelloRequest, validateHelloResult } from '../hello-client/wire';

export interface Principal { role: 'reader' | 'writer' }
export type CredentialVerifier = (credential: string | null) => Promise<Principal | null>;
export type AuthorizationPolicy = (principal: Principal, request: HelloRequest) => boolean | Promise<boolean>;
export type HelloResult = Result<Stored<HelloRecord> | null>;
export interface DispatchInput { credential: string | null; payload: unknown }
export type ApplicationDispatch = (input: DispatchInput) => Promise<HelloResult>;
export const operationPolicy: AuthorizationPolicy = (principal, request) =>
  principal.role === 'writer' || (principal.role === 'reader' && request.operation === 'read');
export function developmentVerifier(mode: 'anonymous' | 'fake'): CredentialVerifier {
  return async credential => mode === 'anonymous' ? { role: 'writer' } :
    credential === 'fixture-reader' ? { role: 'reader' } :
    credential === 'fixture-writer' ? { role: 'writer' } : null;
}
export function failureResult(code: FailureCode): HelloResult { return { ok: false, error: { code } }; }
export function createDispatch(core: HelloApplicationClient, verify: CredentialVerifier, authorize: AuthorizationPolicy): ApplicationDispatch {
  return async ({ credential, payload }) => {
    let principal: Principal | null;
    try { principal = await verify(credential); }
    catch { return failureResult('UNAUTHENTICATED'); }
    if (!principal) return failureResult('UNAUTHENTICATED');
    let request: HelloRequest;
    try { request = validateHelloRequest(payload); }
    catch (error) { return failureResult(error instanceof CommunicationError ? error.code : 'INVALID_ARGUMENT'); }
    try { if (!await authorize(principal, request)) return failureResult('FORBIDDEN'); }
    catch { return failureResult('FORBIDDEN'); }
    try {
      const value = request.operation === 'read' ? await core.read(request.id) :
        request.operation === 'add' ? await core.add(request.record) :
        await core.write(request.record, request.expectedRevision);
      // Validate the application boundary too, without serializing Error objects or metadata.
      let result: HelloResult;
      try { result = validateHelloResult({ ok: true, value }, request, 200); }
      catch { return failureResult(request.operation === 'read' ? 'INTERNAL' : 'OUTCOME_UNKNOWN'); }
      if (result.ok && request.operation !== 'read' && (result.value === null ||
          result.value.record.message !== request.record.message ||
          (request.operation === 'write' && result.value.revision === request.expectedRevision)))
        return failureResult('OUTCOME_UNKNOWN');
      return result;
    } catch (error) {
      // Unknown exceptions after entering a mutation cannot prove that it was not saved.
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      return failureResult(failureCodes.includes(code as FailureCode) ? code as FailureCode :
        request.operation === 'read' ? 'INTERNAL' : 'OUTCOME_UNKNOWN');
    }
  };
}
