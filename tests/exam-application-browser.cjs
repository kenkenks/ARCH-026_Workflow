'use strict';
// Real installed Chromium browser + native Node CDP/WebSocket. No extra package.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {startDemo}=require('../tools/exam-application-demo.cjs');
async function run({storage='memory',emulatorConfig}={}){
 const executable=process.env.ARCH026_BROWSER_EXE||['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p=>fs.existsSync(p));
 if(!executable)throw Error('Installed Chromium browser required; not a skipped PASS');
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-browser-'));let demo=await startDemo({storage,emulatorConfig,port:0});
 let browser,ws;const pending=new Map();let sequence=0;
 try{
  browser=spawn(executable,['--headless=new','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-component-update','--disable-sync','--metrics-recording-only','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1','about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  const endpoint=await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Browser CDP startup timeout')),20000);let stderr='';browser.stderr.on('data',chunk=>{stderr+=chunk;const match=/DevTools listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(stderr);if(match){clearTimeout(timeout);resolve(match[1]);}});browser.once('error',reject);browser.once('exit',()=>reject(Error('Browser exited before CDP')));});
  ws=new WebSocket(endpoint);await once(ws,'open');
  ws.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timeout);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}});
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++sequence,timeout=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout '+method));},15000);pending.set(id,{resolve,reject,timeout});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  console.log('Browser: '+(await call('Browser.getVersion')).product);
  const {targetId}=await call('Target.createTarget',{url:'about:blank'});const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  await call('Network.enable',{},sessionId);await call('Network.setBlockedURLs',{urls:['https://*','http://*.com/*','http://*.net/*']},sessionId);
  await call('Page.enable',{},sessionId);await call('Emulation.setDeviceMetricsOverride',{width:1280,height:1100,deviceScaleFactor:1,mobile:false},sessionId);await call('Page.navigate',{url:demo.url},sessionId);
  const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);if(r.exceptionDetails)throw Error('Browser evaluation failed');return r.result.value;};
  const wait=async expression=>{const until=Date.now()+15000;while(Date.now()<until){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,40));}throw Error('Browser condition timeout: '+expression);};
  const click=async id=>{assert.equal(await evaluate(`document.getElementById(${JSON.stringify(id)}).disabled`),false,`${id} must be enabled`);await evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);};
  const set=async(id,value)=>evaluate(`document.getElementById(${JSON.stringify(id)}).value=${JSON.stringify(value)}`);
  const stage=async text=>{await wait(`document.getElementById('stage').textContent===${JSON.stringify(text)} && !document.getElementById('actor').disabled`);};
  const serverState=async()=>{const id=await evaluate("document.getElementById('application-id').textContent");const response=await fetch(`${demo.url}/api/demo/applications/${id}`,{headers:{authorization:'Bearer demo-admin'}});assert.equal(response.status,200);return (await response.json()).value;};
  await wait("document.getElementById('member').options.length===3");assert.match(await evaluate("document.getElementById('storage-warning').textContent"),storage==='memory'?/全データ消失/:/Firestore Emulator/);
  await set('actor','demo-admin');await evaluate("document.getElementById('actor').dispatchEvent(new Event('change'))");
  await click('start');await stage('先生承認待ち');let s=await serverState();assert.equal(s.history.length,1);assert.equal(s.jobs.length,1);console.log('B01 PASS: real Browser start -> native Job and HTTP state');
  for(let i=0;i<2;i++){
   await set('reason','ブラウザ確認 '+i);await click('return');await stage('再申請待ち');s=await serverState();assert.equal(s.history.filter(h=>h.result==='FALSE').length,i+1);assert.equal(s.review.reason,'ブラウザ確認 '+i);
   await set('note','確認済み '+i);await click('resubmit');await stage('先生承認待ち');
  }
  s=await serverState();assert.equal(s.operations.length,5);assert.equal(s.history.at(-1).nextStepNo,20);console.log('B02 PASS: two return/resubmit loops, FALSE traces retained');
  await click('approve');await stage('審査待ち');s=await serverState();assert.equal(s.history.at(-1).result,'TRUE');
  await set('exam-date','2028-02-29');await click('confirm');await stage('結果登録待ち');await set('result','FAIL');await set('score','45');await click('register');await stage('結果登録済み');
  s=await serverState();assert.equal(s.workflowStatus,'COMPLETED');assert.equal(s.result.result,'FAIL');assert.equal(s.result.score,45);assert.equal(s.operations.length,8);console.log('B03 PASS: approval, exam, business FAIL result -> real END');
  const before=structuredClone(s);await call('Page.reload',{},sessionId);await stage('結果登録済み');s=await serverState();assert.deepEqual(s.history,before.history);assert.deepEqual(s.jobs,before.jobs);assert.equal(await evaluate("document.querySelectorAll('#operations tr').length"),8);assert.equal(await evaluate("document.getElementById('result').value"),'FAIL');assert.equal(await evaluate("document.getElementById('score').value"),'45');console.log('B04 PASS: page reload reads HTTP state without extra execution');
  fs.mkdirSync('runtime-data',{recursive:true});let shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},sessionId);fs.writeFileSync('runtime-data/experiment020'+(storage==='emulator'?'b':'')+'-desktop.png',Buffer.from(shot.data,'base64'));
  await click('start');await stage('先生承認待ち');await click('approve');await stage('審査待ち');await click('confirm');await stage('結果登録待ち');await set('result','PASS');await set('score','85');await click('register');await stage('結果登録済み');s=await serverState();assert.equal(s.result.result,'PASS');assert.equal(s.history.length,6);console.log('B05 PASS: independent second Browser application, PASS output');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true},sessionId);await wait('document.documentElement.clientWidth===390');assert.ok(await evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth'));
  shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true},sessionId);fs.writeFileSync('runtime-data/experiment020'+(storage==='emulator'?'b':'')+'-mobile.png',Buffer.from(shot.data,'base64'));console.log('B06 PASS: mobile viewport, no horizontal document overflow');
  const port=Number(new URL(demo.url).port),savedId=s.applicationId;await demo.close();demo=await startDemo({storage,emulatorConfig,port});await call('Page.reload',{},sessionId);
  if(storage==='memory'){
   await wait("document.getElementById('message').textContent.includes('失われます') && document.getElementById('member').options.length===3");
   assert.equal(await evaluate("document.getElementById('application-id').textContent"),'—');await click('start');await stage('先生承認待ち');assert.equal((await serverState()).history.length,1);console.log('B07 PASS: fresh Memory Host loses old state; Browser re-queries and starts explicitly');
  }else{
   await stage('結果登録済み');assert.equal((await serverState()).applicationId,savedId);assert.equal((await serverState()).history.length,6);console.log('B07 PASS: fresh Emulator Host restores same application, state and history');
   await click('start');await stage('先生承認待ち');const waiting=await serverState();await demo.close();demo=await startDemo({storage,emulatorConfig,port});await call('Page.reload',{},sessionId);await stage('先生承認待ち');
   assert.equal((await serverState()).applicationId,waiting.applicationId);assert.deepEqual((await serverState()).jobs,waiting.jobs);await click('approve');await stage('審査待ち');assert.equal((await serverState()).history.at(-1).result,'TRUE');console.log('B08 PASS: restored approval gate accepts next Browser action without rerunning initial Job');
  }
  console.log('Browser checks: '+(storage==='emulator'?8:7)+' PASS / 0 FAIL');
  await call('Browser.close');
 }finally{
  if(ws)ws.close();for(const p of pending.values()){clearTimeout(p.timeout);p.reject(Error('Browser closed'));}pending.clear();
  if(browser&&browser.exitCode===null){const exited=once(browser,'exit');browser.kill();await Promise.race([exited,new Promise(r=>setTimeout(r,3000))]);}
  await demo.close();
  if(storage==='emulator'&&/^c2-browser-[a-z0-9-]+$/.test(emulatorConfig.namespace)){const c=await require('../src/adapters/workflow-firestore/emulator.cjs').connectEmulator(emulatorConfig);try{await c.db.recursiveDelete(c.root);}finally{await c.close();}}
  // Only this test-created dedicated profile, never the user's browser profile.
  if(path.dirname(path.resolve(profile))===path.resolve(os.tmpdir())){try{fs.rmSync(profile,{recursive:true,force:true});}catch{/* browser child process may still release files */}}
 }
}
if(require.main===module)run(process.argv.includes('--storage=emulator')?{storage:'emulator',emulatorConfig:{FIRESTORE_EMULATOR_HOST:process.env.FIRESTORE_EMULATOR_HOST,projectId:'demo-arch026-c2',namespace:process.argv.find(a=>a.startsWith('--namespace='))?.slice(12)||'c2-browser-'+require('node:crypto').randomUUID()}}:{}).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run};
