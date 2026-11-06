'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http'),vm=require('node:vm');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}

test('GUI HTTP concurrency and delayed request isolation',{timeout:15000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-concurrency-'));
 const oldDir=process.env.ARCH026_GUI_DATA_DIR;process.env.ARCH026_GUI_DATA_DIR=dir;
 const {ExamJobs}=require('../gui/exam-jobs');const original=ExamJobs.prototype.handler;
 let behavior;
 ExamJobs.prototype.handler=function(){const selected=behavior;return selected.handler;};
 const {server}=require('../gui/server');
 if(oldDir===undefined)delete process.env.ARCH026_GUI_DATA_DIR;else process.env.ARCH026_GUI_DATA_DIR=oldDir;
 const cleanup=[];
 t.after(async()=>{cleanup.forEach(fn=>fn());ExamJobs.prototype.handler=original;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 async function api(route,body,status=200){const res=await fetch(base+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const result=await res.json();assert.equal(res.status,status,JSON.stringify(result));return result;}
 const state=()=>api('/api/state'),step=(status=200)=>api('/api/step',{},status);
 async function ticket(){const x=await api('/api/tickets',{title:'probe',createdBy:'test',ownerId:'test'},201);return api('/api/ticket-action',{ticketId:x.ticketId,action:'submit'});}
 const start=(id,executionMode='NORMAL',status=200)=>api('/api/ticket-action',{ticketId:id,action:'start',definitionId:'probe',definitionVersion:'v1',executionMode},status);
 await api('/api/jobs',{keyword:'exam.dateAgreement',jobClass:'CExamDateAgreementJob',displayName:'test'});
 await api('/api/definitions',{id:'probe',version:'v1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId:'exam.dateAgreement',nextStepId:'END'},{id:'END',type:'END'}]});

 for(const outcome of ['COMPLETED','WAITING','FAILED','THROW'])await t.test(`parallel HTTP step: ${outcome}; rejected request changes nothing`,async()=>{
  const gate=deferred(),entered=deferred();cleanup.push(()=>gate.resolve());let calls=0;
  behavior={handler:async()=>{calls++;if(calls>1)return {status:'COMPLETED'};entered.resolve();await gate.promise;if(outcome==='THROW')throw Error('injected failure');return {status:outcome};}};
  const x=await ticket();await start(x.ticketId);
  const first=step(outcome==='THROW'?500:200);await entered.promise;
  const before=await state(),beforeTicket=await api('/api/tickets/'+x.ticketId);
  const rejected=await step(409);assert.equal(rejected.code,'RUNTIME_BUSY');assert.equal(calls,1);assert.deepEqual(await state(),before);assert.deepEqual(await api('/api/tickets/'+x.ticketId),beforeTicket);
  await start(x.ticketId,'NORMAL',409);
  gate.resolve();await first;
  if(outcome==='WAITING'){assert.equal((await state()).status,'WAITING');await step();}
  if(['COMPLETED','WAITING'].includes(outcome)){
   await step();const s=await state();assert.equal(s.status,'COMPLETED');assert.deepEqual(s.history.map(h=>h.stepId),['J','END']);assert.equal((await api('/api/tickets/'+x.ticketId)).status,'COMPLETED');
  }else{
   const s=await state();assert.equal(s.status,'FAILED');assert.equal(s.history.length,1);assert.equal(s.history[0].result,outcome==='THROW'?'ERROR':'FAILED');assert.equal((await api('/api/tickets/'+x.ticketId)).status,'IN_PROGRESS');
   await step(500);assert.deepEqual(await state(),s);
   // Existing cancellation API is only fixture cleanup, not a Ticket policy change.
   await api('/api/ticket-action',{ticketId:x.ticketId,action:'cancel'});
  }
 });

 // Signal acceptance via server's request event, after the production listener has
 // reached readBody(). No sleeps or assumptions about socket scheduling are used.
 async function delayed(route,body){
  const accepted=deferred(),tag=`probe-${++delayed.seq}`;
  const listener=req=>{if(req.headers['x-probe']===tag){server.off('request',listener);accepted.resolve();}};
  server.on('request',listener);const json=JSON.stringify(body);
  let request;const result=new Promise((resolve,reject)=>{
   request=http.request(base+route,{method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(json),'X-Probe':tag}},res=>{let value='';res.on('data',c=>value+=c);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(value)});}catch(e){reject(e);}});});request.on('error',reject);request.write(json.slice(0,-1));
  });
  cleanup.push(()=>request.destroy());await accepted.promise;return {finish:()=>request.end(json.slice(-1)),result};
 }
 delayed.seq=0;
 await t.test('delayed step body cannot execute a replacement Runtime or complete its Ticket',async()=>{
  const a=await ticket();await start(a.ticketId,'DEMO');const pending=await delayed('/api/step',{});
  await step();await step();const b=await ticket();await start(b.ticketId,'DEMO');
  const before=await state(),ta=await api('/api/tickets/'+a.ticketId),tb=await api('/api/tickets/'+b.ticketId);
  pending.finish();const r=await pending.result;assert.equal(r.status,409);assert.equal(r.body.code,'EXECUTION_CHANGED');assert.deepEqual(await state(),before);assert.deepEqual(await api('/api/tickets/'+a.ticketId),ta);assert.deepEqual(await api('/api/tickets/'+b.ticketId),tb);await step();await step();
 });
 await t.test('delayed start cannot replace a newer execution',async()=>{
  const a=await ticket();await start(a.ticketId,'DEMO');const b=await ticket();
  const pending=await delayed('/api/ticket-action',{ticketId:b.ticketId,action:'start',definitionId:'probe',definitionVersion:'v1',executionMode:'DEMO'});
  await step();await step();await start(b.ticketId,'DEMO');const before=await state(),ticketBefore=await api('/api/tickets/'+b.ticketId);
  pending.finish();const r=await pending.result;assert.equal(r.status,409);assert.equal(r.body.code,'EXECUTION_CHANGED');assert.deepEqual(await state(),before);assert.deepEqual(await api('/api/tickets/'+b.ticketId),ticketBefore);await step();await step();
 });
 await t.test('delayed job submission cannot write input into a replacement run',async()=>{
  behavior={handler:async()=>({status:'COMPLETED'})};const a=await ticket();await start(a.ticketId);
  const pending=await delayed('/api/job-submit',{values:{examDate:'2026-11-07',startTime:'10:00',location:'test',confirmedBy:'test'}});
  await step();await step();const b=await ticket();await start(b.ticketId);const before=await state();assert.equal(before.jobForm.record,null);const ticketBefore=await api('/api/tickets/'+b.ticketId);
  pending.finish();const r=await pending.result;assert.equal(r.status,409);assert.equal(r.body.code,'EXECUTION_CHANGED');assert.deepEqual(await state(),before);assert.deepEqual(await api('/api/tickets/'+b.ticketId),ticketBefore);await step();await step();
 });
 await t.test('duplicate HTTP starts create only one execution',async()=>{
  const x=await ticket();const request={ticketId:x.ticketId,action:'start',definitionId:'probe',definitionVersion:'v1'};
  const responses=await Promise.all([fetch(base+'/api/ticket-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}),fetch(base+'/api/ticket-action',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)})]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);await Promise.all(responses.map(r=>r.json()));assert.equal((await api('/api/tickets/'+x.ticketId)).executionId,(await state()).runId);await step();await step();
 });
});

test('GUI start button guard prevents a second request and releases after failure/cancel',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'../gui/index.html'),'utf8');
 const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];new vm.Script(script);
 const refreshFunction=script.split('\n').find(s=>s.startsWith('async function refreshTickets()'));
 const element=()=>({children:[],disabled:false,append(x){this.children.push(x);},replaceChildren(){this.children=[];}});
 const nodes={tickets:element(),ticketError:element(),executionMode:{value:'NORMAL'}};
 let gate=deferred(),definitionCalls=0,starts=0,fail=false,cancel=false;
 const context=vm.createContext({document:{createElement:element},$:id=>nodes[id],cell:(tr,value)=>tr.append({value}),prompt:()=>cancel?null:'probe / v1',refresh:async()=>{},api:async route=>{
  if(route==='/api/tickets')return [{ticketId:'t',status:'OPEN'}];
  if(route==='/api/definitions'){definitionCalls++;await gate.promise;if(fail)throw Error('fetch failed');return [{id:'probe',version:'v1'}];}
  if(route==='/api/ticket-action'){starts++;return {};}
 }});
 vm.runInContext('let starting=false;'+refreshFunction,context);await vm.runInContext('refreshTickets()',context);
 const button=nodes.tickets.children[0].children.at(-1).children.find(b=>b.textContent==='実行開始');
 const first=button.onclick();assert.equal(button.disabled,true);await button.onclick();assert.equal(definitionCalls,1);gate.resolve();await first;assert.equal(starts,1);assert.equal(button.disabled,false);
 fail=true;await button.onclick();assert.equal(button.disabled,false);assert.equal(nodes.ticketError.textContent,'fetch failed');
 fail=false;cancel=true;await button.onclick();assert.equal(button.disabled,false);assert.equal(starts,1);
 cancel=false;await button.onclick();assert.equal(starts,2);
});
