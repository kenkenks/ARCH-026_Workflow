'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {api,definition,options,registry,start,request,raw,WaitingHistoryStore,SQLiteLifecycleBackend}=require('./workflow-artifact-resume/scenario.cjs');
async function fixture(fn,kind='LIMIT_REACHED'){
 const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'execution-owner-')),file=path.join(dir,'test.sqlite');SQLiteLifecycleBackend.initialize(file);
 const backend=new SQLiteLifecycleBackend(file),d=definition(kind),store=new WaitingHistoryStore(backend,options(d));
 try{await start(store,d);await fn({store,d,backend,file});}finally{store.close();if(path.dirname(path.resolve(dir))!==parent||!path.basename(dir).startsWith('execution-owner-'))throw Error('UNSAFE_FIXTURE');fs.rmSync(dir,{recursive:true,force:true});}
}
test('lease expires during beforeStep: no q execution and no checkpoint advance',()=>fixture(async({store,d})=>{
 store.leaseMs=1000;const calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store);let boundary;
 await a.rejects(g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint),100,async()=>{boundary=store.read();await new Promise(r=>setTimeout(r,1100));}),e=>e.code==='EXECUTION_OWNERSHIP_REFUSED'&&e.cause.code==='LEASE_EXPIRED');
 a.deepEqual(calls,[]);a.deepEqual(store.read(),boundary);a.equal(store.readCheckpoint().workflowSnapshot.status,'RUNNING');
}));
const refused=code=>e=>e.code==='EXECUTION_OWNERSHIP_REFUSED'&&e.outcome==='REFUSED'&&e.cause.code===code;
const unknown=code=>e=>e.code==='EXECUTION_OWNERSHIP_UNKNOWN'&&e.outcome==='UNKNOWN'&&e.cause.code===code;
function write(backend,row){backend.database.run('UPDATE waiting_runs SET state_json=? WHERE run_id=?',JSON.stringify(row),'run');}
test('valid ownership permits execution and authoritative checks do not mutate the row',()=>fixture(async({store,d})=>{
 const calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store),verify=store.assertCanExecuteStep.bind(store);let checks=0;
 store.assertCanExecuteStep=s=>{const before=store.read();verify(s);a.deepEqual(store.read(),before);checks++;};
 a.equal((await g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint))).status,'COMPLETED');a.deepEqual(calls,['q']);a.ok(checks>=2);
}));
for(const [label,mutate,code]of [
 ['owner',r=>{r.owner.ownerId='different-host';r.owner.token='different-token';r.owner.fence++;},'FENCED'],
 ['Revision',r=>{r.revision++;r.checkpoint.revision++;},'REVISION_CONFLICT'],
 ['operation',r=>{r.operations.push({operationId:'replacement',kind:'START',status:'RUNNING'});r.activeOperationId='replacement';r.checkpoint.operationIdentifier='replacement';},'OPERATION_CONFLICT'],
 ['execution position',r=>{r.snapshot.currentStepNo=10;r.checkpoint.workflowSnapshot.currentStepNo=10;},'RESUME_STATE_CHANGED']
])test('changed '+label+' after beforeStep refuses q without overwriting checkpoint',()=>fixture(async({store,d,backend})=>{
 const calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store);let changed;
 await a.rejects(g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint),100,()=>{const row=raw(backend);mutate(row);write(backend,row);changed=store.read();}),refused(code));
 a.deepEqual(calls,[]);a.deepEqual(store.read(),changed);
}));
test('new host obtains a real claim during a released boundary: old host executes no q and cannot save',()=>fixture(async({store,d,backend})=>{
 const calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store);let claimed;
 await a.rejects(g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint),100,async()=>{
  const s=store.load('run');store.saveCheckpoint({...s,status:'LIMIT_REACHED'},g.artifacts.createSnapshot());
  const next=new WaitingHistoryStore(backend,options(d,'run','new-host')),restored=await api.restoreWorkflowCheckpoint(d,registry(next),next);
  await next.claimCheckpoint(restored.checkpoint,d,restored.artifacts.createSnapshot(),request(restored.checkpoint,'new-host-operation'));claimed=next.read();
 }),refused('FENCED'));
 a.deepEqual(calls,[]);a.deepEqual(store.read(),claimed);a.throws(()=>store.saveCheckpoint(claimed.snapshot,g.artifacts.createSnapshot()),{code:'FENCED'});a.deepEqual(store.read(),claimed);
}));
test('WAITING Check evaluation is guarded after beforeStep',()=>fixture(async({store,d,backend})=>{
 const calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store);let changed;
 await a.rejects(g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint),100,()=>{const row=raw(backend);row.owner.expiresAt=0;write(backend,row);changed=store.read();}),refused('LEASE_EXPIRED'));
 a.deepEqual(calls,[]);a.deepEqual(store.read(),changed);
},'WAITING'));
test('an already stale host cannot invoke the optional beforeStep hook',()=>fixture(async({store,d,backend})=>{
 const calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store),save=store.saveCheckpoint.bind(store);let hookCalls=0,changed;
 store.saveCheckpoint=(...args)=>{save(...args);const row=raw(backend);row.owner.expiresAt=0;write(backend,row);changed=store.read();};
 await a.rejects(g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint),100,()=>{hookCalls++;}),refused('LEASE_EXPIRED'));a.equal(hookCalls,0);a.deepEqual(calls,[]);a.deepEqual(store.read(),changed);
}));
test('Factory side effects cannot skip the final ownership check before execute',()=>fixture(async({store,d,backend})=>{
 let jobs=0,factories=0;class Form extends api.CJobForm{collect(){jobs++;return 1;}make(v){return v;}}
 // Use a fresh synthetic execution rather than reusing a saved run ID.
 const second=new WaitingHistoryStore(backend,options(d,'factory-run'));
 second.claimStart();const f=new api.CWorkflow([{no:10,createJob:()=>{factories++;const row=JSON.parse(backend.database.get('SELECT state_json FROM waiting_runs WHERE run_id=?','factory-run').state_json);row.owner.expiresAt=0;backend.database.run('UPDATE waiting_runs SET state_json=? WHERE run_id=?',JSON.stringify(row),'factory-run');return new Form('never');}}],second);
 await a.rejects(f.run('factory-run',10),refused('LEASE_EXPIRED'));a.equal(factories,1);a.equal(jobs,0);
}));
for(const code of ['UNAVAILABLE','OUTCOME_UNKNOWN'])test('backend inspection '+code+' is UNKNOWN and never executes or repairs',()=>fixture(async({store,d,backend})=>{
 const calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store),inspect=backend.inspect.bind(backend);let before;
 await a.rejects(g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint),100,()=>{before=store.read();backend.inspect=()=>{throw Object.assign(Error(code),{code});};}),unknown(code));
 a.deepEqual(calls,[]);a.deepEqual(store.read(),before);backend.inspect=inspect;
}));
test('poisoned persistence is UNKNOWN, not a definite lease loss',()=>fixture(async({store,d})=>{
 const calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store);let before;
 await a.rejects(g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint),100,()=>{before=store.read();store.poisoned=true;}),unknown('PERSISTENCE_UNCERTAIN'));a.deepEqual(calls,[]);a.deepEqual(store.read(),before);
}));
test('missing required Port refuses reconstruction and execution before claim or save',()=>fixture(async({store,d})=>{
 const calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store),before=store.read();store.assertCanExecuteStep=undefined;
 await a.rejects(api.restoreWorkflowCheckpoint(d,registry(store,calls),store),{code:'EXECUTION_OWNERSHIP_REQUIRED'});
 await a.rejects(g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint)),{code:'EXECUTION_OWNERSHIP_REQUIRED'});
 await a.rejects(g.workflow.run('run',g.startStepNo),{code:'EXECUTION_OWNERSHIP_REQUIRED'});a.deepEqual(calls,[]);a.deepEqual(store.read(),before);
}));
test('runId mismatch is refused by the authoritative execution Port',()=>fixture(async({store,d})=>{
 const g=await api.restoreWorkflowCheckpoint(d,registry(store),store);await store.claimCheckpoint(g.checkpoint,d,g.artifacts.createSnapshot(),request(g.checkpoint));const before=store.read();a.throws(()=>store.assertCanExecuteStep({...before.snapshot,runId:'wrong'}),{code:'RUN_MISMATCH'});a.deepEqual(store.read(),before);
}));
test('Memory-only Workflow needs no ownership Port or SQLite',async()=>{
 let executions=0;const store=new api.CMemoryHistoryStore(),f=new api.CWorkflow([{no:1,job:new api.CDummyJob('memory',()=>{executions++;})}],store);a.equal((await f.run('memory',1)).status,'COMPLETED');a.equal(executions,1);a.equal(store.assertCanExecuteStep,undefined);
});
test('SQLite timestamp is used instead of a host Date.now override',()=>fixture(async({store,d})=>{
 const g=await api.restoreWorkflowCheckpoint(d,registry(store),store);await store.claimCheckpoint(g.checkpoint,d,g.artifacts.createSnapshot(),request(g.checkpoint));const before=store.read(),now=Date.now;
 try{Date.now=()=>Number.MAX_SAFE_INTEGER;store.assertCanExecuteStep(before.snapshot);}finally{Date.now=now;}a.deepEqual(store.read(),before);
}));
test('Port disconnected by beforeStep cannot silently switch to Memory execution',()=>fixture(async({store,d})=>{
 const calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store);let before;
 await a.rejects(g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint),100,()=>{before=store.read();store.assertCanExecuteStep=undefined;}),refused('EXECUTION_OWNERSHIP_REQUIRED'));a.deepEqual(calls,[]);a.deepEqual(store.read(),before);
}));
test('closed SQLite connection makes inspection UNKNOWN without invoking q',()=>fixture(async({store,d,file})=>{
 const observer=new WaitingHistoryStore(new SQLiteLifecycleBackend(file),options(d)),calls=[],g=await api.restoreWorkflowCheckpoint(d,registry(store,calls),store);let before;
 try{await a.rejects(g.workflow.resumeCheckpoint(g.checkpoint,request(g.checkpoint),100,()=>{before=observer.read();store.close();}),unknown('UNAVAILABLE'));a.deepEqual(calls,[]);a.deepEqual(observer.read(),before);}finally{observer.close();}
}));
