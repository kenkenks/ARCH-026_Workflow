'use strict';
const {test}=require('node:test'),a=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process');
const {definition,options,request,WaitingHistoryStore,SQLiteLifecycleBackend}=require('./workflow-artifact-resume/scenario.cjs');
async function fixture(fn,kind='WAITING'){
 const parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'artifact-process-')),file=path.join(dir,'run.sqlite'),children=[];
 SQLiteLifecycleBackend.initialize(file);const d=definition(kind);
 function launch(input){
  const child=fork(path.join(__dirname,'workflow-artifact-resume/child.cjs'),[JSON.stringify({file,kind,...input})],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});children.push(child);
  let stderr='',result,readyResolve;child.stderr.on('data',b=>stderr+=b);child.stdout.resume();
  const ready=new Promise(resolve=>readyResolve=resolve);
  const done=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{child.kill();reject(Error('child timeout: '+stderr));},20000);
   child.on('message',m=>{if(m.ready)readyResolve();else result=m;});
   child.on('error',e=>{clearTimeout(timer);reject(e);});
   child.on('exit',code=>{clearTimeout(timer);resolve(result||{exit:code,stderr});});
  });
  return {ready,done,go:()=>child.send({go:true})};
 }
 const read=()=>{const s=new WaitingHistoryStore(new SQLiteLifecycleBackend(file),options(d));try{return {row:s.read(),checkpoint:s.readCheckpoint()};}finally{s.close();}};
 try{await fn({dir,file,d,launch,read});}finally{
  for(const c of children)if(c.exitCode===null&&c.signalCode===null){c.kill();await new Promise(r=>c.once('exit',r));}
  if(path.dirname(path.resolve(dir))!==parent||!path.basename(dir).startsWith('artifact-process-'))throw Error('UNSAFE_FIXTURE');fs.rmSync(dir,{recursive:true,force:true});
 }
}
for(const kind of ['WAITING','LIMIT_REACHED'])test(kind+' restarts in a genuinely separate process and persists all restored boxes',()=>fixture(async({launch,read})=>{
 const first=await launch({action:'start'}).done;a.equal(first.ok,true);a.deepEqual(first.calls,['p']);a.equal(first.snapshot.status,kind);
 const next=await launch({action:'resume'}).done;a.equal(next.ok,true,JSON.stringify(next));a.equal(next.snapshot.status,'COMPLETED');a.deepEqual(next.calls,kind==='WAITING'?['check','q']:['q']);
 a.deepEqual(next.result,{value:{n:7},hasUndefined:true,hasEmpty:true});
 const cp=read().checkpoint;a.equal(cp.workflowSnapshot.status,'COMPLETED');a.equal(cp.owner.state,'RELEASED');a.equal(cp.artifactSnapshot.boxes.find(b=>b.name==='empty').entries.length,0);a.equal(cp.artifactSnapshot.boxes.find(b=>b.name==='default').entries.find(e=>e.key==='U').encodedValue.type,'undefined');
},kind));
test('two independent processes race on one inspected checkpoint: at most one executes',()=>fixture(async({launch,read})=>{
 a.equal((await launch({action:'start'}).done).ok,true);
 const x=launch({action:'resume',barrier:true,operationId:'left'}),y=launch({action:'resume',barrier:true,operationId:'right'});
 await Promise.all([x.ready,y.ready]);x.go();y.go();const results=await Promise.all([x.done,y.done]);
 a.equal(results.filter(r=>r.ok).length,1,JSON.stringify(results));a.equal(results.flatMap(r=>r.calls||[]).filter(c=>c==='q').length,1);
 a.ok(['REVISION_CONFLICT','CLAIM_BUSY','RESUME_STATE_CHANGED'].includes(results.find(r=>!r.ok).code));a.equal(read().row.operations.filter(o=>o.kind==='RESUME_WAITING').length,1);
}));
test('operation replay after process exit is read-only and rejects changed content',()=>fixture(async({launch,read})=>{
 await launch({action:'start'}).done;const q=request(read().checkpoint,'once');const first=await launch({action:'resume',request:q}).done;a.equal(first.ok,true);
 const before=read().row,again=await launch({action:'resume',request:q}).done;a.equal(again.ok,true);a.deepEqual(again.calls,[]);a.deepEqual(again.snapshot,first.snapshot);a.deepEqual(read().row,before);
 const bad=await launch({action:'resume',request:{kind:'WAITING',operation:{...q.operation,result:{approved:false}}}}).done;a.equal(bad.code,'OPERATION_CONFLICT');a.deepEqual(read().row,before);
}));
test('process exits immediately after committed claim: no automatic RUNNING retry',()=>fixture(async({launch,read})=>{
 await launch({action:'start'}).done;const q=request(read().checkpoint,'crash');a.equal((await launch({action:'resume',request:q,crash:'after-claim'}).done).exit,91);
 const before=read().row;a.equal(before.snapshot.status,'RUNNING');a.equal(before.owner.state,'ACTIVE');a.equal(before.snapshot.history.filter(h=>h.stepNo===40).length,0);
 const retry=await launch({action:'resume',request:q}).done;a.equal(retry.code,'OPERATION_IN_PROGRESS');a.deepEqual(retry.calls,[]);a.deepEqual(read().row,before);
}));
test('claim response UNKNOWN survives process restart without execution or takeover',()=>fixture(async({launch,read})=>{
 await launch({action:'start'}).done;const q=request(read().checkpoint,'lost');const lost=await launch({action:'resume',request:q,loss:'claim'}).done;a.equal(lost.code,'OUTCOME_UNKNOWN');a.deepEqual(lost.calls,[]);
 const before=read().row,retry=await launch({action:'resume',request:q}).done;a.equal(retry.code,'OPERATION_IN_PROGRESS');a.deepEqual(read().row,before);
}));
test('external effect plus failed checkpoint is not retried by another process',()=>fixture(async({launch,read,dir})=>{
 await launch({action:'start'}).done;const q=request(read().checkpoint,'effect'),effectFile=path.join(dir,'synthetic-effect.txt');
 const failed=await launch({action:'resume',request:q,effectFile}).done;a.equal(failed.code,'HISTORY_SAVE_OUTCOME_UNKNOWN');a.equal(fs.readFileSync(effectFile,'utf8'),'effect\n');
 const retry=await launch({action:'resume',request:q,effectFile}).done;a.equal(retry.code,'OPERATION_IN_PROGRESS');a.deepEqual(retry.calls,[]);a.equal(fs.readFileSync(effectFile,'utf8'),'effect\n');a.equal(read().row.snapshot.status,'RUNNING');
}));
test('independent resume process loses lease in beforeStep and executes zero Jobs',()=>fixture(async({launch,read})=>{
 a.equal((await launch({action:'start'}).done).ok,true);
 const failed=await launch({action:'resume',leaseMs:1000,pauseBeforeStep:1100}).done;
 a.equal(failed.code,'EXECUTION_OWNERSHIP_REFUSED');a.equal(failed.causeCode,'LEASE_EXPIRED');a.deepEqual(failed.calls,[]);a.equal(read().row.snapshot.status,'RUNNING');a.equal(read().row.snapshot.history.filter(h=>h.stepNo===40).length,0);
},'LIMIT_REACHED'));
