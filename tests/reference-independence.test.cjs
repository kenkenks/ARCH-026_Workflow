'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CWorkflow,CDummyJob,CCheckJob,CSequenceBool,CMemoryHistoryStore,CWorkflowMonitor}=require('../dist/src/prototype/workflow');
const {ExamJobs}=require('../gui/exam-jobs');
const sample=(runId='run-a')=>({runId,currentStepNo:2,status:'FAILED',history:[{order:1,stepNo:1,job:'first',result:'DONE',nextStepNo:2,at:'2026-11-07T00:00:00.000Z'}],failure:{code:'BEFORE_STEP_FAILED',stepNo:2,summary:'before step failed'}});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function retainingStore(){const snapshots=[],values=new Map();return {snapshots,load:id=>values.get(id),save:s=>{snapshots.push(s);values.set(s.runId,s);}};}

test('History Store save detaches source root, history entries, array and failure',()=>{
 const store=new CMemoryHistoryStore(),source=sample(),expected=structuredClone(source);store.save(source);
 source.status='COMPLETED';source.currentStepNo=null;source.history[0].job='changed';source.history[0].result='ERROR';source.history.push({...source.history[0],order:2});source.failure.summary='changed';source.failure.stepNo=999;
 assert.deepEqual(store.load('run-a'),expected);
});

test('two loads share no current-schema structures and mutating one changes neither the other nor Store',()=>{
 const store=new CMemoryHistoryStore(),expected=sample();store.save(expected);const a=store.load('run-a'),b=store.load('run-a');
 assert.notEqual(a,b);assert.notEqual(a.history,b.history);assert.notEqual(a.history[0],b.history[0]);assert.notEqual(a.failure,b.failure);
 a.status='COMPLETED';a.runId='wrong';a.currentStepNo=null;a.history[0].result='ERROR';a.history[0].nextStepNo=null;a.failure.summary='changed';a.history.splice(0,1);
 assert.deepEqual(b,expected);assert.deepEqual(store.load('run-a'),expected);assert.equal(store.load('missing'),undefined);
});

test('history array edits and every TraceEntry field remain local to the returned snapshot',()=>{
 const store=new CMemoryHistoryStore(),source=sample();source.history.push({order:2,stepNo:2,job:'failed',result:'ERROR',nextStepNo:null,at:'2026-11-07T00:00:01.000Z',error:'original error'});store.save(source);
 const view=store.load('run-a');Object.assign(view.history[1],{order:99,stepNo:99,job:'modified',result:'TRUE',nextStepNo:999,at:'modified',error:'modified'});view.history.reverse();view.history.pop();view.history.push({...view.history[0]});
 assert.deepEqual(store.load('run-a'),source);
});

test('failure metadata from load and CWorkflowMonitor.get cannot change stored failures',async()=>{
 const store=new CMemoryHistoryStore(),source=sample();store.save(source);const monitor=new CWorkflowMonitor(store),a=await monitor.get('run-a'),b=await monitor.get('run-a');
 a.failure.code='changed';a.failure.stepNo=99;a.failure.summary='changed';a.history[0].result='ERROR';a.history.length=0;
 assert.deepEqual(b,source);assert.deepEqual(await monitor.get('run-a'),source);assert.deepEqual(store.load('run-a'),source);
 const rows=await monitor.summary('run-a');rows[0].lastResult='changed';rows[0].executions=999;assert.deepEqual(await monitor.summary('run-a'),[{stepNo:1,executions:1,lastResult:'DONE'}]);
});

test('different runIds remain independent even when save inputs shared an entry/failure',()=>{
 const store=new CMemoryHistoryStore(),a=sample(),b={...a,runId:'run-b'};store.save(a);store.save(b);const view=store.load('run-a');view.history[0].job='changed';view.failure.summary='changed';view.history.length=0;store.save(view);
 assert.deepEqual(store.load('run-b'),b);assert.equal(store.load('run-a').history.length,0);
});

