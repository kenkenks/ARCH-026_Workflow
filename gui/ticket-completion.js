'use strict';
function conflict(code,message){return Object.assign(new Error(message),{code,status:409});}
/** One current execution's process-local completion coordination; never advances Runtime. */
class TicketCompletion {
 constructor(tickets,runtime,ticketId,runId){
  this.tickets=tickets;this.runtime=runtime;
  this.target={ticketId,runId,workflowId:runtime.definition.id,workflowVersion:runtime.definition.version};
  this.inProgress=false;this.last=null;
 }
 get blocked(){return this.inProgress||(this.last?this.last.result!=='CONFIRMED':this.runtime.status==='COMPLETED');}
 snapshot(){return this.last?{...this.last,inProgress:this.inProgress}:this.inProgress?{...this.target,result:'UNKNOWN',checkedAt:null,code:'TICKET_COMPLETION_IN_PROGRESS',inProgress:true}:null;}
 get message(){
  if(!this.blocked)return null;
  return this.last?.result==='CONFLICT'?'Ticketの完了情報が競合しています。原因を確認してください':this.last?.result==='PENDING'?'Ticketの完了更新が未反映です。専用APIで再確認してください':'Ticketの完了結果が未確認です。状態照合が必要です';
 }
 matches(ticket){const t=this.target;return ticket?.ticketId===t.ticketId&&ticket.executionId===t.runId&&ticket.workflowId===t.workflowId&&ticket.workflowVersion===t.workflowVersion;}
 record(result,code){this.last={...this.target,result,checkedAt:new Date().toISOString(),code};return {...this.last};}
 async observe(){try{const ticket=await this.tickets.get(this.target.ticketId);return ticket?{ticket}:{};}catch{return {};}}
 async reconcile(ticketId,runId){
  if(this.inProgress)throw conflict('TICKET_COMPLETION_BUSY','同じ実行のTicket完了調整を処理中です');
  const r=this.runtime,t=this.target;
  if(!ticketId||!runId||ticketId!==t.ticketId||runId!==t.runId||r.runId!==runId)
   throw conflict('TICKET_COMPLETION_TARGET_MISMATCH','Ticketまたは実行IDが一致しません');
  if(r.executionMode!=='NORMAL'||r.simulatedJobUsed!==false||r.status!=='COMPLETED'||r.definition.id!==t.workflowId||r.definition.version!==t.workflowVersion)
   throw conflict('TICKET_COMPLETION_NOT_ELIGIBLE','通常実行のEND到達を確認できません');
  this.inProgress=true;
  try{
   const before=await this.observe();
   if(!before.ticket)return this.record('UNKNOWN','TICKET_COMPLETION_READ_UNKNOWN');
   if(!this.matches(before.ticket)||!['IN_PROGRESS','COMPLETED'].includes(before.ticket.status))return this.record('CONFLICT','TICKET_COMPLETION_CONFLICT');
   if(before.ticket.status==='COMPLETED')return this.record('CONFIRMED','TICKET_COMPLETION_ALREADY_CONFIRMED');
   let saveThrew=false;
   try{await this.tickets.complete(ticketId);}catch{saveThrew=true;}
   // Observe even after a normal return. This confirms state, not save's outcome.
   const after=await this.observe();
   if(!after.ticket)return this.record('UNKNOWN','TICKET_COMPLETION_READ_UNKNOWN');
   if(!this.matches(after.ticket)||!['IN_PROGRESS','COMPLETED'].includes(after.ticket.status))return this.record('CONFLICT','TICKET_COMPLETION_CONFLICT');
   if(after.ticket.status==='COMPLETED')return this.record('CONFIRMED',saveThrew?'TICKET_COMPLETION_CONFIRMED_AFTER_EXCEPTION':'TICKET_COMPLETION_CONFIRMED');
   return this.record('PENDING',saveThrew?'TICKET_COMPLETION_PENDING_AFTER_EXCEPTION':'TICKET_COMPLETION_NOT_SAVED');
  }catch{return this.record('UNKNOWN','TICKET_COMPLETION_READ_UNKNOWN');}
  finally{this.inProgress=false;}
 }
}
module.exports={TicketCompletion};
