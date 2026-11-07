'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {ExamJobs}=require('../gui/exam-jobs');
const {CMemoryTicketRepository}=require('../dist/src/prototype/ticket');
test('HTTP input boundary: bytes, structure, and zero side effects',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-http-input-')),prev=process.env.ARCH026_GUI_DATA_DIR;
 const save=CMemoryTicketRepository.prototype.save,handler=ExamJobs.prototype.handler;
 let saves=0,calls=0;CMemoryTicketRepository.prototype.save=function(x){saves++;return save.call(this,x);};
 ExamJobs.prototype.handler=function(){return async()=>{calls++;return {status:'COMPLETED'};};};
 process.env.ARCH026_GUI_DATA_DIR=dir;const key=require.resolve('../gui/server');delete require.cache[key];const {server}=require(key);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 async function request(route,body,contentType='application/json',split=false){
  const bytes=Buffer.isBuffer(body)?body:Buffer.from(body);let first;
  const received=split?new Promise(r=>{first=req=>req.once('data',r);server.once('request',first);}):null;
  return new Promise((resolve,reject)=>{
   const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method:'POST',headers:contentType===null?{}:{'Content-Type':contentType}},res=>{let s='';res.on('data',x=>s+=x);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(s)}));});req.on('error',reject);
   if(split){const index=bytes.indexOf(Buffer.from('界'))+1;req.write(bytes.subarray(0,index));received.then(()=>req.end(bytes.subarray(index))).catch(reject);}else req.end(bytes);
  });
 }
 const post=(route,value)=>request(route,JSON.stringify(value));
 const get=async route=>(await fetch(`http://127.0.0.1:${server.address().port}${route}`)).json();
 const input={title:'界',createdBy:'test',ownerId:'test'};
 try{
  for(const [name,body,type,status] of [
   ['invalid JSON','{','application/json',400],['null','null','application/json',400],['array','[]','application/json',400],['number','42','application/json',400],['boolean','true','application/json',400],['empty','','application/json',400],['missing type',JSON.stringify(input),null,415],['text/plain',JSON.stringify(input),'text/plain',415],['invalid UTF8',Buffer.from([123,34,120,34,58,34,255,34,125]),'application/json',400]
  ])await t.test(name,async()=>{const before=await get('/api/state'),count=saves;assert.equal((await request('/api/tickets',body,type)).status,status);assert.equal(saves,count);assert.equal(calls,0);assert.deepEqual(await get('/api/state'),before);});
  await t.test('normal JSON, charset and split UTF8',async()=>{for(const type of ['application/json','application/json; charset=utf-8']){const r=await request('/api/tickets',JSON.stringify(input),type,true);assert.equal(r.status,201);assert.equal(r.body.title,'界');}});
  for(const size of [65535,65536,65537])await t.test(`byte boundary ${size}`,async()=>{const base=JSON.stringify({...input,description:''}),body=JSON.stringify({...input,description:'a'.repeat(size-Buffer.byteLength(base))});assert.equal(Buffer.byteLength(body),size);const before=saves;assert.equal((await request('/api/tickets',body)).status,size>65536?413:201);assert.equal(saves-before,size>65536?0:1);});
  await t.test('Japanese bytes exceed limit despite fewer characters',async()=>{const count=saves;assert.equal((await post('/api/tickets',{...input,title:'界'.repeat(30000)})).status,413);assert.equal(saves,count);});
  await t.test('invalid definition bodies do not publish files',async()=>{
   const before=fs.readdirSync(path.join(dir,'definitions'));
   for(const value of [null,[],true,42,{}])assert.equal((await post('/api/definitions',value)).status,400);
   assert.deepEqual(fs.readdirSync(path.join(dir,'definitions')),before);
  });
  await post('/api/jobs',{keyword:'exam.dateAgreement',jobClass:'CExamDateAgreementJob',displayName:'test'});
  await post('/api/definitions',{id:'test',version:'1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId:'exam.dateAgreement',nextStepId:'C'},{id:'C',type:'CHECK_FINAL',nextStepId:'END'},{id:'END',type:'END'}]});
  const ticket=(await post('/api/tickets',input)).body;
  await post('/api/ticket-action',{ticketId:ticket.ticketId,action:'submit'});
  const start={ticketId:ticket.ticketId,action:'start',definitionId:'test',definitionVersion:'1'};
  for(const [route,value] of [['/api/ticket-action',{...start,definitionVersion:42}],['/api/ticket-action',{ticketId:ticket.ticketId,action:'edit',patch:null}],['/api/definitions',null],['/api/tickets',{...input,description:{bad:true}}]])await t.test(`invalid structure ${route}`,async()=>{const before=await get('/api/state'),count=saves;assert.equal((await post(route,value)).status,400);assert.equal(saves,count);assert.deepEqual(await get('/api/state'),before);});
  assert.equal((await post('/api/ticket-action',start)).status,200);
  for(const value of [null,[],42,true,{checkResult:'PASS'},{extra:true}])await t.test(`JOB advance rejects ${JSON.stringify(value)}`,async()=>{const before=await get('/api/state'),count=saves;assert.equal((await post('/api/step',value)).status,400);assert.equal(calls,0);assert.equal(saves,count);assert.deepEqual(await get('/api/state'),before);});
  await t.test('job input root rejected before submit',async()=>{const before=await get('/api/state');assert.equal((await post('/api/job-submit',{values:[]})).status,400);assert.deepEqual(await get('/api/state'),before);});
  await t.test('completion request shape rejected without changes',async()=>{
   const before=await get('/api/state'),count=saves;
   for(const value of [null,[],{}, {ticketId:ticket.ticketId,runId:42}, {ticketId:ticket.ticketId,runId:before.runId,extra:true}])assert.equal((await post('/api/ticket-completion/reconcile',value)).status,400);
   assert.deepEqual(await get('/api/state'),before);assert.equal(saves,count);assert.equal(calls,0);
  });
  assert.equal((await post('/api/step',{})).status,200);assert.equal(calls,1);
  for(const checkResult of [null,42,true,[],{},'INVALID'])await t.test(`CHECK invalid ${JSON.stringify(checkResult)}`,async()=>{const before=await get('/api/state');assert.equal((await post('/api/step',{checkResult})).status,400);assert.deepEqual(await get('/api/state'),before);assert.equal(calls,1);});
  await t.test('valid operation after rejection',async()=>{assert.equal((await post('/api/step',{checkResult:'PASS'})).status,200);assert.equal((await post('/api/step',{})).status,200);assert.equal((await get('/api/state')).status,'COMPLETED');assert.equal(calls,1);});
  await t.test('reset still ignores unused malformed body and content type',async()=>{assert.equal((await request('/api/reset','{','text/plain')).status,200);assert.equal((await get('/api/state')).status,'READY');});
 }finally{
  server.closeAllConnections();await new Promise(r=>server.close(r));delete require.cache[key];CMemoryTicketRepository.prototype.save=save;ExamJobs.prototype.handler=handler;
  if(prev===undefined)delete process.env.ARCH026_GUI_DATA_DIR;else process.env.ARCH026_GUI_DATA_DIR=prev;
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
