'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DefinitionStore}=require('../../gui/workflow-definitions.js');
const [directory,id,version,overwrite,hold]=process.argv.slice(2);
const store=new DefinitionStore(directory);
const definition={id,version,startStepId:'E',eventRoutes:[],steps:[{id:'E',type:'END'}]};
if(hold==='hold'){
  const rename=fs.renameSync;
  fs.renameSync=(from,to)=>{
    process.send({type:'LOCKED'});
    const wait=new Int32Array(new SharedArrayBuffer(4)),until=Date.now()+10000;
    while(!fs.existsSync(path.join(directory,'release-save'))){
      if(Date.now()>until)throw Error('fixture release timeout');
      Atomics.wait(wait,0,0,10);
    }
    return rename(from,to);
  };
}
process.on('message',message=>{
  if(message!=='GO')return;
  try{store.save(definition,{overwrite:overwrite==='true'});process.send({type:'RESULT',code:'SAVED'});}
  catch(error){process.send({type:'RESULT',code:error.code,status:error.status});}
  process.disconnect();
});
process.send({type:'READY'});
