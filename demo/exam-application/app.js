'use strict';
const $=id=>document.getElementById(id);
let config,state,busy=false,uncertain=false,pending=null;
const opButtons={APPROVE:'approve',RETURN:'return',RESUBMIT:'resubmit',CONFIRM_EXAM:'confirm',REGISTER_RESULT:'register'};
const message=(text,error=false)=>{$('message').textContent=text;$('message').classList.toggle('error',error);};
async function api(path,body){
 let response;try{response=await fetch(path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+$('actor').value,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});}catch{throw {unknown:!!body,message:'通信結果が不明です。同じ操作を再送せず、履歴更新で確認してください。'};}
 let result;try{result=await response.json();}catch{throw {unknown:!!body,message:'応答を確認できません。履歴更新で状態を確認してください。'};}
 if(!response.ok||!result.ok)throw {unknown:result.error?.code==='OUTCOME_UNKNOWN',code:result.error?.code,message:result.error?.message||'処理を確認できません。'};return result.value;
}
function cell(row,text,small){const td=document.createElement('td');td.textContent=String(text??'—');if(small){const s=document.createElement('small');s.textContent=small;td.append(s);}row.append(td);}
function render(){
 for(const [op,id]of Object.entries(opButtons))$(id).disabled=busy||uncertain||!state?.allowedOperations.includes(op);
 $('start').disabled=busy||uncertain||!['demo-applicant','demo-admin'].includes($('actor').value);$('refresh').disabled=busy;$('actor').disabled=busy;
 if(!state)return;
 $('application-id').textContent=state.applicationId;$('created-at').textContent=new Date(state.createdAt).toLocaleString('ja-JP');$('current-grade').textContent=state.grade||'—';$('core-status').textContent=state.workflowStatus;$('stage').textContent=state.businessStage;
 $('waiting').textContent=state.blocked?'安全確認が必要なため、操作を停止しています。':state.workflowStatus==='COMPLETED'?'制御フローはENDに到達しました。':state.busy?'サーバーで処理しています。':'必要な入力が揃うまで、Workflowを実行しません。';
 const stepNos=[10,20,40,50,60];[...$('steps').children].forEach((li,i)=>{li.classList.toggle('done',state.history.some(h=>h.stepNo===stepNos[i]&&h.result!=='ERROR'));li.classList.toggle('current',state.currentStepNo===stepNos[i]);});
 $('review').hidden=state.currentStepNo!==95;if(!$('review').hidden)$('review').textContent='申請内容を確認し、再申請してください。理由：'+(state.review?.reason||'');
 $('outcome').hidden=!state.result;if(state.result)$('outcome').textContent=`結果登録済み：${state.result.result==='PASS'?'合格':'不合格'} / ${state.result.score}点（合成結果）`;
 if(state.result){$('result').value=state.result.result;$('score').value=state.result.score;}
 const exam=state.artifacts.filter(a=>a.key==='examConfirmation').at(-1)?.published;if(exam)$('exam-date').value=exam.examDate;
 $('reason').disabled=$('return').disabled;$('note').disabled=$('resubmit').disabled;$('exam-date').disabled=$('confirm').disabled;$('result').disabled=$('register').disabled;$('score').disabled=$('register').disabled;
 $('operations').replaceChildren();for(const op of state.operations){const tr=document.createElement('tr');cell(tr,new Date(op.at).toLocaleString('ja-JP'),op.commandId);cell(tr,op.actorId);cell(tr,op.operation);cell(tr,`${op.fromStage} → ${op.toStage||'確認中'}`);cell(tr,`${op.status} / ${op.result||'受付済み'}`);$('operations').append(tr);}
 $('operation-count').textContent=state.operations.length+' 件';$('traces').replaceChildren();for(const h of state.history){const tr=document.createElement('tr');for(const v of[h.order,new Date(h.at).toLocaleTimeString('ja-JP'),h.step,h.result,h.nextStepNo??'END'])cell(tr,v);$('traces').append(tr);}$('job-count').textContent=`実際のCJob実行：${state.jobs.length}件 / Workflow履歴：${state.history.length}件`;
}
async function refresh(){if(pending&&pending.actor!==$('actor').value)throw {message:'結果確認は送信時の合成ユーザーに切り替えて行ってください。'};
 if(pending?.kind==='START'){const read=await api('/api/demo/commands/'+pending.commandId);state=read.state;}else if(pending?.applicationId||state||sessionStorage.getItem('exam-application-id'))state=await api('/api/demo/applications/'+(pending?.applicationId||state?.applicationId||sessionStorage.getItem('exam-application-id')));else return;
 if(pending){const op=state.operations.find(o=>o.commandId===pending.commandId);if(op?.status==='APPLIED'){uncertain=false;pending=null;sessionStorage.removeItem('exam-pending');message('保存済みの適用結果を確認しました。再実行はしていません。');}}
 sessionStorage.setItem('exam-application-id',state.applicationId);render();}
