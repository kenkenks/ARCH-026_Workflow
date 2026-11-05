'use strict';
const {validate}=require('./workflow-definitions.js');
function prepare(def,catalog){
 const errors=validate(def);
 if(def.eventRoutes?.length) errors.push('イベントルートの実行は未対応です');
 const jobs=new Map(catalog.map(j=>[j.keyword,j]));
 for(const s of def.steps||[]){
  if(!['JOB','END'].includes(s.type)) errors.push(`${s.id}: ${s.type} の実行は未対応です（判定結果を仮定しません）`);
  if(s.type==='JOB'){
   const j=jobs.get(s.jobId);
   if(!j) errors.push(`${s.id}: 未登録JOB ${s.jobId}`);
   else if(!j.enabled) errors.push(`${s.id}: 無効JOB ${s.jobId}`);
   else if(j.jobClass!=='CJob') errors.push(`${s.id}: JOBクラス ${j.jobClass} は未対応です`);
  }
 }
 if(errors.length){const e=Error(errors.join(' / '));e.status=400;e.details=errors;throw e;}
 const ids=new Map(def.steps.map((s,i)=>[s.id,(i+1)*10]));
 return {start:ids.get(def.startStepId),steps:def.steps.map(s=>({no:ids.get(s.id),id:s.id,name:s.type==='END'?'END':jobs.get(s.jobId).displayName,next:s.nextStepId?ids.get(s.nextStepId):undefined,type:s.type})),definition:JSON.parse(JSON.stringify(def))};
}
module.exports={prepare};
