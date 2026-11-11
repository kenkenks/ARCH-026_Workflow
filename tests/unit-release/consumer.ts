import {CWorkflow,CJob,CCheckJob,CMemoryHistoryStore,type CJobForm,type WaitingOperation,type IWaitingHistoryStore} from '@arch026/workflow-unit';
import {MemoryWaitingStore,type LifecycleOptions} from '@arch026/workflow-unit/waiting';
import {FirestoreWaitingStore,type EmulatorConnection,type Observation} from '@arch026/workflow-unit/firestore';
const config:LifecycleOptions={runId:'run',definitionId:'d',definitionVersion:'1',definitionDigest:'digest'};
const memory=new MemoryWaitingStore(config);
const form:CJobForm<number,number>={name:'add',collect:()=>10,make:n=>n+20};
const job=new CJob(form,memory.products,'result');
const graph=new CWorkflow([{no:1,job,nextStepNo:2},{no:2,waitReason:'input',nextStepNo:3},{no:3,job:new CCheckJob('branch',{evaluate:()=>true},1,1)}],memory);
const oldStore=new CMemoryHistoryStore();void oldStore;void graph;
declare const connection:EmulatorConnection;
const saved=new FirestoreWaitingStore(connection,config);
const port:IWaitingHistoryStore=saved;
const operation:WaitingOperation={runId:'run',operationId:'operation',expectedWaitGeneration:1,expectedRevision:3,result:{approved:true}};
async function check(){const row=await saved.read();if(row?.snapshot?.status==='WAITING')await new CWorkflow([{no:2,waitReason:'input',nextStepNo:2}],port).resumeWaiting(row.snapshot,operation);const evidence:Observation=await saved.observeOperation(operation);return evidence.state;}
void check;
