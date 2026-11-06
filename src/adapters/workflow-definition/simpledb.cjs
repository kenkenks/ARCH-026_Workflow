'use strict';
const { SimpleDB } = require('../simpledb/database.cjs');
const { validatePrototypeDefinition, validateDefinitionKey, DefinitionError } = require('../../../dist/src/prototype/definition');
const STORAGE_SCHEMA = Object.freeze({
  applicationId: 0x41524348, version: 1,
  sql: `CREATE TABLE workflow_definitions (
    definition_id BLOB NOT NULL,
    definition_version BLOB NOT NULL,
    schema_version TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    PRIMARY KEY (definition_id, definition_version)
  ) STRICT;`
});
function failure(error) {
  const result = new DefinitionError(error.code === 'ALREADY_EXISTS' ? 'DEFINITION_ALREADY_EXISTS' :
    ['DATA_CORRUPT', 'STORAGE_SCHEMA_MISMATCH', 'OUTCOME_UNKNOWN'].includes(error.code) ? error.code : 'UNAVAILABLE');
  if (error.cleanupDiagnostics) result.cleanupDiagnostics = [...error.cleanupDiagnostics];
  return result;
}
/** Composition owns the SimpleDB connection; this repository never closes it. */
class SimpleDBWorkflowDefinitionRepository {
  constructor(database) { this.database = database; }
  async add(input) {
    const d = validatePrototypeDefinition(input);
    try {
      this.database.transaction(() => this.database.run(
        'INSERT INTO workflow_definitions VALUES (?, ?, ?, ?)',
        Buffer.from(d.definitionId, 'utf8'), Buffer.from(d.definitionVersion, 'utf8'),
        d.schemaVersion, JSON.stringify(d)));
    } catch (error) { throw failure(error); }
  }
  async get(id, version) {
    validateDefinitionKey(id); validateDefinitionKey(version);
    let row;
    try { row = this.database.get('SELECT * FROM workflow_definitions WHERE definition_id=? AND definition_version=?', Buffer.from(id, 'utf8'), Buffer.from(version, 'utf8')); }
    catch (error) { throw failure(error); }
    if (!row) return null;
    let raw;
    try { raw = JSON.parse(row.definition_json); } catch { throw new DefinitionError('DATA_CORRUPT'); }
    if (raw === null) throw new DefinitionError('DATA_CORRUPT');
    const d = validatePrototypeDefinition(raw);
    if (row.schema_version !== d.schemaVersion) throw new DefinitionError('SCHEMA_MISMATCH');
    if (d.definitionId !== id || d.definitionVersion !== version ||
        !Buffer.from(row.definition_id).equals(Buffer.from(d.definitionId)) ||
        !Buffer.from(row.definition_version).equals(Buffer.from(d.definitionVersion)))
      throw new DefinitionError('DEFINITION_IDENTITY_MISMATCH');
    return d;
  }
}
module.exports = { SimpleDBWorkflowDefinitionRepository, STORAGE_SCHEMA, SimpleDB };
