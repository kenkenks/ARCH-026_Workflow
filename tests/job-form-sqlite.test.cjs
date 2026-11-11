'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {CJob,CMemoryHistoryStore}=require('../dist/src/prototype/workflow');
const {createMemoryProductShelf}=require('../dist/src/prototype/job-form');
const {loadWorkflow,validatePrototypeDefinition}=require('../dist/src/prototype/definition');
const {createMockExamJobForms}=require('../dist/src/prototype/mock-exam');
const definitions=require('../src/adapters/workflow-definition/simpledb.cjs');
const business=require('../src/adapters/mock-exam/simpledb.cjs');
const history=require('../src/adapters/workflow-history/simpledb.cjs');
const {SimpleDBError}=require('../src/adapters/simpledb/database.cjs');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function definition(){return {schemaVersion:'prototype-workflow/1',definitionId:'mock-exam',definitionVersion:'v1',startStepId:'member',steps:[{stepId:'member',stepNo:10,kind:'JOB',jobId:'mock.member',nextStepId:'application'},{stepId:'application',stepNo:20,kind:'JOB',jobId:'mock.application',nextStepId:'result'},{stepId:'result',stepNo:30,kind:'JOB',jobId:'mock.result'}]};}
async function fixture(run){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-exp013-')),connections=[];
 const execute=CJob.prototype.execute,jobs=[];
 CJob.prototype.execute=function(){jobs.push(this);return execute.call(this);};
 const files={definition:path.join(dir,'definition.sqlite'),business:path.join(dir,'business.sqlite'),history:path.join(dir,'history.sqlite')};
 function open(kind){const module=kind==='definition'?definitions:kind==='business'?business:history;const db=module.SimpleDB.open(files[kind],module.STORAGE_SCHEMA||module.SCHEMA);connections.push(db);return db;}
 try{
  for(const kind of Object.keys(files)){const module=kind==='definition'?definitions:kind==='business'?business:history;module.SimpleDB.initialize(files[kind],module.STORAGE_SCHEMA||module.SCHEMA);}
  const definitionDB=open('definition'),businessDB=open('business'),historyDB=open('history'),repository=business.seedMockExam(businessDB),definitionRepository=new definitions.SimpleDBWorkflowDefinitionRepository(definitionDB);
  await definitionRepository.add(definition());
  await run({dir,files,open,definitionDB,businessDB,historyDB,repository,definitionRepository,jobs});
 }finally{CJob.prototype.execute=execute;for(const db of connections.reverse())db.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));fs.rmSync(dir,{recursive:true,force:true});}
}
async function reconstruct(f,{runId='run',memberId='M001',applicationId='A001',forms=createMockExamJobForms(f.repository),checks=new Map(),products=createMemoryProductShelf(),store=new history.SQLiteWorkflowHistoryStore(f.historyDB,'mock-exam','v1')}={}){
 products.put('request',{memberId,applicationId});const registry={jobs:new Map(),checks,jobForms:{definitions:forms,products}};
 const loaded=await loadWorkflow(f.definitionRepository,'mock-exam','v1',registry,store);return {...loaded,products,store,runId};
}
test('A seed synthetic members/applications/results; primary/related lookup and absent null across connections',()=>fixture(async f=>{
 const repo=new business.MockExamSQLiteRepository(f.open('business'));assert.deepEqual(await repo.getMember('M001'),{id:'M001',name:'Synthetic M001'});
 const app=await repo.getApplication('A001');assert.deepEqual(app,{id:'A001',memberId:'M001'});assert.deepEqual(await repo.getExamResult(app.id),{applicationId:'A001',result:'PASS',score:85});
 assert.equal((await repo.getExamResult('A002')).result,'FAIL');assert.equal(await repo.getMember('absent'),null);assert.equal(await repo.getApplication('absent'),null);assert.equal(await repo.getExamResult('absent'),null);
 assert.throws(()=>repo.addMember({id:'M001',name:'duplicate'}),e=>e.code==='ALREADY_EXISTS');assert.throws(()=>repo.addApplication({id:'bad',memberId:'unknown'}));assert.equal(await repo.getApplication('bad'),null);
}));
test('B existing immutable Definition repository roundtrips schema/version with a second connection',()=>fixture(async f=>{
 const repo=new definitions.SimpleDBWorkflowDefinitionRepository(f.open('definition')),d=await repo.get('mock-exam','v1');assert.deepEqual(d,definition());assert.deepEqual(validatePrototypeDefinition(d),d);
 await assert.rejects(repo.add(d),e=>e.code==='DEFINITION_ALREADY_EXISTS');assert.equal(await repo.get('missing','v1'),null);assert.equal(JSON.stringify(d).includes('function'),false);
}));
for(const change of ['unknown form','step number','unknown target'])test(`G invalid definition: ${change}`,()=>fixture(async f=>{
 const d=definition();d.definitionId='invalid';if(change==='unknown form')d.steps[0].jobId='unregistered';if(change==='step number')d.steps[0].stepNo='10';if(change==='unknown target')d.steps[0].nextStepId='absent';
 if(change!=='unknown form'){await assert.rejects(f.definitionRepository.add(d),e=>e.code==='INVALID_DEFINITION');assert.equal(await f.definitionRepository.get('invalid','v1'),null);}
 else{await f.definitionRepository.add(d);await assert.rejects(loadWorkflow(f.definitionRepository,'invalid','v1',{jobs:new Map(),checks:new Map(),jobForms:{definitions:createMockExamJobForms(f.repository),products:createMemoryProductShelf()}},new CMemoryHistoryStore()),e=>e.code==='UNSUPPORTED_JOB');}
}));
for(const [memberId,applicationId,outcome]of [['M001','A001','PASS'],['M002','A002','FAIL']])test(`D/E saved definition + forms -> CJobs -> SQLite history: business ${outcome}`,()=>fixture(async f=>{
 const r=await reconstruct(f,{runId:outcome,memberId,applicationId});const result=await r.workflow.run(r.runId,r.startStepNo);assert.equal(result.status,'COMPLETED');assert.deepEqual(result.history.map(h=>[h.stepNo,h.job,h.result]),[[10,'get-member','DONE'],[20,'get-application','DONE'],[30,'get-result','DONE']]);
 assert.equal(r.products.get('member').id,memberId);assert.equal(r.products.get('application').id,applicationId);assert.equal(r.products.get('examResult').result,outcome);
 const other=new history.SQLiteWorkflowHistoryStore(f.open('history'),'mock-exam','v1');assert.deepEqual(other.load(outcome),result);assert.deepEqual(other.getRun(outcome),{definitionId:'mock-exam',definitionVersion:'v1',snapshot:result});assert.equal(other.load('absent'),undefined);
 const rows=f.historyDB.connection.prepare('SELECT trace_order FROM workflow_history WHERE run_id=? ORDER BY trace_order').all(outcome);assert.deepEqual(rows.map(x=>x.trace_order),[1,2,3]);assert.equal(Object.hasOwn(other.getRun(outcome),'startedAt'),false);
}));
test('C persisted loop definition creates fresh CJobs at every visit, shared form identity, history occurrence order',()=>fixture(async f=>{
 const d=definition();d.steps[0].nextStepId='check';d.steps.splice(1,0,{stepId:'check',stepNo:15,kind:'CHECK_BOOL',checkId:'three',trueStepId:'application',falseStepId:'member'});d.definitionVersion='loop';await f.definitionRepository.add(d);
 let visits=0;const forms=createMockExamJobForms(f.repository),original=CJob.prototype.execute,created=[];CJob.prototype.execute=async function(){created.push(this);return original.call(this);};
 try{const products=createMemoryProductShelf();products.put('request',{memberId:'M001',applicationId:'A001'});const store=new history.SQLiteWorkflowHistoryStore(f.historyDB,'mock-exam','loop');
 const loaded=await loadWorkflow(f.definitionRepository,'mock-exam','loop',{jobs:new Map(),checks:new Map([['three',()=>({evaluate:()=>++visits>=3})]]),jobForms:{definitions:forms,products}},store);
 assert.equal(created.length,0);const result=await loaded.workflow.run('loop',loaded.startStepNo);assert.equal(result.status,'COMPLETED');assert.equal(created.length,5);assert.equal(new Set(created).size,5);assert.ok(created.slice(0,3).every(j=>j.form===forms.get('mock.member').form));
 assert.deepEqual(result.history.map(h=>h.stepNo),[10,15,10,15,10,15,20,30]);assert.deepEqual(created.slice(0,3).map(j=>j.getState().status),['COMPLETED','COMPLETED','COMPLETED']);assert.deepEqual(created[0].getRecorded(),{value:{id:'M001',name:'Synthetic M001'}});
 const other=new history.SQLiteWorkflowHistoryStore(f.open('history'),'mock-exam','loop');assert.deepEqual(other.load('loop'),result);
 }finally{CJob.prototype.execute=original;}
}));
for(const order of ['sequential','PASS-first','FAIL-first'])test(`F shared forms and saved definition, distinct connections/run state: ${order}`,()=>fixture(async f=>{
 const entered={M001:deferred(),M002:deferred()},release={M001:deferred(),M002:deferred()};const port={getMember:async id=>{const value=await f.repository.getMember(id);if(order!=='sequential'){entered[id].resolve();await release[id].promise;}return value;},getApplication:id=>f.repository.getApplication(id),getExamResult:id=>f.repository.getExamResult(id)};
 const forms=createMockExamJobForms(port),a=await reconstruct(f,{runId:'run-001',forms}),b=await reconstruct(f,{runId:'run-002',forms,memberId:'M002',applicationId:'A002',store:new history.SQLiteWorkflowHistoryStore(f.open('history'),'mock-exam','v1')});
 let x,y;if(order==='sequential'){x=await a.workflow.run(a.runId,a.startStepNo);y=await b.workflow.run(b.runId,b.startStepNo);}else{
 const pa=a.workflow.run(a.runId,a.startStepNo),pb=b.workflow.run(b.runId,b.startStepNo);await Promise.all([entered.M001.promise,entered.M002.promise]);
 const [first,second,pf,ps]=order==='PASS-first'?['M001','M002',pa,pb]:['M002','M001',pb,pa];release[first].resolve();assert.equal((await pf).status,'COMPLETED');assert.equal(a.store.load(second==='M001'?a.runId:b.runId).status,'RUNNING');release[second].resolve();await ps;x=await pa;y=await pb;
 }
 assert.equal(x.status,'COMPLETED');assert.equal(y.status,'COMPLETED');assert.equal(a.products.get('examResult').result,'PASS');assert.equal(b.products.get('examResult').result,'FAIL');assert.notStrictEqual(a.products,b.products);assert.deepEqual(a.store.load(a.runId),x);assert.deepEqual(b.store.load(b.runId),y);
 assert.equal(f.jobs.length,6);assert.equal(new Set(f.jobs).size,6);assert.ok(f.jobs.every(j=>j.getState().status==='COMPLETED'));assert.equal(f.jobs.filter(j=>j.form===forms.get('mock.member').form).length,2);
}));
for(const [name,memberId,applicationId,step]of [['member','absent','A001',10],['application','M001','absent',20],['result','M001','A003',30]])test(`G missing ${name} becomes distinct BUSINESS_NOT_FOUND and persisted FAILED`,()=>fixture(async f=>{
 if(name==='result')f.repository.addApplication({id:'A003',memberId:'M001'});
 const r=await reconstruct(f,{runId:name,memberId,applicationId}),result=await r.workflow.run(r.runId,r.startStepNo);assert.equal(result.status,'FAILED');assert.equal(result.currentStepNo,step);assert.match(result.history.at(-1).error,/BUSINESS_NOT_FOUND/);assert.equal(result.history.at(-1).result,'ERROR');
 assert.deepEqual(new history.SQLiteWorkflowHistoryStore(f.open('history'),'mock-exam','v1').load(name),result);
}));
test('G closed business DB read is a technical UNAVAILABLE, persisted separately from not-found',()=>fixture(async f=>{
 const r=await reconstruct(f,{runId:'read-error'});f.businessDB.close();const result=await r.workflow.run(r.runId,r.startStepNo);assert.equal(result.status,'FAILED');assert.match(result.history[0].error,/UNAVAILABLE/);assert.doesNotMatch(result.history[0].error,/BUSINESS_NOT_FOUND/);assert.deepEqual(r.store.load(r.runId),result);
}));
test('G actual query_only DB write error does not damage previous stored run',()=>fixture(async f=>{
 const good=await reconstruct(f,{runId:'good'}),saved=await good.workflow.run(good.runId,good.startStepNo);f.historyDB.connection.exec('PRAGMA query_only=ON');
 const r=await reconstruct(f,{runId:'write-error'});await assert.rejects(r.workflow.run(r.runId,r.startStepNo),e=>e.code==='HISTORY_SAVE_OUTCOME_UNKNOWN'&&e.attemptedSnapshot.status==='RUNNING');assert.equal(r.products.has('member'),false);
 const other=new history.SQLiteWorkflowHistoryStore(f.open('history'),'mock-exam','v1');assert.equal(other.load('write-error'),undefined);assert.deepEqual(other.load('good'),saved);
}));
test('G business execution failure and failure-history persistence failure are distinct events',()=>fixture(async f=>{
 const root=Error('injected repository read failure'),port={getMember:async()=>{f.historyDB.connection.exec('PRAGMA query_only=ON');throw root;},getApplication:id=>f.repository.getApplication(id),getExamResult:id=>f.repository.getExamResult(id)};
 const r=await reconstruct(f,{runId:'double-failure',forms:createMockExamJobForms(port)});
 await assert.rejects(r.workflow.run(r.runId,r.startStepNo),e=>{assert.equal(e.code,'HISTORY_SAVE_OUTCOME_UNKNOWN');assert.strictEqual(e.cause,root);assert.equal(e.storageCause.code,'UNAVAILABLE');assert.equal(e.attemptedSnapshot.status,'FAILED');assert.equal(e.attemptedSnapshot.history[0].result,'ERROR');return true;});
 const persisted=new history.SQLiteWorkflowHistoryStore(f.open('history'),'mock-exam','v1').load('double-failure');assert.equal(persisted.status,'RUNNING');assert.deepEqual(persisted.history,[]);
}));
test('E run+history transaction rolls back as a unit; completed history is append-only and corrupt rows are detected',()=>fixture(async f=>{
 const r=await reconstruct(f,{runId:'integrity'}),result=await r.workflow.run(r.runId,r.startStepNo);const bad=structuredClone(result);bad.history[0].job='changed';assert.throws(()=>r.store.save(bad),e=>e.code==='HISTORY_CONFLICT');assert.deepEqual(r.store.load(r.runId),result);
 const old=f.historyDB.run.bind(f.historyDB);f.historyDB.run=(sql,...params)=>{if(sql.startsWith('INSERT INTO workflow_history'))throw new SimpleDBError('UNAVAILABLE');return old(sql,...params);};
 try{assert.throws(()=>r.store.save({...result,runId:'atomic'}));}finally{f.historyDB.run=old;}
 assert.equal(r.store.load('atomic'),undefined);f.historyDB.run('UPDATE workflow_history SET job_name=? WHERE run_id=? AND trace_order=1','corrupt',r.runId);assert.throws(()=>r.store.load(r.runId),e=>e.code==='DATA_CORRUPT');
}));
test('E beforeStep failure metadata and optional trace metadata survive JSON/SQL projection',()=>fixture(async f=>{
 const r=await reconstruct(f,{runId:'hook'});await assert.rejects(r.workflow.run(r.runId,r.startStepNo,100,async()=>{throw Error('hook');}),e=>e.code==='BEFORE_STEP_FAILED');
 const snapshot=new history.SQLiteWorkflowHistoryStore(f.open('history'),'mock-exam','v1').load('hook');assert.equal(snapshot.status,'FAILED');assert.deepEqual(snapshot.history,[]);assert.equal(snapshot.failure.code,'BEFORE_STEP_FAILED');
 const enriched={runId:'metadata',status:'COMPLETED',currentStepNo:null,executionMode:'DEMO',history:[{order:1,stepNo:10,job:'synthetic',result:'DONE',nextStepNo:null,at:'2026-11-08T00:00:00Z',simulated:true}]};r.store.save(enriched);assert.deepEqual(r.store.load('metadata'),enriched);
}));
test('B/G registry ambiguity rejects before Job execution; DB family mismatch never upgrades a file',()=>fixture(async f=>{
 const forms=createMockExamJobForms(f.repository),products=createMemoryProductShelf();
 await assert.rejects(loadWorkflow(f.definitionRepository,'mock-exam','v1',{jobs:new Map([['mock.member',()=>{throw Error('must not construct');}]]),checks:new Map(),jobForms:{definitions:forms,products}},new CMemoryHistoryStore()),e=>e.code==='AMBIGUOUS_JOB');assert.equal(f.jobs.length,0);
 const before=fs.readFileSync(f.files.business);assert.throws(()=>history.SimpleDB.open(f.files.business,history.SCHEMA),e=>e.code==='STORAGE_SCHEMA_MISMATCH');assert.deepEqual(fs.readFileSync(f.files.business),before);
}));
test('E history run identity cannot silently switch its Definition Version',()=>fixture(async f=>{
 const r=await reconstruct(f,{runId:'identity'}),result=await r.workflow.run(r.runId,r.startStepNo);
 const other=new history.SQLiteWorkflowHistoryStore(f.open('history'),'mock-exam','different');assert.throws(()=>other.load('identity'),e=>e.code==='HISTORY_IDENTITY_MISMATCH');assert.throws(()=>other.save(result),e=>e.code==='HISTORY_IDENTITY_MISMATCH');assert.deepEqual(r.store.load('identity'),result);
}));
