'use strict';
// Reusable work definitions; command/context are bound per operation, never stored here.
const labels=Object.freeze({10:'申請受付',20:'先生承認待ち',30:'承認判断',40:'審査待ち',50:'結果登録待ち',60:'完了',90:'申請内容確認',95:'再申請待ち'});
const requireProduct=(p,key)=>{if(!p.has(key))throw Error('MISSING_DEMO_INPUT');return p.get(key);};
const work=Object.freeze({
 'application.accept':{key:'application',collect:(p,c)=>c,make:c=>({applicationId:c.applicationId,memberId:c.payload.memberId,grade:c.payload.grade,createdAt:c.createdAt})},
 'teacher.decision':{key:'teacherDecision',collect:(p,c)=>({application:requireProduct(p,'application'),command:c}),make:({command:c})=>({decision:c.kind,reason:c.payload.reason||'',commandId:c.commandId})},
 'exam.confirm':{key:'examConfirmation',collect:(p,c)=>({decision:requireProduct(p,'teacherDecision'),command:c}),make:({decision,command:c})=>{if(decision.decision!=='APPROVE')throw Error('APPROVAL_REQUIRED');return {examDate:c.payload.examDate,commandId:c.commandId};}},
 'result.register':{key:'examResult',collect:(p,c)=>({exam:requireProduct(p,'examConfirmation'),command:c}),make:({command:c})=>({...c.payload,commandId:c.commandId})},
 'application.finish':{key:'applicationOutcome',collect:p=>requireProduct(p,'examResult'),make:r=>({outcome:'RECORDED',result:r.result,score:r.score})},
 'application.review':{key:'review',collect:p=>requireProduct(p,'teacherDecision'),make:d=>{if(d.decision!=='RETURN')throw Error('RETURN_REQUIRED');return {reason:d.reason};}},
 'application.resubmit':{key:'application',collect:(p,c)=>({application:requireProduct(p,'application'),command:c}),make:({application,command:c})=>({...application,grade:c.payload.grade,note:c.payload.note})}
});
function createForms(context){
 return new Map(Object.entries(work).map(([id,definition])=>[id,{artifactKey:definition.key,form:{name:labels[({
 'application.accept':10,'teacher.decision':20,'exam.confirm':40,'result.register':50,'application.finish':60,'application.review':90,'application.resubmit':95})[id]],
 collect:async products=>definition.collect(products,context),make:async input=>definition.make(input)}}]));
}
function checks(products){return new Map([['teacher.approved',()=>({evaluate:()=>{const value=requireProduct(products,'teacherDecision');if(!['APPROVE','RETURN'].includes(value.decision))throw Error('INVALID_DECISION');return value.decision==='APPROVE';}})]]);}
module.exports={createForms,checks,labels};
