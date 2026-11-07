'use strict';
// Business record values are normalized strings; copy their known DTO structure.
function copyRecord(record){return record?{...record,values:{...record.values}}:null;}
/** Each business JOB owns its input schema, validation and volatile records. */
class CExamBusinessJob {
  constructor(){this.records=new Map();}
  get fields(){return [];}
  key(runId,stepId){return JSON.stringify([runId,stepId]);}
  describe(keyword,runId,stepId){return {keyword,fields:this.fields,record:copyRecord(this.records.get(this.key(runId,stepId)))};}
  submit(keyword,runId,stepId,input){
    if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('入力が不正です'),{status:400});
    const values={};
    for(const f of this.fields){
      const value=String(input[f.key]??'').trim();
      if(f.required&&!value)throw Object.assign(new Error(`${f.label}は必須です`),{status:400});
      if(value.length>500)throw Object.assign(new Error(`${f.label}が長すぎます`),{status:400});
      if(f.options&&!f.options.includes(value))throw Object.assign(new Error(`${f.label}が不正です`),{status:400});
      if(value&&f.type==='date'&&!/^\d{4}-\d{2}-\d{2}$/.test(value))throw Object.assign(new Error('審査日が不正です'),{status:400});
      if(value&&f.type==='time'&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw Object.assign(new Error('開始時刻が不正です'),{status:400});
      values[f.key]=value;
    }
    const record={values,completedAt:new Date().toISOString(),keyword};
    this.records.set(this.key(runId,stepId),record);return copyRecord(record);
  }
  handler(runId){return async ({stepId})=>({status:this.records.has(this.key(runId,stepId))?'COMPLETED':'WAITING'});}
}
class CExamDateAgreementJob extends CExamBusinessJob {
  get fields(){return [{key:'examDate',label:'審査日',type:'date',required:true},{key:'startTime',label:'開始時刻',type:'time',required:true},{key:'location',label:'審査場所',type:'text',required:true},{key:'confirmedBy',label:'確定者',type:'text',required:true}];}
}
class CExamResultRegistrationJob extends CExamBusinessJob {
  get fields(){return [{key:'candidate',label:'受審者',type:'text',required:true},{key:'grade',label:'受審級・段位',type:'text',required:true},{key:'result',label:'合否',type:'select',options:['合格','不合格'],required:true},{key:'evaluator',label:'判定者',type:'text',required:true},{key:'remarks',label:'講評',type:'text',required:false}];}
}
const JOB_IMPLEMENTATIONS=Object.freeze({
  CExamDateAgreementJob:{keyword:'exam.dateAgreement',Class:CExamDateAgreementJob},
  CExamResultRegistrationJob:{keyword:'exam.resultRegistration',Class:CExamResultRegistrationJob}
});
class ExamJobs {
  constructor(){this.instances=new Map(Object.entries(JOB_IMPLEMENTATIONS).map(([name,x])=>[name,new x.Class()]));}
  resolve(keyword,jobClass){const entry=JOB_IMPLEMENTATIONS[jobClass];return entry?.keyword===keyword?this.instances.get(jobClass):null;}
  // Compatibility with older tests and catalog entries; new workflows use explicit class mapping.
  kind(keyword){return keyword==='exam.dateAgreement'?'date':keyword==='exam.resultRegistration'?'result':null;}
  fields(keyword,jobClass){return this.resolve(keyword,jobClass||this.defaultClass(keyword))?.fields||null;}
  defaultClass(keyword){return Object.keys(JOB_IMPLEMENTATIONS).find(name=>JOB_IMPLEMENTATIONS[name].keyword===keyword);}
  describe(keyword,runId,stepId,jobClass){return this.resolve(keyword,jobClass||this.defaultClass(keyword))?.describe(keyword,runId,stepId)||null;}
  submit(keyword,runId,stepId,input,jobClass){const job=this.resolve(keyword,jobClass||this.defaultClass(keyword));if(!job)throw Object.assign(new Error('業務JOBではありません'),{status:400});return job.submit(keyword,runId,stepId,input);}
  handler(keyword,runId,jobClass){return this.resolve(keyword,jobClass||this.defaultClass(keyword))?.handler(runId)||null;}
}
module.exports={CExamBusinessJob,CExamDateAgreementJob,CExamResultRegistrationJob,JOB_IMPLEMENTATIONS,ExamJobs};
