'use strict';
// Physical SQLite migrations stay at the adapter boundary, independent of the logical migrations.
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const {DatabaseSync,constants}=require('node:sqlite');
const {SimpleDB,SimpleDBError}=require('./database.cjs');
const {DATA_STORAGE_SCHEMA,DATA_STORAGE_SCHEMA_V1,DATA_REVISION_INDEX_SQL}=require('../data/simpledb.cjs');
const {STORAGE_SCHEMA}=require('../workflow-definition/simpledb.cjs');
const {validateDemoItem,validateDataRevision,validateDataId}=require('../../../dist/src/data/demo-item');
const {validatePrototypeDefinition}=require('../../../dist/src/prototype/definition');
function fail(code){throw new SimpleDBError(code);}
function hash(value){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function all(db,sql){return db.connection.prepare(sql).all();}
function schemaFingerprint(db){
  return hash(all(db,"SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
    .map(r=>({...r,sql:r.sql?.trim()??null})));
}
function expectedFingerprint(schema){
  const connection=new DatabaseSync(':memory:');
  try{connection.exec(schema.sql);return schemaFingerprint(new SimpleDB(connection));}finally{connection.close();}
}
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
function familyOf(registry,kind){
  if(!Object.hasOwn(registry,kind))fail('UNKNOWN_DB_KIND');
  const family=registry[kind],ids=new Set(),from=new Set();
  if(!Number.isSafeInteger(family.applicationId)||!family.versions||!Array.isArray(family.steps))fail('INVALID_REGISTRY');
  for(const [version,schema]of Object.entries(family.versions)){
    if(!Number.isSafeInteger(Number(version))||Number(version)<1||schema.version!==Number(version)||schema.applicationId!==family.applicationId)fail('INVALID_REGISTRY');
  }
  for(const step of family.steps){
    if(typeof step.id!=='string'||!step.id||ids.has(step.id)||from.has(step.from)||!Number.isSafeInteger(step.from)||!Number.isSafeInteger(step.to)||
      !family.versions[step.from]||!family.versions[step.to]||step.from>=step.to||
      typeof step.apply!=='function'||typeof step.verify!=='function')fail('INVALID_REGISTRY');
    if([step.apply,step.verify].some(fn=>fn.constructor.name==='AsyncFunction'))fail('ASYNC_MIGRATION_UNSUPPORTED');
    ids.add(step.id);from.add(step.from);
  }
  return family;
}
function observe(db,family){
  const applicationId=db.get('PRAGMA application_id').application_id,version=db.get('PRAGMA user_version').user_version;
  if(applicationId!==family.applicationId)fail('DB_KIND_MISMATCH');
  if(!Object.hasOwn(family.versions,version))fail('UNKNOWN_VERSION');
  const fingerprint=schemaFingerprint(db);
  if(fingerprint!==expectedFingerprint(family.versions[version]))fail('PHYSICAL_SCHEMA_MISMATCH');
  const checks=all(db,'PRAGMA quick_check');if(checks.length!==1||checks[0].quick_check!=='ok')fail('DATA_CORRUPT');
  const rows=all(db,family.rowsSQL);
  try{family.validateRows(rows);}catch{fail('DATA_CORRUPT');}
  const values=rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,ArrayBuffer.isView(v)?{blob:Buffer.from(v).toString('hex')}:v])));
  return Object.freeze({applicationId,version,schemaFingerprint:fingerprint,dataFingerprint:hash(values),recordCount:rows.length});
}
function openExisting(file,readOnly){
  let connection;
  try{
    fs.accessSync(file,readOnly?fs.constants.R_OK:fs.constants.R_OK|fs.constants.W_OK);
    connection=new DatabaseSync(file,{readOnly,timeout:100});
    return new SimpleDB(connection);
  }catch(error){if(connection)try{connection.close();}catch{};throw normalized(error);}
}
function normalized(error){
  if(error instanceof SimpleDBError)return error;
  return new SimpleDBError([11,26].includes(error?.errcode&255)?'DATA_CORRUPT':'UNAVAILABLE');
}
function closePreserving(db,primary){
  try{db.close();}catch(error){
    if(primary){primary.cleanupDiagnostics=[...(primary.cleanupDiagnostics||[]),'CLOSE_FAILED'];return primary;}
    const failure=normalized(error);failure.cleanupDiagnostics=['CLOSE_FAILED'];return failure;
  }
  return primary;
}
function pathFor(family,current,target){
  if(!Number.isSafeInteger(target)||!Object.hasOwn(family.versions,target))fail('UNKNOWN_VERSION');
  if(current>target)fail('DOWNGRADE_UNSUPPORTED');
  const steps=[];
  while(current<target){
    const step=family.steps.find(s=>s.from===current);
    if(!step||step.to>target)fail('MIGRATION_PATH_MISSING');
    steps.push(step);current=step.to;
  }
  return steps;
}
function registryFingerprint(family){
  return hash({versions:Object.entries(family.versions).sort(([a],[b])=>Number(a)-Number(b)).map(([v,s])=>[Number(v),expectedFingerprint(s)]),
    steps:family.steps.map(({id,from,to})=>({id,from,to})).sort((a,b)=>a.from-b.from)});
}
function bodyOf(plan){return {planVersion:plan.planVersion,kind:plan.kind,targetVersion:plan.targetVersion,registryFingerprint:plan.registryFingerprint,source:plan.source,steps:plan.steps};}
/** Read-only file connection. No journal/schema/version/data mutation. */
function planSchemaMigration(file,{kind,targetVersion},registry=SCHEMA_MIGRATION_REGISTRY){
  const family=familyOf(registry,kind),db=openExisting(file,true);let primary,plan;
  try{
    const source=observe(db,family),steps=pathFor(family,source.version,targetVersion).map(({id,from,to})=>({id,from,to}));
    const body={planVersion:1,kind,targetVersion,registryFingerprint:registryFingerprint(family),source,steps};plan={...body,planFingerprint:hash(body)};
  }catch(error){primary=normalized(error);}
  primary=closePreserving(db,primary);if(primary)throw primary;return plan;
}
// Migration callbacks receive scoped, synchronous SQL access only. Control statements
// and PRAGMA writes are reserved to the executor. This is not a sandbox for untrusted JS.
function callback(db,fn,args){
  let active=true,primary,result;
  const check=()=>{if(!active)fail('MIGRATION_CONTEXT_CLOSED');};
  const ctx=Object.freeze({exec(sql){check();db.connection.exec(sql);},get(sql){check();return db.get(sql);},all(sql){check();return all(db,sql);}});
  const denied=new Set([constants.SQLITE_TRANSACTION,constants.SQLITE_SAVEPOINT,constants.SQLITE_ATTACH,constants.SQLITE_DETACH]);
  db.connection.setAuthorizer((action,arg1,arg2)=>{
    if(denied.has(action))return constants.SQLITE_DENY;
    if(action===constants.SQLITE_PRAGMA){
      if(['user_version','application_id'].includes(arg1)&&arg2===null)return constants.SQLITE_OK;
      if(['table_info','table_xinfo','index_list','index_info','index_xinfo'].includes(arg1))return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
  try{
    result=fn(ctx,...args);
    if(result&&typeof result.then==='function'){
      Promise.resolve(result).catch(()=>{});fail('ASYNC_MIGRATION_UNSUPPORTED');
    }
  }catch(error){primary=normalized(error);}
  finally{
    active=false;
    try{db.connection.setAuthorizer(null);}catch{
      db.poisoned=true;
      if(!primary)primary=new SimpleDBError('UNAVAILABLE');
      primary.cleanupDiagnostics=[...(primary.cleanupDiagnostics||[]),'AUTHORIZER_RESET_FAILED'];
    }
  }
  if(primary)throw primary;return result;
}
function assertSource(current,source){
  if(current.applicationId!==source.applicationId)fail('DB_KIND_MISMATCH');
  if(current.version!==source.version)fail('VERSION_CHANGED');
  if(current.schemaFingerprint!==source.schemaFingerprint)fail('PHYSICAL_SCHEMA_MISMATCH');
  if(current.dataFingerprint!==source.dataFingerprint)fail('DATA_CHANGED');
}
/** Explicit apply. All steps and their user_version updates commit together for one DB. */
function executeSchemaMigration(file,input,registry=SCHEMA_MIGRATION_REGISTRY){
  let plan;try{plan=JSON.parse(JSON.stringify(input));}catch{fail('INVALID_PLAN');}
  if(plan?.planVersion!==1||hash(bodyOf(plan))!==plan.planFingerprint)fail('INVALID_PLAN');
  if(!plan.source||!Number.isSafeInteger(plan.source.version)||!Array.isArray(plan.steps)||
    !/^[0-9a-f]{64}$/.test(plan.source.schemaFingerprint)||!/^[0-9a-f]{64}$/.test(plan.source.dataFingerprint))fail('INVALID_PLAN');
  const family=familyOf(registry,plan.kind),steps=pathFor(family,plan.source.version,plan.targetVersion);
  if(registryFingerprint(family)!==plan.registryFingerprint)fail('REGISTRY_CHANGED');
  if(JSON.stringify(steps.map(({id,from,to})=>({id,from,to})))!==JSON.stringify(plan.steps))fail('REGISTRY_CHANGED');
  const db=openExisting(file,false);let primary,after,commitOutcome='NOT_ATTEMPTED';
  try{
    // Check metadata before full observation, so a changed version is reported explicitly.
    if(db.get('PRAGMA application_id').application_id!==family.applicationId)fail('DB_KIND_MISMATCH');
    if(db.get('PRAGMA user_version').user_version!==plan.source.version)fail('VERSION_CHANGED');
    assertSource(observe(db,family),plan.source);
    if(steps.length){
      commitOutcome='CONFIRMED_FAILURE';
      db.transaction(()=>{
        if(db.get('PRAGMA user_version').user_version!==plan.source.version)fail('VERSION_CHANGED');
        assertSource(observe(db,family),plan.source);
        for(const step of steps){
          const before=observe(db,family);
          callback(db,step.apply,[]);
          if(schemaFingerprint(db)!==expectedFingerprint(family.versions[step.to]))fail('POST_CHECK_FAILED');
          db.connection.exec(`PRAGMA user_version=${step.to}`);
          const current=observe(db,family);
          if(before.dataFingerprint!==current.dataFingerprint)fail('DATA_CHANGED');
          callback(db,step.verify,[before,current]);
          const verified=observe(db,family);
          if(verified.version!==step.to||verified.dataFingerprint!==before.dataFingerprint)fail('POST_CHECK_FAILED');
        }
      });
      commitOutcome='CONFIRMED_SUCCESS';
    }
    after=observe(db,family);
    if(after.version!==plan.targetVersion||after.dataFingerprint!==plan.source.dataFingerprint)fail('POST_CHECK_FAILED');
  }catch(error){primary=normalized(error);if(primary.code==='OUTCOME_UNKNOWN')commitOutcome='UNKNOWN';}
  primary=closePreserving(db,primary);
  const result={ok:!primary,status:primary?(primary.code==='OUTCOME_UNKNOWN'?'OUTCOME_UNKNOWN':'FAILED'):(steps.length?'APPLIED':'NO_OP'),
    kind:plan.kind,fromVersion:plan.source.version,toVersion:plan.targetVersion,planFingerprint:plan.planFingerprint,
    steps:plan.steps,commitOutcome,dataPreserved:after?after.dataFingerprint===plan.source.dataFingerprint:null};
  if(primary){
    result.code=primary.code;if(primary.cleanupDiagnostics)result.cleanupDiagnostics=primary.cleanupDiagnostics;
    // Fresh read-only connection after closing the potentially poisoned writer.
    try{
      const reconciled=planSchemaMigration(file,{kind:plan.kind,targetVersion:plan.targetVersion},registry).source;
      result.reconciliation={...reconciled,matchesSource:reconciled.version===plan.source.version&&reconciled.schemaFingerprint===plan.source.schemaFingerprint,
        matchesTarget:reconciled.version===plan.targetVersion&&reconciled.schemaFingerprint===expectedFingerprint(family.versions[plan.targetVersion]),
        dataPreserved:reconciled.dataFingerprint===plan.source.dataFingerprint};
    }catch(error){result.reconciliation={code:normalized(error).code};}
  }else result.after=after;
  return result;
}
module.exports={SCHEMA_MIGRATION_REGISTRY,planSchemaMigration,executeSchemaMigration};
