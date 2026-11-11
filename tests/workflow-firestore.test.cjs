'use strict';
const {test,after,before}=require('node:test'),assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto'),{fork}=require('node:child_process');
const {connectEmulator,validateEnvironment,leaseValid,Timestamp}=require('../src/adapters/workflow-firestore/emulator.cjs');
const {FirestoreExperimentStore,hash}=require('../src/adapters/workflow-firestore/store.cjs');
const {createExecution}=require('../src/adapters/workflow-firestore/composition.cjs');
const {definition,registry}=require('./workflow-firestore/scenario.cjs');
const config={FIRESTORE_EMULATOR_HOST:process.env.FIRESTORE_EMULATOR_HOST,projectId:'demo-arch026-c2',namespace:'c2-'+randomUUID()};
let connection;const children=new Set();
before(async()=>{connection=await connectEmulator(config);});
after(async()=>{for(const c of children)c.kill();if(connection){await connection.db.recursiveDelete(connection.root);await connection.close();}});
const fresh=(id=randomUUID(),options)=>new FirestoreExperimentStore(connection,id,options);
const code=expected=>e=>e.code===expected;
const change=s=>({definitionId:definition.definitionId,definitionVersion:'1',definitionDigest:hash(definition),snapshot:{runId:s.runId,currentStepNo:1,status:'RUNNING',history:[]},jobs:[],artifacts:[]});
function request(child,msg){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',done);reject(Error('child timeout'));},30000);const done=x=>{clearTimeout(timer);resolve(x);};child.once('message',done);child.send(msg);});}
async function host(){const child=fork(require.resolve('./workflow-firestore/child.cjs'),[],{stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,FIRESTORE_EMULATOR_HOST:config.FIRESTORE_EMULATOR_HOST}});children.add(child);assert.deepEqual(await request(child,{action:'init',config}),{ready:true});return child;}
function kill(c){c.kill();children.delete(c);}
test('S01 safety: missing/remote host and non-demo project rejected before SDK',()=>{
 for(const FIRESTORE_EMULATOR_HOST of [undefined,'localhost:8692','8.8.8.8:8692','http://127.0.0.1:8692','127.0.0.1:99999'])assert.throws(()=>validateEnvironment({...config,FIRESTORE_EMULATOR_HOST}),code('EMULATOR_REQUIRED'));
 assert.throws(()=>validateEnvironment({...config,projectId:'production'}),code('DEMO_PROJECT_REQUIRED'));
 assert.throws(()=>validateEnvironment({...config,namespace:'business'}),code('NAMESPACE_REQUIRED'));
});
test('S02 safety: unavailable emulator and ambient mismatch fail closed',async()=>{
 await assert.rejects(connectEmulator({...config,FIRESTORE_EMULATOR_HOST:'127.0.0.1:1'}),code('EMULATOR_ENV_MISMATCH'));
 const old=process.env.FIRESTORE_EMULATOR_HOST;process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:1';
 try{await assert.rejects(connectEmulator({...config,FIRESTORE_EMULATOR_HOST:'127.0.0.1:1'}),code('EMULATOR_UNAVAILABLE'));}finally{process.env.FIRESTORE_EMULATOR_HOST=old;}
});
test('A01 Definition create-only and versions',async()=>{const s=fresh();await s.add(definition);assert.deepEqual(await s.get(definition.definitionId,'1'),definition);
 await assert.rejects(s.add(definition),code('DEFINITION_ALREADY_EXISTS'));await s.add({...definition,definitionVersion:'2'});assert.equal((await s.get(definition.definitionId,'2')).definitionVersion,'2');assert.equal(await s.get('absent','1'),null);});
