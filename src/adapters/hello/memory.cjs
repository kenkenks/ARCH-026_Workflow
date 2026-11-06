'use strict';
const { randomUUID } = require('node:crypto');
const { RepositoryError } = require('../../../dist/src/hello/contracts');
const { validateId, validateRecord, validateRevision } = require('../../../dist/src/hello/schema');
const copy = value => value === null ? null : structuredClone(value);
function openMemory() {
  const rows = new Map(); let closed = false;
  function ready() { if (closed) throw new RepositoryError('UNAVAILABLE'); }
  const port = {
    async read(id) { validateId(id); ready(); return copy(rows.get(id) || null); },
    async add(input) {
      const record = validateRecord(input); ready();
      if (rows.has(record.id)) throw new RepositoryError('ALREADY_EXISTS');
      const stored = { record, revision: randomUUID() }; rows.set(record.id, stored); return copy(stored);
    },
    async write(input, revision) {
      const record = validateRecord(input); validateRevision(revision); ready();
      const old = rows.get(record.id);
      if (!old) throw new RepositoryError('NOT_FOUND');
      if (old.revision !== revision) throw new RepositoryError('CONFLICT');
      const stored = { record, revision: randomUUID() }; rows.set(record.id, stored); return copy(stored);
    },
  };
  return { port, async close() { closed = true; } };
}
module.exports = { openMemory };
