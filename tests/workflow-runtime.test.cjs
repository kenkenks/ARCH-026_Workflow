const {test}=require('node:test');const assert=require('node:assert/strict');
const {WorkflowRuntime}=require('../gui/workflow-runtime');
const def={id:'exam',version:'v1',startStepId:'S1',eventRoutes:[],steps:[
 {id:'S1',type:'JOB',jobId:'exam.dateAgreement',nextStepId:'S2'},
 {id:'S2',type:'CHECK_PROVISIONAL',nextStepId:'S3',retryTargetStepId:'S1'},
 {id:'S3',type:'JOB',jobId:'exam.result',nextStepId:'S4'},
 {id:'S4',type:'END'}]};
test('JOB待機、再開、差戻し、判定、完了',async()=>{
 // Explicit test handlers exercise Runtime protocol, not business input validation.
 let calls=0;const runtime=new WorkflowRuntime(def,{'exam.dateAgreement':async()=>({status:++calls===1?'WAITING':'COMPLETED'}),'exam.result':async()=>({status:'COMPLETED'})});
 assert.equal((await runtime.advance()).status,'WAITING');assert.equal(runtime.snapshot().history.length,0);
 assert.equal((await runtime.advance()).currentStepId,'S2');
 assert.equal((await runtime.advance()).status,'WAITING');
 assert.equal((await runtime.advance({checkResult:'REJECT'})).currentStepId,'S1');
 await runtime.advance();await runtime.advance({checkResult:'PASS'});await runtime.advance();
 assert.equal((await runtime.advance()).status,'COMPLETED');assert.equal(runtime.snapshot().history.length,6);
});
test('未実装JOBは成功扱いせずFAILEDとなり、完了履歴を作らない',async()=>{const r=new WorkflowRuntime(def);await assert.rejects(()=>r.advance(),/実装未登録/);assert.equal(r.snapshot().history.length,0);assert.equal(r.snapshot().status,'FAILED');assert.equal(r.snapshot().simulatedJobUsed,false);await assert.rejects(()=>r.advance(),/終了/);});
test('不正なCHECK結果を拒否',async()=>{const r=new WorkflowRuntime(def,{'exam.dateAgreement':async()=>({status:'COMPLETED'})});await r.advance();await assert.rejects(()=>r.advance({checkResult:'TRUE'}),/不正/);});
test('差戻し先のないREJECTはFAILED',async()=>{const d={...def,steps:def.steps.map(s=>s.id==='S2'?{...s,type:'CHECK_FINAL',retryTargetStepId:undefined}:s)};const r=new WorkflowRuntime(d,{'exam.dateAgreement':async()=>({status:'COMPLETED'})});await r.advance();assert.equal((await r.advance({checkResult:'REJECT'})).status,'FAILED');});

const shortDef={id:'short',version:'v1',startStepId:'J',eventRoutes:[],steps:[{id:'J',type:'JOB',jobId:'custom.job',nextStepId:'END'},{id:'END',type:'END'}]};
test('通常実行のHandler正常終了とEND到達を区別して記録',async()=>{
 let calls=0;const r=new WorkflowRuntime(shortDef,{'custom.job':async()=>{calls++;return {status:'COMPLETED'};}});
 const first=await r.advance();assert.equal(first.status,'ACTIVE');assert.equal(first.history[0].result,'DONE');
 const end=await r.advance();assert.equal(calls,1);assert.equal(end.status,'COMPLETED');assert.equal(end.resultKind,'CONTROL_FLOW_COMPLETED');assert.equal(end.executionMode,'NORMAL');assert.equal(end.simulatedJobUsed,false);assert.ok(end.history.every(h=>h.executionMode==='NORMAL'&&!h.simulated));
});
test('明示的DEMOの模擬Handlerを結果・履歴へ記録',async()=>{
 const r=new WorkflowRuntime(shortDef,{'custom.job':async()=>({status:'COMPLETED'})},{executionMode:'DEMO',simulatedJobIds:['custom.job']});
 assert.equal(r.snapshot().simulatedJobUsed,false);await r.advance();const end=await r.advance();
 assert.equal(end.status,'COMPLETED');assert.equal(end.resultKind,'DEMO_COMPLETED');assert.equal(end.simulatedJobUsed,true);assert.equal(end.history[0].simulated,true);assert.equal(end.history[1].simulated,false);assert.ok(end.history.every(h=>h.executionMode==='DEMO'));
 assert.throws(()=>new WorkflowRuntime(shortDef,{}, {executionMode:'NORMAL',simulatedJobIds:['custom.job']}),/モード/);
 assert.throws(()=>new WorkflowRuntime(shortDef,{}, {executionMode:'invalid'}),/モード/);
});
for(const [name,handler,result] of [
 ['例外',async()=>{throw Error('handler failed');},'ERROR'],
 ['不正戻り値',async()=>({status:'UNKNOWN'}),'ERROR'],
 ['失敗',async()=>({status:'FAILED'}),'FAILED']
])test(`${name}をCOMPLETEDにせず実行されたJobのみ失敗履歴に残す`,async()=>{
 const r=new WorkflowRuntime(shortDef,{'custom.job':handler});
 if(result==='ERROR')await assert.rejects(()=>r.advance());else await r.advance();
 const s=r.snapshot();assert.equal(s.status,'FAILED');assert.equal(s.resultKind,'FAILED');assert.equal(s.history.length,1);assert.equal(s.history[0].result,result);assert.equal(s.currentStepId,'J');assert.equal(s.pending,null);
});
test('後続Handler未解決時は実行済みJobだけDONEで残す',async()=>{
 const d={...shortDef,steps:[{...shortDef.steps[0],nextStepId:'M'},{id:'M',type:'JOB',jobId:'missing',nextStepId:'END'},shortDef.steps[1]]};
 const r=new WorkflowRuntime(d,{'custom.job':async()=>({status:'COMPLETED'})});
 await r.advance();await assert.rejects(()=>r.advance(),/実装未登録/);
 const s=r.snapshot();assert.equal(s.status,'FAILED');assert.equal(s.history.length,1);assert.equal(s.history[0].stepId,'J');assert.equal(s.history[0].result,'DONE');assert.equal(s.currentStepId,'M');assert.equal(s.simulatedJobUsed,false);
});
test('模擬HandlerのWAITINGと例外も使用事実を保ち、完了扱いしない',async()=>{
 let calls=0;const r=new WorkflowRuntime(shortDef,{'custom.job':async()=>{if(++calls===1)return {status:'WAITING'};throw Error('demo failed');}},{executionMode:'DEMO',simulatedJobIds:['custom.job']});
 const waiting=await r.advance();assert.equal(waiting.status,'WAITING');assert.equal(waiting.simulatedJobUsed,true);assert.equal(waiting.history.length,0);
 await assert.rejects(()=>r.advance(),/demo failed/);const failed=r.snapshot();assert.equal(failed.status,'FAILED');assert.equal(failed.resultKind,'FAILED');assert.equal(failed.history[0].executionMode,'DEMO');assert.equal(failed.history[0].simulated,true);assert.equal(failed.history[0].result,'ERROR');
});
