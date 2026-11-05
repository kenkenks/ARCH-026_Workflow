'use strict';
const fs=require('node:fs');
const path=require('node:path');
const ALLOWED_CLASSES=new Set(['CJob','CCheckJob','CExamDateAgreementJob','CExamResultRegistrationJob']);
function validateJob(job){
 const errors=[];
 if(!job||typeof job!=='object'||Array.isArray(job))return ['JOBはオブジェクトが必要です'];
 if(typeof job.keyword!=='string'||!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(job.keyword))errors.push('keywordの形式が不正です');
 if(typeof job.displayName!=='string'||!job.displayName.trim())errors.push('表示名は必須です');
 if(!ALLOWED_CLASSES.has(job.jobClass))errors.push('未対応のJOBクラスです');
 if(job.jobClass==='CExamDateAgreementJob'&&job.keyword!=='exam.dateAgreement')errors.push('日程合意クラスのkeywordはexam.dateAgreementです');
 if(job.jobClass==='CExamResultRegistrationJob'&&job.keyword!=='exam.resultRegistration')errors.push('結果登録クラスのkeywordはexam.resultRegistrationです');
 if(job.description!==undefined&&typeof job.description!=='string')errors.push('説明は文字列が必要です');
 if(job.enabled!==undefined&&typeof job.enabled!=='boolean')errors.push('enabledは真偽値が必要です');
 return errors;
}
class JobCatalog {
 constructor(file){this.file=file;fs.mkdirSync(path.dirname(file),{recursive:true});}
 list(){if(!fs.existsSync(this.file))return [];const data=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!Array.isArray(data))throw Error('JOBカタログ形式が不正です');return data;}
 save(job){const errors=validateJob(job);if(errors.length){const e=Error(errors.join(' / '));e.status=400;throw e;}
  const list=this.list();const index=list.findIndex(x=>x.keyword===job.keyword);
  const normalized={keyword:job.keyword,displayName:job.displayName.trim(),description:job.description||'',jobClass:job.jobClass,enabled:job.enabled!==false};
  if(index<0)list.push(normalized);else list[index]=normalized;
  list.sort((a,b)=>a.keyword.localeCompare(b.keyword));
  const tmp=this.file+'.tmp-'+process.pid;fs.writeFileSync(tmp,JSON.stringify(list,null,2)+'\n');fs.renameSync(tmp,this.file);return normalized;
 }
}
module.exports={JobCatalog,validateJob,ALLOWED_CLASSES};
