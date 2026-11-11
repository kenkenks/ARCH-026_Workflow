'use strict';
const {randomUUID}=require('node:crypto');
const {SimpleDB}=require('../simpledb/database.cjs');
const {ExternalError,hash,encode}=require('../job-execution/external.cjs');
const RECEIPT_SCHEMA=Object.freeze({applicationId:0x41524e52,version:1,sql:'CREATE TABLE receipts(receipt_id INTEGER PRIMARY KEY,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL) STRICT;'});
const NOTIFICATION_SCHEMA=Object.freeze({applicationId:0x41524e45,version:1,sql:`
CREATE TABLE config(service_id TEXT PRIMARY KEY NOT NULL,idempotent INTEGER NOT NULL CHECK(idempotent IN (0,1))) STRICT;
CREATE TABLE notifications(notification_id TEXT PRIMARY KEY NOT NULL,request_id TEXT NOT NULL,payload_json TEXT NOT NULL) STRICT;
CREATE TABLE results(request_id TEXT PRIMARY KEY NOT NULL,payload_hash TEXT NOT NULL,response_json TEXT NOT NULL) STRICT;`});
function initializeMockService({receiptFile,notificationFile,id,idempotent}){if(typeof id!=='string'||!id.trim()||typeof idempotent!=='boolean')throw new ExternalError('INVALID_SERVICE_CONFIG');SimpleDB.initialize(receiptFile,RECEIPT_SCHEMA);SimpleDB.initialize(notificationFile,NOTIFICATION_SCHEMA);const db=SimpleDB.open(notificationFile,NOTIFICATION_SCHEMA);try{db.transaction(()=>db.run('INSERT INTO config VALUES (?,?)',id,idempotent?1:0));}finally{db.close();}}
/** Independent durable mock service. Records receipts separately from notification effects. */
class MockNotificationService{
 constructor(config){this.config={...config};this.id=config.id;this.idempotent=config.idempotent;}
 open(){const db=SimpleDB.open(this.config.notificationFile,NOTIFICATION_SCHEMA);const c=db.get('SELECT * FROM config');if(!c||c.service_id!==this.id||c.idempotent!==(this.idempotent?1:0)){db.close();throw new ExternalError('SERVICE_CONFIG_MISMATCH');}return db;}
 async send(request,{fault,reject=false}={}){
  if(!request||typeof request.requestId!=='string'||!request.requestId.trim()||hash(request.payload)!==request.payloadHash)throw new ExternalError('INVALID_SERVICE_REQUEST');
  if(fault==='before-receipt')throw new ExternalError('TRANSPORT_UNAVAILABLE');
  const receipts=SimpleDB.open(this.config.receiptFile,RECEIPT_SCHEMA);try{receipts.transaction(()=>receipts.run('INSERT INTO receipts(request_id,payload_hash,payload_json) VALUES (?,?,?)',request.requestId,request.payloadHash,encode(request.payload)));}finally{receipts.close();}
  if(fault==='after-receipt')throw new ExternalError('TRANSPORT_UNAVAILABLE');
  const db=this.open();let value;try{value=db.transaction(()=>{const old=db.get('SELECT * FROM results WHERE request_id=?',request.requestId);
   if(old&&old.payload_hash!==request.payloadHash)return {requestId:request.requestId,payloadHash:request.payloadHash,status:'REJECTED',result:{code:'REQUEST_ID_CONTENT_CONFLICT'}};
   if(this.idempotent&&old)return JSON.parse(old.response_json);
   const response={requestId:request.requestId,payloadHash:request.payloadHash,status:reject?'REJECTED':'CONFIRMED',result:reject?{code:'MOCK_REJECTED'}:{notificationId:randomUUID()}};
   if(!reject)db.run('INSERT INTO notifications VALUES (?,?,?)',response.result.notificationId,request.requestId,encode(request.payload));
   if(!old)db.run('INSERT INTO results VALUES (?,?,?)',request.requestId,request.payloadHash,encode(response));
   return response;
  });}finally{db.close();}
  if(fault==='after-effect'||fault==='response-loss')throw new ExternalError('TRANSPORT_UNAVAILABLE');return value;
 }
 async lookup(requestId){if(!this.idempotent)throw new ExternalError('LOOKUP_UNSUPPORTED');const db=this.open();try{const row=db.get('SELECT * FROM results WHERE request_id=?',requestId);return row?JSON.parse(row.response_json):null;}finally{db.close();}}
}
module.exports={RECEIPT_SCHEMA,NOTIFICATION_SCHEMA,initializeMockService,MockNotificationService};