test('retained earlier snapshot mutation cannot alter later snapshots or Core history',async()=>{
 const store=retainingStore(),entered=deferred(),release=deferred();let step=0;
 const wf=new CWorkflow([{no:1,job:new CDummyJob('first'),nextStepNo:2},{no:2,job:new CDummyJob('second')}],store);
 const running=wf.run('retained',1,10,async()=>{if(++step===2){entered.resolve();await release.promise;}});await entered.promise;
 const prior=store.snapshots[1];assert.equal(prior.history[0].job,'first');prior.history[0].job='changed through old snapshot';prior.history[0].result='ERROR';prior.history[0].nextStepNo=999;prior.history.push({...prior.history[0],order:99});prior.status='COMPLETED';
 release.resolve();const final=await running;assert.equal(final.status,'COMPLETED');assert.deepEqual(final.history.map(h=>[h.stepNo,h.job,h.result,h.nextStepNo]),[[1,'first','DONE',2],[2,'second','DONE',null]]);
 const latest=store.snapshots.at(-1);assert.notEqual(prior.history[0],latest.history[0]);assert.notEqual(final.history[0],latest.history[0]);assert.equal(latest.history.length,2);assert.equal(latest.history[0].job,'first');
});

test('Store mutating every received snapshot cannot corrupt Core final result',async()=>{
 const values=new Map();let saves=0;
 const store={load:id=>values.get(id),save:s=>{saves++;values.set(s.runId,s);s.status='FAILED';s.currentStepNo=999;for(const entry of s.history){entry.job='adapter changed';entry.result='ERROR';}s.history.push({order:999,stepNo:999,job:'fake',result:'ERROR',nextStepNo:null,at:'fake'});}};
 const wf=new CWorkflow([{no:1,job:new CDummyJob('actual')}],store),result=await wf.run('mutating-store',1);
 assert.ok(saves>0);assert.equal(result.status,'COMPLETED');assert.equal(result.currentStepNo,null);assert.deepEqual(result.history.map(h=>[h.stepNo,h.job,h.result]),[[1,'actual','DONE']]);
 // Adapter-owned data is deliberately corrupt in this fixture; Core must not trust its references.
 assert.equal(values.get('mutating-store').status,'FAILED');
});

test('final result and final Store input do not share root, history or TraceEntry',async()=>{
 const store=retainingStore(),wf=new CWorkflow([{no:1,job:new CDummyJob('original')}],store);const result=await wf.run('final',1),saved=store.snapshots.at(-1);
 assert.notEqual(result,saved);assert.notEqual(result.history,saved.history);assert.notEqual(result.history[0],saved.history[0]);
 saved.history[0].job='store changed';assert.equal(result.history[0].job,'original');result.status='FAILED';result.history[0].result='ERROR';result.history.length=0;
 assert.equal(saved.status,'COMPLETED');assert.equal(saved.history.length,1);assert.equal(saved.history[0].result,'DONE');
});

test('FALSE FALSE TRUE branches, loops and END remain unchanged with a retaining Store',async()=>{
 const store=retainingStore(),wf=new CWorkflow([{no:1,job:new CDummyJob('A'),nextStepNo:2},{no:2,job:new CCheckJob('check',new CSequenceBool([false,false,true]),1,3)},{no:3,job:new CDummyJob('END')}],store);
 const result=await wf.run('branches',1);assert.equal(result.status,'COMPLETED');assert.deepEqual(result.history.map(h=>h.stepNo),[1,2,1,2,1,2,3]);assert.deepEqual(result.history.filter(h=>h.stepNo===2).map(h=>h.result),['FALSE','FALSE','TRUE']);
 const first=store.snapshots.find(s=>s.history.length===1);first.history[0].result='ERROR';assert.equal(result.history[0].result,'DONE');assert.equal(store.snapshots.at(-1).history[0].result,'DONE');
});

