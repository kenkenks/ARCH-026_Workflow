'use strict';
const {randomUUID}=require('node:crypto');
const {SimpleDB,SimpleDBError}=require('../simpledb/database.cjs');
const {DataError,validateDataId,validateDataRevision,validateDemoItem}=require('../../../dist/src/data/demo-item');
// A separate database family, NOT an upgrade of the Workflow Definition database.
const DATA_STORAGE_SCHEMA_V1=Object.freeze({applicationId:0x41524441,version:1,sql:`
CREATE TABLE data_records (
  collection BLOB NOT NULL, record_id BLOB NOT NULL,
  record_json TEXT NOT NULL, revision TEXT NOT NULL CHECK(length(revision)>0),
  PRIMARY KEY(collection,record_id)
) STRICT;`});
const DATA_REVISION_INDEX_SQL='CREATE INDEX data_records_collection_revision ON data_records(collection,revision);';
const DATA_STORAGE_SCHEMA=Object.freeze({applicationId:DATA_STORAGE_SCHEMA_V1.applicationId,version:2,
  migrationFromVersions:Object.freeze([1]),sql:DATA_STORAGE_SCHEMA_V1.sql+'\n'+DATA_REVISION_INDEX_SQL});
const codes=new Set(['ALREADY_EXISTS','NOT_FOUND','CONFLICT','DATA_CORRUPT','SCHEMA_MISMATCH','VALIDATION_FAILED','INVALID_ARGUMENT','OUTCOME_UNKNOWN','STORAGE_SCHEMA_MISMATCH']);
function normalize(error){
  const e=new DataError(codes.has(error?.code)?error.code:'UNAVAILABLE');
  if(error?.cleanupDiagnostics)e.cleanupDiagnostics=[...error.cleanupDiagnostics];
  return e;
}
/** Composition owns connection lifetime. This adapter is scoped to one logical collection. */
class SimpleDBDataRepository {
  constructor(database,collection){validateDataId(collection);this.database=database;this.collection=collection;}
  params(id){return [Buffer.from(this.collection,'utf8'),Buffer.from(id,'utf8')];}
  decode(row,id){
    if(!row)return null;
    let raw;try{raw=JSON.parse(row.record_json);}catch{throw new DataError('DATA_CORRUPT');}
    let record;
    try{record=validateDemoItem(raw);validateDataRevision(row.revision);}
    catch(error){throw new DataError(error.code==='SCHEMA_MISMATCH'?'SCHEMA_MISMATCH':'DATA_CORRUPT');}
    if(record.id!==id||!Buffer.from(row.collection).equals(Buffer.from(this.collection))||
       !Buffer.from(row.record_id).equals(Buffer.from(id)))throw new DataError('DATA_CORRUPT');
    return {record,revision:row.revision};
  }
  async read(id){
    validateDataId(id);
    try{return this.decode(this.database.get('SELECT * FROM data_records WHERE collection=? AND record_id=?',...this.params(id)),id);}
    catch(error){throw normalize(error);}
  }
  async add(input){
    const record=validateDemoItem(input),revision=randomUUID();
    try{return this.database.transaction(()=>{
      this.database.run('INSERT INTO data_records VALUES (?,?,?,?)',...this.params(record.id),JSON.stringify(record),revision);
      return {record:validateDemoItem(record),revision};
    });}catch(error){throw normalize(error);}
  }
  async write(input,expectedRevision){
    const record=validateDemoItem(input);validateDataRevision(expectedRevision);
    const revision=randomUUID();
    try{return this.database.transaction(()=>{
      const old=this.database.get('SELECT * FROM data_records WHERE collection=? AND record_id=?',...this.params(record.id));
      if(!old)throw new SimpleDBError('NOT_FOUND');
      // Refuse to overwrite corrupt data, even when a caller knows its revision.
      try{this.decode(old,record.id);}catch(error){throw new SimpleDBError(normalize(error).code);}
      if(old.revision!==expectedRevision)throw new SimpleDBError('CONFLICT');
      const changed=this.database.run('UPDATE data_records SET record_json=?,revision=? WHERE collection=? AND record_id=? AND revision=?',JSON.stringify(record),revision,...this.params(record.id),expectedRevision);
      if(changed.changes!==1)throw new SimpleDBError('CONFLICT');
      return {record:validateDemoItem(record),revision};
    });}catch(error){throw normalize(error);}
  }
}
module.exports={SimpleDBDataRepository,DATA_STORAGE_SCHEMA,DATA_STORAGE_SCHEMA_V1,DATA_REVISION_INDEX_SQL,SimpleDB};
