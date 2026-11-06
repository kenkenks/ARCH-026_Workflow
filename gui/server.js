'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { CWorkflow, CDummyJob, CCheckJob, CSequenceBool, CMemoryHistoryStore, CWorkflowMonitor } = require('../dist/src/prototype/workflow.js');
const { CTicketManager, CMemoryTicketRepository } = require('../dist/src/prototype/ticket.js');
const { validate, DefinitionStore } = require('./workflow-definitions.js');
const { JobCatalog, ALLOWED_CLASSES } = require('./job-catalog.js');
const {prepare} = require('./template-runner.js');
const {WorkflowRuntime} = require('./workflow-runtime.js');
const {ExamJobs} = require('./exam-jobs.js');
const examJobs=new ExamJobs();
const dataDirectory=process.env.ARCH026_GUI_DATA_DIR||path.join(__dirname,'data');
const jobs = new JobCatalog(path.join(dataDirectory,'job-catalog.json'));
const definitions = new DefinitionStore(path.join(dataDirectory,'definitions'));
const tickets = new CTicketManager(new CMemoryTicketRepository());
let activeTicketId = null;
const port = Number(process.env.PORT || 3000);
let runCounter = 0;
let state;
let runtime = null;
function init(template=null) {
  runtime = null;
  activeTicketId = null;
  const store = new CMemoryHistoryStore();
  // Fixed/template previews are exclusively simulated; annotate the stored history.
  const save=store.save.bind(store);
  store.save=s=>save({...s,executionMode:'DEMO',simulatedJobUsed:s.history.length>0,resultKind:s.status==='COMPLETED'?'DEMO_COMPLETED':s.status,history:s.history.map(h=>({...h,executionMode:'DEMO',simulated:true}))});
  const steps = [
    {no:10, job:new CDummyJob('仮ジョブA'), nextStepNo:20},
    {no:20, job:new CCheckJob('Bool判定',new CSequenceBool([false,false,true]),10,30)},
    {no:30, job:new CDummyJob('仮ジョブB'), nextStepNo:40},
    {no:40, job:new CDummyJob('仮ジョブC')}
  ];
  const selectedSteps=template ? template.steps.map(s=>({no:s.no,job:new CDummyJob(s.name),nextStepNo:s.next})) : steps;
  const workflow = new CWorkflow(selectedSteps,store);
  const monitor = new CWorkflowMonitor(store);
  state = {store, workflow, monitor, runId:`gui-${++runCounter}`, permits:[], waiting:[], running:false, done:false, error:null,template:template?{id:template.definition.id,version:template.definition.version,steps:template.steps}:null,startStepNo:template?.start??10};
}
init();
function gate(s) { return new Promise(resolve => { if (s.permits.length) {s.permits.shift(); resolve();} else s.waiting.push(resolve); }); }
function step() {
  const s=state;
  if(s.done) return;
  if(!s.running){
    s.running=true;
    s.workflow.run(s.runId,s.startStepNo,100,()=>gate(s)).then(()=>{s.done=true;}).catch(e=>{s.error=String(e);s.done=true;});
  }
  const next=s.waiting.shift(); if(next) next(); else s.permits.push(true);
}
async function snapshot() {
  if(runtime){
    const r=runtime.snapshot();
    const counts=new Map();
    const steps=runtime.definition.steps.map((x,i)=>({id:x.id,no:(i+1)*10,name:x.type==='JOB'?(jobs.list().find(j=>j.keyword===x.jobId)?.displayName||x.jobId):x.type,type:x.type,jobId:x.jobId}));
    const history=r.history.map(h=>{const step=steps.find(x=>x.id===h.stepId);const c=counts.get(h.stepId)||{stepNo:step?.no,executions:0,lastResult:''};c.executions++;c.lastResult=h.result;counts.set(h.stepId,c);return {...h,stepNo:step?.no,job:step?.name,nextStepNo:steps.find(x=>x.id===h.nextStepId)?.no??null};});
    const current=runtime.steps.get(r.currentStepId);const jobForm=r.executionMode==='NORMAL'&&current?.type==='JOB'?examJobs.describe(current.jobId,state.runId,current.id,jobs.list().find(j=>j.keyword===current.jobId)?.jobClass):null;
    return {executionMode:r.executionMode,resultKind:r.resultKind,simulatedJobUsed:r.simulatedJobUsed,jobForm,activeTicketId,runId:state.runId,status:r.status,currentStepNo:steps.find(x=>x.id===r.currentStepId)?.no??null,history,summary:[...counts.values()],error:state.error,done:['COMPLETED','FAILED'].includes(r.status),pending:r.pending,template:{id:r.definitionId,version:r.definitionVersion,steps},runtime:true};
  }
  const s=state;
  const data=await s.monitor.get(s.runId);
  return {executionMode:'DEMO',resultKind:data?.resultKind||'READY',simulatedJobUsed:data?.simulatedJobUsed||false,activeTicketId,runId:s.runId, status:data?.status || 'READY', currentStepNo:data?.currentStepNo ?? (data?'END':s.startStepNo), history:data?.history || [], summary:await s.monitor.summary(s.runId), error:s.error, done:s.done,template:s.template};
}
function send(res,code,body,type='application/json; charset=utf-8') {res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(type.startsWith('application/json')?JSON.stringify(body):body);}
async function readBody(req){let body='';for await(const chunk of req){body+=chunk;if(body.length>65536)throw Error('Request too large');}return JSON.parse(body||'{}');}
const server=http.createServer(async(req,res)=>{
  // Capture before reading an asynchronous request body. A delayed request must not
  // silently switch to whichever execution happens to be global later.
  const targetRuntime=runtime,targetState=state,targetRunId=state.runId,targetTicketId=activeTicketId;
  const targetStepId=targetRuntime?.currentStepId;
  const requireTarget=()=>{
    if(runtime!==targetRuntime||state!==targetState||state.runId!==targetRunId||activeTicketId!==targetTicketId)
      throw Object.assign(Error('実行対象が変更されました'),{code:'EXECUTION_CHANGED',status:409});
  };
  try {
    const url=new URL(req.url,`http://localhost:${port}`);
    if(req.method==='GET' && url.pathname==='/') return send(res,200,fs.readFileSync(path.join(__dirname,'index.html'),'utf8'),'text/html; charset=utf-8');
    if(req.method==='GET' && url.pathname==='/api/job-classes') return send(res,200,[...ALLOWED_CLASSES]);
    if(req.method==='GET' && url.pathname==='/api/jobs') return send(res,200,jobs.list());
    if(req.method==='POST' && url.pathname==='/api/jobs') return send(res,200,jobs.save(await readBody(req)));
    if(req.method==='GET' && url.pathname==='/api/definitions') return send(res,200,definitions.list());
    if(req.method==='POST' && url.pathname==='/api/definitions/validate') {const def=await readBody(req);const errors=validate(def);return send(res,200,{valid:!errors.length,errors});}
    if(req.method==='POST' && url.pathname==='/api/definitions') {const def=await readBody(req);if(tickets.list().some(t=>t.workflowId===def.id&&t.workflowVersion===def.version))return send(res,409,{error:'実行に使用されたひな型Versionは変更できません'});return send(res,200,definitions.save(def,{overwrite:url.searchParams.get('overwrite')==='true'}));}
    if(url.pathname==='/api/definition' && ['GET','DELETE'].includes(req.method)) {
      const id=url.searchParams.get('id'),version=url.searchParams.get('version');
      if(!id||!version)return send(res,400,{error:'id と version が必要です'});
      if(req.method==='GET'){const def=definitions.get(id,version);return send(res,def?200:404,def||{error:'Not found'});}
      if(tickets.list().some(t=>t.workflowId===id&&t.workflowVersion===version))return send(res,409,{error:'実行に使用されたひな型Versionは削除できません'});return send(res,definitions.remove(id,version)?200:404,{ok:true});
    }
    if(req.method==='GET' && url.pathname==='/api/tickets') return send(res,200,tickets.list());
    if(req.method==='POST' && url.pathname==='/api/tickets') {const input=await readBody(req);const t=tickets.create(input);return send(res,201,t);}
    if(req.method==='GET' && url.pathname.startsWith('/api/tickets/')) {const id=decodeURIComponent(url.pathname.slice(13));const t=tickets.get(id);return send(res,t?200:404,t||{error:'Not found'});}
    if(req.method==='POST' && url.pathname==='/api/ticket-action') {
      const {ticketId,action,patch,definitionId,definitionVersion,executionMode='NORMAL'}=await readBody(req);let t;
      if(action==='edit')t=tickets.edit(ticketId,patch||{});
      else if(action==='submit')t=tickets.submit(ticketId);
      else if(action==='cancel')t=tickets.cancel(ticketId);
      else if(action==='start'){
        requireTarget();
        if(!['NORMAL','DEMO'].includes(executionMode))return send(res,400,{error:'実行モードが不正です'});
        if(runtime&&!['COMPLETED','FAILED'].includes(runtime.status))return send(res,409,{error:'Workflow is running'});
        if(state.running&&!state.done)return send(res,409,{error:'Workflow is running'});
        if(activeTicketId&&tickets.get(activeTicketId)?.status==='IN_PROGRESS')return send(res,409,{error:'Another ticket is active'});
        const ticket=tickets.get(ticketId);if(!ticket||ticket.status!=='OPEN')return send(res,409,{error:'提出済みチケットが必要です'});
        if(!definitionId||!definitionVersion)return send(res,400,{error:'ひな型IDとVersionを指定してください'});
        const def=definitions.get(definitionId,definitionVersion);if(!def)return send(res,404,{error:'ひな型が見つかりません'});
        const catalog=jobs.list();
        const errors=validate(def);
        if(def.eventRoutes?.length)errors.push('イベントルートはPhase 4Bでは未対応です。イベントなしのひな型を使用してください');
        const lookup=new Map(catalog.map(j=>[j.keyword,j]));
        for(const s of def.steps){if(s.type==='JOB'){const j=lookup.get(s.jobId);if(!j||!j.enabled)errors.push(`${s.id}: JOB未登録または無効: ${s.jobId}`);else if(j.jobClass==='CCheckJob')errors.push(`${s.id}: JOB工程にはCHECKクラスを指定できません: ${s.jobId}`);}}
        if(errors.length)return send(res,400,{error:errors.join(' / '),details:errors});
        const runId=`runtime-${++runCounter}`;
        const handlers={};const simulatedJobIds=[];
        for(const s of def.steps.filter(s=>s.type==='JOB')){
          if(executionMode==='DEMO'){
            handlers[s.jobId]=async()=>({status:'COMPLETED'});simulatedJobIds.push(s.jobId);
          }else{
            const handler=examJobs.handler(s.jobId,runId,lookup.get(s.jobId)?.jobClass);
            if(!handler)return send(res,400,{error:`実装未登録のJOB: ${s.jobId}`});
            handlers[s.jobId]=handler;
          }
        }
        const nextRuntime=new WorkflowRuntime(def,handlers,{executionMode,simulatedJobIds});
        init();state.runId=runId;runtime=nextRuntime;
        // A demo preview never attaches or completes a business Ticket.
        if(executionMode==='NORMAL'){t=tickets.attachWorkflow(ticketId,def.id,def.version,runId);activeTicketId=ticketId;}
        else {activeTicketId=null;t={...ticket,executionMode};}
      } else return send(res,400,{error:'Unknown action'});
      return send(res,200,t);
    }
    if(req.method==='POST' && url.pathname==='/api/job-submit') {
      if(!targetRuntime||!targetTicketId)return send(res,409,{error:'実行中のJOBがありません'});
      const current=targetRuntime.steps.get(targetStepId);
      if(!current||current.type!=='JOB'||!examJobs.resolve(current.jobId,jobs.list().find(j=>j.keyword===current.jobId)?.jobClass))return send(res,409,{error:'業務入力を受け付ける工程ではありません'});
      const body=await readBody(req);
      requireTarget();
      if(targetRuntime.currentStepId!==targetStepId||targetRuntime.advancing||['COMPLETED','FAILED'].includes(targetRuntime.status))return send(res,409,{error:'実行工程が変更されたか処理中です'});
      const record=examJobs.submit(current.jobId,targetRunId,current.id,body.values,jobs.list().find(j=>j.keyword===current.jobId)?.jobClass);
      return send(res,200,{ok:true,completedAt:record.completedAt});
    }
    if(req.method==='GET' && url.pathname==='/api/state') return send(res,200,await snapshot());
    if(req.method==='POST' && url.pathname==='/api/step') {
      if(targetRuntime){
        const body=await readBody(req);
        requireTarget();
        if(targetRuntime.currentStepId!==targetStepId)throw Object.assign(Error('実行工程が変更されました'),{code:'EXECUTION_CHANGED',status:409});
        const r=await targetRuntime.advance({checkResult:body.checkResult});
        requireTarget();
        if(r.executionMode==='NORMAL'&&!r.simulatedJobUsed&&r.status==='COMPLETED'&&targetTicketId&&tickets.get(targetTicketId)?.status==='IN_PROGRESS')tickets.complete(targetTicketId);
        return send(res,200,{ok:true,status:r.status,executionMode:r.executionMode,resultKind:r.resultKind,simulatedJobUsed:r.simulatedJobUsed});
      }
      step();return send(res,200,{ok:true});
    }
    if(req.method==='POST' && url.pathname==='/api/reset') {if(runtime && !['COMPLETED','FAILED'].includes(runtime.status))return send(res,409,{error:'実行中のひな型はリセットできません'});if(activeTicketId && tickets.get(activeTicketId)?.status==='IN_PROGRESS') return send(res,409,{error:'チケット実行中はリセットできません。'});if(state.running && !state.done) return send(res,409,{error:'実行中はリセットできません。完了後にリセットしてください。'});init();return send(res,200,{ok:true});}
    send(res,404,{error:'Not found'});
  } catch(e){send(res,e.status||500,{error:e.message||String(e),code:e.code,details:e.details});}
});
if(require.main===module)server.listen(port,'127.0.0.1',()=>console.log(`ARCH-026 GUI: http://127.0.0.1:${server.address().port}`));
module.exports={server};