test('A02 nonasync Registry, actual async CMRP, record/post boundary and persisted completion',async()=>{
 const s=fresh();await s.claim('host-a');const observations=[];let release,entered;const enteredPromise=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const calls=[];
 const execution=await createExecution(s,definition,registry(async id=>{calls.push(id);if(id==='a'){entered();await gate;}}),new Map([['yes',()=>({evaluate:()=>true})]]),{observe:x=>observations.push(x)});
 const running=execution.run();await enteredPromise;const during=await s.inspect();assert.equal(during.head.snapshot.status,'RUNNING');assert.equal(during.jobs[0].phase,'collect');assert.equal(during.artifacts.length,0);release();
 const result=await running;assert.equal(result.status,'COMPLETED');assert.deepEqual(calls,['a','b','c']);assert.deepEqual(observations.map(x=>x.published),[false,false,false]);
 const read=await s.inspect();assert.equal(read.head.snapshot.status,'COMPLETED');assert.deepEqual(read.history.map(h=>h.result),['DONE','DONE','TRUE','DONE']);assert.equal(read.jobs.length,3);assert.equal(new Set(read.jobs.map(j=>j.jobExecutionId)).size,3);
 assert.ok(read.jobs.every(j=>j.status==='COMPLETED'));assert.deepEqual(read.artifacts.filter(a=>a.kind==='PUBLISHED').map(a=>a.value),[10,20,30]);assert.equal(read.artifacts.filter(a=>a.kind==='INTERNAL').length,3);assert.equal(execution.products.get('C'),30);
});
test('A03 asynchronous rejection yields FAILED/ERROR, no publication for failed Job',async()=>{
 const s=fresh();await s.claim('host');const e=await createExecution(s,definition,registry(()=>{},'a'),new Map([['yes',()=>({evaluate:()=>true})]]));assert.equal((await e.run()).status,'FAILED');const state=await s.inspect();assert.equal(state.jobs[0].status,'FAILED');assert.equal(state.history[0].result,'ERROR');assert.equal(state.artifacts.length,0);
 await assert.rejects(createExecution(s,definition,registry(),new Map(),{resume:true}),code('RESUME_REJECTED'));
});
test('B01 atomic simultaneous Claim in separate processes: one winner, loser no execution',async()=>{
 const a=await host(),b=await host(),runId=randomUUID();try{const results=await Promise.all([request(a,{action:'claim',runId,owner:'a'}),request(b,{action:'claim',runId,owner:'b'})]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.filter(r=>r.code==='CLAIM_BUSY').length,1);
 const state=await fresh(runId).inspect();assert.equal(state.owner.fence,1);assert.equal(state.head,null);assert.equal(state.jobs.length,0);
 }finally{kill(a);kill(b);}
});
test('B02 simultaneous Heartbeats retain one ownership generation',async()=>{const s=fresh();await s.claim('host');await Promise.all([s.heartbeat(),s.heartbeat()]);const o=(await s.inspect()).owner;assert.equal(o.fence,1);assert.equal(o.token,s.credential.token);});
test('C01 wrong claimToken and old fence reject run/history/artifact atomic payload',async()=>{
 const s=fresh();await s.claim('host');const real=s.credential;await s.commit(change(s));const before=await s.inspect();
 for(const credential of [{...real,token:'wrong'},{...real,fence:0}]){s.credential=credential;await assert.rejects(s.commit(change(s)),code('FENCED'));assert.deepEqual((await s.inspect()).head,before.head);}s.credential=real;
});
test('D01 server readTime expiry and explicit administrative Takeover; stale writes rejected',async()=>{
 const s=fresh();await s.claim('old');await s.commit(change(s));
 // Isolated fixture: force expired server timestamp without relying on sleeps or Host clock.
 const read=await s.owner.get();await s.owner.update({expiresAt:Timestamp.fromMillis(read.readTime.toMillis()-1)});
 await assert.rejects(s.commit(change(s)),code('LEASE_EXPIRED'));await assert.rejects(s.heartbeat(),code('LEASE_EXPIRED'));
 const newer=fresh(s.runId);await assert.rejects(newer.claim('new'),code('ADMINISTRATIVE_TAKEOVER_REQUIRED'));
 const next=await newer.claim('new',{administrativeTakeover:true});assert.equal(next.fence,2);
 await assert.rejects(s.commit(change(s)),code('FENCED'));await assert.rejects(s.release(),code('FENCED'));
 await newer.load(newer.runId);await newer.commit(change(newer));assert.equal((await newer.inspect()).owner.fence,2);
});
test('D02 clock rollback/advance cannot affect readTime comparison; equality expires',()=>{
 const old=Date.now;try{for(const clock of [0,Number.MAX_SAFE_INTEGER]){Date.now=()=>clock;const now=new Timestamp(100,500);assert.equal(leaseValid(new Timestamp(100,501),now),true);assert.equal(leaseValid(new Timestamp(100,500),now),false);assert.equal(leaseValid(new Timestamp(99,999),now),false);}}finally{Date.now=old;}
 assert.throws(()=>leaseValid(new Timestamp(100,0),null),code('CLOCK_UNAVAILABLE'));
});
test('F01 cross-process checkpoint resume: A/B and Check not repeated, only C executes',async()=>{
 const runId=randomUUID(),a=await host();const first=await request(a,{action:'slice',runId,owner:'slice'});assert.equal(first.ok,true,first.code);assert.equal(first.result.status,'LIMIT_REACHED');assert.deepEqual(first.makes,['a','b']);kill(a);
 const before=await fresh(runId).inspect(),ids=before.jobs.map(j=>j.jobExecutionId);assert.deepEqual(before.history.map(h=>h.result),['DONE','DONE','TRUE']);
 const b=await host();try{const result=await request(b,{action:'resume',runId,owner:'resume'});assert.equal(result.ok,true,result.code);assert.equal(result.result.status,'COMPLETED');assert.deepEqual(result.makes,['c']);const after=await fresh(runId).inspect();assert.deepEqual(after.history.slice(0,3),before.history);assert.ok(ids.every(id=>after.jobs.some(j=>j.jobExecutionId===id)));assert.equal(new Set(after.jobs.map(j=>j.jobExecutionId)).size,3);assert.equal(after.artifacts.filter(a=>a.kind==='PUBLISHED').at(-1).value,30);}finally{kill(b);}
});
test('G01 commit response loss is UNKNOWN; receipt readback is observation; no retry',async()=>{
 const s=fresh();await s.claim('host');await assert.rejects(s.commit(change(s),{afterCommit:()=>{throw Error('lost response');}}),code('OUTCOME_UNKNOWN'));assert.equal(s.poisoned,true);assert.equal((await s.observeMutation(s.lastMutationId)).state,'PRESENT');assert.equal((await s.inspect()).head.snapshot.status,'RUNNING');await assert.rejects(s.commit(change(s)),code('PERSISTENCE_UNCERTAIN'));
});
test('G02 precommit failure commits no run, history or artifacts',async()=>{const s=fresh();await s.claim('host');await assert.rejects(s.commit(change(s),{beforeCommit:()=>{throw Error('before commit');}}),code('OUTCOME_UNKNOWN'));assert.equal((await s.inspect()).head,null);assert.equal((await s.observeMutation(s.lastMutationId)).state,'ABSENT');});
test('G03 stale head revision refuses concurrent operation, preserves committed state',async()=>{const s=fresh();await s.claim('host');await s.commit(change(s));const other=fresh(s.runId);other.credential=s.credential;await other.load(s.runId);await s.commit(change(s));await assert.rejects(other.commit(change(other)),code('RUN_CHANGED'));});
test('G05 UNKNOWN/RUNNING is not a resume boundary',async()=>{const s=fresh();await s.claim('host');await s.commit(change(s));await assert.rejects(createExecution(s,definition,registry(),new Map(),{resume:true}),code('RESUME_REJECTED'));});
test('C02 stale Host cannot append history, job or artifact after takeover',async()=>{
 const s=fresh();await s.claim('old');await s.commit(change(s));const o=await s.owner.get();await s.owner.update({expiresAt:Timestamp.fromMillis(o.readTime.toMillis()-1)});
 const n=fresh(s.runId);await n.claim('new',{administrativeTakeover:true});const before=await n.inspect();
 const job={jobExecutionId:randomUUID(),runId:s.runId,stepId:'a',stepNo:1,jobFormId:'a',iterationNo:1,status:'COMPLETED',phase:'post'};
 const payload=change(s);payload.snapshot={runId:s.runId,status:'COMPLETED',currentStepNo:null,history:[{order:1,stepNo:1,job:'a',result:'DONE',nextStepNo:null,at:'2026-01-01T00:00:00Z'}]};payload.jobs=[job];payload.artifacts=[{jobExecutionId:job.jobExecutionId,artifactKey:'X',kind:'PUBLISHED',type:'number',value:10,publicationEvidence:'RETURNED'}];
 await assert.rejects(s.commit(payload),code('FENCED'));const after=await n.inspect();assert.deepEqual(after.head,before.head);assert.deepEqual(after.history,before.history);assert.deepEqual(after.jobs,before.jobs);assert.deepEqual(after.artifacts,before.artifacts);
});
test('G06 Firestore callback retry does not execute a Job again',async()=>{
 const s=fresh();await s.claim('host');let callbacks=0,makes=0;
 const commit=s.commit.bind(s);let injected=false;
 s.commit=(changes,options)=>{if(!injected){injected=true;return commit(changes,{...options,onAttempt:()=>{callbacks++;if(callbacks===1)throw Object.assign(Error('synthetic ABORTED before reads'),{code:10});}});}return commit(changes,options);};
 const e=await createExecution(s,definition,registry(()=>{makes++;}),new Map([['yes',()=>({evaluate:()=>true})]]));assert.equal((await e.run()).status,'COMPLETED');assert.equal(makes,3);assert.equal(callbacks,2);assert.equal((await s.inspect()).history.length,4);
});
test('G07 load snapshots are independent, persisted Schema corruption rejected',async()=>{
 const s=fresh();await s.claim('host');await s.commit(change(s));const a=await s.load(s.runId),b=await s.load(s.runId);a.history.push({});a.status='FAILED';assert.equal(b.status,'RUNNING');assert.equal((await s.load(s.runId)).history.length,0);
 await s.run.update({schemaVersion:999});await assert.rejects(s.inspect(),code('SCHEMA_MISMATCH'));
});
test('G08 payload bound fails before protected writes',async()=>{const s=fresh();await s.claim('host');const c=change(s);c.extra='x'.repeat(65536);await assert.rejects(s.commit(c),code('PAYLOAD_TOO_LARGE'));assert.equal((await s.inspect()).head,null);});

// Crash transactions can retain Emulator locks until its timeout; run these last.
for(const action of ['killBefore','killDuring'])test(`G04 ${action}: child termination exposes no partial protected write`,async()=>{const runId=randomUUID(),c=await host();assert.deepEqual(await request(c,{action,runId,owner:'crash'}),{barrier:true});kill(c);const state=await fresh(runId).inspect();assert.equal(state.head,null);assert.equal(state.history.length,0);assert.equal(state.artifacts.length,0);assert.equal(state.jobs.length,0);});
