'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {TicketCompletion}=require('../gui/ticket-completion');
const {CTicketManager,CMemoryTicketRepository}=require('../dist/src/prototype/ticket');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function setup(){
 const repo=new CMemoryTicketRepository();let clock=0,writes=0,gets=0;
 const manager=new CTicketManager(repo,()=>`2026-11-07T00:00:${String(clock++).padStart(2,'0')}.000Z`);
 const t=manager.create({title:'test',createdBy:'test',ownerId:'test'});manager.submit(t.ticketId);manager.attachWorkflow(t.ticketId,'wf','v1','run-1');
 const rawSave=repo.save.bind(repo);repo.save=t=>{if(t.status==='COMPLETED')writes++;rawSave(t);};
 const control={get:id=>manager.get(id),complete:id=>manager.complete(id)};
 const boundary={get:id=>{gets++;return control.get(id);},complete:id=>control.complete(id)};
 const runtime={runId:'run-1',definition:{id:'wf',version:'v1'},executionMode:'NORMAL',simulatedJobUsed:false,status:'COMPLETED',history:[{result:'DONE'}],advance(){throw Error('advance must not be called');}};
 const coordinator=new TicketCompletion(boundary,runtime,t.ticketId,'run-1');
 return {repo,manager,control,runtime,coordinator,id:t.ticketId,rawSave,get writes(){return writes;},get gets(){return gets;},run:()=>coordinator.reconcile(t.ticketId,'run-1')};
}

