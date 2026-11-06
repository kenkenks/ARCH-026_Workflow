'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync,fork}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {SimpleDB,STORAGE_SCHEMA,SimpleDBWorkflowDefinitionRepository:Repository}=require('../src/adapters/workflow-definition/simpledb.cjs');
const {LocalWorkflowDefinitionRepository}=require('../src/adapters/workflow-definition/local-file.cjs');
const {definition,registry}=require('./workflow-definition/fixture.cjs');
const {loadWorkflow}=require('../dist/src/prototype/definition');
const {CMemoryHistoryStore}=require('../dist/src/prototype/workflow');
async function temporary(action){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-simpledb-')),file=path.join(dir,'test.sqlite');
  let db;
  try{SimpleDB.initialize(file,STORAGE_SCHEMA);db=SimpleDB.open(file,STORAGE_SCHEMA);await action({dir,file,db,repo:new Repository(db)});}
  finally{db?.close();fs.rmSync(dir,{recursive:true,force:true});}
}
for(const backend of ['json','simpledb'])test(`${backend}: common Definition Repository contract`,()=>temporary(async({dir,repo})=>{
  if(backend==='json')repo=new LocalWorkflowDefinitionRepository(path.join(dir,'json'));
  const expected=definition(),input=structuredClone(expected);await repo.add(input);input.steps[0].jobId='changed';
  assert.deepEqual(await repo.get('saved-example','v1'),expected);
  const copy=await repo.get('saved-example','v1');copy.steps.pop();assert.deepEqual(await repo.get('saved-example','v1'),expected);
  assert.equal(await repo.get('missing','v1'),null);
  await assert.rejects(repo.add(expected),{code:'DEFINITION_ALREADY_EXISTS'});
  await repo.add(definition('v2'));assert.deepEqual(await repo.get('saved-example','v2'),definition('v2'));
  const results=await Promise.allSettled([repo.add(definition('race')),repo.add(definition('race'))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'DEFINITION_ALREADY_EXISTS');
  await assert.rejects(repo.add({...expected,schemaVersion:'bad'}),{code:'SCHEMA_MISMATCH'});
  for(const [id,version]of [['Case','v1'],['case','v1'],['Case','V1'],['a__b','c'],['a','b__c'],['x\u0000y','v'],['長'.repeat(3000),'v']]){
    const d={...definition(version),definitionId:id};await repo.add(d);assert.deepEqual(await repo.get(id,version),d);
  }
  const rebuilt=await loadWorkflow(repo,'saved-example','v1',registry(),new CMemoryHistoryStore());
  const result=await rebuilt.workflow.run('shared',rebuilt.startStepNo);
  assert.equal(result.status,'COMPLETED');assert.deepEqual(result.history.map(x=>x.stepNo),[10,20,10,20,10,20,30]);
  assert.deepEqual(result.history.filter(x=>x.stepNo===20).map(x=>x.result),['FALSE','FALSE','TRUE']);
}));
test('reconnect and separate process read',()=>temporary(async({file,db,repo})=>{
  await repo.add(definition());db.close();const reopened=SimpleDB.open(file,STORAGE_SCHEMA);
  try{assert.deepEqual(await new Repository(reopened).get('saved-example','v1'),definition());}finally{reopened.close();}
  const r=spawnSync(process.execPath,[path.join(__dirname,'workflow-definition/simpledb-child.cjs'),'read',file],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),definition());
}));
test('initialization is explicit and physical version mismatch is rejected',()=>temporary(async({dir,file,db})=>{
  assert.throws(()=>SimpleDB.initialize(file,STORAGE_SCHEMA),{code:'ALREADY_EXISTS'});
  const missing=path.join(dir,'missing.sqlite');assert.throws(()=>SimpleDB.open(missing,STORAGE_SCHEMA),{code:'UNAVAILABLE'});assert.equal(fs.existsSync(missing),false);
  db.run('PRAGMA user_version=99');assert.throws(()=>SimpleDB.open(file,STORAGE_SCHEMA),{code:'STORAGE_SCHEMA_MISMATCH'});
}));
test('stored corruption, schema and identity mismatches are rejected without repair',()=>temporary(async({db,repo})=>{
  await repo.add(definition());
  for(const [json,schema,code]of [['{','prototype-workflow/1','DATA_CORRUPT'],['null','prototype-workflow/1','DATA_CORRUPT'],[JSON.stringify({...definition(),schemaVersion:'bad'}),'bad','SCHEMA_MISMATCH'],[JSON.stringify(definition()),'bad','SCHEMA_MISMATCH'],[JSON.stringify({...definition(),definitionId:'other'}),'prototype-workflow/1','DEFINITION_IDENTITY_MISMATCH']]){
    db.run('UPDATE workflow_definitions SET definition_json=?,schema_version=?',json,schema);
    await assert.rejects(repo.get('saved-example','v1'),{code});assert.equal(db.get('SELECT definition_json FROM workflow_definitions').definition_json,json);
  }
}));
test('SQLite lock conflict is a definite failure, existing data preserved',()=>temporary(async({file,repo})=>{
  await repo.add(definition());const lock=new DatabaseSync(file);
  try{lock.exec('BEGIN IMMEDIATE');await assert.rejects(repo.add(definition('blocked')),{code:'UNAVAILABLE'});}
  finally{lock.exec('ROLLBACK');lock.close();}
  assert.equal(await repo.get('saved-example','blocked'),null);assert.deepEqual(await repo.get('saved-example','v1'),definition());
}));
test('write fault rolls back; commit and cleanup faults preserve unknown outcome',()=>temporary(async({db,repo})=>{
  const run=db.run;db.run=()=>{throw Error('private path');};
  try{await assert.rejects(repo.add(definition()),e=>e.code==='UNAVAILABLE'&&!e.message.includes('private'));}finally{db.run=run;}
  assert.equal(await repo.get('saved-example','v1'),null);
  const exec=db.connection.exec.bind(db.connection);
  db.connection.exec=sql=>{if(sql==='COMMIT'||sql==='ROLLBACK')throw Error('private path');return exec(sql);};
  try{await assert.rejects(repo.add(definition()),e=>e.code==='OUTCOME_UNKNOWN'&&e.cleanupDiagnostics[0]==='ROLLBACK_FAILED');}
  finally{db.connection.exec=exec;exec('ROLLBACK');}
  await assert.rejects(repo.get('saved-example','v1'),{code:'UNAVAILABLE'});
  assert.equal(db.connection.prepare('SELECT count(*) AS n FROM workflow_definitions').get().n,0);
}));
test('physical database corruption is detected',()=>temporary(async({file,db})=>{
  db.close();fs.writeFileSync(file,'not a database');assert.throws(()=>SimpleDB.open(file,STORAGE_SCHEMA),{code:'DATA_CORRUPT'});
}));
test('SQLite write rejection rolls back without publishing a version',()=>temporary(async({db,repo})=>{
  await repo.add(definition());db.run('PRAGMA query_only=ON');
  await assert.rejects(repo.add(definition('readonly')),{code:'UNAVAILABLE'});
  db.run('PRAGMA query_only=OFF');assert.equal(await repo.get('saved-example','readonly'),null);
  assert.deepEqual(await repo.get('saved-example','v1'),definition());
}));
test('generic transaction rolls back all prior writes on failure',()=>temporary(async({db})=>{
  assert.throws(()=>db.transaction(()=>{
    db.run('INSERT INTO workflow_definitions VALUES (?,?,?,?)',Buffer.from('x'),Buffer.from('v'),'schema','{}');
    throw Error('private');
  }),{code:'UNAVAILABLE'});
  assert.equal(db.get('SELECT count(*) AS n FROM workflow_definitions').n,0);
}));
test('commit response failure is unknown even when the data committed',()=>temporary(async({db,repo})=>{
  const exec=db.connection.exec.bind(db.connection);
  db.connection.exec=sql=>{const result=exec(sql);if(sql==='COMMIT')throw Error('private');return result;};
  try{await assert.rejects(repo.add(definition()),{code:'OUTCOME_UNKNOWN'});}
  finally{db.connection.exec=exec;}
  // Failed rollback poisons the connection; use a fresh connection to reconcile state.
  const file=db.connection.location();const fresh=SimpleDB.open(file,STORAGE_SCHEMA);
  try{assert.deepEqual(await new Repository(fresh).get('saved-example','v1'),definition());}finally{fresh.close();}
}));
test('failed initialization rolls back and committed initialization survives close failure',()=>temporary(async({dir})=>{
  const bad=path.join(dir,'bad.sqlite');
  assert.throws(()=>SimpleDB.initialize(bad,{...STORAGE_SCHEMA,sql:'CREATE TABLE first (id INTEGER); invalid SQL;'}),{code:'UNAVAILABLE'});
  assert.equal(fs.existsSync(bad),false);
  const file=path.join(dir,'close.sqlite'),close=SimpleDB.prototype.close;let calls=0;
  SimpleDB.prototype.close=function(){if(++calls===1)throw Error('private');return close.call(this);};
  try{assert.throws(()=>SimpleDB.initialize(file,STORAGE_SCHEMA),{code:'UNAVAILABLE'});}
  finally{SimpleDB.prototype.close=close;}
  const opened=SimpleDB.open(file,STORAGE_SCHEMA);opened.close();opened.close();
  assert.throws(()=>opened.get('SELECT 1'),{code:'UNAVAILABLE'});
}));
test('two processes race after readiness barrier; one immutable definition wins',()=>temporary(async({file,repo})=>{
  const children=[0,1].map(()=>{
    const proc=fork(path.join(__dirname,'workflow-definition/simpledb-child.cjs'),['race',file],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    let readyResolve,readyReject,result;
    const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
    const timer=setTimeout(()=>{readyReject(Error('timeout'));proc.kill();},10000);
    proc.on('message',m=>{if(m==='READY')readyResolve();else result=m;});
    const exit=new Promise((resolve,reject)=>{proc.on('error',reject);proc.on('exit',code=>{clearTimeout(timer);readyReject(Error('early exit'));code===0?resolve(result):reject(Error('child failed'));});});
    return {proc,ready,exit};
  });
  try{await Promise.all(children.map(c=>c.ready));children.forEach(c=>c.proc.send('GO'));assert.deepEqual((await Promise.all(children.map(c=>c.exit))).sort(),['ADDED','DEFINITION_ALREADY_EXISTS']);assert.deepEqual(await repo.get('saved-example','v1'),definition());}
  finally{children.forEach(c=>{if(c.proc.exitCode===null)c.proc.kill();});await Promise.allSettled(children.map(c=>c.exit));}
}));
