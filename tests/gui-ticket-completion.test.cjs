'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
const {ExamJobs}=require('../gui/exam-jobs');
const {WorkflowRuntime}=require('../gui/workflow-runtime');
const {CTicketManager,CMemoryTicketRepository}=require('../dist/src/prototype/ticket');
const secret='PRIVATE_TEST_INFORMATION /private/test-path';
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function fixture(run){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-completion-')),oldDirectory=process.env.ARCH026_GUI_DATA_DIR;
 const original={handler:ExamJobs.prototype.handler,save:CMemoryTicketRepository.prototype.save,get:CTicketManager.prototype.get,complete:CTicketManager.prototype.complete,advance:WorkflowRuntime.prototype.advance};
 const c={jobs:0,advances:0,saves:0,completes:0,gets:0,mode:'normal',getMode:'normal'};
 ExamJobs.prototype.handler=()=>async()=>{c.jobs++;if(c.failJob)throw Error(secret);return {status:'COMPLETED'};};
 WorkflowRuntime.prototype.advance=function(...args){c.advances++;return original.advance.apply(this,args);};
 CMemoryTicketRepository.prototype.save=function(ticket){
  c.repo=this;
  if(ticket.status==='COMPLETED'){
   c.saves++;if(c.mode==='before')throw Error(secret);if(c.mode==='silent')return;
   original.save.call(this,ticket);if(c.mode==='after')throw Error(secret);return;
  }
  original.save.call(this,ticket);
 };
 CTicketManager.prototype.get=function(id){
  const read=()=>{
   c.gets++;if(id===c.id){if(c.getMode==='throw')throw Error(secret);if(c.getMode==='missing')return undefined;}
   const value=original.get.call(this,id);return id===c.id&&c.readPatch&&value?{...value,...c.readPatch}:value;
  };
  if(id===c.id&&c.gate){c.entered.resolve();return c.gate.promise.then(read);}
  return read();
 };
 CTicketManager.prototype.complete=function(id){c.completes++;try{return original.complete.call(this,id);}finally{if(c.afterRead)c.getMode=c.afterRead;}};
 process.env.ARCH026_GUI_DATA_DIR=directory;const key=require.resolve('../gui/server');delete require.cache[key];let server;
 try{
  ({server}=require('../gui/server'));if(oldDirectory===undefined)delete process.env.ARCH026_GUI_DATA_DIR;else process.env.ARCH026_GUI_DATA_DIR=oldDirectory;
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  async function api(route,body,status=200){const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return value;}
  await api('/api/jobs',{keyword:'exam.dateAgreement',jobClass:'CExamDateAgreementJob',displayName:'test'});
  await api('/api/definitions',{id:'wf',version:'v1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId:'exam.dateAgreement',nextStepId:'END'},{id:'END',type:'END'}]});
  async function ticket(){const t=await api('/api/tickets',{title:'test',createdBy:'test',ownerId:'test'},201);return api('/api/ticket-action',{ticketId:t.ticketId,action:'submit'});}
  const start=(id,mode='NORMAL',status=200)=>api('/api/ticket-action',{ticketId:id,action:'start',definitionId:'wf',definitionVersion:'v1',executionMode:mode},status);
  const x=await ticket();c.id=x.ticketId;
  await run({c,x,api,ticket,start,state:()=>api('/api/state'),step:(status=200)=>api('/api/step',{},status),raw:()=>c.repo.get(x.ticketId),patch:values=>original.save.call(c.repo,{...c.repo.get(x.ticketId),...values}),server,base});
 }finally{
  c.gate?.resolve();ExamJobs.prototype.handler=original.handler;CMemoryTicketRepository.prototype.save=original.save;CTicketManager.prototype.get=original.get;CTicketManager.prototype.complete=original.complete;WorkflowRuntime.prototype.advance=original.advance;
  if(oldDirectory===undefined)delete process.env.ARCH026_GUI_DATA_DIR;else process.env.ARCH026_GUI_DATA_DIR=oldDirectory;
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}delete require.cache[key];fs.rmSync(directory,{recursive:true,force:true});
 }
}
async function finishJob(f){await f.start(f.x.ticketId);await f.step();return f.state();}
async function recover(f,status=200,override={}){const s=await f.state();return f.api('/api/ticket-completion/reconcile',{ticketId:f.x.ticketId,runId:s.runId,...override},status);}

test('normal END and repeat reconciliation confirm without re-running Job or changing history/updatedAt',()=>fixture(async f=>{
 await finishJob(f);const end=await f.step();assert.equal(end.ticketCompletion.result,'CONFIRMED');const before=await f.state(),at=f.raw().updatedAt;
 assert.equal(before.status,'COMPLETED');assert.equal(before.ticketCompletion.ticketId,f.x.ticketId);assert.equal(before.ticketCompletion.runId,before.runId);assert.equal(before.ticketCompletion.workflowId,'wf');assert.equal(before.ticketCompletion.workflowVersion,'v1');assert.ok(Date.parse(before.ticketCompletion.checkedAt));
 const counts={jobs:f.c.jobs,advances:f.c.advances,saves:f.c.saves,completes:f.c.completes};await recover(f);await recover(f);
 assert.deepEqual({jobs:f.c.jobs,advances:f.c.advances,saves:f.c.saves,completes:f.c.completes},counts);assert.deepEqual((await f.state()).history,before.history);assert.equal(f.raw().updatedAt,at);assert.equal(f.c.jobs,1);assert.equal(f.c.saves,1);
}));

for(const mode of ['before','after','silent'])test(`END save ${mode}: read-back classifies outcome and explicit recovery does not repeat Job`,()=>fixture(async f=>{
 await finishJob(f);f.c.mode=mode;const response=await f.step(mode==='after'?200:503);const expected=mode==='after'?'CONFIRMED':'PENDING';assert.equal(response.ticketCompletion.result,expected);
 const before=await f.state(),history=structuredClone(before.history),advances=f.c.advances;assert.equal(before.status,'COMPLETED');assert.equal(before.ticketCompletion.result,expected);assert.ok(!JSON.stringify(response).includes(secret));assert.ok(!JSON.stringify(before).includes(secret));assert.equal(f.c.completes,1);
 if(mode!=='after'){const other=await f.ticket();await f.start(other.ticketId,'NORMAL',409);await f.start(other.ticketId,'DEMO',409);await f.api('/api/reset',{},409);assert.equal((await f.state()).runId,before.runId);}
 f.c.mode='normal';await recover(f);assert.equal((await f.state()).ticketCompletion.result,'CONFIRMED');assert.equal(f.raw().status,'COMPLETED');assert.equal(f.c.jobs,1);assert.equal(f.c.advances,advances);assert.deepEqual((await f.state()).history,history);assert.equal(f.c.saves,mode==='after'?1:2);
}));

for(const getMode of ['throw','missing'])test(`Ticket read ${getMode} holds old Runtime and can be explicitly reconciled later`,()=>fixture(async f=>{
 const other=await f.ticket();await finishJob(f);f.c.getMode=getMode;await f.step(503);const before=await f.state();assert.equal(before.ticketCompletion.result,'UNKNOWN');assert.equal(f.c.saves,0);
 await f.start(other.ticketId,'NORMAL',409);await f.api('/api/reset',{},409);assert.deepEqual(await f.state(),before);assert.equal(f.raw().status,'IN_PROGRESS');
 f.c.getMode='normal';assert.deepEqual(await f.state(),before);await recover(f);assert.equal(f.c.saves,1);assert.equal(f.c.jobs,1);assert.deepEqual((await f.state()).history,before.history);
}));

for(const mode of ['before','after'])test(`post-save read failure (${mode}) is UNKNOWN and read-back recovery is safe`,()=>fixture(async f=>{
 await finishJob(f);f.c.mode=mode;f.c.afterRead='throw';await f.step(503);const before=await f.state();assert.equal(before.ticketCompletion.result,'UNKNOWN');assert.equal(f.raw().status,mode==='after'?'COMPLETED':'IN_PROGRESS');
 f.c.mode='normal';f.c.afterRead=null;f.c.getMode='normal';await recover(f);assert.equal((await f.state()).ticketCompletion.result,'CONFIRMED');assert.equal(f.c.saves,mode==='after'?1:2);assert.equal(f.c.jobs,1);assert.deepEqual((await f.state()).history,before.history);
}));

test('already COMPLETED before END causes no save or timestamp update',()=>fixture(async f=>{
 await finishJob(f);f.patch({status:'COMPLETED'});const at=f.raw().updatedAt;await f.step();assert.equal(f.c.saves,0);assert.equal(f.c.completes,0);await recover(f);assert.equal(f.c.saves,0);assert.equal(f.raw().updatedAt,at);assert.equal((await f.state()).ticketCompletion.result,'CONFIRMED');
}));

for(const status of ['OPEN','DRAFT','CANCELLED','OTHER'])test(`${status} is a retained CONFLICT, never automatically completed`,()=>fixture(async f=>{
 const other=await f.ticket();await finishJob(f);f.patch({status});await f.step(409);const before=await f.state();assert.equal(before.status,'COMPLETED');assert.equal(before.ticketCompletion.result,'CONFLICT');assert.equal(f.raw().status,status);assert.equal(f.c.saves,0);
 await f.start(other.ticketId,'NORMAL',409);await f.api('/api/reset',{},409);assert.deepEqual(await f.state(),before);assert.equal(f.c.completes,0);
 // Merely reading state must not automatically retry a conflict.
 assert.equal((await f.state()).ticketCompletion.checkedAt,before.ticketCompletion.checkedAt);
}));

for(const [key,value] of [['ticketId','other-ticket'],['executionId','other-run'],['workflowId','other-workflow'],['workflowVersion','other-version']])test(`${key} mismatch blocks completion and preserves both tickets`,()=>fixture(async f=>{
 const other=await f.ticket();await finishJob(f);const actual=f.raw(),otherBefore=await f.api('/api/tickets/'+other.ticketId);f.c.readPatch={[key]:value};await f.step(409);
 assert.equal((await f.state()).ticketCompletion.result,'CONFLICT');assert.equal(f.c.saves,0);assert.equal(f.c.completes,0);assert.deepEqual(f.raw(),actual);assert.deepEqual(await f.api('/api/tickets/'+other.ticketId),otherBefore);
 await recover(f,409);assert.equal(f.c.completes,0);
}));

test('manual correction followed by explicit recovery can resolve CONFLICT without advance',()=>fixture(async f=>{
 await finishJob(f);f.c.readPatch={executionId:'wrong'};await f.step(409);const before=await f.state();f.c.readPatch=null;assert.equal((await f.state()).ticketCompletion.result,'CONFLICT');assert.equal(f.c.saves,0);await recover(f);assert.equal(f.c.saves,1);assert.equal(f.c.jobs,1);assert.deepEqual((await f.state()).history,before.history);
}));

for(const mode of ['FAILED','DEMO','ACTIVE'])test(`${mode} Runtime cannot use completion recovery`,()=>fixture(async f=>{
 if(mode==='FAILED')f.c.failJob=true;await f.start(f.x.ticketId,mode==='DEMO'?'DEMO':'NORMAL');
 if(mode==='FAILED')await f.step(500);if(mode==='DEMO'){await f.step();await f.step();}
 const before=await f.state();await recover(f,409);assert.deepEqual(await f.state(),before);assert.equal(f.c.saves,0);assert.equal(f.c.completes,0);assert.equal(f.raw().status,mode==='DEMO'?'OPEN':'IN_PROGRESS');
}));

test('invalid request IDs and body do not change completion state',()=>fixture(async f=>{
 await finishJob(f);await f.step();const before=await f.state();await recover(f,409,{ticketId:'other'});await recover(f,409,{runId:'other'});
 for(const body of [null,[],{}, {ticketId:f.x.ticketId}, {ticketId:f.x.ticketId,runId:before.runId,extra:true}])await f.api('/api/ticket-completion/reconcile',body,400);
 assert.deepEqual(await f.state(),before);assert.equal(f.c.saves,1);assert.equal(f.c.jobs,1);
}));

test('parallel recovery, start and reset are rejected without changing Ticket or histories',{timeout:10000},()=>fixture(async f=>{
 const other=await f.ticket();await finishJob(f);f.c.mode='before';await f.step(503);f.c.mode='normal';f.c.gate=deferred();f.c.entered=deferred();
 const first=recover(f);await f.c.entered.promise;const before=await f.state(),ticketBefore=f.raw(),counts={jobs:f.c.jobs,advances:f.c.advances,saves:f.c.saves,gets:f.c.gets};
 assert.equal(before.ticketCompletion.inProgress,true);
 assert.equal((await recover(f,409)).code,'TICKET_COMPLETION_BUSY');assert.equal((await f.start(other.ticketId,'NORMAL',409)).code,'TICKET_COMPLETION_BUSY');await f.api('/api/reset',{},409);
 await f.api('/api/ticket-action',{ticketId:f.x.ticketId,action:'cancel'},409);await f.api('/api/step',{},409);
 assert.deepEqual(await f.state(),before);assert.deepEqual(f.raw(),ticketBefore);assert.deepEqual({jobs:f.c.jobs,advances:f.c.advances,saves:f.c.saves,gets:f.c.gets},counts);
 f.c.gate.resolve();await first;f.c.gate=null;assert.equal((await f.state()).ticketCompletion.result,'CONFIRMED');assert.equal(f.c.jobs,1);assert.equal(f.c.saves,2);assert.deepEqual((await f.state()).history,before.history);
 await f.start(other.ticketId);assert.equal((await f.state()).activeTicketId,other.ticketId);
}));

test('late start body cannot discard a Runtime whose completion became UNKNOWN',()=>fixture(async f=>{
 const other=await f.ticket();await finishJob(f);let accepted;const entered=new Promise(r=>accepted=r);
 const listener=req=>{if(req.headers['x-probe']==='late-completion'){f.server.off('request',listener);accepted();}};f.server.on('request',listener);
 const json=JSON.stringify({ticketId:other.ticketId,action:'start',definitionId:'wf',definitionVersion:'v1'});let request;
 const result=new Promise((resolve,reject)=>{request=http.request(f.base+'/api/ticket-action',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(json),'X-Probe':'late-completion'}},response=>{let body='';response.on('data',c=>body+=c);response.on('end',()=>resolve({status:response.statusCode,value:JSON.parse(body)}));});request.on('error',reject);request.write(json.slice(0,-1));});
 await entered;f.c.getMode='missing';await f.step(503);const before=await f.state();request.end(json.slice(-1));const response=await result;assert.equal(response.status,409);assert.equal(response.value.code,'TICKET_COMPLETION_UNRESOLVED');assert.deepEqual(await f.state(),before);assert.equal(f.c.jobs,1);
}));

