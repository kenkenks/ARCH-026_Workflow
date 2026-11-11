'use strict';
const {randomUUID}=require('node:crypto');
const {fork}=require('node:child_process');
const path=require('node:path');
const unit=require('@arch026/workflow-unit');
const {MemoryWaitingStore}=require('@arch026/workflow-unit/waiting');
const firestore=require('@arch026/workflow-unit/firestore');
const definition={schemaVersion:'prototype-workflow/2',definitionId:'package-wait',definitionVersion:'1',startStepId:'a',steps:[
 {stepId:'a',stepNo:10,kind:'JOB',jobId:'a',nextStepId:'wait'},
 {stepId:'wait',stepNo:20,kind:'WAIT',reason:'authorized-input',nextStepId:'check'},
 {stepId:'check',stepNo:30,kind:'CHECK_BOOL',checkId:'approved',trueStepId:'b',falseStepId:'return'},
 {stepId:'b',stepNo:40,kind:'JOB',jobId:'b'},
 {stepId:'return',stepNo:50,kind:'JOB',jobId:'return',nextStepId:'wait'}]};
function options(runId='run',ownerId=randomUUID()){return {runId,ownerId,definitionId:definition.definitionId,definitionVersion:'1',definitionDigest:firestore.hash(definition),leaseMs:30000};}
function registry(u,store,calls=[]){return {jobs:new Map(),jobForms:{products:store.products,definitions:new Map(['a','b','return'].map(id=>[id,{artifactKey:id,form:{name:id,
 collect:p=>{calls.push(id+':collect');return id==='a'?10:p.get('a');},make:x=>{calls.push(id+':make');return id==='a'?x:x+20;},record:()=>calls.push(id+':record')}}])),
 onCreate:job=>{if(!(job instanceof u.CJob))throw Error('NOT_DISTRIBUTED_CJOB');}},checks:new Map([['approved',()=>({evaluate:()=>{calls.push('check');return store.getInput().approved===true;}})]])};}
async function workflow(store,calls=[]){const saved=await store.load('run');const r=unit.reconstructWorkflow(definition,registry(unit,store,calls),store,{history:saved?.history||[]});if(!(r.workflow instanceof unit.CWorkflow))throw Error('NOT_DISTRIBUTED_CWORKFLOW');return r.workflow;}
async function waiting(store,calls=[]){await store.claimStart('start');return (await workflow(store,calls)).run('run',10);}
async function request(store,id='approve',approved=true){const row=await store.read();return {runId:'run',operationId:id,expectedWaitGeneration:row.snapshot.waiting.generation,expectedRevision:row.revision,result:{approved}};}
async function fixture(fn){const environment={FIRESTORE_EMULATOR_HOST:process.env.FIRESTORE_EMULATOR_HOST,projectId:'demo-arch026-c2',namespace:'c2-release-'+randomUUID()},connection=await firestore.connectEmulator(environment),children=[];
 const open=id=>new firestore.FirestoreWaitingStore(connection,options('run',id||randomUUID()));
 const child=async()=>{const p=fork(path.join(__dirname,'child.cjs'),[],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','ignore','pipe','ipc'],env:process.env});p.stderr.on('data',()=>{});let seq=0;const pending=new Map();p.on('message',m=>{pending.get(m.id)?.(m);pending.delete(m.id);});const exit=new Promise(r=>p.once('exit',r));p.on('exit',code=>{for(const r of pending.values())r({ok:false,code:'CHILD_EXIT_'+code});pending.clear();});
 const send=m=>new Promise((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(Error('IPC timeout'));},40000);pending.set(id,r=>{clearTimeout(t);resolve(r);});p.send({...m,id});});const c={p,send,exit};children.push(c);const ready=await send({action:'init',environment});if(!ready.ok)throw Error(ready.code);return c;};
 try{await fn({connection,open,child,store:open()});}finally{for(const c of children){if(c.p.connected)await c.send({action:'close'});if(c.p.exitCode===null){c.p.kill();await c.exit;}}await connection.db.recursiveDelete(connection.root);await connection.close();}}
module.exports={unit,firestore,MemoryWaitingStore,definition,options,registry,workflow,waiting,request,fixture};
