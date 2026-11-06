'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {SimpleDB,SimpleDBError}=require('../src/adapters/simpledb/database.cjs');
const {DATA_STORAGE_SCHEMA,DATA_STORAGE_SCHEMA_V1,DATA_REVISION_INDEX_SQL,SimpleDBDataRepository}=require('../src/adapters/data/simpledb.cjs');
const {STORAGE_SCHEMA,SimpleDBWorkflowDefinitionRepository}=require('../src/adapters/workflow-definition/simpledb.cjs');
const {SCHEMA_MIGRATION_REGISTRY:registry,planSchemaMigration:plan,executeSchemaMigration:execute}=require('../src/adapters/simpledb/schema-migration.cjs');
const {DEMO_TRANSFORM}=require('../dist/src/data/demo-item');
const {planDataMigration,executeDataMigration}=require('../dist/src/migration/data');
const {definition}=require('./workflow-definition/fixture.cjs');
const oldRecord={id:'a',schemaVersion:'1',name:'unchanged',enabled:true};
async function temporary(action){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-schema-')),connections=[];
  function create(name='data',schema=DATA_STORAGE_SCHEMA_V1){const file=path.join(dir,name+'.sqlite');SimpleDB.initialize(file,schema);return file;}
  function open(file,schema=DATA_STORAGE_SCHEMA_V1){const db=SimpleDB.open(file,schema);connections.push(db);return db;}
  try{await action({dir,create,open});}finally{for(const db of connections)db.close();fs.rmSync(dir,{recursive:true,force:true});}
}
function changedStep(change){return {...registry,data:{...registry.data,steps:[{...registry.data.steps[0],...change}]}};}
function withTransactionFault(fault,action){
  const original=SimpleDB.prototype.transaction;
  SimpleDB.prototype.transaction=function(fn){
    const exec=this.connection.exec.bind(this.connection);
    this.connection.exec=sql=>fault(sql,()=>exec(sql));
    try{return original.call(this,fn);}finally{this.connection.exec=exec;}
  };
  try{return action();}finally{SimpleDB.prototype.transaction=original;}
}
const log=()=>({async append(){}});
test('fresh Data DB v2, data preservation, CAS, repeat and separate-process reopen',()=>temporary(async ctx=>{
  const fresh=ctx.create('fresh',DATA_STORAGE_SCHEMA);assert.equal(ctx.open(fresh,DATA_STORAGE_SCHEMA).get('PRAGMA user_version').user_version,2);
  const file=ctx.create(),db=ctx.open(file),repo=new SimpleDBDataRepository(db,'demo-items');
  const stored=await repo.add(oldRecord);await repo.add({...oldRecord,id:'Case'});await repo.add({...oldRecord,id:'case'});db.close();
  const p=plan(file,{kind:'data',targetVersion:2});assert.deepEqual(p.steps.map(x=>[x.from,x.to]),[[1,2]]);
  const result=execute(file,p);assert.equal(result.ok,true);assert.equal(result.status,'APPLIED');assert.equal(result.dataPreserved,true);assert.equal(result.after.recordCount,3);
  const migrated=ctx.open(file,DATA_STORAGE_SCHEMA),newRepo=new SimpleDBDataRepository(migrated,'demo-items');assert.deepEqual(await newRepo.read('a'),stored);
  assert.ok(migrated.connection.prepare('PRAGMA index_list(data_records)').all().some(x=>x.name==='data_records_collection_revision'&&x.unique===0));
  const updated=await newRepo.write(oldRecord,stored.revision);assert.notEqual(updated.revision,stored.revision);await assert.rejects(newRepo.write(oldRecord,stored.revision),{code:'CONFLICT'});migrated.close();
  const bytes=fs.readFileSync(file),noop=plan(file,{kind:'data',targetVersion:2});assert.deepEqual(noop.steps,[]);assert.equal(execute(file,noop).status,'NO_OP');assert.deepEqual(fs.readFileSync(file),bytes);
  const child=spawnSync(process.execPath,[path.join(__dirname,'schema-migration/child.cjs'),file],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),{version:2,stored:updated});
}));
test('Dry Run is read-only: DB bytes, rows, version and directory unchanged',()=>temporary(async ctx=>{
  const file=ctx.create(),db=ctx.open(file);await new SimpleDBDataRepository(db,'demo-items').add(oldRecord);db.close();
  const bytes=fs.readFileSync(file),names=fs.readdirSync(ctx.dir);
  assert.equal(plan(file,{kind:'data',targetVersion:2}).source.version,1);
  assert.deepEqual(fs.readFileSync(file),bytes);assert.deepEqual(fs.readdirSync(ctx.dir),names);
  const check=ctx.open(file);assert.equal(check.get('PRAGMA user_version').user_version,1);assert.equal(check.get("SELECT count(*) AS n FROM sqlite_schema WHERE name='data_records_collection_revision'").n,0);
}));
test('normal Open never auto-migrates; Definition version stays 1',()=>temporary(async ctx=>{
  const file=ctx.create(),bytes=fs.readFileSync(file);assert.throws(()=>SimpleDB.open(file,DATA_STORAGE_SCHEMA),{code:'MIGRATION_REQUIRED'});assert.deepEqual(fs.readFileSync(file),bytes);
  const definitions=ctx.create('definitions',STORAGE_SCHEMA),db=ctx.open(definitions,STORAGE_SCHEMA),repo=new SimpleDBWorkflowDefinitionRepository(db);await repo.add(definition());db.close();
  const before=fs.readFileSync(definitions),p=plan(definitions,{kind:'definition',targetVersion:1});assert.equal(p.source.applicationId,0x41524348);assert.equal(execute(definitions,p).status,'NO_OP');assert.deepEqual(fs.readFileSync(definitions),before);
  assert.throws(()=>plan(definitions,{kind:'definition',targetVersion:2}),{code:'UNKNOWN_VERSION'});
  assert.deepEqual(await new SimpleDBWorkflowDefinitionRepository(ctx.open(definitions,STORAGE_SCHEMA)).get('saved-example','v1'),definition());
}));
test('kind mismatch, unknown kind/version, downgrade and missing paths are rejected',()=>temporary(async ctx=>{
  const file=ctx.create();assert.throws(()=>plan(file,{kind:'definition',targetVersion:1}),{code:'DB_KIND_MISMATCH'});
  assert.throws(()=>plan(file,{kind:'other',targetVersion:1}),{code:'UNKNOWN_DB_KIND'});
  assert.throws(()=>plan(file,{kind:'data',targetVersion:99}),{code:'UNKNOWN_VERSION'});
  assert.throws(()=>plan(file,{kind:'data',targetVersion:2},{...registry,data:{...registry.data,steps:[]}}),{code:'MIGRATION_PATH_MISSING'});
  ctx.open(file).run('PRAGMA user_version=99');assert.throws(()=>plan(file,{kind:'data',targetVersion:2}),{code:'UNKNOWN_VERSION'});
  const latest=ctx.create('latest',DATA_STORAGE_SCHEMA);assert.throws(()=>plan(latest,{kind:'data',targetVersion:1}),{code:'DOWNGRADE_UNSUPPORTED'});
}));
test('physical schema mismatch, fake metadata and corrupt payload are never repaired',()=>temporary(async ctx=>{
  for(const variant of ['table','extra','index','json','file']){
    const file=ctx.create('bad-'+variant),db=ctx.open(file);
    if(variant==='table')db.connection.exec('DROP TABLE data_records; CREATE TABLE data_records(id TEXT);');
    if(variant==='extra')db.connection.exec('CREATE TABLE unexpected(id TEXT);');
    if(variant==='index')db.connection.exec(DATA_REVISION_INDEX_SQL); // index already present but user_version claims v1
    if(variant==='json')db.run('INSERT INTO data_records VALUES(?,?,?,?)',Buffer.from('demo-items'),Buffer.from('a'),'{','r');
    db.close();if(variant==='file')fs.writeFileSync(file,'not sqlite');const bytes=fs.readFileSync(file);
    assert.throws(()=>plan(file,{kind:'data',targetVersion:2}),{code:['json','file'].includes(variant)?'DATA_CORRUPT':'PHYSICAL_SCHEMA_MISMATCH'});assert.deepEqual(fs.readFileSync(file),bytes);
  }
}));
test('pre-execution kind/version/data/schema changes and modified plans stop',()=>temporary(async ctx=>{
  for(const variant of ['kind','version','data','schema','plan']){
    const file=ctx.create('change-'+variant),p=plan(file,{kind:'data',targetVersion:2}),db=ctx.open(file);
    if(variant==='kind')db.run('PRAGMA application_id=1');
    if(variant==='version')db.run('PRAGMA user_version=2');
    if(variant==='data')await new SimpleDBDataRepository(db,'demo-items').add(oldRecord);
    if(variant==='schema')db.connection.exec('CREATE INDEX unexpected ON data_records(revision);');
    if(variant==='plan')p.targetVersion=1;
    db.close();const before=fs.readFileSync(file);
    if(variant==='plan')assert.throws(()=>execute(file,p),{code:'INVALID_PLAN'});
    else{const r=execute(file,p);assert.equal(r.ok,false);assert.equal(r.code,{kind:'DB_KIND_MISMATCH',version:'VERSION_CHANGED',data:'DATA_CHANGED',schema:'PHYSICAL_SCHEMA_MISMATCH'}[variant]);}
    assert.deepEqual(fs.readFileSync(file),before);
  }
}));
test('mid-DDL failure rolls back schema and version, then valid retry succeeds',()=>temporary(async ctx=>{
  const file=ctx.create(),db=ctx.open(file);const stored=await new SimpleDBDataRepository(db,'demo-items').add(oldRecord);db.close();
  const bad=changedStep({apply(ctx){ctx.exec(DATA_REVISION_INDEX_SQL);throw new SimpleDBError('INJECTED_FAILURE');}}),p=plan(file,{kind:'data',targetVersion:2},bad);
  const r=execute(file,p,bad);assert.equal(r.code,'INJECTED_FAILURE');assert.equal(r.reconciliation.version,1);assert.equal(r.reconciliation.matchesSource,true);assert.equal(r.reconciliation.dataPreserved,true);
  assert.deepEqual(await new SimpleDBDataRepository(ctx.open(file),'demo-items').read('a'),stored);
  assert.equal(execute(file,plan(file,{kind:'data',targetVersion:2})).ok,true);
}));
test('failure immediately before user_version update rolls back index creation',()=>temporary(async ctx=>{
  const file=ctx.create(),p=plan(file,{kind:'data',targetVersion:2});
  const r=withTransactionFault((sql,run)=>{if(sql==='PRAGMA user_version=2')throw new SimpleDBError('VERSION_WRITE_FAILED');return run();},()=>execute(file,p));
  assert.equal(r.code,'VERSION_WRITE_FAILED');assert.equal(r.reconciliation.version,1);assert.equal(r.reconciliation.matchesSource,true);
}));
test('post-apply verification failure rolls back user_version and DDL',()=>temporary(async ctx=>{
  const file=ctx.create(),bad=changedStep({verify(){throw new SimpleDBError('POST_CHECK_FAILED');}});
  const r=execute(file,plan(file,{kind:'data',targetVersion:2},bad),bad);assert.equal(r.code,'POST_CHECK_FAILED');assert.equal(r.reconciliation.version,1);assert.equal(r.reconciliation.matchesSource,true);
}));
test('data modification by apply or verify is detected before commit and rolled back',()=>temporary(async ctx=>{
  for(const phase of ['apply','verify']){
    const file=ctx.create('mutate-'+phase),db=ctx.open(file);const stored=await new SimpleDBDataRepository(db,'demo-items').add(oldRecord);db.close();
    const bad=changedStep(phase==='apply'?{apply(ctx){ctx.exec(DATA_REVISION_INDEX_SQL);ctx.exec('DELETE FROM data_records');}}:{verify(ctx){ctx.exec('DELETE FROM data_records');}});
    const r=execute(file,plan(file,{kind:'data',targetVersion:2},bad),bad);assert.equal(r.ok,false);assert.equal(r.reconciliation.dataPreserved,true);assert.equal(r.reconciliation.version,1);
    assert.deepEqual(await new SimpleDBDataRepository(ctx.open(file),'demo-items').read('a'),stored);
  }
}));
test('commit failure before/after actual commit stays unknown and reconciles without retry',()=>temporary(async ctx=>{
  for(const committed of [false,true]){
    const file=ctx.create('commit-'+committed),db=ctx.open(file);await new SimpleDBDataRepository(db,'demo-items').add(oldRecord);db.close();const p=plan(file,{kind:'data',targetVersion:2});
    let commits=0;const r=withTransactionFault((sql,run)=>{if(sql==='COMMIT'){commits++;if(committed)run();throw Error('private filesystem path');}return run();},()=>execute(file,p));
    assert.equal(r.ok,false);assert.equal(r.status,'OUTCOME_UNKNOWN');assert.equal(r.reconciliation.version,committed?2:1);assert.equal(r.reconciliation.dataPreserved,true);assert.equal(commits,1);assert.equal(JSON.stringify(r).includes('private'),false);
    const next=execute(file,plan(file,{kind:'data',targetVersion:2}));assert.equal(next.status,committed?'NO_OP':'APPLIED');
  }
}));
test('rollback/close cleanup failure cannot overwrite original unknown outcome',()=>temporary(async ctx=>{
  const file=ctx.create(),p=plan(file,{kind:'data',targetVersion:2});const close=SimpleDB.prototype.close;let first=true;
  SimpleDB.prototype.close=function(){if(first){first=false;close.call(this);throw Error('private close');}return close.call(this);};
  let r;try{r=withTransactionFault((sql,run)=>{if(sql==='COMMIT'||sql==='ROLLBACK')throw Error('private');return run();},()=>execute(file,p));}finally{SimpleDB.prototype.close=close;}
  assert.equal(r.code,'OUTCOME_UNKNOWN');assert.ok(r.cleanupDiagnostics.includes('ROLLBACK_FAILED'));assert.ok(r.cleanupDiagnostics.includes('CLOSE_FAILED'));assert.equal(r.reconciliation.version,1);
}));
test('re-executing stale plan and mismatched v2 schema is rejected',()=>temporary(async ctx=>{
  const file=ctx.create(),p=plan(file,{kind:'data',targetVersion:2});assert.equal(execute(file,p).ok,true);assert.equal(execute(file,p).code,'VERSION_CHANGED');
  const db=ctx.open(file,DATA_STORAGE_SCHEMA);db.connection.exec('DROP INDEX data_records_collection_revision');db.close();
  assert.throws(()=>plan(file,{kind:'data',targetVersion:2}),{code:'PHYSICAL_SCHEMA_MISMATCH'});
}));
test('ordered registry steps execute by From version; all planned steps share one transaction',()=>temporary(async ctx=>{
  const sql3=DATA_STORAGE_SCHEMA.sql+'\nCREATE INDEX data_record_id_lookup ON data_records(record_id);',calls=[];
  const next={id:'test-v2-v3',from:2,to:3,apply(ctx){calls.push(2);ctx.exec('CREATE INDEX data_record_id_lookup ON data_records(record_id);');},verify(){}};
  const custom={...registry,data:{...registry.data,versions:{...registry.data.versions,3:{applicationId:DATA_STORAGE_SCHEMA.applicationId,version:3,sql:sql3}},steps:[next,{...registry.data.steps[0],apply(ctx){calls.push(1);ctx.exec(DATA_REVISION_INDEX_SQL);}}]}};
  const file=ctx.create(),p=plan(file,{kind:'data',targetVersion:3},custom);assert.deepEqual(p.steps.map(s=>s.from),[1,2]);assert.equal(execute(file,p,custom).ok,true);assert.deepEqual(calls,[1,2]);
  const failed=ctx.create('failed'),bad={...custom,data:{...custom.data,steps:[{...next,verify(){throw new SimpleDBError('TEST_FAILURE');}},custom.data.steps[1]]}};
  const r=execute(failed,plan(failed,{kind:'data',targetVersion:3},bad),bad);assert.equal(r.reconciliation.version,1);assert.equal(r.reconciliation.matchesSource,true);
}));
test('async callbacks, detached contexts and transaction-control SQL are rejected',()=>temporary(async ctx=>{
  const file=ctx.create(),asyncRegistry=changedStep({async apply(){}});assert.throws(()=>plan(file,{kind:'data',targetVersion:2},asyncRegistry),{code:'ASYNC_MIGRATION_UNSUPPORTED'});
  for(const sql of ['COMMIT','PRAGMA user_version=2']){
    const bad=changedStep({apply(ctx){ctx.exec(DATA_REVISION_INDEX_SQL);ctx.exec(sql);}});
    const r=execute(file,plan(file,{kind:'data',targetVersion:2},bad),bad);assert.equal(r.ok,false);assert.equal(r.reconciliation.version,1);
  }
  let saved;const detached=changedStep({apply(ctx){saved=ctx;ctx.exec(DATA_REVISION_INDEX_SQL);}});assert.equal(execute(file,plan(file,{kind:'data',targetVersion:2},detached),detached).ok,true);
  assert.throws(()=>saved.exec('DROP TABLE data_records'),{code:'MIGRATION_CONTEXT_CLOSED'});
}));
test('missing database is not created and lock contention is a definite failure',()=>temporary(async ctx=>{
  const missing=path.join(ctx.dir,'missing.sqlite');assert.throws(()=>plan(missing,{kind:'data',targetVersion:2}),{code:'UNAVAILABLE'});assert.equal(fs.existsSync(missing),false);
  const file=ctx.create(),p=plan(file,{kind:'data',targetVersion:2}),lock=ctx.open(file);lock.connection.exec('BEGIN IMMEDIATE');
  let r;try{r=execute(file,p);}finally{lock.connection.exec('ROLLBACK');}
  assert.equal(r.code,'UNAVAILABLE');assert.equal(ctx.open(file).get('PRAGMA user_version').user_version,1);
}));
test('Data Migration continues after physical migration with existing source Revision',()=>temporary(async ctx=>{
  const sourceFile=ctx.create('source'),destFile=ctx.create('dest'),sourceDb=ctx.open(sourceFile);
  const stored=await new SimpleDBDataRepository(sourceDb,'demo-items').add(oldRecord);sourceDb.close();
  for(const file of [sourceFile,destFile])assert.equal(execute(file,plan(file,{kind:'data',targetVersion:2})).ok,true);
  const source=new SimpleDBDataRepository(ctx.open(sourceFile,DATA_STORAGE_SCHEMA),'demo-items'),destination=new SimpleDBDataRepository(ctx.open(destFile,DATA_STORAGE_SCHEMA),'demo-items');
  assert.deepEqual(await source.read('a'),stored);
  const manifest={manifestVersion:1,migrationId:'after-schema',collection:'demo-items',transformVersion:DEMO_TRANSFORM,items:[{id:'a',allowUpdate:false,expectedTarget:null}]};
  const result=await executeDataMigration(await planDataMigration(manifest,source,destination),source,destination,'after-schema-run',log());
  assert.equal(result.ok,true);assert.equal(result.items[0].verified,true);assert.deepEqual((await destination.read('a')).record,{id:'a',schemaVersion:'2',label:'unchanged',enabled:true});
}));
test('registry changes after planning are rejected before touching the DB',()=>temporary(async ctx=>{
  const file=ctx.create(),p=plan(file,{kind:'data',targetVersion:2}),bytes=fs.readFileSync(file);
  assert.throws(()=>execute(file,p,changedStep({id:'different-step'})),{code:'REGISTRY_CHANGED'});assert.deepEqual(fs.readFileSync(file),bytes);
}));
test('thenable callbacks cannot write through a detached context after rollback',()=>temporary(async ctx=>{
  const file=ctx.create();let lateCode;
  const bad=changedStep({apply(ctx){ctx.exec(DATA_REVISION_INDEX_SQL);return Promise.resolve().then(()=>{try{ctx.exec('DROP TABLE data_records');}catch(e){lateCode=e.code;}});}});
  const r=execute(file,plan(file,{kind:'data',targetVersion:2},bad),bad);assert.equal(r.code,'ASYNC_MIGRATION_UNSUPPORTED');assert.equal(r.reconciliation.version,1);
  await Promise.resolve();assert.equal(lateCode,'MIGRATION_CONTEXT_CLOSED');assert.equal(plan(file,{kind:'data',targetVersion:2}).source.version,1);
}));
test('CLI dry-run and apply require explicit paths and a saved plan',()=>temporary(async ctx=>{
  const file=ctx.create(),bytes=fs.readFileSync(file),tool=path.join(__dirname,'../tools/schema-migration.cjs');
  const run=args=>spawnSync(process.execPath,[tool,...args],{encoding:'utf8',windowsHide:true,timeout:10000});
  const dry=run(['dry-run','data',file,'2']);assert.equal(dry.status,0,dry.stderr);const p=JSON.parse(dry.stdout);assert.equal(p.source.version,1);assert.deepEqual(fs.readFileSync(file),bytes);
  const planFile=path.join(ctx.dir,'plan.json');fs.writeFileSync(planFile,JSON.stringify(p));const applied=run(['apply',file,planFile]);assert.equal(applied.status,0,applied.stderr);assert.equal(JSON.parse(applied.stdout).commitOutcome,'CONFIRMED_SUCCESS');
  const invalid=run(['dry-run','definition',file,'1']);assert.equal(invalid.status,1);assert.equal(invalid.stderr.trim(),'DB_KIND_MISMATCH');
}));