test('beforeStep failure diagnostic remains pristine when Store mutates and rejects its input',async()=>{
 const root=Error('hook root'),secondary=Error('save error'),values=new Map();
 const store={load:id=>values.get(id),save:s=>{values.set(s.runId,s);if(s.status==='FAILED'){s.failure.summary='changed by Store';s.failure.stepNo=999;throw secondary;}}};
 const wf=new CWorkflow([{no:1,job:new CDummyJob('not executed')}],store);
 await assert.rejects(wf.run('failure',1,10,async()=>{throw root;}),e=>{
  assert.equal(e.code,'HISTORY_SAVE_OUTCOME_UNKNOWN');assert.equal(e.cause,root);assert.equal(e.storageCause,secondary);assert.equal(e.attemptedSnapshot.failure.summary,'beforeStepで例外が発生しました');assert.equal(e.attemptedSnapshot.failure.stepNo,1);assert.deepEqual(e.attemptedSnapshot.history,[]);return true;
 });
});

const models=[
 {keyword:'exam.dateAgreement',jobClass:'CExamDateAgreementJob',input:{examDate:'2026-11-07',startTime:'10:00',location:' original ',confirmedBy:' test '},expected:{examDate:'2026-11-07',startTime:'10:00',location:'original',confirmedBy:'test'},field:'location'},
 {keyword:'exam.resultRegistration',jobClass:'CExamResultRegistrationJob',input:{candidate:' candidate ',grade:' grade ',result:'合格',evaluator:' evaluator ',remarks:' note '},expected:{candidate:'candidate',grade:'grade',result:'合格',evaluator:'evaluator',remarks:'note'},field:'candidate'}
];
for(const model of models){
 const describe=(jobs,run='run',step='step')=>jobs.describe(model.keyword,run,step,model.jobClass);
 const submit=(jobs,input=model.input,run='run',step='step')=>jobs.submit(model.keyword,run,step,input,model.jobClass);
 test(`${model.keyword}: submit root/values mutations cannot change normalized saved input`,async()=>{
  const jobs=new ExamJobs(),input={...model.input},handler=jobs.handler(model.keyword,'run',model.jobClass);assert.equal(describe(jobs).record,null);assert.equal((await handler({stepId:'step'})).status,'WAITING');
  const result=submit(jobs,input),expected=structuredClone(result);assert.deepEqual(result.values,model.expected);
  input[model.field]='source changed';result.keyword='changed';result.completedAt='changed';result.values[model.field]='changed';result.values={replaced:'values'};
  assert.deepEqual(describe(jobs).record,expected);assert.equal((await handler({stepId:'step'})).status,'COMPLETED');
 });
 test(`${model.keyword}: describe copies record and values for every caller`,()=>{
  const jobs=new ExamJobs(),saved=submit(jobs),a=describe(jobs),b=describe(jobs);
  assert.notEqual(a,b);assert.notEqual(a.record,b.record);assert.notEqual(a.record.values,b.record.values);assert.notEqual(saved,b.record);assert.notEqual(saved.values,b.record.values);
  a.keyword='wrapper changed';a.record.keyword='record changed';a.record.completedAt='changed';a.record.values[model.field]='changed';
  assert.deepEqual(b.record,saved);assert.deepEqual(describe(jobs).record,saved);b.record=null;assert.deepEqual(describe(jobs).record,saved);
 });
 test(`${model.keyword}: different run/step records and past views stay independent`,()=>{
  const jobs=new ExamJobs(),first=submit(jobs),other=submit(jobs,{...model.input,[model.field]:'other'},'other-run'),otherStep=submit(jobs,{...model.input,[model.field]:'other-step'},'run','other-step');
  const view=describe(jobs);view.record.values[model.field]='view changed';first.values[model.field]='return changed';
  assert.deepEqual(describe(jobs).record.values,model.expected);assert.deepEqual(describe(jobs,'other-run').record,other);assert.deepEqual(describe(jobs,'run','other-step').record,otherStep);
  const prior=describe(jobs);submit(jobs,{...model.input,[model.field]:'new input'});assert.equal(prior.record.values[model.field],model.expected[model.field]);assert.equal(describe(jobs).record.values[model.field],'new input');
 });
}
