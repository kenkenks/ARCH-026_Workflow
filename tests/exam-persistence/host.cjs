'use strict';
const {startDemo}=require('../../tools/exam-application-demo.cjs');
const {createFirestoreExamApplication}=require('../../src/adapters/workflow-firestore/exam-application.cjs');
let demo,release,used=false,lost=false;
process.on('message',async message=>{
 try{
  if(message.action==='init'){
   const o=message.options||{};
   const hook=point=>async context=>{
    if(used||o.point!==point)return;
    if(o.kind&&context.kind&&o.kind!==context.kind)return;
    used=true;
    if(o.credential==='token')context.store.credential={...context.store.credential,token:'wrong'};
    else if(o.credential==='fence')context.store.credential={...context.store.credential,fence:0};
    else if(o.pause){process.send({event:'barrier',point,id:context.id});await new Promise(r=>release=r);}
    else throw Object.assign(Error('SYNTHETIC_FAULT'),{code:point==='beforeAccept'?'NOT_ACCEPTED':'SYNTHETIC_FAULT'});
   };
   const app=await createFirestoreExamApplication(message.config,Object.fromEntries(['beforeAccept','afterAccept','beforeSlice','beforeFinalize','afterFinalize'].map(p=>[p,hook(p)])));
   demo=await startDemo({storage:'emulator',port:0,application:app,afterOperationResponse:({res,result})=>{if(!lost&&result.operation.kind===o.loseResponseKind){lost=true;res.destroy();}}});
   process.send({id:message.id,ok:true,url:demo.url,config:app.config()});
  }else if(message.action==='release'){release?.();process.send({id:message.id,ok:true});}
  else if(message.action==='close'){await demo.close();process.send({id:message.id,ok:true},()=>process.disconnect());}
 }catch(e){process.send({id:message.id,ok:false,code:e.code||'HOST_FAILURE'},()=>{if(message.action==='init')process.disconnect();});}
});
