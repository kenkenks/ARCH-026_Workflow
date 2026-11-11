'use strict';
const Module=require('node:module'),load=Module._load;
Module._load=function(name,...args){if(/^(?:node:)?sqlite$|^sqlite3$|^better-sqlite3$/.test(name))throw Error('SQLITE_RUNTIME_FORBIDDEN');return load.call(this,name,...args);};
const {firestore,options,workflow}=require('./scenario.cjs');
let connection,store;
process.on('message',async m=>{try{
 if(m.action==='init'){connection=await firestore.connectEmulator(m.environment);store=new firestore.FirestoreWaitingStore(connection,options());const path=require('node:path');if(Object.keys(require.cache).some(f=>!path.resolve(f).startsWith(path.resolve(process.cwd())+path.sep)))throw Error('EXTERNAL_MODULE');process.send({id:m.id,ok:true});return;}
 if(m.action==='close'){await connection.close();process.send({id:m.id,ok:true});process.disconnect();return;}
 const value=m.action==='read'?await store.read():m.action==='observe'?await store.observeOperation(m.request):await(await workflow(store)).resumeWaiting(m.saved||await store.load('run'),m.request);
 process.send({id:m.id,ok:true,value});
 }catch(e){process.send({id:m.id,ok:false,code:e.code||'UNEXPECTED'});}});
