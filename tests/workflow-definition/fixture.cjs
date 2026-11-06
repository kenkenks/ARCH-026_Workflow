'use strict';
const {CDummyJob,CSequenceBool}=require('../../dist/src/prototype/workflow');
function definition(version='v1'){
  return {schemaVersion:'prototype-workflow/1',definitionId:'saved-example',definitionVersion:version,startStepId:'start',steps:[
    {stepId:'start',stepNo:10,kind:'JOB',jobId:'sample.work',nextStepId:'check'},
    {stepId:'check',stepNo:20,kind:'CHECK_BOOL',checkId:'sample.sequence',trueStepId:'finish',falseStepId:'start'},
    {stepId:'finish',stepNo:30,kind:'JOB',jobId:'sample.finish'},
  ]};
}
function registry(values=[false,false,true],actions=[]){
  return {jobs:new Map([
    ['sample.work',ctx=>new CDummyJob(ctx.stepId,()=>actions.push(ctx.stepId))],
    ['sample.finish',ctx=>new CDummyJob(ctx.stepId,()=>actions.push(ctx.stepId))],
  ]),checks:new Map([['sample.sequence',()=>new CSequenceBool(values)]])};
}
module.exports={definition,registry};
