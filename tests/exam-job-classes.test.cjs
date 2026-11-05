const test=require('node:test');const assert=require('node:assert/strict');
const {ExamJobs,CExamDateAgreementJob,CExamResultRegistrationJob}=require('../gui/exam-jobs');
const {validateJob}=require('../gui/job-catalog');
test('two independent business JOB classes retain existing schemas',()=>{
 const jobs=new ExamJobs();
 assert.equal(jobs.resolve('exam.dateAgreement','CExamDateAgreementJob') instanceof CExamDateAgreementJob,true);
 assert.equal(jobs.resolve('exam.resultRegistration','CExamResultRegistrationJob') instanceof CExamResultRegistrationJob,true);
 assert.deepEqual(jobs.fields('exam.dateAgreement').map(f=>f.key),['examDate','startTime','location','confirmedBy']);
 assert.deepEqual(jobs.fields('exam.resultRegistration').map(f=>f.key),['candidate','grade','result','evaluator','remarks']);
});
test('class binding rejects unrelated keyword and validates mandatory fields',async()=>{
 const jobs=new ExamJobs();assert.equal(jobs.resolve('exam.dateAgreement','CExamResultRegistrationJob'),null);
 assert.throws(()=>jobs.submit('exam.dateAgreement','run','S001',{},'CExamDateAgreementJob'),/必須/);
 const handler=jobs.handler('exam.dateAgreement','run','CExamDateAgreementJob');
 assert.equal((await handler({stepId:'S001'})).status,'WAITING');
 jobs.submit('exam.dateAgreement','run','S001',{examDate:'2026-11-14',startTime:'10:30',location:'道場',confirmedBy:'先生'},'CExamDateAgreementJob');
 assert.equal((await handler({stepId:'S001'})).status,'COMPLETED');
 assert.equal((await handler({stepId:'S002'})).status,'WAITING');
 assert.ok(validateJob({keyword:'exam.dateAgreement',displayName:'審査日程合意',jobClass:'CExamDateAgreementJob'}).length===0);
 assert.ok(validateJob({keyword:'exam.other',displayName:'別',jobClass:'CExamDateAgreementJob'}).length>0);
});
