'use strict';
// ARCH-specific schemas and validators; the generic engine never imports this module.
const {SimpleDBError}=require('./database.cjs');
const {DATA_STORAGE_SCHEMA,DATA_STORAGE_SCHEMA_V1,DATA_REVISION_INDEX_SQL}=require('../data/simpledb.cjs');
const {STORAGE_SCHEMA}=require('../workflow-definition/simpledb.cjs');
const {validateDemoItem,validateDataRevision,validateDataId}=require('../../../dist/src/data/demo-item');
const {validatePrototypeDefinition}=require('../../../dist/src/prototype/definition');
function fail(code){throw new SimpleDBError(code);}
function validateDataRows(rows){
  for(const row of rows){
    const d=validateDemoItem(JSON.parse(row.record_json));validateDataRevision(row.revision);
    const collection=Buffer.from(row.collection).toString('utf8');validateDataId(collection);
    if(!Buffer.from(row.record_id).equals(Buffer.from(d.id))||!Buffer.from(collection).equals(Buffer.from(row.collection)))fail('DATA_CORRUPT');
  }
}
function validateDefinitionRows(rows){
  for(const row of rows){
    const d=validatePrototypeDefinition(JSON.parse(row.definition_json));
    if(!Buffer.from(row.definition_id).equals(Buffer.from(d.definitionId))||
       !Buffer.from(row.definition_version).equals(Buffer.from(d.definitionVersion))||row.schema_version!==d.schemaVersion)fail('DATA_CORRUPT');
  }
}
const dataStep=Object.freeze({id:'data-v1-v2-collection-revision-index',from:1,to:2,
  apply(ctx){ctx.exec(DATA_REVISION_INDEX_SQL);},
  verify(ctx,before,after){
    if(ctx.get('PRAGMA user_version').user_version!==2||before.dataFingerprint!==after.dataFingerprint)fail('POST_CHECK_FAILED');
    if(!ctx.all('PRAGMA index_list(data_records)').some(r=>r.name==='data_records_collection_revision'&&r.unique===0))fail('POST_CHECK_FAILED');
  }});
const SCHEMA_MIGRATION_REGISTRY=Object.freeze({
  data:Object.freeze({applicationId:DATA_STORAGE_SCHEMA.applicationId,
    versions:Object.freeze({1:DATA_STORAGE_SCHEMA_V1,2:DATA_STORAGE_SCHEMA}),steps:Object.freeze([dataStep]),
    rowsSQL:'SELECT * FROM data_records ORDER BY collection,record_id',validateRows:validateDataRows}),
  definition:Object.freeze({applicationId:STORAGE_SCHEMA.applicationId,versions:Object.freeze({1:STORAGE_SCHEMA}),steps:Object.freeze([]),
    rowsSQL:'SELECT * FROM workflow_definitions ORDER BY definition_id,definition_version',validateRows:validateDefinitionRows})
});
module.exports={SCHEMA_MIGRATION_REGISTRY};
