'use strict';
const {ExternalOperations}=require('../../src/adapters/job-execution/external.cjs');
const {MockNotificationService}=require('../../src/adapters/mock-notification/service.cjs');
const input=JSON.parse(process.argv[2]);let release;const gate=()=>new Promise(r=>{release=r;});
process.on('message',m=>{if(m==='continue')release?.();});
(async()=>{const service=new MockNotificationService(input.service);
 if(input.mode==='send')return service.send(input.request);
 if(input.mode==='lookup')return service.lookup(input.requestId);
 const ops=new ExternalOperations(input.options,input.ownership);try{const prepared=ops.prepare(input.operation);process.send({event:'prepared',requestId:prepared.requestId});
  if(input.pause==='prepared')await gate();
  const client={id:service.id,idempotent:service.idempotent,lookup:id=>service.lookup(id),send:async req=>{
   if(input.pause==='before-remote'){process.send({event:'before-remote',requestId:req.requestId});await gate();}
   const result=await service.send(req);
   if(input.pause==='after-effect'){process.send({event:'after-effect',requestId:req.requestId});await gate();}return result;
  }};
  return await ops.dispatch(prepared,client);
 }finally{ops.close();}
})().then(value=>{if(process.send)process.send({event:'done',ok:true,value});else process.stdout.write(JSON.stringify({ok:true,value}));if(process.connected)process.disconnect();},error=>{if(process.send)process.send({event:'done',ok:false,code:error?.code??'UNEXPECTED'});else process.stdout.write(JSON.stringify({ok:false,code:error?.code??'UNEXPECTED'}));if(process.connected)process.disconnect();});