async function send(kind,payload){if(busy||uncertain)return;busy=true;render();const commandId=crypto.randomUUID();pending={commandId,kind,actor:$('actor').value,applicationId:state?.applicationId||null,bootSessionId:config.bootSessionId};sessionStorage.setItem('exam-pending',JSON.stringify(pending));
 try{const result=kind==='START'?await api('/api/demo/applications',{commandId,bootSessionId:config.bootSessionId,memberId:$('member').value,grade:$('grade').value}):await api(`/api/demo/applications/${state.applicationId}/commands`,{commandId,bootSessionId:config.bootSessionId,expectedRevision:state.revision,expectedStepNo:state.currentStepNo,kind,payload});state=result.state;sessionStorage.setItem('exam-application-id',state.applicationId);if(result.operation.status!=='APPLIED'){uncertain=true;message('操作結果は '+result.operation.status+' です。再実行せず、履歴更新で確認してください。',true);return;}pending=null;sessionStorage.removeItem('exam-pending');await refresh();message('操作を適用しました。サーバーの最新状態を表示しています。');}
 catch(e){uncertain=!!e.unknown;if(!uncertain){if(e.code==='WORKFLOW_FAILED')await refresh().catch(()=>{});pending=null;sessionStorage.removeItem('exam-pending');await refresh().catch(()=>{});}message(e.message||'操作できません。',true);}
 finally{busy=false;render();}
}
$('start').onclick=()=>send('START');$('approve').onclick=()=>send('APPROVE',{});$('return').onclick=()=>send('RETURN',{reason:$('reason').value});$('resubmit').onclick=()=>send('RESUBMIT',{grade:$('grade').value,note:$('note').value});$('confirm').onclick=()=>send('CONFIRM_EXAM',{examDate:$('exam-date').value});$('register').onclick=()=>send('REGISTER_RESULT',{result:$('result').value,score:$('score').value===''?null:Number($('score').value)});
$('refresh').onclick=()=>refresh().catch(e=>message(e.message,true));$('actor').onchange=()=>{sessionStorage.setItem('exam-actor',$('actor').value);if(state)state.allowedOperations=[];render();refresh().catch(e=>message(e.message,true));};
(async()=>{config=await api('/api/demo/config');$('storage-label').textContent=config.storage==='emulator'?'Emulator デモ':'Memory デモ';$('storage-warning').textContent=config.warning;for(const [id,values]of[['member',config.members],['grade',config.grades]])for(const v of values){const option=document.createElement('option');option.value=v;option.textContent=v;$(id).append(option);}$('exam-date').value=new Date().toISOString().slice(0,10);
 const actor=sessionStorage.getItem('exam-actor');if(['demo-applicant','demo-teacher','demo-admin'].includes(actor))$('actor').value=actor;
 try{pending=JSON.parse(sessionStorage.getItem('exam-pending')||'null');}catch{pending=null;}
 if(pending&&pending.bootSessionId!==config.bootSessionId){pending=null;sessionStorage.removeItem('exam-pending');sessionStorage.removeItem('exam-application-id');message('Memoryのセッションが変わり、前回データは失われました。旧操作は再実行しません。新規申請を開始できます。',true);}
 if(pending){uncertain=true;$('actor').value=pending.actor;await refresh().catch(()=>message('前回の操作結果は未確認です。履歴更新で照合してください。',true));}
 const id=sessionStorage.getItem('exam-application-id');if(id&&!pending){try{state=await api('/api/demo/applications/'+id);message('保存中の申請をサーバーから再取得しました。');}catch(e){if(e.code==='NOT_FOUND'){sessionStorage.removeItem('exam-application-id');message('前回の申請は取得できません。Memory終了後は失われます。新しく開始してください。');}else message(e.message||'状態を確認できません。',true);}}render();})().catch(e=>message(e.message||'サーバーに接続できません。',true));
