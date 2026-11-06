'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync,fork}=require('node:child_process');
const {SimpleDB,DATA_STORAGE_SCHEMA,SimpleDBDataRepository}=require('../src/adapters/data/simpledb.cjs');
const {STORAGE_SCHEMA}=require('../src/adapters/workflow-definition/simpledb.cjs');
const {FileMigrationJournal}=require('../src/adapters/data/file-journal.cjs');
const {DataError,DEMO_TRANSFORM,transformDemoItem}=require('../dist/src/data/demo-item');
const {dataFingerprint,planDataMigration:plan,executeDataMigration:execute}=require('../dist/src/migration/data');
const v1=(id='a',name='before')=>({id,schemaVersion:'1',name,enabled:true});
const v2=(id='a',label='before')=>({id,schemaVersion:'2',label,enabled:true});
const manifest=(items=[{id:'a',allowUpdate:false,expectedTarget:null}])=>({manifestVersion:1,migrationId:'demo-migration',collection:'demo-items',transformVersion:DEMO_TRANSFORM,items});
const journal=()=>({events:[],async append(event){this.events.push(structuredClone(event));}});
async function temporary(action){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-data-')),connections=[];
  function open(file){const db=SimpleDB.open(file,DATA_STORAGE_SCHEMA);connections.push(db);return db;}
  function create(name){const file=path.join(dir,name+'.sqlite');SimpleDB.initialize(file,DATA_STORAGE_SCHEMA);const db=open(file);return {file,db,repo:new SimpleDBDataRepository(db,'demo-items')};}
  try{await action({dir,create,open,connections});}finally{for(const db of connections)db.close();fs.rmSync(dir,{recursive:true,force:true});}
}
async function setup(ctx){const source=ctx.create('source'),target=ctx.create('target');await source.repo.add(v1());return {source,target};}
async function expected(stored){return {revision:stored.revision,fingerprint:await dataFingerprint(stored.record)};}
function wrap(repo,overrides){return {collection:repo.collection,read:repo.read.bind(repo),add:repo.add.bind(repo),write:repo.write.bind(repo),...overrides};}
test('Data Repository: create-only, versions, collections, detached values, CAS and same-content revision',()=>temporary(async ctx=>{
  const {repo,db}=ctx.create('repository');const input=v1(),saved=await repo.add(input);input.name='changed';saved.record.name='changed';
  const first=await repo.read('a');assert.deepEqual(first.record,v1());assert.equal(await repo.read('missing'),null);
  await assert.rejects(repo.add(v1()),{code:'ALREADY_EXISTS'});await assert.rejects(repo.write(v1('missing'),'rev'),{code:'NOT_FOUND'});
  await assert.rejects(repo.write(v1(),'wrong'),{code:'CONFLICT'});
  const updated=await repo.write(first.record,first.revision);assert.notEqual(updated.revision,first.revision);assert.deepEqual(updated.record,v1());
  updated.record.name='external';assert.deepEqual((await repo.read('a')).record,v1());
  const other=new SimpleDBDataRepository(db,'other');await other.add(v2());assert.deepEqual((await other.read('a')).record,v2());
  await repo.add(v1('Case'));await repo.add(v1('case'));assert.notEqual((await repo.read('Case')).revision,(await repo.read('case')).revision);
}));
test('separate physical family never upgrades Definition DB; new-data open does not initialize',()=>temporary(async ctx=>{
  const file=path.join(ctx.dir,'definitions.sqlite');SimpleDB.initialize(file,STORAGE_SCHEMA);const bytes=fs.readFileSync(file);
  assert.throws(()=>SimpleDB.open(file,DATA_STORAGE_SCHEMA),{code:'STORAGE_SCHEMA_MISMATCH'});assert.deepEqual(fs.readFileSync(file),bytes);
  const data=ctx.create('data');assert.throws(()=>SimpleDB.open(data.file,STORAGE_SCHEMA),{code:'STORAGE_SCHEMA_MISMATCH'});
  assert.throws(()=>SimpleDB.initialize(data.file,DATA_STORAGE_SCHEMA),{code:'ALREADY_EXISTS'});
  const missing=path.join(ctx.dir,'missing.sqlite');assert.throws(()=>SimpleDB.open(missing,DATA_STORAGE_SCHEMA),{code:'UNAVAILABLE'});assert.equal(fs.existsSync(missing),false);
}));
test('CREATE, schema transformation and NO_OP rerun with persisted journal',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx);const p=await plan(manifest(),source.repo,target.repo);assert.equal(p.items[0].action,'CREATE');
  const logFile=path.join(ctx.dir,'run1.jsonl'),log=new FileMigrationJournal(logFile);
  let r;try{r=await execute(p,source.repo,target.repo,'run-1',log);}finally{log.close();}
  assert.equal(r.ok,true);assert.equal(r.items[0].status,'CREATED');assert.equal(r.items[0].verified,true);
  const stored=await target.repo.read('a');assert.deepEqual(stored.record,v2());assert.notEqual(stored.revision,(await source.repo.read('a')).revision);
  const events=fs.readFileSync(logFile,'utf8').trim().split('\n').map(JSON.parse);assert.deepEqual(events.map(e=>e.phase),['PLAN','INTENT','RESULT','SUMMARY']);
  assert.equal(events[0].migrationId,'demo-migration');assert.equal(events[0].runId,'run-1');assert.equal(events[0].planFingerprint,p.planFingerprint);
  assert.equal(events[2].item.targetRevisionAfter,stored.revision);assert.equal(events[3].item.stoppedAt,null);assert.deepEqual(events[3].item.unprocessedIds,[]);
  const retry=await execute(await plan(manifest(),source.repo,target.repo),source.repo,target.repo,'run-2',journal());assert.equal(retry.items[0].status,'NO_OP');assert.equal((await target.repo.read('a')).revision,stored.revision);
  assert.throws(()=>new FileMigrationJournal(logFile),{code:'JOURNAL_UNAVAILABLE'});
}));
test('UPDATE requires explicit permission and exact destination baseline',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx);const old=await target.repo.add(v1('a','old'));
  const m=manifest([{id:'a',allowUpdate:true,expectedTarget:await expected(old)}]);
  const p=await plan(m,source.repo,target.repo);assert.equal(p.items[0].action,'UPDATE');
  const r=await execute(p,source.repo,target.repo,'update',journal());assert.equal(r.items[0].status,'UPDATED');assert.equal(r.items[0].verified,true);
  const after=await target.repo.read('a');assert.deepEqual(after.record,v2());assert.notEqual(after.revision,old.revision);
  // Same old manifest is safe after completion because the current state already equals the output.
  assert.equal((await plan(m,source.repo,target.repo)).items[0].action,'NO_OP');
}));
test('CONFLICT and REJECT cover disabled updates, stale baseline, missing source and invalid schema/transform',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx);await target.repo.add(v2('a','other'));
  const denied=await plan(manifest(),source.repo,target.repo);assert.equal(denied.items[0].action,'CONFLICT');assert.equal((await execute(denied,source.repo,target.repo,'denied',journal())).ok,false);
  const stale=manifest([{id:'a',allowUpdate:true,expectedTarget:{revision:'wrong',fingerprint:'0'.repeat(64)}}]);assert.equal((await plan(stale,source.repo,target.repo)).items[0].action,'CONFLICT');
  for(const m of [manifest([{id:'missing',allowUpdate:false,expectedTarget:null}]),{...manifest(),transformVersion:'unknown'}])assert.equal((await plan(m,source.repo,target.repo)).items[0].action,'REJECT');
  const badSource=wrap(source.repo,{read:async()=>({record:{...v1(),schemaVersion:'9'},revision:'r'})});assert.equal((await plan(manifest(),badSource,target.repo)).items[0].reason,'SCHEMA_MISMATCH');
  assert.deepEqual((await target.repo.read('a')).record,v2('a','other'));
}));
test('Dry Run has zero add/write/journal calls; duplicate and collection mismatch rejected',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx);let writes=0;const dst=wrap(target.repo,{add:async()=>{writes++;throw Error();},write:async()=>{writes++;throw Error();}});
  await plan(manifest(),source.repo,dst);assert.equal(writes,0);
  await assert.rejects(plan(manifest([{id:'a',allowUpdate:false,expectedTarget:null},{id:'a',allowUpdate:false,expectedTarget:null}]),source.repo,dst),{code:'DUPLICATE_MANIFEST_TARGET'});
  await assert.rejects(plan({...manifest(),collection:'other'},source.repo,dst),{code:'COLLECTION_MISMATCH'});
}));
test('source and destination changes after planning stop, including same-content new revision',()=>temporary(async ctx=>{
  for(const side of ['source','target']){
    const source=ctx.create('s-'+side),target=ctx.create('t-'+side);await source.repo.add(v1());const old=await target.repo.add(v1('a','old'));
    const p=await plan(manifest([{id:'a',allowUpdate:true,expectedTarget:await expected(old)}]),source.repo,target.repo);
    const repo=side==='source'?source.repo:target.repo;const before=await repo.read('a');await repo.write(before.record,before.revision);
    const r=await execute(p,source.repo,target.repo,'changed-'+side,journal());assert.equal(r.items[0].status,side==='source'?'SOURCE_CHANGED':'TARGET_CHANGED');assert.equal(r.items[0].writeOutcome,'NOT_ATTEMPTED');
  }
}));
test('two parallel CAS updates: one success and one CONFLICT',()=>temporary(async ctx=>{
  const {repo}=ctx.create('parallel');const old=await repo.add(v1());
  const results=await Promise.allSettled([repo.write(v2('a','left'),old.revision),repo.write(v2('a','right'),old.revision)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.find(x=>x.status==='rejected').reason.code,'CONFLICT');
}));
test('CAS race between executor check and write cannot overwrite the winner',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx);const old=await target.repo.add(v1('a','old'));
  const p=await plan(manifest([{id:'a',allowUpdate:true,expectedTarget:await expected(old)}]),source.repo,target.repo);
  const racing=wrap(target.repo,{write:async(record,revision)=>{await target.repo.write(v2('a','winner'),revision);return target.repo.write(record,revision);}});
  const r=await execute(p,source.repo,racing,'race',journal());assert.equal(r.items[0].status,'CONFLICT');assert.equal(r.items[0].writeOutcome,'CONFIRMED_FAILURE');assert.deepEqual((await target.repo.read('a')).record,v2('a','winner'));
}));
test('pre-write failure and real SQLite query-only failure preserve old data',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx),p=await plan(manifest(),source.repo,target.repo);
  const bad=wrap(target.repo,{add:async()=>{throw new DataError('UNAVAILABLE');}});
  const r=await execute(p,source.repo,bad,'before',journal());assert.equal(r.items[0].writeOutcome,'CONFIRMED_FAILURE');assert.equal(await target.repo.read('a'),null);
  target.db.run('PRAGMA query_only=ON');await assert.rejects(target.repo.add(v1()),{code:'UNAVAILABLE'});target.db.run('PRAGMA query_only=OFF');assert.equal(await target.repo.read('a'),null);
}));
test('commit failure before or after actual commit remains unknown; fresh connection reconciles',()=>temporary(async ctx=>{
  for(const committed of [false,true]){
    const source=ctx.create('cs'+committed),target=ctx.create('ct'+committed);await source.repo.add(v1());const p=await plan(manifest(),source.repo,target.repo);
    const exec=target.db.connection.exec.bind(target.db.connection);target.db.connection.exec=sql=>{if(sql==='COMMIT'){if(committed)exec(sql);throw Error('private');}return exec(sql);};
    let r;try{r=await execute(p,source.repo,target.repo,'commit-'+committed,journal());}finally{target.db.connection.exec=exec;}
    assert.equal(r.items[0].status,'OUTCOME_UNKNOWN');assert.equal(r.items[0].writeOutcome,'UNKNOWN');target.db.close();
    const fresh=new SimpleDBDataRepository(ctx.open(target.file),'demo-items');assert.equal((await fresh.read('a'))!==null,committed);
    const resumed=await execute(await plan(manifest(),source.repo,fresh),source.repo,fresh,'resume-'+committed,journal());assert.equal(resumed.items[0].status,committed?'NO_OP':'CREATED');
  }
}));
test('response loss is state reconciliation, never automatic retry or success',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx),p=await plan(manifest(),source.repo,target.repo);let calls=0;
  const lost=wrap(target.repo,{add:async d=>{calls++;await target.repo.add(d);throw new DataError('OUTCOME_UNKNOWN');}});
  const r=await execute(p,source.repo,lost,'lost',journal());assert.equal(r.items[0].status,'OUTCOME_UNKNOWN');assert.equal(r.items[0].reconciliation.matchesExpected,true);assert.equal(r.items[0].verified,false);assert.equal(calls,1);
}));
test('read-back mismatch is failure even after confirmed update',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx),p=await plan(manifest(),source.repo,target.repo);let added=false;
  const mismatch=wrap(target.repo,{add:async d=>{const x=await target.repo.add(d);added=true;return x;},read:async id=>{const x=await target.repo.read(id);return added?{record:v2(id,'wrong'),revision:x.revision}:x;}});
  const r=await execute(p,source.repo,mismatch,'mismatch',journal());assert.equal(r.items[0].status,'FAILED');assert.equal(r.items[0].reason,'POST_CHECK_MISMATCH');assert.equal(r.items[0].writeOutcome,'CONFIRMED_SUCCESS');assert.equal(r.items[0].verified,false);
}));
test('partial batch stops and reruns without changing completed records',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx);await source.repo.add(v1('b'));await source.repo.add(v1('c'));const m=manifest(['a','b','c'].map(id=>({id,allowUpdate:false,expectedTarget:null})));
  const fail=wrap(target.repo,{add:async d=>{if(d.id==='b')throw new DataError('UNAVAILABLE');return target.repo.add(d);}});
  const r=await execute(await plan(m,source.repo,target.repo),source.repo,fail,'partial',journal());assert.equal(r.stoppedAt,1);assert.deepEqual(r.unprocessedIds,['c']);const old=await target.repo.read('a');
  const rerun=await execute(await plan(m,source.repo,target.repo),source.repo,target.repo,'again',journal());assert.equal(rerun.ok,true);assert.deepEqual(rerun.items.map(x=>x.status),['NO_OP','CREATED','CREATED']);assert.deepEqual(await target.repo.read('a'),old);
}));
test('journal faults stop before write or retain confirmed DB result; missing result requires fresh DB check',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx),p=await plan(manifest(),source.repo,target.repo);
  const unavailable={async append(){throw Error('private');}};const before=await execute(p,source.repo,target.repo,'journal-before',unavailable);assert.equal(before.ok,false);assert.equal(await target.repo.read('a'),null);
  const partial=journal();const append=partial.append.bind(partial);partial.append=async e=>{if(e.phase==='RESULT')throw Error('lost log');return append(e);};
  const after=await execute(p,source.repo,target.repo,'journal-after',partial);assert.equal(after.ok,false);assert.equal(after.items[0].writeOutcome,'CONFIRMED_SUCCESS');assert.equal(after.items[0].journalFailed,true);
  assert.equal((await execute(await plan(manifest(),source.repo,target.repo),source.repo,target.repo,'journal-resume',journal())).items[0].status,'NO_OP');
}));
test('corrupt payload, unknown schema and identity mismatch stop without repair',()=>temporary(async ctx=>{
  const {repo,db}=ctx.create('corrupt');await repo.add(v1());
  for(const [json,code]of [['{','DATA_CORRUPT'],[JSON.stringify({...v1(),schemaVersion:'9'}),'SCHEMA_MISMATCH'],[JSON.stringify(v1('other')),'DATA_CORRUPT']]){
    db.run('UPDATE data_records SET record_json=?',json);await assert.rejects(repo.read('a'),{code});await assert.rejects(repo.write(v2(),'r'),{code});assert.equal(db.get('SELECT record_json FROM data_records').record_json,json);
  }
}));
test('reopen and separate process read preserve record and Revision',()=>temporary(async ctx=>{
  const {repo,db,file}=ctx.create('persistent');const saved=await repo.add(v2());db.close();
  assert.deepEqual(await new SimpleDBDataRepository(ctx.open(file),'demo-items').read('a'),saved);
  const r=spawnSync(process.execPath,[path.join(__dirname,'data-migration/child.cjs'),'read',file,'a'],{encoding:'utf8',windowsHide:true,timeout:10000});assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),saved);
}));
test('two processes CAS race after shared barrier: exactly one succeeds',()=>temporary(async ctx=>{
  const {repo,file}=ctx.create('race');const old=await repo.add(v1());
  const children=[0,1].map(()=>{
    const proc=fork(path.join(__dirname,'data-migration/child.cjs'),['race',file,'a',old.revision],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    let resolveReady,rejectReady,value;const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const timer=setTimeout(()=>{rejectReady(Error('timeout'));proc.kill();},10000);
    proc.on('message',m=>{if(m==='READY')resolveReady();else value=m;});
    const done=new Promise((resolve,reject)=>{proc.on('error',reject);proc.on('exit',code=>{clearTimeout(timer);rejectReady(Error('early exit'));code===0?resolve(value):reject(Error('child failed'));});});return {proc,ready,done};
  });
  try{await Promise.all(children.map(c=>c.ready));children.forEach(c=>c.proc.send('GO'));assert.deepEqual((await Promise.all(children.map(c=>c.done))).sort(),['CONFLICT','UPDATED']);}
  finally{children.forEach(c=>{if(c.proc.exitCode===null)c.proc.kill();});await Promise.allSettled(children.map(c=>c.done));}
}));
test('plan tampering is rejected before journal and DB writes',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx),p=await plan(manifest(),source.repo,target.repo);p.items[0].action='UPDATE';const log=journal();
  await assert.rejects(execute(p,source.repo,target.repo,'tampered',log),{code:'INVALID_PLAN'});assert.equal(log.events.length,0);assert.equal(await target.repo.read('a'),null);
}));
test('lost UPDATE response reruns as NO_OP with fresh DB state, not the old source Revision',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx),old=await target.repo.add(v1('a','old'));
  const m=manifest([{id:'a',allowUpdate:true,expectedTarget:await expected(old)}]),p=await plan(m,source.repo,target.repo);let writes=0;
  const lost=wrap(target.repo,{write:async(d,revision)=>{writes++;assert.equal(revision,old.revision);await target.repo.write(d,revision);throw new DataError('OUTCOME_UNKNOWN');}});
  const r=await execute(p,source.repo,lost,'lost-update',journal());assert.equal(r.items[0].status,'OUTCOME_UNKNOWN');assert.equal(r.items[0].reconciliation.matchesExpected,true);assert.equal(writes,1);
  const rerun=await execute(await plan(m,source.repo,target.repo),source.repo,lost,'reconcile-update',journal());assert.equal(rerun.items[0].status,'NO_OP');assert.equal(writes,1);
}));
test('concurrent CREATE cannot overwrite a record created after preflight',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx),p=await plan(manifest(),source.repo,target.repo);
  const race=wrap(target.repo,{add:async d=>{await target.repo.add(v2('a','concurrent'));return target.repo.add(d);}});
  const r=await execute(p,source.repo,race,'create-race',journal());assert.equal(r.items[0].status,'CONFLICT');assert.equal(r.items[0].reason,'ALREADY_EXISTS');assert.deepEqual((await target.repo.read('a')).record,v2('a','concurrent'));
}));
test('file journal fsync failure stops database writes and does not expose OS details',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx),p=await plan(manifest(),source.repo,target.repo);
  const file=path.join(ctx.dir,'failed.jsonl'),log=new FileMigrationJournal(file),sync=fs.fsyncSync;
  fs.fsyncSync=()=>{throw Error('private filesystem path');};
  let r;try{r=await execute(p,source.repo,target.repo,'failed-log',log);}finally{fs.fsyncSync=sync;log.close();}
  assert.equal(r.ok,false);assert.equal(r.reason,'JOURNAL_UNAVAILABLE');assert.equal(await target.repo.read('a'),null);assert.equal(JSON.stringify(r).includes('private'),false);
}));
test('returned Revision and stored Revision must match after UPDATE',()=>temporary(async ctx=>{
  const {source,target}=await setup(ctx),old=await target.repo.add(v1('a','old'));
  const p=await plan(manifest([{id:'a',allowUpdate:true,expectedTarget:await expected(old)}]),source.repo,target.repo);
  const staleReturn=wrap(target.repo,{write:async(d,r)=>{await target.repo.write(d,r);return {record:d,revision:r};}});
  const result=await execute(p,source.repo,staleReturn,'stale-return',journal());assert.equal(result.items[0].reason,'POST_CHECK_MISMATCH');assert.equal(result.items[0].verified,false);assert.equal(result.items[0].writeOutcome,'CONFIRMED_SUCCESS');
}));
