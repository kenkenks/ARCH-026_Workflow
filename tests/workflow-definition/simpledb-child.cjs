'use strict';
const { SimpleDB, STORAGE_SCHEMA, SimpleDBWorkflowDefinitionRepository } = require('../../src/adapters/workflow-definition/simpledb.cjs');
const { definition } = require('./fixture.cjs');
const db = SimpleDB.open(process.argv[3], STORAGE_SCHEMA, {timeout: 2000});
const repo = new SimpleDBWorkflowDefinitionRepository(db);
async function perform() {
  try {
    if (process.argv[2] === 'read') console.log(JSON.stringify(await repo.get('saved-example', 'v1')));
    else { try { await repo.add(definition()); process.send('ADDED'); } catch(e) { process.send(e.code); } }
  } finally { db.close(); if (process.connected) process.disconnect(); }
}
if (process.argv[2] === 'race') { process.on('message', () => perform().catch(() => {process.exitCode=1;})); process.send('READY'); }
else perform().catch(() => {process.exitCode=1;});
