'use strict';
const definition={schemaVersion:'prototype-workflow/1',definitionId:'c2-synthetic',definitionVersion:'1',startStepId:'a',steps:[
 {stepId:'a',stepNo:1,kind:'JOB',jobId:'a',nextStepId:'b'},
 {stepId:'b',stepNo:2,kind:'JOB',jobId:'b',nextStepId:'check'},
 {stepId:'check',stepNo:3,kind:'CHECK_BOOL',checkId:'yes',trueStepId:'c',falseStepId:'c'},
 {stepId:'c',stepNo:4,kind:'JOB',jobId:'c'}]};
function registry(onMake=()=>{},fault){return new Map(['a','b','c'].map((id,i)=>[id,{artifactKey:id.toUpperCase(),form:{name:id,
 collect:async shelf=>{if(i&& !shelf.has(String.fromCharCode(64+i)))throw Error('MISSING_INPUT');return i?shelf.get(String.fromCharCode(64+i)):0;},
 make:async input=>{await onMake(id);if(fault===id)throw Error('SYNTHETIC_FAILURE');return input+10;}}}]));}
module.exports={definition,registry};