test('normal completion and repeated confirmation preserve Job/history and updatedAt',async()=>{
 const x=setup(),history=structuredClone(x.runtime.history);
 const first=await x.run();assert.equal(first.result,'CONFIRMED');assert.equal(first.ticketId,x.id);assert.equal(first.runId,'run-1');assert.equal(first.workflowId,'wf');assert.equal(first.workflowVersion,'v1');assert.ok(Number.isFinite(Date.parse(first.checkedAt)));assert.equal(x.writes,1);
 const at=x.manager.get(x.id).updatedAt;const again=await x.run();assert.equal(again.code,'TICKET_COMPLETION_ALREADY_CONFIRMED');assert.equal(x.writes,1);assert.equal(x.manager.get(x.id).updatedAt,at);assert.deepEqual(x.runtime.history,history);assert.equal(x.runtime.status,'COMPLETED');assert.equal(x.coordinator.blocked,false);
 again.result='UNKNOWN';assert.equal(x.coordinator.snapshot().result,'CONFIRMED');
});
for(const after of [false,true])test(`save exception ${after?'after':'before'} write is reconciled, never retried automatically`,async()=>{
 const x=setup();x.control.complete=id=>{if(after)x.manager.complete(id);throw Error('PRIVATE_TEST_PATH');};
 const result=await x.run();assert.equal(result.result,after?'CONFIRMED':'PENDING');assert.equal(result.code,after?'TICKET_COMPLETION_CONFIRMED_AFTER_EXCEPTION':'TICKET_COMPLETION_PENDING_AFTER_EXCEPTION');assert.equal(x.writes,after?1:0);assert.equal(x.coordinator.blocked,!after);assert.ok(!JSON.stringify(result).includes('PRIVATE_TEST_PATH'));
 x.control.complete=id=>x.manager.complete(id);assert.equal((await x.run()).result,'CONFIRMED');assert.equal(x.writes,1);
});
for(const missing of [true,false])test(`initial read ${missing?'missing':'throws'} is UNKNOWN without saving`,async()=>{
 const x=setup();x.control.get=()=>{if(missing)return undefined;throw Error('private');};
 assert.equal((await x.run()).result,'UNKNOWN');assert.equal(x.writes,0);assert.equal(x.coordinator.blocked,true);assert.equal(x.coordinator.inProgress,false);
});
for(const afterWrite of [false,true])test(`read-back unavailable after ${afterWrite?'persisted':'unpersisted'} update is UNKNOWN`,async()=>{
 const x=setup();let count=0;x.control.get=id=>{if(++count>1)throw Error('read failure');return x.manager.get(id);};
 x.control.complete=id=>{if(afterWrite)return x.manager.complete(id);throw Error('save failure');};
 assert.equal((await x.run()).result,'UNKNOWN');assert.equal(x.writes,afterWrite?1:0);assert.equal(x.coordinator.blocked,true);
 x.control.get=id=>x.manager.get(id);x.control.complete=id=>x.manager.complete(id);assert.equal((await x.run()).result,'CONFIRMED');assert.equal(x.writes,1);
});
test('normal save return without a stored change is PENDING',async()=>{
 const x=setup();x.control.complete=()=>({status:'COMPLETED'});assert.equal((await x.run()).result,'PENDING');assert.equal(x.writes,0);
});
for(const status of ['OPEN','DRAFT','CANCELLED','INVALID'])test(`${status} is CONFLICT without completion save`,async()=>{
 const x=setup();x.rawSave({...x.manager.get(x.id),status});assert.equal((await x.run()).result,'CONFLICT');assert.equal(x.writes,0);assert.equal(x.manager.get(x.id).status,status);assert.equal(x.coordinator.blocked,true);
});
for(const [key,value] of [['ticketId','other'],['executionId','other'],['workflowId','other'],['workflowVersion','other']])test(`${key} mismatch is CONFLICT, including already COMPLETED`,async()=>{
 for(const status of ['IN_PROGRESS','COMPLETED']){
  const x=setup();x.control.get=id=>({...x.manager.get(id),status,[key]:value});const before=x.manager.get(x.id);
  assert.equal((await x.run()).result,'CONFLICT');assert.equal(x.writes,0);assert.deepEqual(x.manager.get(x.id),before);
 }
});
for(const patch of [{status:'FAILED'},{executionMode:'DEMO'},{simulatedJobUsed:true},{runId:'other'}])test(`ineligible Runtime ${JSON.stringify(patch)} does not read or save Ticket`,async()=>{
 const x=setup();Object.assign(x.runtime,patch);await assert.rejects(x.run(),e=>e.status===409);assert.equal(x.gets,0);assert.equal(x.writes,0);assert.equal(x.coordinator.snapshot(),null);
});
test('wrong recovery target does not poison current result',async()=>{
 const x=setup();await x.run();const before=x.coordinator.snapshot();
 for(const [id,run] of [['other','run-1'],[x.id,'other']])await assert.rejects(x.coordinator.reconcile(id,run),{code:'TICKET_COMPLETION_TARGET_MISMATCH',status:409});
 assert.deepEqual(x.coordinator.snapshot(),before);assert.equal(x.writes,1);
});
test('deterministic parallel reconciliation rejects duplicate without state or storage side effects',async()=>{
 const x=setup(),gate=deferred(),entered=deferred();x.control.get=async id=>{entered.resolve();await gate.promise;return x.manager.get(id);};
 const first=x.run();await entered.promise;const before=x.coordinator.snapshot();const gets=x.gets;
 await assert.rejects(x.run(),{code:'TICKET_COMPLETION_BUSY',status:409});assert.equal(x.gets,gets);assert.equal(x.writes,0);assert.deepEqual(x.coordinator.snapshot(),before);assert.equal(x.coordinator.blocked,true);
 gate.resolve();assert.equal((await first).result,'CONFIRMED');assert.equal(x.writes,1);assert.equal(x.coordinator.inProgress,false);
});
test('post-save identity conflict is retained, with no background retries',async()=>{
 const x=setup();let reads=0;x.control.get=id=>{const t=x.manager.get(id);return ++reads===1?t:{...t,executionId:'other'};};
 assert.equal((await x.run()).result,'CONFLICT');assert.equal(x.writes,1);const before=x.coordinator.snapshot();await Promise.resolve();assert.deepEqual(x.coordinator.snapshot(),before);assert.equal(x.writes,1);
});
