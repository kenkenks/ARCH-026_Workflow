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
test('未実装JOBは成功扱いしない',async()=>{const r=new WorkflowRuntime(def);await assert.rejects(()=>r.advance(),/実装未登録/);assert.equal(r.snapshot().history.length,0);});
test('不正なCHECK結果を拒否',async()=>{const r=new WorkflowRuntime(def,{'exam.dateAgreement':async()=>({status:'COMPLETED'})});await r.advance();await assert.rejects(()=>r.advance({checkResult:'TRUE'}),/不正/);});
test('差戻し先のないREJECTはFAILED',async()=>{const d={...def,steps:def.steps.map(s=>s.id==='S2'?{...s,type:'CHECK_FINAL',retryTargetStepId:undefined}:s)};const r=new WorkflowRuntime(d,{'exam.dateAgreement':async()=>({status:'COMPLETED'})});await r.advance();assert.equal((await r.advance({checkResult:'REJECT'})).status,'FAILED');});
