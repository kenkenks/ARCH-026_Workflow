'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {SimpleDB}=require('../src/adapters/simpledb/database.cjs');
const engine=require('../src/adapters/simpledb/schema-migration-engine.cjs');
const facade=require('../src/adapters/simpledb/schema-migration.cjs');

// Independent two-table application: no ARCH business model, schema, validator or registry.
function customRegistry(){
 const applicationId=0x54455354;
 const sql='CREATE TABLE records(id INTEGER NOT NULL PRIMARY KEY,payload TEXT NOT NULL) STRICT;'+
  'CREATE TABLE notes(id INTEGER NOT NULL PRIMARY KEY,record_id INTEGER NOT NULL REFERENCES records(id),payload TEXT NOT NULL) STRICT;';
 const index='CREATE INDEX notes_record_lookup ON notes(record_id);';
 const versions={1:{applicationId,version:1,sql},2:{applicationId,version:2,sql:sql+index}};
 return {independent:{
  applicationId,versions,
  rowsSQL:"SELECT 'records' AS entity,id,NULL AS parent_id,payload FROM records UNION ALL SELECT 'notes',id,record_id,payload FROM notes ORDER BY entity,id",
  validateRows(rows){
   const owners=new Set(rows.filter(r=>r.entity==='records').map(r=>r.id));
   for(const row of rows){
    if(!['records','notes'].includes(row.entity)||!Number.isSafeInteger(row.id)||typeof row.payload!=='string'||!row.payload||
      (row.entity==='notes'&&!owners.has(row.parent_id)))throw Error('invalid independent record');
   }
  },
  steps:[{id:'independent-v1-v2-index',from:1,to:2,
   apply(ctx){ctx.exec(index);},
   verify(ctx,before,after){
    assert.equal(before.dataFingerprint,after.dataFingerprint);
    assert.equal(ctx.get('PRAGMA user_version').user_version,2);
    assert.ok(ctx.all('PRAGMA index_list(notes)').some(r=>r.name==='notes_record_lookup'));
   }
  }]
 }};
}
function temporary(action){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-generic-migration-'));
 try{return action(dir);}finally{fs.rmSync(dir,{recursive:true,force:true});}
}
function fixture(dir,name='sample'){
 const registry=customRegistry(),file=path.join(dir,name+'.sqlite');
 SimpleDB.initialize(file,registry.independent.versions[1]);
 const db=SimpleDB.open(file,registry.independent.versions[1]);
 try{db.run('INSERT INTO records VALUES(?,?)',1,'original record');db.run('INSERT INTO notes VALUES(?,?,?)',1,1,'original note');}
 finally{db.close();}
 return {file,registry};
}
function replaceStep(registry,change){
 return {independent:{...registry.independent,steps:[{...registry.independent.steps[0],...change}]}};
}
const target={kind:'independent',targetVersion:2};

