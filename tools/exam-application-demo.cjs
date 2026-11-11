'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {ExamApplication,DemoError,principal}=require('../demo/exam-application/application.cjs');
const {readBody}=require('../gui/http-input');
const publicFiles={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const messages={INVALID_ARGUMENT:'入力の形式を確認してください。',INVALID_DATE:'存在する日付を入力してください。',INVALID_COMMAND_ID:'操作IDが不正です。',UNAUTHENTICATED:'合成ユーザーを選択してください。',FORBIDDEN:'この合成ユーザーには操作権限がありません。',NOT_FOUND:'申請または操作が見つかりません。Memory再起動後は状態が失われます。',SESSION_CHANGED:'サーバーが再起動しました。ページを再読み込みしてください。',STATE_CONFLICT:'現在の状態では操作できません。',STALE_STATE:'画面の状態が古くなっています。履歴を更新してください。',INVALID_OPERATION:'現在の工程ではこの操作はできません。',COMMAND_CONFLICT:'同じ操作IDに異なる入力は指定できません。',EXECUTION_BUSY:'処理中です。状態を取得してから操作してください。',OUTCOME_UNKNOWN:'結果確認が必要です。自動再送せず、状態と操作履歴を確認してください。',WORKFLOW_FAILED:'Workflow実行が失敗しました。追加操作を停止しました。',EXECUTION_LIMIT:'デモの履歴上限に達しました。新しい申請を使用してください。',SHUTTING_DOWN:'サーバーを終了しています。',INTERNAL:'処理を完了できませんでした。',HTTP_INPUT:'JSON本文・文字コード・サイズを確認してください。',ORIGIN_REJECTED:'同じローカル画面から操作してください。'};
Object.assign(messages,{CLAIM_BUSY:'別サーバーがこの申請を処理しています。状態を更新してください。',FENCED:'実行所有権が変わったため保存を拒否しました。',LEASE_EXPIRED:'実行Leaseが失効しました。自動再実行しません。',ADMINISTRATIVE_TAKEOVER_REQUIRED:'期限切れ所有権の管理確認が必要です。自動Takeoverは行いません。',STORAGE_UNAVAILABLE:'Emulatorの保存状態を取得できません。接続を確認してください。',NOT_ACCEPTED:'保存受付前に処理を中止しました。操作は確定していません。',SAVED_STATE_INVALID:'保存状態の整合性を確認できないため停止しました。'});
async function startDemo({storage,port=3020,application,emulatorConfig,afterOperationResponse}={}){
 if(!['memory','emulator'].includes(storage))throw new DemoError('EXPLICIT_MEMORY_REQUIRED');
 if(storage==='emulator'&&!emulatorConfig&&!application)throw new DemoError('EXPLICIT_MEMORY_REQUIRED');
 if(!Number.isInteger(port)||port<0||port>65535)throw new DemoError('INVALID_PORT');
 const app=application||(storage==='memory'?new ExamApplication():await require('../src/adapters/workflow-firestore/exam-application.cjs').createFirestoreExamApplication(emulatorConfig||{}));
 const server=http.createServer(async(req,res)=>{
  const respond=(status,value)=>{if(res.destroyed)return;res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
  try{
   const host=`127.0.0.1:${server.address().port}`,origin=`http://${host}`;
   if(req.headers.host!==host||(req.headers.origin&&req.headers.origin!==origin)||(req.method==='POST'&&req.headers.origin!==origin))throw new DemoError('ORIGIN_REJECTED',403);
   const url=new URL(req.url,origin),pathname=url.pathname;
   if(url.search)throw new DemoError('INVALID_ARGUMENT');
   if(req.method==='GET'&&publicFiles[pathname]){
    const [name,type]=publicFiles[pathname],body=fs.readFileSync(path.join(__dirname,'../demo/exam-application',name));
    res.writeHead(200,{'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(body);return;
   }
   if(req.method==='GET'&&pathname==='/api/demo/config'){respond(200,{ok:true,value:app.config()});return;}
   const p=principal(req.headers.authorization);
   const startLookup=/^\/api\/demo\/commands\/([0-9a-f-]{36})$/.exec(pathname);
   if(req.method==='GET'&&startLookup){respond(200,{ok:true,value:await app.lookupStart(startLookup[1],p)});return;}
   if(req.method==='POST'&&pathname==='/api/demo/applications'){
    const body=await readBody(req),result=await app.start(body,p);if(afterOperationResponse)await afterOperationResponse({req,res,result});respond(result.replayed?200:201,{ok:true,value:result});return;
   }
   const match=/^\/api\/demo\/applications\/(DEMO-[0-9a-f]{24})(?:\/(commands|history)(?:\/([0-9a-f-]{36}))?)?$/.exec(pathname);
   if(!match)throw new DemoError('NOT_FOUND',404);
   const [,id,route,commandId]=match;
   if(req.method==='GET'&&!route){respond(200,{ok:true,value:await app.get(id,p)});return;}
   if(req.method==='GET'&&route==='history'&&!commandId){const state=await app.get(id,p);respond(200,{ok:true,value:{history:state.history,operations:state.operations}});return;}
   if(req.method==='GET'&&route==='commands'&&commandId){respond(200,{ok:true,value:await app.lookupCommand(id,commandId,p)});return;}
   if(req.method==='POST'&&route==='commands'&&!commandId){const body=await readBody(req),result=await app.command(id,body,p);if(afterOperationResponse)await afterOperationResponse({req,res,result});respond(result.operation.status==='ACCEPTED'?202:200,{ok:true,value:result});return;}
   throw new DemoError('METHOD_NOT_ALLOWED',405);
  }catch(error){const status=error instanceof DemoError?error.status:([400,413,415].includes(error?.status)?error.status:500);const code=error instanceof DemoError?error.code:(status===500?'INTERNAL':'HTTP_INPUT');respond(status,{ok:false,error:{code,message:messages[code]||'要求を処理できません。'}});}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}catch(e){await app.close();throw e;}
 let closing;
 const close=()=>closing||(closing=(async()=>{app.closing=true;const stopped=new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));await app.close();server.closeIdleConnections();await stopped;})());
 return {app,server,url:`http://127.0.0.1:${server.address().port}`,close};
}
if(require.main===module){
 const args=process.argv.slice(2),option=name=>args.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
 const storage=option('storage'),port=option('port');
 if(args.some(a=>!/^--(storage|port|project|namespace)=/.test(a))){console.error('引数: --storage=memory|emulator --port=3020 --project=demo-arch026-c2 --namespace=c2-experiment020');process.exitCode=1;}
 else startDemo({storage,port:port===undefined?3020:Number(port),emulatorConfig:storage==='emulator'?{FIRESTORE_EMULATOR_HOST:process.env.FIRESTORE_EMULATOR_HOST,projectId:option('project')||'demo-arch026-c2',namespace:option('namespace')||'c2-experiment020'}:undefined}).then(d=>{
  console.log('審査申請Workflowデモ: '+d.url+'\n永続化: '+d.app.config().storage+'（明示選択）\nEmulator使用: '+d.app.config().emulator+'\n注意: '+d.app.config().warning+'\n終了: Ctrl+C');
  let stop=false;const shutdown=()=>{if(stop)return;stop=true;d.close().then(()=>{console.log('HTTP受付・処理を終了しました。');},()=>{console.error('終了状態を確認してください。');process.exitCode=1;});};
  process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
 }).catch(()=>{console.error('起動できません。明示storageとEmulator専用設定を確認してください。Memoryへの自動fallbackはありません。');process.exitCode=1;});
}
module.exports={startDemo};
