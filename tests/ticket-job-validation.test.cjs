'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CTicketManager,CMemoryTicketRepository,TicketValidationError}=require('../dist/src/prototype/ticket');
const {ExamJobs}=require('../gui/exam-jobs');
const {WorkflowRuntime}=require('../gui/workflow-runtime');
const input={title:'test',createdBy:'author',ownerId:'owner'};
const date={examDate:'2028-02-29',startTime:'10:00',location:'道場',confirmedBy:'先生'};
function setup(){const repo=new CMemoryTicketRepository();let saves=0;const save=repo.save.bind(repo);repo.save=t=>{saves++;save(t);};return {manager:new CTicketManager(repo,()=> '2026-11-07T10:00:00.000Z'),repo,count:()=>saves};}
const invalid=e=>e instanceof TicketValidationError&&e.status===400&&e.code==='INVALID_ARGUMENT';
test('Ticket required fields, root, description, dueAt and parent ID: reject before any save',()=>{
 const {manager:m,count}=setup();
 for(const value of [null,undefined,[],42,true,'text'])assert.throws(()=>m.create(value),invalid);
 for(const key of ['title','createdBy','ownerId']){
  const missing={...input};delete missing[key];assert.throws(()=>m.create(missing),invalid);
  for(const value of [null,42,true,[],{},'', ' '])assert.throws(()=>m.create({...input,[key]:value}),invalid);
 }
 for(const value of [null,42,false,[],{}])assert.throws(()=>m.create({...input,description:value}),invalid);
 for(const value of [42,true,[],{},'', '2026-02-30T10:00Z','2027-02-29T10:00Z','1900-02-29T10:00Z','2026-13-01T10:00Z','2026-01-00T10:00Z','2026-01-01','2026-01-01T25:00Z','2026-01-01T24:01Z','2026-01-01T10:60Z','2026-01-01T10:00:60Z','2026-01-01T10:00+24:00','2026-01-01T10:00+09:60'])assert.throws(()=>m.create({...input,dueAt:value}),invalid);
 for(const value of [42,true,[],{},'', ' '])assert.throws(()=>m.create({...input,parentTicketId:value}),invalid);
 assert.equal(count(),0);assert.deepEqual(m.list(),[]);
});
test('Ticket valid calendar, offsets, local times, null and omitted optional fields retain values',()=>{
 const {manager:m}=setup();
 for(const dueAt of [null,undefined,'2028-02-29T09:30Z','2000-02-29T09:30:00.123Z','2026-11-07T09:30:00+09:00','2026-11-07T09:30-05:30','2026-11-07T09:30','2026-11-07T24:00:00Z']){
  const t=m.create({...input,dueAt,parentTicketId:null});assert.equal(t.dueAt,dueAt??null);assert.equal(t.description,'');assert.equal(t.parentTicketId,null);
 }
 const t=m.create({...input,description:''});m.edit(t.ticketId,{dueAt:null,description:''});assert.equal(m.get(t.ticketId).dueAt,null);
});
test('Ticket edit validates whole patch before mutation, including a reference-retaining repository',()=>{
 const {manager:m,count,repo}=setup(),t=m.create(input);const before=m.get(t.ticketId),n=count();
 // A direct Repository may return references: failed input still must not mutate them.
 const get=repo.get.bind(repo);let stored=get(t.ticketId);repo.get=()=>stored;
 for(const patch of [null,[],42,{title:42},{title:'changed',description:{}},{title:'changed',dueAt:'2026-02-30T10:00Z'},{ownerId:null},{description:null}]){
  assert.throws(()=>m.edit(t.ticketId,patch),invalid);assert.deepEqual(stored,before);assert.equal(count(),n);
 }
 repo.get=get;m.edit(t.ticketId,{title:'valid',description:'text'});assert.equal(m.get(t.ticketId).title,'valid');
});
test('Ticket public ID and Workflow binding validation preserve OPEN state and save count',()=>{
 const {manager:m,count}=setup(),t=m.create(input);m.submit(t.ticketId);const before=m.get(t.ticketId),n=count();
 for(const value of [null,undefined,42,true,[],{},'', ' ']){
  for(const action of ['get','submit','complete','cancel'])assert.throws(()=>m[action](value),invalid);
  assert.throws(()=>m.edit(value,{}),invalid);
  for(const index of [0,1,2]){const args=['workflow','v1','run'];args[index]=value;assert.throws(()=>m.attachWorkflow(t.ticketId,...args),invalid);}
 }
 assert.deepEqual(m.get(t.ticketId),before);assert.equal(count(),n);m.attachWorkflow(t.ticketId,'workflow','v1','run');m.complete(t.ticketId);assert.equal(m.get(t.ticketId).status,'COMPLETED');assert.throws(()=>m.edit(t.ticketId,{title:'closed'}));
});
test('Job rejects wrong types and impossible dates without creating records or completing Workflow',async()=>{
 const jobs=new ExamJobs(),keyword='exam.dateAgreement',handler=jobs.handler(keyword,'run');
 const runtime=new WorkflowRuntime({id:'test',version:'1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId:keyword,nextStepId:'END'},{id:'END',type:'END'}]},{[keyword]:handler},{runId:'run'});
 for(const field of Object.keys(date))for(const value of [42,true,[],{}]){
  assert.throws(()=>jobs.submit(keyword,'run','J',{...date,[field]:value}),e=>e.status===400);
  assert.equal(jobs.describe(keyword,'run','J').record,null);
 }
 for(const examDate of ['2026-99-99','2026-02-30','2027-02-29','1900-02-29','2026-04-31','2026-00-01','2026-01-00'])assert.throws(()=>jobs.submit(keyword,'run','J',{...date,examDate}),e=>e.status===400);
 assert.equal((await runtime.advance()).status,'WAITING');assert.deepEqual(runtime.history,[]);
 const record=jobs.submit(keyword,'run','J',date);assert.deepEqual(record.values,date);
 for(const bad of [{...date,location:{}},{...date,confirmedBy:false},{...date,examDate:'2027-02-29'}]){
  assert.throws(()=>jobs.submit(keyword,'run','J',bad),e=>e.status===400);assert.deepEqual(jobs.describe(keyword,'run','J').record,record);
 }
 record.values.location='mutated';assert.equal(jobs.describe(keyword,'run','J').record.values.location,date.location);
 assert.equal((await runtime.advance()).status,'ACTIVE');assert.equal((await runtime.advance()).status,'COMPLETED');
});
test('Job optional remarks null/omission and required/null checks retain existing contracts',()=>{
 const j=new ExamJobs(),base={candidate:'A',grade:'初段',result:'合格',evaluator:'先生'};
 for(const remarks of [undefined,null,''])assert.equal(j.submit('exam.resultRegistration','r','s',{...base,remarks}).values.remarks,'');
 for(const remarks of [42,false,{},[]])assert.throws(()=>j.submit('exam.resultRegistration','r','s',{...base,remarks}),e=>e.status===400);
 for(const field of Object.keys(date))for(const value of [undefined,null,' '])assert.throws(()=>j.submit('exam.dateAgreement','r','s',{...date,[field]:value}),e=>e.status===400);
});
test('HTTP Ticket and Job validation: 400, no saves or completion, recovery with valid input',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-ticket-validation-')),prev=process.env.ARCH026_GUI_DATA_DIR;
 const save=CMemoryTicketRepository.prototype.save;let saves=0;
 CMemoryTicketRepository.prototype.save=function(t){saves++;return save.call(this,t);};
 process.env.ARCH026_GUI_DATA_DIR=dir;const key=require.resolve('../gui/server');delete require.cache[key];const {server}=require(key);
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  async function api(route,body,status=200){const res=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),value=await res.json();assert.equal(res.status,status,JSON.stringify(value));return value;}
  for(const dueAt of ['2026-02-30T10:00Z','2027-02-29T10:00Z','2026-01-01T25:00Z']){const before=saves;await api('/api/tickets',{...input,dueAt},400);assert.equal(saves,before);assert.deepEqual(await api('/api/tickets'),[]);}
  const ticket=await api('/api/tickets',{...input,dueAt:'2028-02-29T10:00+0900'},201),n=saves;
  await api('/api/ticket-action',{ticketId:ticket.ticketId,action:'edit',patch:{title:'changed',dueAt:'2026-02-30T10:00Z'}},400);
  assert.equal(saves,n);assert.deepEqual(await api('/api/tickets/'+ticket.ticketId),ticket);
  await api('/api/jobs',{keyword:'exam.dateAgreement',jobClass:'CExamDateAgreementJob',displayName:'日程合意'});
  await api('/api/definitions',{id:'v',version:'1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId:'exam.dateAgreement',nextStepId:'END'},{id:'END',type:'END'}]});
  await api('/api/ticket-action',{ticketId:ticket.ticketId,action:'submit'});
  await api('/api/ticket-action',{ticketId:ticket.ticketId,action:'start',definitionId:'v',definitionVersion:'1'});
  const before=await api('/api/state'),count=saves;
  for(const bad of [{...date,examDate:'2026-02-30'},{...date,location:{}},{...date,confirmedBy:false}]){
   await api('/api/job-submit',{values:bad},400);assert.deepEqual(await api('/api/state'),before);assert.equal(saves,count);
  }
  await api('/api/step',{});const waiting=await api('/api/state');assert.equal(waiting.status,'WAITING');assert.deepEqual(waiting.history,[]);assert.equal(waiting.jobForm.record,null);
  assert.equal((await api('/api/tickets/'+ticket.ticketId)).status,'IN_PROGRESS');
  await api('/api/job-submit',{values:date});const recorded=await api('/api/state');
  await api('/api/job-submit',{values:{...date,location:42}},400);assert.deepEqual(await api('/api/state'),recorded);
  await api('/api/step',{});await api('/api/step',{});assert.equal((await api('/api/state')).status,'COMPLETED');assert.equal((await api('/api/tickets/'+ticket.ticketId)).status,'COMPLETED');
 }finally{
  server.closeAllConnections();await new Promise(r=>server.close(r));delete require.cache[key];CMemoryTicketRepository.prototype.save=save;
  if(prev===undefined)delete process.env.ARCH026_GUI_DATA_DIR;else process.env.ARCH026_GUI_DATA_DIR=prev;
  fs.rmSync(dir,{recursive:true,force:true});
 }
});