test('GUI label distinguishes Runtime END from Ticket completion confirmation',()=>{
 const html=fs.readFileSync(path.join(__dirname,'../gui/index.html'),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
 const statement=script.match(/if\(s.ticketCompletion\)\$\('status'\)\.textContent\+=[^;]+;/)[0];
 for(const [result,label] of [['CONFIRMED','完了確認済み'],['PENDING','完了更新待ち'],['UNKNOWN','完了結果不明'],['CONFLICT','完了情報競合']]){
  const element={textContent:'Runtime END'};vm.runInNewContext(statement,{$:()=>element,s:{ticketCompletion:{result,inProgress:false}}});assert.match(element.textContent,/Runtime END/);assert.ok(element.textContent.includes(label));
 }
});

test('late recovery request cannot modify a replacement execution or another Ticket',()=>fixture(async f=>{
 const other=await f.ticket();await finishJob(f);await f.step();const old=await f.state(),oldTicket=f.raw();
 let accepted;const entered=new Promise(resolve=>accepted=resolve);
 const listener=req=>{if(req.headers['x-probe']==='late-recovery'){f.server.off('request',listener);accepted();}};f.server.on('request',listener);
 const json=JSON.stringify({ticketId:f.x.ticketId,runId:old.runId});let request;
 const result=new Promise((resolve,reject)=>{request=http.request(f.base+'/api/ticket-completion/reconcile',{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(json),'X-Probe':'late-recovery'}},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,value:JSON.parse(body)}));});request.on('error',reject);request.write(json.slice(0,-1));});
 await entered;await f.start(other.ticketId);const before=await f.state(),newTicket=await f.api('/api/tickets/'+other.ticketId),saves=f.c.saves;
 request.end(json.slice(-1));const response=await result;assert.equal(response.status,409);assert.equal(response.value.code,'EXECUTION_CHANGED');assert.deepEqual(await f.state(),before);assert.deepEqual(await f.api('/api/tickets/'+other.ticketId),newTicket);assert.deepEqual(f.raw(),oldTicket);assert.equal(f.c.saves,saves);assert.equal(f.c.jobs,1);
}));
