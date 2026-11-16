'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),{fork}=require('node:child_process');
const {api,definition,options,registry,start,request,WaitingHistoryStore,SQLiteLifecycleBackend}=require('./workflow-artifact-resume/scenario.cjs');
const project=c=>{const {token,...owner}=c.owner;return {...c,owner:{...owner,tokenSha256:crypto.createHash('sha256').update(token).digest('hex')}};};
async function fixture(fn,kind='LIMIT_REACHED'){
 const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'arch-c05-c10-')),file=path.join(dir,'workflow.sqlite'),ledger=path.join(dir,'effects.jsonl'),children=[],d=definition(kind);SQLiteLifecycleBackend.initialize(file);
 const store=new WaitingHistoryStore(new SQLiteLifecycleBackend(file),options(d,'run','setup'));
 const read=()=>{const s=new WaitingHistoryStore(new SQLiteLifecycleBackend(file),options(d));try{return s.readCheckpoint();}finally{s.close();}};
 const effects=()=>fs.existsSync(ledger)?fs.readFileSync(ledger,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
 function launch(input){
  const child=fork(path.join(__dirname,'stage22c-claim-states/child.cjs'),[JSON.stringify({file,ledger,kind,...input})],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});children.push(child);child.stdout.resume();let stderr='',result,readyResolve,readyReject,outcomeResolve;
  const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});ready.catch(()=>{});const outcome=new Promise(resolve=>outcomeResolve=resolve);
  const done=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill();const e=Error('CHILD_TIMEOUT '+stderr);readyReject(e);reject(e);},12000);
   child.stderr.on('data',b=>stderr+=b);child.on('message',m=>{if(m.phase==='READY')readyResolve(m);else if(m.phase==='CLAIMED')outcomeResolve({claimed:m});else result=m;});
   child.once('error',e=>{clearTimeout(timer);readyReject(e);reject(e);});child.once('exit',(code,signal)=>{clearTimeout(timer);const value={code,signal,result,stderr};readyReject(Error('NO_READY'));outcomeResolve({finished:value});resolve(value);});
  });done.catch(()=>{});return {ready,outcome,done,go:()=>child.send({go:true})};
 }
 try{await fn({store,d,file,ledger,read,effects,launch});}finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill();await ended;}store.close();if(path.dirname(path.resolve(dir))!==parent||!path.basename(dir).startsWith('arch-c05-c10-'))throw Error('UNSAFE_FIXTURE');fs.rmSync(dir,{recursive:true,force:true});}
}
for(const sameId of [true,false])test('C05: simultaneous claim with '+(sameId?'same':'different')+' operation IDs',()=>fixture(async({store,d,read,effects,launch})=>{
 await start(store,d);const initial=project(read()),leftId=sameId?'shared-operation':'left-operation',rightId=sameId?'shared-operation':'right-operation';
 const left=launch({host:'left',operationId:leftId,barrier:true,hold:true}),right=launch({host:'right',operationId:rightId,barrier:true,hold:true});
 const inspected=await Promise.all([left.ready,right.ready]);a.deepEqual(inspected[0].checkpoint,initial);a.deepEqual(inspected[1].checkpoint,initial);left.go();right.go();
 const outcomes=await Promise.all([left.outcome,right.outcome]),winnerIndex=outcomes.findIndex(o=>o.claimed),loserIndex=winnerIndex===0?1:0;
 a.equal(outcomes.filter(o=>o.claimed).length,1);a.ok(outcomes[loserIndex].finished);const held=outcomes[winnerIndex].claimed,loser=outcomes[loserIndex].finished.result,current=project(read());
 a.equal(loser.ok,false);a.equal(loser.counts.started,0);a.equal(loser.credentialPresent,false);a.equal(loser.code,sameId?'OPERATION_IN_PROGRESS':'REVISION_CONFLICT');a.deepEqual(current,held.checkpoint);
 a.equal(current.owner.state,'ACTIVE');a.equal(current.owner.fence,initial.owner.fence+1);a.notEqual(current.owner.tokenSha256,initial.owner.tokenSha256);a.equal(held.credential.tokenSha256,current.owner.tokenSha256);a.equal(current.revision,initial.revision+2);a.equal(effects().length,0);
 a.ok(current.owner.expiresAt>store.backend.database.get("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS n").n);
 const winner=winnerIndex===0?left:right,winnerId=winnerIndex===0?leftId:rightId;winner.go();const completed=await winner.done;a.equal(completed.result.ok,true);a.equal(completed.result.snapshot.status,'COMPLETED');
 const final=project(read()),rows=effects();a.equal(rows.filter(r=>r.kind==='JOB_STARTED').length,1);a.equal(rows.filter(r=>r.kind==='EXTERNAL_EFFECT').length,1);a.equal(rows.filter(r=>r.kind==='JOB_SUCCEEDED').length,1);
 a.equal(final.revision,current.revision+1);a.equal(final.owner.fence,current.owner.fence);a.equal(final.owner.tokenSha256,current.owner.tokenSha256);a.equal(final.owner.state,'RELEASED');a.equal(final.workflowSnapshot.history.filter(h=>h.stepNo===40).length,1);
 const raw=store.read(),operations=raw.operations.filter(o=>o.kind==='RESUME_LIMIT');a.equal(operations.length,1);a.equal(operations[0].status,'FINISHED');a.equal(operations[0].revision,final.revision);a.deepEqual(operations[0].snapshot,final.workflowSnapshot);
 const replay=await launch({host:'receipt-reader',request:{kind:'LIMIT_REACHED',operationId:winnerId,expectedRevision:initial.revision}}).done;
 a.equal(replay.result.ok,true);a.equal(replay.result.counts.started,0);a.equal(replay.result.credentialPresent,false);a.deepEqual(project(read()),final);a.deepEqual(effects(),rows);
 console.log('STAGE22C_CLAIM_STATE_OBSERVATION '+JSON.stringify({scenario:'C05',mode:sameId?'same-operation':'different-operation',result:'PASS',synchronization:'Both independent processes read the same checkpoint before GO; winner held after claim and initial RUNNING save until loser exits.',claimSuccesses:1,rejections:1,rejectionCode:loser.code,loserCredentialPresent:loser.credentialPresent,readOnlyReceiptSuccesses:1,receiptReaderCredentialPresent:replay.result.credentialPresent,jobStarted:1,jobSucceeded:1,externalEffects:1,extraReplayEffects:0,initial,claimed:current,winnerCredential:held.credential,final,operation:{operationId:operations[0].operationId,revision:operations[0].revision,status:operations[0].status},ledger:rows,duplicateOwnershipObserved:false,checkpointConsistency:'PASS'}));
}));
for(const state of ['WAITING','LIMIT_REACHED','RUNNING','FAILED','COMPLETED'])test('C10: aged '+state+' checkpoint follows existing resume contract',()=>fixture(async({store,d,read,effects,ledger,launch})=>{
 if(state==='FAILED'||state==='COMPLETED'){
  class Setup extends api.CJobForm{async execute(c){fs.appendFileSync(ledger,JSON.stringify({kind:'JOB_STARTED',host:'setup'})+'\n');await super.execute(c);fs.appendFileSync(ledger,JSON.stringify({kind:'JOB_SUCCEEDED',host:'setup'})+'\n');}collect(){return 1;}make(v){return v;}record(){fs.appendFileSync(ledger,JSON.stringify({kind:'EXTERNAL_EFFECT',host:'setup'})+'\n');if(state==='FAILED')throw Error('synthetic failure after effect');}}
  const r=registry(store);r.nativeForms.set('q',{form:new Setup('q'),artifactKey:'RESULT'});store.claimStart('setup');const g=api.reconstructWorkflow(d,r,store);a.equal((await g.workflow.run('run',g.startStepNo)).status,state);
 }else{
  await start(store,d);if(state==='RUNNING'){const g=await api.restoreWorkflowCheckpoint(d,registry(store),store);await store.claimCheckpoint(g.checkpoint,d,g.artifacts.createSnapshot(),request(g.checkpoint,'paused-operation'));}
 }
 a.equal(read().workflowSnapshot.status,state);
 const row=store.backend.read('run'),age=30*24*60*60*1000,shift=t=>new Date(Date.parse(t)-age).toISOString(),shiftSnapshot=s=>{for(const h of s.history)h.at=shift(h.at);};
 row.owner.expiresAt-=age;row.updatedAt=shift(row.updatedAt);shiftSnapshot(row.snapshot);row.checkpoint.workflowSnapshot=structuredClone(row.snapshot);for(const op of row.operations)if(op.snapshot)shiftSnapshot(op.snapshot);for(const event of row.events)event.at=shift(event.at);
 store.backend.database.run('UPDATE waiting_runs SET state_json=? WHERE run_id=?',JSON.stringify(row),'run');
 const aged=project(read()),beforeLedger=effects(),oldOwner=aged.owner,op=request(read(),'explicit-resume'),reply=await launch({host:'new-host',request:op}).done;a.equal(reply.code,0);
 a.ok(aged.owner.expiresAt<store.backend.database.get("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS n").n);
 const after=project(read()),afterLedger=effects(),permitted=state==='WAITING'||state==='LIMIT_REACHED';
 if(permitted){a.equal(reply.result.ok,true);a.equal(reply.result.snapshot.status,'COMPLETED');a.equal(reply.result.counts.started,1);a.equal(reply.result.counts.effects,1);a.ok(!reply.result.calls.includes('p'));a.equal(after.owner.fence,oldOwner.fence+1);a.notEqual(after.owner.tokenSha256,oldOwner.tokenSha256);a.ok(after.revision>aged.revision);a.equal(after.workflowSnapshot.history.filter(h=>h.stepNo===40).length,1);}
 else{a.equal(reply.result.ok,false);a.equal(reply.result.code,state==='RUNNING'?'CLAIM_BUSY':'CHECKPOINT_NOT_RESUMABLE');a.equal(reply.result.counts.started,0);a.deepEqual(after,aged);a.deepEqual(afterLedger,beforeLedger);}
 const effectBefore=beforeLedger.filter(r=>r.kind==='EXTERNAL_EFFECT').length,effectAfter=afterLedger.filter(r=>r.kind==='EXTERNAL_EFFECT').length;a.equal(effectAfter-effectBefore,permitted?1:0);
 console.log('STAGE22C_CLAIM_STATE_OBSERVATION '+JSON.stringify({scenario:'C10',state,result:'PASS',ageMethod:'Temporary fixture timestamps uniformly shifted 30 days: lease expiry, updatedAt, Workflow/operation Snapshot history at, and event at. No real 30-day wait/local-clock override. Owner ID/token/fence/Revision, history structure/results, Definition and status unchanged.',aged,after,request:op,response:reply.result,jobStartsAdded:reply.result.counts.started,jobSuccessesAdded:reply.result.counts.completed,effectsBefore:effectBefore,effectsAfter:effectAfter,effectsAdded:effectAfter-effectBefore,duplicateEffectObserved:false,limitation:state==='RUNNING'||state==='FAILED'?'No automatic forced recovery exists; manual outcome reconciliation is required.':state==='COMPLETED'?'New execution is out of scope; existing receipt replay is covered by C05 and prior evidence.':'Normal explicit resume; exact Definition and box declarations still apply.'}));
},state==='WAITING'?'WAITING':'LIMIT_REACHED'));
