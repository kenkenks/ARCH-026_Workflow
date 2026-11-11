'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),net=require('node:net');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {build}=require('./package-workflow-unit.cjs');
const root=path.resolve(__dirname,'..'),sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
async function run(){
 const packed=build(),old=path.join(root,'runtime-data/workflow-unit/arch026-workflow-unit-0.1.0-experiment.021.1.tgz');
 if(sha(old)!=='e7f97e55ed2da17adf32cb7358df39c816ed7e929ea4c7dee1b87d0aafda34c4')throw Error('OLD_UNIT_MISMATCH_STOP');
 const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-unit-release-')),evidence={sandbox,version:packed.record.version,filename:packed.record.filename,sha256:packed.record.sha256,bytes:fs.statSync(packed.archive).size};
 if(path.dirname(path.resolve(sandbox))!==path.resolve(os.tmpdir())||path.resolve(sandbox,'node_modules')===path.resolve(sandbox))throw Error('ISOLATED_DIRECTORY_REQUIRED');
 fs.mkdirSync(path.join(sandbox,'vendor'));fs.mkdirSync(path.join(sandbox,'tests'));
 for(const file of [packed.archive,old])fs.copyFileSync(file,path.join(sandbox,'vendor',path.basename(file)));
 fs.writeFileSync(path.join(sandbox,'release-record.json'),JSON.stringify(packed.record,null,2));
 fs.writeFileSync(path.join(sandbox,'package.json'),JSON.stringify({name:'arch026-isolated-release-test',version:'0.0.0',private:true,dependencies:{'@arch026/workflow-unit':'file:vendor/'+path.basename(packed.archive),'@arch026/workflow-unit-old':'file:vendor/'+path.basename(old)},devDependencies:{typescript:'5.9.3'}},null,2));
 for(const file of ['public.test.cjs','scenario.cjs','child.cjs'])fs.copyFileSync(path.join(root,'tests/unit-release',file),path.join(sandbox,'tests',file));
 fs.copyFileSync(path.join(root,'tests/unit-release/consumer.ts'),path.join(sandbox,'consumer.ts'));
 fs.writeFileSync(path.join(sandbox,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'NodeNext',moduleResolution:'NodeNext',strict:true,noEmit:true,skipLibCheck:false,esModuleInterop:true},files:['consumer.ts']},null,2));
 const env={...process.env,UNIT_FORBIDDEN_SOURCE_ROOT:root};for(const key of ['NODE_PATH','NODE_OPTIONS','INIT_CWD','npm_config_local_prefix','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GCLOUD_PROJECT','FIREBASE_CONFIG'])delete env[key];
 const execute=async(args,file)=>{const out=fs.openSync(path.join(sandbox,file),'w');try{const child=spawn(process.execPath,args,{cwd:sandbox,env,windowsHide:true,stdio:['ignore',out,out]});const [code]=await once(child,'exit');if(code!==0){console.error(fs.readFileSync(path.join(sandbox,file),'utf8').slice(-14000));throw Error('ISOLATED_CHECK_FAILED_STOP: '+file);}return code;}finally{fs.closeSync(out);}};
 const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');let emulator,emulatorLog,stopped=false;
 async function stop(){if(stopped)return;stopped=true;if(emulator&&emulator.exitCode===null){const done=once(emulator,'exit');emulator.kill();await done;}if(emulatorLog!==undefined)fs.closeSync(emulatorLog);}
 try{
  console.log('Independent sandbox: '+sandbox);
  await execute([npm,'install','--offline','--ignore-scripts','--no-audit','--no-fund'],'install.log');
  // npm ci affects only this newly-created sandbox/node_modules.
  await execute([npm,'ci','--offline','--ignore-scripts','--no-audit','--no-fund'],'ci.log');
  evidence.lockSha256=sha(path.join(sandbox,'package-lock.json'));
  await execute(['--test','--test-concurrency=1','--test-name-pattern=^P0[1-8]','tests/public.test.cjs'],'smoke.log');
  console.log('Installed package smoke/type checks PASS');
  const jar=process.env.ARCH026_FIRESTORE_EMULATOR_JAR||path.join(os.homedir(),'.cache/firebase/emulators/cloud-firestore-emulator-v1.21.0.jar');
  if(!fs.existsSync(jar))throw Error('EMULATOR_UNAVAILABLE_TESTS_NOT_RUN');
  const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});env.FIRESTORE_EMULATOR_HOST='127.0.0.1:'+port;
  emulatorLog=fs.openSync(path.join(sandbox,'emulator.log'),'w');emulator=spawn('java',['-jar',jar,'--host','127.0.0.1','--port',String(port),'--project_id','demo-arch026-c2','--single_project_mode','true','--single_project_mode_error','true'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{let ready='';const timer=setTimeout(()=>reject(Error('Emulator startup timeout')),20000),data=b=>{fs.writeSync(emulatorLog,b);ready+=b.toString();if(ready.includes('Dev App Server is now running')){clearTimeout(timer);resolve();}};emulator.stdout.on('data',data);emulator.stderr.on('data',data);emulator.once('error',reject);emulator.once('exit',()=>{clearTimeout(timer);reject(Error('Emulator exited'));});});
  await execute(['--test','--test-concurrency=1','tests/public.test.cjs'],'tests.log');
  evidence.status='PASS';console.log(fs.readFileSync(path.join(sandbox,'tests.log'),'utf8').slice(-1600));
 }catch(e){evidence.status='BLOCKED';evidence.failure=e.message;throw e;}finally{
  await stop();if(sha(old)!=='e7f97e55ed2da17adf32cb7358df39c816ed7e929ea4c7dee1b87d0aafda34c4')throw Error('OLD_UNIT_CHANGED_STOP');
  evidence.emulatorStopped=true;const file=path.join(root,'runtime-data','unit-release-evidence-'+Date.now()+'.json');fs.writeFileSync(file,JSON.stringify(evidence,null,2)+'\n');console.log('Evidence: '+file);
 }
 return evidence;
}
if(require.main===module)run().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={run};
