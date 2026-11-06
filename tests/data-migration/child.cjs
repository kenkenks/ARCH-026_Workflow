'use strict';
const {SimpleDB,DATA_STORAGE_SCHEMA,SimpleDBDataRepository}=require('../../src/adapters/data/simpledb.cjs');
const [mode,file,id,revision]=process.argv.slice(2);
const db=SimpleDB.open(file,DATA_STORAGE_SCHEMA,{timeout:2000});
const repo=new SimpleDBDataRepository(db,'demo-items');
async function run(){
  try{
    if(mode==='read')console.log(JSON.stringify(await repo.read(id)));
    else{
      try{await repo.write({id,schemaVersion:'2',label:String(process.pid),enabled:true},revision);process.send('UPDATED');}
      catch(error){process.send(error.code);}
    }
  }finally{db.close();if(process.connected)process.disconnect();}
}
if(mode==='race'){process.on('message',()=>run().catch(()=>{process.exitCode=1;}));process.send('READY');}
else run().catch(()=>{process.exitCode=1;});
