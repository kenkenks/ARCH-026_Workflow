'use strict';
class ExamProgressError extends Error {
 constructor(code,sourceCode){super(code);this.name='ExamProgressError';this.code=code;if(sourceCode)this.sourceCode=sourceCode;}
}
const fail=(code,source)=>{throw new ExamProgressError(code,source);};
const object=x=>!!x&&typeof x==='object'&&!Array.isArray(x);
const text=x=>typeof x==='string'&&!!x.trim();
const count=x=>typeof x==='number'&&Number.isFinite(x)&&x>=0;
const invalidSource=new Set(['INVALID_PROGRESS_COUNT','INVALID_PROGRESS_DATE','INVALID_PROGRESS_DURATION','INVALID_PROGRESS_ATTENDANCE']);
/** Projection is injected by Composition. No DAO, filesystem, environment or SDK is created here. */
function createExamProgressAdapter(projectAttendanceProgress){
 if(typeof projectAttendanceProgress!=='function')fail('INVALID_PROJECTION_DEPENDENCY');
 return Object.freeze({async evaluate(input){
  if(!object(input)||!text(input.memberId))fail('INVALID_ARGUMENT');const memberId=input.memberId.trim();
  if(input.facts===null)return {kind:'NOT_FOUND',memberId};
  if(!Object.hasOwn(input,'facts'))fail('INPUT_UNAVAILABLE');
  if(!object(input.facts))fail('INVALID_ARGUMENT');
  if(input.facts.member===null)return {kind:'NOT_FOUND',memberId};
  const {member,attendanceRows,standard,rankOption}=input.facts;
  if(!object(member)||!text(member.member_id)||member.member_id.trim()!==memberId||typeof member.status!=='string'||!Array.isArray(attendanceRows)||!object(standard)||!object(rankOption))fail('INVALID_ARGUMENT');
  let facts;try{facts=structuredClone({member:{...member,member_id:memberId},attendanceRows,standard,rankOption});}catch{fail('INVALID_ARGUMENT');}
  let result;try{result=await projectAttendanceProgress(facts);}catch(error){
   const code=typeof error?.message==='string'?error.message:'';
   if(code==='PROGRESS_INPUT_UNAVAILABLE')return {kind:'BUSINESS_REJECTED',memberId,reason:code};
   if(invalidSource.has(code))fail('INVALID_SOURCE_DATA',code);
   fail('PROJECTION_FAILED');
  }
  if(!object(result)||result.ok!==true||result.member_id!==memberId||typeof result.current_rank!=='string'||typeof result.current_rank_id!=='string'||typeof result.examination_ready!=='boolean'||
   !['carried_training_count','recorded_training_count','training_count','required_training_count','training_days','required_training_days'].every(k=>count(result[k]))||
   !['remaining_training_count','remaining_training_days'].every(k=>result[k]===null||count(result[k])))fail('INVALID_PROJECTION_RESULT');
  // Rename/project only: counts, remaining values and readiness come from the original function.
  return {kind:'PROJECTED',memberId,progress:{currentRank:result.current_rank,currentRankId:result.current_rank_id,
   carriedTrainingCount:result.carried_training_count,recordedTrainingCount:result.recorded_training_count,
   trainingCount:result.training_count,requiredTrainingCount:result.required_training_count,remainingTrainingCount:result.remaining_training_count,
   trainingDays:result.training_days,requiredTrainingDays:result.required_training_days,remainingTrainingDays:result.remaining_training_days,
   examinationReady:result.examination_ready}};
 }});
}
/** Reusable structural CJobForm. Each Workflow visit still constructs its own CJob. */
function createExamProgressForm(adapter,{inputKey='examProgressInput'}={}){
 if(!adapter||typeof adapter.evaluate!=='function'||!text(inputKey))fail('INVALID_ARGUMENT');
 return Object.freeze({name:'exam-progress',collect(reader){if(!reader.has(inputKey))fail('INPUT_UNAVAILABLE');return reader.get(inputKey);},make:input=>adapter.evaluate(input)});
}
module.exports={createExamProgressAdapter,createExamProgressForm,ExamProgressError};
