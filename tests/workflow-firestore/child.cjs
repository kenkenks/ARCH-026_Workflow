'use strict';
const {connectEmulator}=require('../../src/adapters/workflow-firestore/emulator.cjs');
const {FirestoreExperimentStore}=require('../../src/adapters/workflow-firestore/store.cjs');
const {createExecution}=require('../../src/adapters/workflow-firestore/composition.cjs');
const {definition,registry}=require('./scenario.cjs');
let connection;
const send=x=>new Promise(resolve=>process.send(x,resolve));
process.on('message',async command=>{
 try{
  if(command.action==='init'){connection=await connectEmulator(command.config);await send({ready:true});return;}
  const store=new FirestoreExperimentStore(connection,command.runId);
  if(command.action==='claim'){
   const credential=await store.claim(command.owner);await send({ok:true,credential});
  }else if(command.action==='inspect'){const state=await store.inspect();await send({ok:true,state});}
  else if(command.action==='slice'||command.action==='resume'){
   await store.claim(command.owner);let makes=[];
   const execution=await createExecution(store,definition,registry(id=>makes.push(id)),new Map([['yes',()=>({evaluate:()=>true})]]),{resume:command.action==='resume'});
   const result=await execution.run(command.action==='slice'?3:100);await store.release();await send({ok:true,result,makes});
  }else if(command.action==='killBefore'||command.action==='killDuring'){
   await store.claim(command.owner);
   const change={definitionId:definition.definitionId,definitionVersion:'1',definitionDigest:require('../../src/adapters/workflow-firestore/store.cjs').hash(definition),
    snapshot:{runId:command.runId,currentStepNo:1,status:'RUNNING',history:[]},jobs:[],artifacts:[]};
   if(command.action==='killBefore'){await send({barrier:true});return;}
   await store.commit(change,{beforeCommit:async()=>{await send({barrier:true});await new Promise(()=>{});}});
  }else if(command.action==='close'){await connection.close();process.disconnect();}
 }catch(e){await send({ok:false,code:e.code||'INTERNAL'});}
});
