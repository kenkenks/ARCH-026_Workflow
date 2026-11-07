'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {ExamJobs}=require('../gui/exam-jobs');
const {JobCatalog}=require('../gui/job-catalog');
const {CMemoryTicketRepository}=require('../dist/src/prototype/ticket');
const secret='TEST_PRIVATE_VALUE /internal/test-path';

async function fixture(t,run){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-errors-')),previous=process.env.ARCH026_GUI_DATA_DIR;
 const oldHandler=ExamJobs.prototype.handler,oldSave=CMemoryTicketRepository.prototype.save,oldGet=CMemoryTicketRepository.prototype.get,oldList=JobCatalog.prototype.list;
 const control={calls:0,attempts:0,handler:async()=>({status:'COMPLETED'})};
 ExamJobs.prototype.handler=function(){const fn=control.handler;return async(...args)=>{control.calls++;return fn(...args);};};
 CMemoryTicketRepository.prototype.save=function(ticket){
  if(ticket.status==='COMPLETED'&&control.completeFault)throw Error(secret);
  if(ticket.status==='IN_PROGRESS'){
   control.attempts++;control.repo=this;control.observedCandidate={...ticket};
   if(control.save==='before')throw Error(secret);
   oldSave.call(this,ticket);
   if(control.save==='after')throw Error(secret);
   return;
  }
  return oldSave.call(this,ticket);
 };
 CMemoryTicketRepository.prototype.get=function(id){
  const original=oldGet.call(this,id);
  if(control.attempts){
   if(control.read==='fail')throw Error(secret);
   if(control.read==='missing')return undefined;
   if(control.read==='mismatch')return {...original,executionId:'other-execution'};
  }
  return original;
 };
 JobCatalog.prototype.list=function(){if(Object.hasOwn(control,'serverThrow'))throw control.serverThrow;return oldList.call(this);};
 process.env.ARCH026_GUI_DATA_DIR=dir;const key=require.resolve('../gui/server');delete require.cache[key];let server;
 try{
  ({server}=require('../gui/server'));if(previous===undefined)delete process.env.ARCH026_GUI_DATA_DIR;else process.env.ARCH026_GUI_DATA_DIR=previous;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  async function api(route,body,status=200){const response=await fetch(base+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}
  await api('/api/jobs',{keyword:'exam.dateAgreement',jobClass:'CExamDateAgreementJob',displayName:'test'});
  await api('/api/definitions',{id:'probe',version:'v1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId:'exam.dateAgreement',nextStepId:'END'},{id:'END',type:'END'}]});
  async function ticket(){const x=await api('/api/tickets',{title:'test',createdBy:'test',ownerId:'test'},201);return api('/api/ticket-action',{ticketId:x.ticketId,action:'submit'});}
  const start=(id,mode='NORMAL',status=200)=>api('/api/ticket-action',{ticketId:id,action:'start',definitionId:'probe',definitionVersion:'v1',executionMode:mode},status);
  await run({control,api,ticket,start,state:()=>api('/api/state'),rawGet:id=>oldGet.call(control.repo,id),server,base});
 }finally{
  ExamJobs.prototype.handler=oldHandler;CMemoryTicketRepository.prototype.save=oldSave;CMemoryTicketRepository.prototype.get=oldGet;JobCatalog.prototype.list=oldList;
  if(previous===undefined)delete process.env.ARCH026_GUI_DATA_DIR;else process.env.ARCH026_GUI_DATA_DIR=previous;
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}delete require.cache[key];fs.rmSync(dir,{recursive:true,force:true});
 }
}

for(const [name,handler,code] of [
 ['sync',()=>{throw Error(secret);},'HANDLER_EXCEPTION'],
 ['reject',()=>Promise.reject(Error(secret)),'HANDLER_EXCEPTION'],
 ['invalid',async()=>({status:'UNKNOWN'}),'INVALID_JOB_RESULT'],
 ['null',()=>{throw null;},'HANDLER_EXCEPTION'],
 ['string',()=>{throw secret;},'HANDLER_EXCEPTION'],
 ['number',()=>{throw 12345;},'HANDLER_EXCEPTION'],
 ['object',()=>{throw {secret,stack:secret};},'HANDLER_EXCEPTION']
])test(`HTTP ${name}: safe response, state re-fetch, ERROR cause and guard release`,t=>fixture(t,async({control,api,ticket,start,state})=>{
 control.handler=handler;const x=await ticket();await start(x.ticketId);
 const failure=await api('/api/step',{},500);assert.equal(failure.code,code);assert.ok(!JSON.stringify(failure).includes(secret));
 const s=await state();assert.equal(s.status,'FAILED');assert.equal(s.diagnostic.code,code);assert.equal(s.diagnostic.runId,s.runId);assert.equal(s.diagnostic.stepId,'J');assert.equal(s.diagnostic.executionMode,'NORMAL');assert.deepEqual(s.history[0].diagnostic,s.diagnostic);assert.equal(s.history[0].result,'ERROR');assert.ok(s.error);assert.ok(!JSON.stringify(s).includes(secret));
 assert.equal((await api('/api/tickets/'+x.ticketId)).status,'IN_PROGRESS');assert.equal(control.calls,1);
 const ended=await api('/api/step',{},500);assert.notEqual(ended.code,'RUNTIME_BUSY');assert.deepEqual(await state(),s);assert.equal(control.calls,1);
}));

for(const [name,value] of [['null',null],['string',secret],['number',12345],['object',{secret,status:401}],['getters',{get status(){throw Error(secret);},toString(){throw Error(secret);}}],['Error getters',Object.defineProperty(Error(secret),'code',{get(){throw Error(secret);}})]])test(`Server catch safely normalizes ${name} outside Runtime`,t=>fixture(t,async({control,api})=>{
 control.serverThrow=value;assert.deepEqual(await api('/api/jobs',undefined,500),{error:'内部処理で例外が発生しました',code:'INTERNAL'});
}));

test('Server retains HTTP 400 for existing validation errors',t=>fixture(t,async({api})=>{
 const response=await api('/api/jobs',{keyword:'invalid job'},400);assert.ok(response.error);
}));

test('Ticket pre-save failure leaves old execution unchanged, retry needs no orphan cleanup',t=>fixture(t,async({control,api,ticket,start,state})=>{
 const x=await ticket(),before=await state();control.save='before';const result=await start(x.ticketId,'NORMAL',500);assert.equal(result.code,'TICKET_START_FAILED');assert.ok(!JSON.stringify(result).includes(secret));assert.deepEqual(await state(),before);assert.equal(control.calls,0);assert.equal((await api('/api/tickets/'+x.ticketId)).status,'OPEN');
 control.save=null;await start(x.ticketId);const s=await state();assert.equal(s.runtime,true);assert.equal(s.activeTicketId,x.ticketId);assert.equal((await api('/api/tickets/'+x.ticketId)).executionId,s.runId);assert.equal(control.calls,0);
}));

test('Ticket post-save exception publishes only the reconciled binding, never retries attach',t=>fixture(t,async({control,api,ticket,start,state})=>{
 const x=await ticket();control.save='after';const result=await start(x.ticketId);assert.equal(result.startReconciliation,'MATCHED_AFTER_EXCEPTION');assert.equal(control.attempts,1);assert.equal(control.calls,0);
 const s=await state(),stored=await api('/api/tickets/'+x.ticketId);assert.equal(s.status,'READY');assert.equal(s.activeTicketId,x.ticketId);assert.equal(stored.executionId,s.runId);assert.equal(s.startDiagnostic.code,'TICKET_START_RECONCILED');assert.equal(s.startIssue,null);assert.ok(!JSON.stringify(s).includes(secret));
 await api('/api/step',{});await api('/api/step',{});assert.equal((await state()).status,'COMPLETED');assert.equal((await api('/api/tickets/'+x.ticketId)).status,'COMPLETED');assert.equal(control.attempts,1);
}));

for(const read of ['fail','missing','mismatch'])test(`unresolved Ticket binding (${read}) blocks further execution and reset`,t=>fixture(t,async({control,api,ticket,start,state,rawGet})=>{
 const x=await ticket(),other=await ticket();const before=await state();control.save='after';control.read=read;
 const response=await start(x.ticketId,'NORMAL',503);assert.equal(response.code,'TICKET_START_OUTCOME_UNKNOWN');assert.ok(!JSON.stringify(response).includes(secret));assert.equal(control.attempts,1);assert.equal(control.calls,0);
 const s=await state();assert.equal(s.runtime,before.runtime);assert.equal(s.runId,before.runId);assert.equal(s.activeTicketId,before.activeTicketId);assert.equal(s.status,before.status);assert.equal(s.history.length,0);assert.equal(s.startIssue.code,'TICKET_START_OUTCOME_UNKNOWN');assert.equal(s.startIssue.ticketId,x.ticketId);assert.equal(s.startIssue.runId,rawGet(x.ticketId).executionId);
 // Reads becoming healthy do not silently clear the uncertain-start hold.
 control.read=null;
 for(const mode of ['NORMAL','DEMO'])assert.equal((await start(other.ticketId,mode,503)).code,'TICKET_START_OUTCOME_UNKNOWN');
 for(const route of ['/api/step','/api/reset','/api/job-submit'])assert.equal((await api(route,{},503)).code,'TICKET_START_OUTCOME_UNKNOWN');
 assert.deepEqual(await state(),s);assert.equal(control.attempts,1);assert.equal(control.calls,0);assert.equal(rawGet(other.ticketId).status,'OPEN');
}));

test('successful attach with inconsistent observation is not published',t=>fixture(t,async({control,ticket,start,state})=>{
 const x=await ticket();control.read='mismatch';const result=await start(x.ticketId,'NORMAL',503);assert.equal(result.code,'TICKET_START_OUTCOME_UNKNOWN');const s=await state();assert.equal(s.activeTicketId,null);assert.notEqual(s.runtime,true);assert.equal(control.calls,0);
}));

test('DEMO never calls Ticket attach even when its saving path would fail',t=>fixture(t,async({control,api,ticket,start,state})=>{
 const x=await ticket();control.save='before';await start(x.ticketId,'DEMO');await api('/api/step',{});await api('/api/step',{});
 const s=await state();assert.equal(s.resultKind,'DEMO_COMPLETED');assert.equal(s.activeTicketId,null);assert.equal(s.simulatedJobUsed,true);assert.equal(control.attempts,0);assert.equal(control.calls,0);assert.equal((await api('/api/tickets/'+x.ticketId)).status,'OPEN');
}));

test('HTTP WAITING can be re-evaluated and explicit CHECK ERROR has diagnostics',t=>fixture(t,async({control,api,ticket,start,state})=>{
 let calls=0;control.handler=async()=>({status:++calls===1?'WAITING':'COMPLETED'});const x=await ticket();await start(x.ticketId);assert.equal((await api('/api/step',{})).status,'WAITING');assert.equal((await api('/api/step',{})).status,'ACTIVE');await api('/api/step',{});assert.equal((await state()).status,'COMPLETED');
 await api('/api/definitions',{id:'check',version:'v1',startStepId:'C',eventRoutes:[],steps:[{id:'C',type:'CHECK_FINAL',nextStepId:'END'},{id:'END',type:'END'}]});const y=await ticket();await api('/api/ticket-action',{ticketId:y.ticketId,action:'start',definitionId:'check',definitionVersion:'v1'});await api('/api/step',{checkResult:'ERROR'});const s=await state();assert.equal(s.status,'FAILED');assert.equal(s.diagnostic.code,'CHECK_ERROR');assert.deepEqual(s.history[0].diagnostic,s.diagnostic);
}));

test('Ticket completion failure is PENDING and explicit recovery never reruns a successful Job',t=>fixture(t,async({control,api,ticket,start,state})=>{
 const x=await ticket();await start(x.ticketId);await api('/api/step',{});control.completeFault=true;
 await api('/api/step',{},503);assert.equal((await state()).status,'COMPLETED');assert.equal((await state()).ticketCompletion.result,'PENDING');assert.equal((await api('/api/tickets/'+x.ticketId)).status,'IN_PROGRESS');
 await api('/api/step',{},500);assert.equal(control.calls,1);assert.equal((await state()).status,'COMPLETED');
 control.completeFault=false;const runId=(await state()).runId;await api('/api/ticket-completion/reconcile',{ticketId:x.ticketId,runId});assert.equal((await state()).ticketCompletion.result,'CONFIRMED');assert.equal(control.calls,1);assert.equal((await state()).history.length,2);
}));

test('a start body accepted before uncertainty cannot bypass the hold when it arrives late',t=>fixture(t,async({control,ticket,start,state,server,base})=>{
 const x=await ticket(),other=await ticket();let accepted;
 const entered=new Promise(resolve=>{accepted=resolve;});
 const listener=req=>{if(req.headers['x-probe']==='late-start'){server.off('request',listener);accepted();}};
 server.on('request',listener);const json=JSON.stringify({ticketId:other.ticketId,action:'start',definitionId:'probe',definitionVersion:'v1'});
 let request;
 const result=new Promise((resolve,reject)=>{
  request=http.request(base+'/api/ticket-action',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(json),'X-Probe':'late-start'}},response=>{let body='';response.on('data',c=>body+=c);response.on('end',()=>{try{resolve({status:response.statusCode,body:JSON.parse(body)});}catch(e){reject(e);}});});request.on('error',reject);request.write(json.slice(0,-1));
 });
 t.after(()=>{server.off('request',listener);request.destroy();});await entered;
 control.save='after';control.read='fail';await start(x.ticketId,'NORMAL',503);const before=await state();control.read=null;
 request.end(json.slice(-1));const response=await result;assert.equal(response.status,503);assert.equal(response.body.code,'TICKET_START_OUTCOME_UNKNOWN');assert.deepEqual(await state(),before);assert.equal(control.attempts,1);assert.equal(control.calls,0);
}));