test('isolated engine and compatibility entry migrate without any business module or dist directory',()=>temporary(dir=>{
 for(const file of ['database.cjs','schema-migration-engine.cjs','schema-migration.cjs'])
  fs.copyFileSync(path.join(__dirname,'../src/adapters/simpledb',file),path.join(dir,file));
 const child=String.raw`
  const assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module');
  const {SimpleDB}=require('./database.cjs');
  const load=Module._load;
  Module._load=function(request,...args){
   if(/schema-migration-registry|workflow-definition|demo-item|prototype|adapters[\/]data|dist[\/]/.test(request))
    throw Error('business dependency requested: '+request);
   return load.call(this,request,...args);
  };
  const make=CUSTOM_FACTORY;
  const registry=make();
  for(const name of ['schema-migration-engine.cjs','schema-migration.cjs']){
   const api=require('./'+name),file=path.join(process.cwd(),name+'.sqlite');
   SimpleDB.initialize(file,registry.independent.versions[1]);
   const db=SimpleDB.open(file,registry.independent.versions[1]);
   db.run('INSERT INTO records VALUES(1,?)','persisted');db.run('INSERT INTO notes VALUES(1,1,?)','also persisted');db.close();
   const plan=api.planSchemaMigration(file,{kind:'independent',targetVersion:2},registry);
   assert.equal(plan.source.recordCount,2);
   const result=api.executeSchemaMigration(file,plan,registry);
   assert.equal(result.ok,true);assert.equal(result.dataPreserved,true);
  }
  const api=require('./schema-migration.cjs');
  assert.deepEqual(Object.keys(api),['SCHEMA_MIGRATION_REGISTRY','planSchemaMigration','executeSchemaMigration']);
  assert.throws(()=>api.planSchemaMigration('unused',{kind:'independent',targetVersion:2},null),TypeError);
  assert.ok(!Object.keys(require.cache).some(p=>/schema-migration-registry|[\/]dist[\/]|workflow-definition|demo-item/.test(p)));
  process.stdout.write('independent OK');
 `;
 const result=spawnSync(process.execPath,['-e',child.replace('CUSTOM_FACTORY',customRegistry.toString())],{cwd:dir,encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'independent OK');
}));

test('explicit-registry facade and engine produce identical plans and results',()=>temporary(dir=>{
 const {file,registry}=fixture(dir),copy=path.join(dir,'copy.sqlite');fs.copyFileSync(file,copy);
 const a=engine.planSchemaMigration(file,target,registry),b=facade.planSchemaMigration(copy,target,registry);
 assert.deepEqual(a,b);
 assert.deepEqual(engine.executeSchemaMigration(file,a,registry),facade.executeSchemaMigration(copy,b,registry));
 assert.equal(engine.executeSchemaMigration(file,engine.planSchemaMigration(file,target,registry),registry).status,'NO_OP');
}));

for(const table of ['records','notes']){
 test('independent registry rejects '+table+' mutation and rolls back schema, version and data',()=>temporary(dir=>{
  const {file,registry}=fixture(dir),original=registry.independent.steps[0];
  const bad=replaceStep(registry,{apply(ctx){original.apply(ctx);ctx.exec("UPDATE "+table+" SET payload='modified'");}});
  const plan=engine.planSchemaMigration(file,target,bad);
  const result=engine.executeSchemaMigration(file,plan,bad);
  assert.equal(result.ok,false);assert.equal(result.code,'DATA_CHANGED');
  assert.equal(result.reconciliation.matchesSource,true);assert.equal(result.reconciliation.dataPreserved,true);
  const db=SimpleDB.open(file,registry.independent.versions[1]);
  try{assert.equal(db.get('SELECT count(*) AS n FROM sqlite_schema WHERE name=?','notes_record_lookup').n,0);}
  finally{db.close();}
 }));
}

test('independent verify cannot alter data and failures roll back',()=>temporary(dir=>{
 const {file,registry}=fixture(dir);
 const bad=replaceStep(registry,{verify(ctx){ctx.exec('DELETE FROM notes');}});
 const result=engine.executeSchemaMigration(file,engine.planSchemaMigration(file,target,bad),bad);
 assert.equal(result.ok,false);assert.equal(result.code,'POST_CHECK_FAILED');
 assert.equal(result.reconciliation.matchesSource,true);assert.equal(result.reconciliation.dataPreserved,true);
}));

test('independent callback exception rolls back and a fresh valid retry succeeds',()=>temporary(dir=>{
 const {file,registry}=fixture(dir),original=registry.independent.steps[0];
 const bad=replaceStep(registry,{apply(ctx){original.apply(ctx);throw Error('injected');}});
 const result=engine.executeSchemaMigration(file,engine.planSchemaMigration(file,target,bad),bad);
 assert.equal(result.ok,false);assert.equal(result.reconciliation.matchesSource,true);assert.equal(result.reconciliation.dataPreserved,true);
 assert.equal(engine.executeSchemaMigration(file,engine.planSchemaMigration(file,target,registry),registry).ok,true);
}));

test('independent later-step failure rolls back every step together',()=>temporary(dir=>{
 const {file,registry}=fixture(dir),family=registry.independent;
 const third={applicationId:family.applicationId,version:3,sql:family.versions[2].sql+'CREATE INDEX records_payload_lookup ON records(payload);'};
 const custom={independent:{...family,versions:{...family.versions,3:third},steps:[...family.steps,{
  id:'independent-v2-v3-fail',from:2,to:3,apply(ctx){ctx.exec('CREATE INDEX records_payload_lookup ON records(payload);');},
  verify(){throw Error('after all DDL');}
 }]}};
 const result=engine.executeSchemaMigration(file,engine.planSchemaMigration(file,{kind:'independent',targetVersion:3},custom),custom);
 assert.equal(result.ok,false);assert.equal(result.reconciliation.version,1);assert.equal(result.reconciliation.matchesSource,true);
 assert.equal(result.reconciliation.dataPreserved,true);
}));

test('independent malformed payload, physical schema and version fail closed',()=>temporary(dir=>{
 for(const variant of ['payload','schema','version']){
  const {file,registry}=fixture(dir,variant),db=SimpleDB.open(file,registry.independent.versions[1]);
  try{
   if(variant==='payload')db.run("UPDATE notes SET payload=''");
   if(variant==='schema')db.connection.exec('CREATE TABLE unexpected(id TEXT)');
   if(variant==='version')db.connection.exec('PRAGMA user_version=99');
  }finally{db.close();}
  assert.throws(()=>engine.planSchemaMigration(file,target,registry),{code:{payload:'DATA_CORRUPT',schema:'PHYSICAL_SCHEMA_MISMATCH',version:'UNKNOWN_VERSION'}[variant]});
 }
}));

test('independent async callback and transaction-control SQL are rejected',()=>temporary(dir=>{
 const {file,registry}=fixture(dir);
 const asynchronous=replaceStep(registry,{async apply(){}});
 assert.throws(()=>engine.planSchemaMigration(file,target,asynchronous),{code:'ASYNC_MIGRATION_UNSUPPORTED'});
 const bad=replaceStep(registry,{apply(ctx){ctx.exec('COMMIT');}});
 const result=engine.executeSchemaMigration(file,engine.planSchemaMigration(file,target,bad),bad);
 assert.equal(result.ok,false);assert.equal(result.reconciliation.matchesSource,true);
}));

test('compatibility exports retain cached default registry and undefined-default behavior',()=>temporary(dir=>{
 const defaultRegistry=facade.SCHEMA_MIGRATION_REGISTRY;
 assert.strictEqual(facade.SCHEMA_MIGRATION_REGISTRY,defaultRegistry);
 assert.strictEqual(defaultRegistry,require('../src/adapters/simpledb/schema-migration-registry.cjs').SCHEMA_MIGRATION_REGISTRY);
 assert.equal(facade.planSchemaMigration.length,2);assert.equal(facade.executeSchemaMigration.length,2);
 const file=path.join(dir,'default.sqlite');SimpleDB.initialize(file,defaultRegistry.data.versions[1]);
 const omitted=facade.planSchemaMigration(file,{kind:'data',targetVersion:2});
 assert.deepEqual(omitted,facade.planSchemaMigration(file,{kind:'data',targetVersion:2},undefined));
 assert.deepEqual(omitted,engine.planSchemaMigration(file,{kind:'data',targetVersion:2},defaultRegistry));
 const copy=path.join(dir,'default-copy.sqlite');fs.copyFileSync(file,copy);
 assert.deepEqual(facade.executeSchemaMigration(file,omitted),engine.executeSchemaMigration(copy,omitted,defaultRegistry));
}));
