'use strict';
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

class SimpleDBError extends Error {
  constructor(code) { super(code); this.name = 'SimpleDBError'; this.code = code; }
}
function classify(error) {
  if (error instanceof SimpleDBError) return error;
  // SQLite extended result codes, not OS messages or SQL text.
  const code = error?.errcode;
  return new SimpleDBError(code === 1555 || code === 2067 ? 'ALREADY_EXISTS' :
    [11, 26].includes(code & 255) ? 'DATA_CORRUPT' : 'UNAVAILABLE');
}
class SimpleDB {
  constructor(connection) { this.connection = connection; this.closed = false; this.active = false; this.poisoned = false; }
  static initialize(file, schema) {
    let created = false, initialized = false, db;
    try {
      fs.closeSync(fs.openSync(file, 'wx')); created = true;
      db = new SimpleDB(new DatabaseSync(file));
      db.connection.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      db.transaction(() => {
        db.connection.exec(schema.sql);
        db.connection.exec(`PRAGMA application_id=${schema.applicationId}; PRAGMA user_version=${schema.version};`);
      });
      initialized = true;
      db.close();
    } catch (error) {
      const failure = error?.code === 'EEXIST' ? new SimpleDBError('ALREADY_EXISTS') : classify(error);
      const diagnostics = [];
      if (db && !db.closed) try { db.close(); } catch { diagnostics.push('CLOSE_FAILED'); }
      // Never remove committed storage, or storage whose transaction outcome is unknown.
      if (created && !initialized && failure.code !== 'OUTCOME_UNKNOWN' && (!db || db.closed))
        try { fs.unlinkSync(file); } catch { diagnostics.push('INITIALIZATION_FILE_CLEANUP_FAILED'); }
      if (diagnostics.length) failure.cleanupDiagnostics = diagnostics;
      throw failure;
    }
  }
  static open(file, schema, { timeout = 100 } = {}) {
    let db;
    try {
      if (!Number.isInteger(timeout) || timeout < 0) throw new SimpleDBError('UNAVAILABLE');
      fs.accessSync(file, fs.constants.R_OK | fs.constants.W_OK);
      db = new SimpleDB(new DatabaseSync(file, { timeout }));
      if (db.get('PRAGMA application_id').application_id !== schema.applicationId ||
          db.get('PRAGMA user_version').user_version !== schema.version)
        throw new SimpleDBError('STORAGE_SCHEMA_MISMATCH');
      db.connection.exec('PRAGMA synchronous=FULL;');
      return db;
    } catch (error) {
      const failure = classify(error);
      if (db) try { db.close(); } catch { failure.cleanupDiagnostics = ['CLOSE_FAILED']; }
      throw failure;
    }
  }
  assertOpen() { if (this.closed || this.poisoned) throw new SimpleDBError('UNAVAILABLE'); }
  get(sql, ...params) {
    try { this.assertOpen(); return this.connection.prepare(sql).get(...params); }
    catch (error) { throw classify(error); }
  }
  run(sql, ...params) {
    try { this.assertOpen(); return this.connection.prepare(sql).run(...params); }
    catch (error) { throw classify(error); }
  }
  transaction(action) {
    this.assertOpen();
    if (this.active) throw new SimpleDBError('UNAVAILABLE');
    let begun = false, committing = false;
    try {
      this.connection.exec('BEGIN IMMEDIATE'); begun = true; this.active = true;
      const result = action();
      if (result && typeof result.then === 'function') throw new SimpleDBError('UNAVAILABLE');
      committing = true; this.connection.exec('COMMIT'); begun = false;
      return result;
    } catch (error) {
      const failure = committing ? new SimpleDBError('OUTCOME_UNKNOWN') : classify(error);
      if (begun) try { this.connection.exec('ROLLBACK'); } catch {
        this.poisoned = true; failure.cleanupDiagnostics = ['ROLLBACK_FAILED'];
      }
      throw failure;
    } finally { this.active = false; }
  }
  close() {
    if (this.closed) return;
    try {
      if (this.active) throw new SimpleDBError('UNAVAILABLE');
      this.connection.close(); this.closed = true;
    } catch (error) { throw classify(error); }
  }
}
module.exports = { SimpleDB, SimpleDBError };
