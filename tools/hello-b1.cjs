'use strict';
// Development-only loopback Host. IPC is the deterministic stop path for Windows test runners.
const {startB1}=require('../src/composition/hello-b1.cjs');
(async()=>{
  let app;
  try {
    app=await startB1({applicationId:'hello-world',host:{provider:'node-http',options:{port:0}},
      storage:{provider:'local-file',options:{directory:process.argv[2]||'runtime-data/hello-b1'}},auth:{mode:'anonymous'}});
    const ready={type:'ready',origin:app.origin,developmentOnly:true};
    if(process.send)process.send(ready);else console.log(JSON.stringify(ready));
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;try{await app.stop();if(process.send)process.send({type:'stopped'});process.disconnect?.();}
      catch{process.exitCode=1;if(process.send)process.send({type:'stop-failed',code:'OUTCOME_UNKNOWN'});process.disconnect?.();}};
    process.on('message',message=>{if(message?.type==='stop')void stop();});
    process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
  }catch{process.exitCode=1;console.error('HELLO_B1_START_FAILED');}
})();
