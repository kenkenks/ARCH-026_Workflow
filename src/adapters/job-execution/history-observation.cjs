'use strict';
const {isDeepStrictEqual:equal}=require('node:util');
const {readDiagnosticInput}=require('./diagnostic.cjs');
/** Read-only evidence. Never retries save or turns WorkflowRunError into success. */
async function observeHistorySave(options,attemptedSnapshot,storageCause){
 let input;try{input=await readDiagnosticInput(options);}catch{return {state:'UNKNOWN',scope:'SAVE_OPERATION',commitOutcome:'UNKNOWN',reason:'READ_UNAVAILABLE'};}
 const available=!input.readIssues.length,stored=input.run?.snapshot;
 const matches=!!attemptedSnapshot&&available&&equal(stored,attemptedSnapshot);
 const rollbackProof=storageCause?.rollbackConfirmed===true&&(
  ['BEGIN','ACTION'].includes(storageCause.transactionPhase)||storageCause.transactionPhase==='COMMIT'&&[5,6].includes(storageCause.sqliteCode&255));
 const base={observedWorkflowStatus:stored?.status||null,historyLength:available?input.traceRows.length:null,
  uniqueHistoryOrders:available?new Set(input.traceRows.map(h=>h.order)).size===input.traceRows.length:null,observedStateMatches:matches};
 if(rollbackProof)return {...base,state:'NOT_APPLIED',scope:'SAVE_OPERATION',commitOutcome:'NOT_APPLIED',reason:'LOCAL_TRANSACTION_ROLLBACK_CONFIRMED'};
 if(matches)return {...base,state:'APPLIED',scope:'OBSERVED_SNAPSHOT',commitOutcome:'UNKNOWN',reason:'STATE_MATCH_IS_NOT_OPERATION_ID_PROOF'};
 return {...base,state:'UNKNOWN',scope:'SAVE_OPERATION',commitOutcome:'UNKNOWN',reason:available?'NO_UNIQUE_SAVE_OPERATION_ID':'READ_UNAVAILABLE'};
}
module.exports={observeHistorySave};
