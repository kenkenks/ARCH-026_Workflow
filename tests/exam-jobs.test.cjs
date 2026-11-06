'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const {ExamJobs}=require('../gui/exam-jobs');
const {validateJob}=require('../gui/job-catalog');
const {validate}=require('../gui/workflow-definitions');
const DATE_JOB='exam.dateAgreement';
const dateInput={examDate:'2026-12-01',startTime:'13:00',location:'本部',confirmedBy:'先生'};
test('date JOB waits for its own validated inputs',async()=>{
 const j=new ExamJobs(),h=j.handler(DATE_JOB,'r1');assert.equal(typeof h,'function');
 assert.equal((await h({stepId:'S1'})).status,'WAITING');
 assert.throws(()=>j.submit(DATE_JOB,'r1','S1',{examDate:'2026-12-01'}),e=>e.status===400&&/必須/.test(e.message));
 assert.equal((await h({stepId:'S1'})).status,'WAITING');
 const record=j.submit(DATE_JOB,'r1','S1',dateInput);
 assert.deepEqual(record.values,dateInput);assert.equal(record.keyword,DATE_JOB);
 assert.equal((await h({stepId:'S1'})).status,'COMPLETED');assert.equal((await h({stepId:'S2'})).status,'WAITING');
 assert.equal((await j.handler(DATE_JOB,'r2')({stepId:'S1'})).status,'WAITING');
});
test('result JOB validates outcome and isolates runs',async()=>{const j=new ExamJobs();assert.throws(()=>j.submit('exam.resultRegistration','r1','S2',{candidate:'A',grade:'初段',result:'未定',evaluator:'先生'}),/不正/);j.submit('exam.resultRegistration','r1','S2',{candidate:'A',grade:'初段',result:'合格',evaluator:'先生'});assert.equal((await j.handler('exam.resultRegistration','r1')({stepId:'S2'})).status,'COMPLETED');assert.equal((await j.handler('exam.resultRegistration','r2')({stepId:'S2'})).status,'WAITING');});
test('dateAgreement keeps all four required fields and existing date/time validation',async()=>{
 const j=new ExamJobs(),h=j.handler(DATE_JOB,'validation','CExamDateAgreementJob');
 assert.deepEqual(j.fields(DATE_JOB,'CExamDateAgreementJob').map(f=>f.key),['examDate','startTime','location','confirmedBy']);
 for(const field of Object.keys(dateInput)){
  const missing={...dateInput};delete missing[field];
  assert.throws(()=>j.submit(DATE_JOB,'validation','S1',missing,'CExamDateAgreementJob'),e=>e.status===400&&/必須/.test(e.message));
 }
 for(const bad of [{...dateInput,examDate:'2026/12/01'},{...dateInput,startTime:'24:00'}])
  assert.throws(()=>j.submit(DATE_JOB,'validation','S1',bad,'CExamDateAgreementJob'),e=>e.status===400&&/不正/.test(e.message));
 assert.equal((await h({stepId:'S1'})).status,'WAITING');assert.equal(j.describe(DATE_JOB,'validation','S1','CExamDateAgreementJob').record,null);
});
test('current keyword/class binding rejects legacy keyword without introducing an alias',()=>{
 const j=new ExamJobs();
 assert.equal(j.handler('exam.date','legacy','CExamDateAgreementJob'),null);
 assert.equal(j.handler('exam.date','legacy'),null);
 assert.throws(()=>j.submit('exam.date','legacy','S1',dateInput),{status:400});
 assert.ok(validateJob({keyword:'exam.date',displayName:'旧日程合意',jobClass:'CExamDateAgreementJob'}).length>0);
 assert.deepEqual(validateJob({keyword:DATE_JOB,displayName:'日程合意',jobClass:'CExamDateAgreementJob'}),[]);
 assert.equal(j.resolve(DATE_JOB,'CExamResultRegistrationJob'),null);
});
test('current samples use dateAgreement and the runnable sample resolves explicit business classes',()=>{
 const runnable=require('../src/definitions/exam-two-jobs.phase4c.example.json');
 const design=require('../src/definitions/exam-workflow.example.json');
 assert.deepEqual(validate(runnable),[]);assert.deepEqual(validate(design),[]);
 assert.equal(runnable.steps.find(s=>s.id==='S001').jobId,DATE_JOB);
 assert.equal(design.steps.find(s=>s.id==='S007').jobId,DATE_JOB);
 const classes=new Map([[DATE_JOB,'CExamDateAgreementJob'],['exam.resultRegistration','CExamResultRegistrationJob']]);
 const jobs=new ExamJobs();
 for(const step of runnable.steps.filter(s=>s.type==='JOB')){
  assert.ok(classes.has(step.jobId));
  const jobClass=classes.get(step.jobId);
  assert.deepEqual(validateJob({keyword:step.jobId,displayName:step.jobId,jobClass}),[]);
  assert.equal(typeof jobs.handler(step.jobId,'sample',jobClass),'function');
  assert.notEqual(jobs.fields(step.jobId,jobClass),null);
 }
 // The larger design sample still has event routes and is not a runnable business workflow.
 assert.ok(design.eventRoutes.length>0);
});
