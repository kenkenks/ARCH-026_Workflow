'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { RepositoryError } = require('../../../dist/src/hello/contracts');
const { helloSchema, validateId, validateRecord, validateRevision } = require('../../../dist/src/hello/schema');
const fingerprint = createHash('sha256').update(JSON.stringify(helloSchema)).digest('hex');
function normalized(error, code = 'UNAVAILABLE') {
  return error instanceof RepositoryError ? error : new RepositoryError(code);
}
// Only bounded stage labels are public diagnostics; never attach raw I/O errors or paths.
function cleanupDiagnostic(error, stage) {
  if (!error.cleanupDiagnostics) error.cleanupDiagnostics = [];
  error.cleanupDiagnostics.push(stage);
}
function decode(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new RepositoryError('DATA_CORRUPT'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      Object.keys(data).sort().join(',') !== 'rows,schema' ||
      !data.schema || typeof data.schema !== 'object' ||
      Object.keys(data.schema).sort().join(',') !== 'fingerprint,id,version' ||
      !Array.isArray(data.rows)) throw new RepositoryError('DATA_CORRUPT');
  if (data.schema.id !== helloSchema.id || data.schema.version !== helloSchema.version ||
      data.schema.fingerprint !== fingerprint) throw new RepositoryError('SCHEMA_MISMATCH');
  const ids = new Set();
  try {
    for (const stored of data.rows) {
      if (!stored || Object.keys(stored).sort().join(',') !== 'record,revision') throw Error();
      validateRecord(stored.record); validateRevision(stored.revision);
      if (ids.has(stored.record.id)) throw Error(); ids.add(stored.record.id);
    }
  } catch { throw new RepositoryError('DATA_CORRUPT'); }
  return data;
}
async function openLocalFile(directory, io = fs) {
  // Canonical directory identity prevents alternate spellings/symlink aliases taking separate locks.
  let root;
  try {
    await io.mkdir(directory, { recursive: true });
    root = await io.realpath(directory);
  } catch { throw new RepositoryError('UNAVAILABLE'); }
  const lockPath = path.join(root, 'owner.lock');
  let lock;
  try { lock = await io.open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') {
      const failure = new RepositoryError('UNAVAILABLE'); failure.diagnostic = 'LOCK_PRESENT_NO_AUTOMATIC_RECOVERY'; throw failure;
    }
    throw new RepositoryError('UNAVAILABLE');
  }
  const file = path.join(root, 'records.json');
  let queue = Promise.resolve(), closing = false, closePromise, uncertain = false;
  async function release() {
    try { await lock.close(); }
    catch { const error = new RepositoryError('UNAVAILABLE'); cleanupDiagnostic(error, 'LOCK_CLOSE_FAILED'); throw error; }
    // Do not remove the ownership lock if its handle could not be closed.
    try { await io.unlink(lockPath); }
    catch { const error = new RepositoryError('UNAVAILABLE'); cleanupDiagnostic(error, 'LOCK_UNLINK_FAILED'); throw error; }
  }
  async function persist(data) {
    const temp = path.join(root, 'records.tmp-' + randomUUID());
    let handle, renameStarted = false;
    try {
      handle = await io.open(temp, 'wx');
      await handle.writeFile(JSON.stringify(data), 'utf8'); await handle.sync(); await handle.close(); handle = null;
      renameStarted = true; await io.rename(temp, file);
    } catch {
      const error = new RepositoryError(renameStarted ? 'OUTCOME_UNKNOWN' : 'UNAVAILABLE');
      if (handle) try { await handle.close(); } catch { cleanupDiagnostic(error, 'TEMP_CLOSE_FAILED'); }
      try { await io.unlink(temp); } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') cleanupDiagnostic(error, 'TEMP_UNLINK_FAILED');
      }
      if (renameStarted) uncertain = true;
      throw error;
    }
  }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID() })); await lock.sync();
    try { decode(await io.readFile(file, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Only a genuinely empty owned directory may be initialized. Never repair leftovers.
      if ((await io.readdir(root)).some(name => name !== 'owner.lock')) throw new RepositoryError('DATA_CORRUPT');
      await persist({ schema: { id: helloSchema.id, version: helloSchema.version, fingerprint }, rows: [] });
    }
  } catch (cause) {
    const error = normalized(cause);
    try { await release(); } catch (cleanupError) {
      for (const stage of cleanupError.cleanupDiagnostics || ['LOCK_RELEASE_FAILED']) cleanupDiagnostic(error, stage);
    }
    throw error;
  }
  function serial(operation) {
    if (closing) return Promise.reject(new RepositoryError('UNAVAILABLE'));
    const pending = queue.then(async () => {
      if (uncertain) throw new RepositoryError('OUTCOME_UNKNOWN');
      return operation();
    });
    queue = pending.catch(() => {}); return pending;
  }
  async function load() {
    try { return decode(await io.readFile(file, 'utf8')); }
    catch (error) { throw error instanceof RepositoryError ? error : new RepositoryError('UNAVAILABLE'); }
  }
  async function mutate(record, revision, add) {
    const data = await load(); const index = data.rows.findIndex(row => row.record.id === record.id);
    if (add && index >= 0) throw new RepositoryError('ALREADY_EXISTS');
    if (!add && index < 0) throw new RepositoryError('NOT_FOUND');
    if (!add && data.rows[index].revision !== revision) throw new RepositoryError('CONFLICT');
    const stored = { record, revision: randomUUID() };
    if (add) data.rows.push(stored); else data.rows[index] = stored;
    await persist(data); return structuredClone(stored);
  }
  return {
    port: {
      async read(id) { validateId(id); return serial(async () => (await load()).rows.find(row => row.record.id === id) || null); },
      async add(input) { const record = validateRecord(input); return serial(() => mutate(record, null, true)); },
      async write(input, revision) { const record = validateRecord(input); validateRevision(revision); return serial(() => mutate(record, revision, false)); },
    },
    close() { if (!closePromise) { closing = true; closePromise = queue.then(release); } return closePromise; },
  };
}
module.exports = { openLocalFile };
