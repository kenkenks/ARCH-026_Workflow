'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

test('GUI実HTTP: 通常Handler解決、明示デモ、Ticket完了の分離',async t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-mode-'));
 const previous=process.env.ARCH026_GUI_DATA_DIR;
 process.env.ARCH026_GUI_DATA_DIR=directory;
 const {server}=require('../gui/server');
 if(previous===undefined)delete process.env.ARCH026_GUI_DATA_DIR;else process.env.ARCH026_GUI_DATA_DIR=previous;
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(directory,{recursive:true,force:true});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 async function api(route,body,status=200){const r=await fetch(base+route,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return value;}
 const state=()=>api('/api/state');
 const step=()=>api('/api/step',{});
 async function ticket(){const x=await api('/api/tickets',{title:'test',createdBy:'test-author',ownerId:'test-owner'},201);return api('/api/ticket-action',{ticketId:x.ticketId,action:'submit'});}
 const definition=(id,jobId)=>({id,version:'v1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId,nextStepId:'END'},{id:'END',type:'END'}]});
 await api('/api/jobs',{keyword:'custom.job',displayName:'unimplemented',jobClass:'CJob'});
 await api('/api/jobs',{keyword:'exam.dateAgreement',displayName:'date agreement',jobClass:'CExamDateAgreementJob'});
 await api('/api/definitions',definition('unresolved','custom.job'));
 await api('/api/definitions',definition('resolved','exam.dateAgreement'));
 const a=await ticket();
 await t.test('通常実行は未解決Handlerを開始前拒否し、Ticketや履歴を変更しない',async()=>{
  const before=await state();
  const rejected=await api('/api/ticket-action',{ticketId:a.ticketId,action:'start',definitionId:'unresolved',definitionVersion:'v1'},400);
  assert.match(rejected.error,/実装未登録/);assert.deepEqual(await state(),before);
  const after=await api('/api/tickets/'+a.ticketId);assert.equal(after.status,'OPEN');assert.equal(after.workflowId,null);
 });
 await t.test('明示的DEMOのみ模擬Handler実行、業務TicketはOPENのまま',async()=>{
  await api('/api/ticket-action',{ticketId:a.ticketId,action:'start',definitionId:'unresolved',definitionVersion:'v1',executionMode:'DEMO'});
  assert.equal((await state()).jobForm,null);
  await step();const completed=await step();assert.equal(completed.resultKind,'DEMO_COMPLETED');
  const s=await state();assert.equal(s.executionMode,'DEMO');assert.equal(s.simulatedJobUsed,true);assert.equal(s.history[0].simulated,true);assert.equal(s.history[0].executionMode,'DEMO');assert.equal(s.history[0].result,'DONE');assert.equal(s.activeTicketId,null);assert.equal((await api('/api/tickets/'+a.ticketId)).status,'OPEN');
  await api('/api/job-submit',{values:{}},409);
 });
 await t.test('解決可能な業務JOBもDEMOでは実Handlerを呼ばずTicketは未完了',async()=>{
  await api('/api/ticket-action',{ticketId:a.ticketId,action:'start',definitionId:'resolved',definitionVersion:'v1',executionMode:'DEMO'});
  await step();await step();const s=await state();assert.equal(s.resultKind,'DEMO_COMPLETED');assert.equal(s.simulatedJobUsed,true);assert.equal((await api('/api/tickets/'+a.ticketId)).status,'OPEN');
 });
 await t.test('通常実行は入力前WAITING、登録後のみ完了・Ticket完了',async()=>{
  await api('/api/ticket-action',{ticketId:a.ticketId,action:'start',definitionId:'resolved',definitionVersion:'v1'});
  assert.equal((await step()).status,'WAITING');let s=await state();assert.equal(s.history.length,0);assert.equal(s.executionMode,'NORMAL');assert.equal(s.simulatedJobUsed,false);assert.equal((await api('/api/tickets/'+a.ticketId)).status,'IN_PROGRESS');
  await api('/api/job-submit',{values:{examDate:'2026-11-06',startTime:'10:00',location:'test-room',confirmedBy:'test-user'}});
  assert.equal((await step()).status,'ACTIVE');assert.equal((await step()).resultKind,'CONTROL_FLOW_COMPLETED');
  s=await state();assert.ok(s.history.every(h=>h.executionMode==='NORMAL'&&!h.simulated));assert.equal((await api('/api/tickets/'+a.ticketId)).status,'COMPLETED');
 });
 await t.test('固定デモFALSE FALSE TRUE ENDと履歴のDEMO表示を維持',async()=>{
  await api('/api/reset',{});
  for(let i=0;i<8;i++){
   await step();
   for(let n=0;n<100;n++){const s=await state();if(s.history.length>=i+1)break;await new Promise(resolve=>setTimeout(resolve,5));}
  }
  const s=await state();assert.equal(s.activeTicketId,null);assert.equal(s.status,'COMPLETED');assert.equal(s.resultKind,'DEMO_COMPLETED');assert.deepEqual(s.history.filter(h=>h.stepNo===20).map(h=>h.result),['FALSE','FALSE','TRUE']);assert.equal(s.history.at(-1).nextStepNo,null);assert.ok(s.history.every(h=>h.executionMode==='DEMO'&&h.simulated));
 });
});

test('CLIデモは模擬処理を明示し、既存の循環分岐を実行',()=>{
 const output=execFileSync(process.execPath,['dist/src/prototype/demo.js'],{cwd:path.join(__dirname,'..'),encoding:'utf8'});
 const trace=output.split('工程別サマリー')[0];
 assert.match(output,/モード=DEMO/);assert.match(output,/業務完了ではありません/);assert.equal((trace.match(/'FALSE'/g)||[]).length,2);assert.equal((trace.match(/'TRUE'/g)||[]).length,1);assert.match(output,/END/);
});
