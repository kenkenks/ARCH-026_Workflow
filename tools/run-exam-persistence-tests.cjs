'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events'),{randomUUID}=require('node:crypto');
async function run(){
 const jar=process.env.ARCH026_FIRESTORE_EMULATOR_JAR||path.join(os.homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.21.0.jar');
 if(!fs.existsSync(jar))throw Error('Firestore Emulator JAR unavailable; dependent tests NOT RUN');
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
 const endpoint='127.0.0.1:'+port;fs.mkdirSync('logs',{recursive:true});const log=fs.openSync(path.join('logs','020b-emulator-'+randomUUID()+'.log'),'w');
 const emulator=spawn('java',['-jar',jar,'--host','127.0.0.1','--port',String(port),'--project_id','demo-arch026-c2','--single_project_mode','true','--single_project_mode_error','true'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stopped=false;const stop=async()=>{if(stopped)return;stopped=true;if(emulator.exitCode===null){const exited=once(emulator,'exit');emulator.kill();await exited;}fs.closeSync(log);};
 const env={...process.env,FIRESTORE_EMULATOR_HOST:endpoint};
 try{
  await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Emulator startup timeout; tests NOT RUN')),20000);let ready='';
   const data=b=>{fs.writeSync(log,b);ready+=b.toString();if(ready.includes('Dev App Server is now running')){clearTimeout(timeout);resolve();}ready=ready.slice(-4000);};emulator.stdout.on('data',data);emulator.stderr.on('data',data);emulator.once('error',reject);emulator.once('exit',()=>{clearTimeout(timeout);reject(Error('Emulator failed; tests NOT RUN'));});
  });
  const probe=await fetch(`http://${endpoint}/emulator/v1/projects/demo-arch026-c2:ruleCoverage`,{signal:AbortSignal.timeout(3000)});if(!probe.ok||!Object.hasOwn(await probe.json(),'rules'))throw Error('Emulator probe failed; tests NOT RUN');
  console.log('Emulator ready (owned child): '+endpoint);
  const execute=async args=>{const child=spawn(process.execPath,args,{windowsHide:true,stdio:'inherit',env});const [code]=await once(child,'exit');if(code!==0)throw Error('Test subprocess failed: '+args.join(' '));};
  if(process.argv.includes('--browser'))await execute(['tests/exam-application-browser.cjs','--storage=emulator','--namespace=c2-browser-'+randomUUID()]);
  else await execute(['--test','--test-concurrency=1',...process.argv.filter(x=>x.startsWith('--test-name-pattern=')),...(process.argv.includes('--waiting-only')?['tests/workflow-firestore-waiting.test.cjs']:process.argv.includes('--c2-only')?['tests/workflow-firestore.test.cjs']:['tests/exam-application-persistence.test.cjs',...(process.argv.includes('--with-c2')?['tests/workflow-firestore.test.cjs']:[]),...(process.argv.includes('--with-waiting')?['tests/workflow-firestore-waiting.test.cjs']:[])])]);
  await stop();
  process.env.FIRESTORE_EMULATOR_HOST=endpoint;
  const {connectEmulator}=require('../src/adapters/workflow-firestore/emulator.cjs');
  let rejected=false;try{await connectEmulator({FIRESTORE_EMULATOR_HOST:endpoint,projectId:'demo-arch026-c2',namespace:'c2-stopped-check'});}catch(e){rejected=e.code==='EMULATOR_UNAVAILABLE';}
  if(!rejected)throw Error('Stopped Emulator was not rejected');console.log('E-stop PASS: stopped Emulator rejected; no Memory/production fallback');
 }finally{await stop();}
}
if(require.main===module)run().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run};
