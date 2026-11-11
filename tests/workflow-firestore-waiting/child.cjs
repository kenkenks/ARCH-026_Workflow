'use strict';
const {connectEmulator}=require('../../src/adapters/workflow-firestore/emulator.cjs');
const {FirestoreWaitingStore}=require('../../src/adapters/workflow-firestore/waiting.cjs');
const {graph,config}=require('./scenario.cjs');
let connection,store;const calls=[];
process.on('message',async m=>{try{
 if(m.action==='init'){
  connection=await connectEmulator(m.environment);store=new FirestoreWaitingStore(connection,{...config,ownerId:m.owner,leaseMs:30000,hooks:{
   beforeCommit:({kind,row})=>{if(m.crash==='before-wait'&&kind==='save'&&row.snapshot?.status==='WAITING')process.exit(81);if(m.crash==='before-resume'&&kind==='claimWaiting')process.exit(83);},
   afterCommit:({kind,row})=>{if(m.crash==='after-wait'&&kind==='save'&&row.snapshot?.status==='WAITING')process.exit(82);if(m.crash==='after-resume'&&kind==='claimWaiting')process.exit(84);}
  }});process.send({id:m.id,ok:true});return;
 }
 if(m.action==='close'){await connection.close();process.send({id:m.id,ok:true});process.disconnect();return;}
 if(m.action==='read'){process.send({id:m.id,ok:true,value:await store.read()});return;}
 if(m.action==='observe'){process.send({id:m.id,ok:true,value:await store.observeOperation(m.request,{sealAbsent:!!m.seal})});return;}
 const wf=await graph(store,calls);let value;
 if(m.action==='start'){await store.claimStart('start');value=await wf.run('run',10);}
 else value=await wf.resumeWaiting(m.saved||await store.load('run'),m.request);
 process.send({id:m.id,ok:true,value,calls});
 }catch(e){process.send({id:m.id,ok:false,code:e.code||'UNEXPECTED',calls});}});
