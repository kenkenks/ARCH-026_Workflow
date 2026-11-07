'use strict';
const {TextDecoder}=require('node:util');
const BODY_LIMIT=65536; // Existing GUI request limit, measured in bytes.
function invalid(message='要求の構造が不正です',status=400){throw Object.assign(Error(message),{status});}
function object(value){if(!value||typeof value!=='object'||Array.isArray(value))invalid();return value;}
function text(value){if(typeof value!=='string'||!value.trim())invalid();}
async function readBody(req){
 const type=req.headers['content-type']||'';
 if(!/^application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i.test(type))invalid('application/json が必要です',415);
 const chunks=[];let size=0,tooLarge=false;
 // Drain an oversized request without retaining it, so the connection can receive 413.
 for await(const chunk of req){size+=chunk.length;if(size>BODY_LIMIT){tooLarge=true;chunks.length=0;}else if(!tooLarge)chunks.push(chunk);}
 if(tooLarge)invalid('本文のサイズ上限を超えています',413);
 let value;
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}catch{invalid('有効なUTF-8 JSON本文が必要です');}
 return object(value);
}
function ticketFields(value,create=false){
 object(value);
 for(const key of create?['title','createdBy','ownerId']:[])text(value[key]);
 for(const key of ['title','description','createdBy','ownerId'])if(Object.hasOwn(value,key)&&typeof value[key]!=='string')invalid();
 for(const key of ['title','ownerId'])if(Object.hasOwn(value,key))text(value[key]);
 for(const key of ['dueAt','parentTicketId'])if(Object.hasOwn(value,key)&&value[key]!==null&&typeof value[key]!=='string')invalid();
}
function validateRequest(route,body,step){
 object(body);
 // Unknown metadata on existing editing APIs remains accepted/ignored as before.
 if(route==='/api/tickets')ticketFields(body,true);
 if(route==='/api/ticket-action'){
  text(body.ticketId);if(!['edit','submit','cancel','start'].includes(body.action))invalid();
  if(body.action==='edit')ticketFields(body.patch);
  if(body.action==='start'){text(body.definitionId);text(body.definitionVersion);if(body.executionMode!==undefined&&!['NORMAL','DEMO'].includes(body.executionMode))invalid();}
 }
 if(route==='/api/job-submit')object(body.values); // Field semantics belong to ExamJobs.
 if(route==='/api/step'){
  if(Object.keys(body).some(key=>key!=='checkResult'))invalid();
  if(Object.hasOwn(body,'checkResult')&&(!['CHECK_FINAL','CHECK_PROVISIONAL','CHECK_WAIT'].includes(step?.type)||!['PASS','REJECT','WAIT','ERROR'].includes(body.checkResult)))invalid();
 }
 return body;
}
module.exports={readBody,validateRequest,BODY_LIMIT};
