import type { HelloRecord, Revision, Stored } from '../../hello/contracts';
import { CommunicationError, CredentialSource, HelloApplicationClient, HelloRequest } from '../../hello-client/contracts';
import { validateHelloRequest, validateHelloResult } from '../../hello-client/wire';

export const MAX_BODY_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export interface HttpClientOptions {
  endpoint?: string;
  timeoutMs?: number;
  fetchImpl?: (input: string, init: RequestInit) => Promise<Response>;
  credentialSource?: CredentialSource;
}
export function createHttpClient(options: HttpClientOptions = {}): HelloApplicationClient {
  const endpoint = options.endpoint ?? '/api/hello';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  try {
    const url = new URL(endpoint, 'http://relative.invalid');
    if ((!endpoint.startsWith('/') && !/^https?:\/\//.test(endpoint)) || endpoint.startsWith('//') ||
        !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/api/hello' ||
        url.search || url.hash || url.username || url.password) throw Error();
  } catch { throw new CommunicationError('UNSUPPORTED_CONFIGURATION'); }
  if (typeof fetchImpl !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new CommunicationError('UNSUPPORTED_CONFIGURATION');

  async function call(input: HelloRequest): Promise<Stored<HelloRecord> | null> {
    let request: HelloRequest;
    try { request = validateHelloRequest(input); }
    catch (error) {
      if (error instanceof CommunicationError) throw error;
      throw new CommunicationError('INVALID_ARGUMENT');
    }
    const body = JSON.stringify(request);
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new CommunicationError('INVALID_ARGUMENT');
    let sent = false;
    const controller = new AbortController();
    const transportError = () => new CommunicationError(sent && request.operation !== 'read' ? 'OUTCOME_UNKNOWN' : 'UNAVAILABLE');
    const invalidResponse = () => new CommunicationError(request.operation === 'read' ? 'INTERNAL' : 'OUTCOME_UNKNOWN');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    function stopReading() {
      // Cancellation is best effort: a rejecting or hanging cleanup must not replace the primary failure.
      try { void reader?.cancel().catch(() => {}); } catch { /* Preserve primary error. */ }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); stopReading(); reject(transportError()); }, timeoutMs);
    });
    const perform = async () => {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      try {
        const token = await options.credentialSource?.getCredential(false);
        if (token !== undefined && token !== null) {
          if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw Error();
          headers.set('Authorization', `Bearer ${token}`);
        }
      } catch { throw new CommunicationError('UNAVAILABLE'); }
      if (controller.signal.aborted) throw transportError();
      let response: Response, text: string;
      try {
        sent = true;
        response = await fetchImpl!(endpoint, {
          method: 'POST', headers, body, signal: controller.signal,
          redirect: 'error', credentials: 'omit', cache: 'no-store',
        });
      } catch { throw transportError(); }
      if (controller.signal.aborted) {
        try { void response.body?.cancel().catch(() => {}); } catch { /* Preserve timeout. */ }
        throw transportError();
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        reader = response.body?.getReader();
        if (reader) {
          while (true) {
            const chunk = await reader.read();
            if (controller.signal.aborted) throw transportError();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > MAX_BODY_BYTES) {
              stopReading(); controller.abort(); throw invalidResponse();
            }
            chunks.push(chunk.value);
          }
        }
      } catch (error) {
        stopReading();
        if (error instanceof CommunicationError) throw error;
        throw transportError();
      } finally {
        try { reader?.releaseLock(); } catch { /* Cleanup must not hide read errors. */ }
      }
      if (controller.signal.aborted) throw transportError();
      let result;
      try {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) throw Error();
        result = validateHelloResult(JSON.parse(text), request, response.status);
      } catch { throw invalidResponse(); }
      if (!result.ok) throw new CommunicationError(result.error.code);
      if (request.operation !== 'read' && (result.value === null ||
          result.value.record.id !== request.record.id || result.value.record.message !== request.record.message ||
          (request.operation === 'write' && result.value.revision === request.expectedRevision))) throw invalidResponse();
      return result.value;
    };
    try { return await Promise.race([perform(), deadline]); }
    finally { clearTimeout(timer); }
  }
  return {
    read: id => call({ operation: 'read', id }),
    add: record => call({ operation: 'add', record }) as Promise<Stored<HelloRecord>>,
    write: (record, expectedRevision) => call({ operation: 'write', record, expectedRevision }) as Promise<Stored<HelloRecord>>,
  };
}
