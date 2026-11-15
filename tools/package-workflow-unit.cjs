'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),version='0.3.0-framework.13',name='@arch026/workflow-unit';
const api={workflow:['WorkflowValidationError','CWorkflowTask','CJob','CDummyJob','CCheckJob','CSequenceBool','WorkflowRunError','WorkflowExecutionOwnershipError','CMemoryHistoryStore','CWorkflow','CWorkflowMonitor'],
 'job-form':['createMemoryProductShelf','bindJobForm'],definition:['DEFINITION_SCHEMA_VERSION','WAITING_DEFINITION_SCHEMA_VERSION','ARTIFACT_DEFINITION_SCHEMA_VERSION','DefinitionError','validateDefinitionKey','validatePrototypeDefinition','reconstructWorkflow','loadWorkflow','restoreWorkflowCheckpoint'],diagnosis:['diagnoseSavedRun']};
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function execute(exe,args,cwd=root){const r=cp.spawnSync(exe,args,{cwd,encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error(r.stderr||r.stdout||'command failed');return r.stdout;}
function build(output=path.join(root,'runtime-data/workflow-unit')){
 execute(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p','tsconfig.workflow-unit.json']);
 const stage=fs.mkdtempSync(path.join(root,'runtime-data/workflow-unit-stage-')),files=[],sources={};
 const put=(p,bytes)=>{fs.mkdirSync(path.dirname(path.join(stage,p)),{recursive:true});fs.writeFileSync(path.join(stage,p),bytes);files.push(p);};
 for(const base of ['workflow','job-form','definition','diagnosis']){
  const src=`src/prototype/${base}.ts`;sources[src]=digest(fs.readFileSync(path.join(root,src)));
  for(const ext of ['js','d.ts'])put(`dist/src/prototype/${base}.${ext}`,fs.readFileSync(path.join(root,`runtime-data/workflow-unit-build/src/prototype/${base}.${ext}`)));
 }
 // Prototype paths are compatibility entries; include their canonical Unit implementation.
 for(const base of ['CWorkflow','CJobForm','ArtifactManager','ArtifactSnapshot','Definition','WorkflowRegistry','WorkflowBuilder']){
  const src=`Frwk_Units/Workflow/src/${base}.ts`;sources[src]=digest(fs.readFileSync(path.join(root,src)));
  for(const ext of ['js','d.ts'])put(`dist/Frwk_Units/Workflow/src/${base}.${ext}`,fs.readFileSync(path.join(root,`runtime-data/workflow-unit-build/Frwk_Units/Workflow/src/${base}.${ext}`)));
 }
 for(const base of ['emulator','store','composition','waiting']){const p=`src/adapters/workflow-firestore/${base}.cjs`,bytes=fs.readFileSync(path.join(root,p));put(p,bytes);sources[p]=digest(bytes);}
 const waiting='src/adapters/workflow-waiting/lifecycle.cjs',waitingBytes=fs.readFileSync(path.join(root,waiting));put(waiting,waitingBytes);sources[waiting]=digest(waitingBytes);
 for(const base of ['waiting','firestore'])for(const ext of ['cjs','d.ts']){const p=`tools/workflow-unit/${base}.${ext}`,bytes=fs.readFileSync(path.join(root,p));put(`${base}.${ext}`,bytes);sources[p]=digest(bytes);}
 put('index.cjs',Buffer.from("'use strict';\n"+Object.entries(api).map(([file,names],i)=>`const m${i}=require('./dist/src/prototype/${file}');\n`+names.map(n=>`exports.${n}=m${i}.${n};`).join('\n')).join('\n')+'\n'));
 put('index.d.ts',Buffer.from("export * from './dist/src/prototype/workflow';\nexport * from './dist/src/prototype/job-form';\nexport * from './dist/src/prototype/definition';\nexport * from './dist/src/prototype/diagnosis';\n"));
 put('package.json',Buffer.from(JSON.stringify({name,version,private:true,main:'index.cjs',types:'index.d.ts',engines:{node:'>=24 <25'},exports:{'.':{types:'./index.d.ts',require:'./index.cjs',default:'./index.cjs'},'./waiting':{types:'./waiting.d.ts',require:'./waiting.cjs',default:'./waiting.cjs'},'./firestore':{types:'./firestore.d.ts',require:'./firestore.cjs',default:'./firestore.cjs'},'./manifest':'./unit-manifest.json'},dependencies:{'@google-cloud/firestore':'9.3.1'}},null,2)+'\n'));
 const manifest={name,version,source:'ARCH-026_Workflow',sourceHead:execute('git',['rev-parse','HEAD']).trim(),publicApi:{root:Object.values(api).flat(),waiting:['MemoryWaitingStore'],firestore:['connectEmulator','validateEnvironment','leaseValid','PersistenceError','fail','Timestamp','FieldValue','FirestoreExperimentStore','hash','createExecution','FirestoreWaitingStore']},sources,files:Object.fromEntries(files.sort().map(p=>[p,digest(fs.readFileSync(path.join(stage,p)))]))};
 const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(stage,'unit-manifest.json'),manifestBytes);
 // npm's CLI is JS; no shell interpolation or registry publication.
 const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
 const packed=JSON.parse(execute(process.execPath,[npm,'pack','--ignore-scripts','--json'],stage))[0];const archive=fs.readFileSync(path.join(stage,packed.filename));
 fs.mkdirSync(output,{recursive:true});const target=path.join(output,packed.filename),sha256=digest(archive);
 if(fs.existsSync(target)&&digest(fs.readFileSync(target))!==sha256)throw Error('IMMUTABLE_VERSION_CHANGED: choose a new Unit version');
 fs.writeFileSync(target,archive);const record={name,version,filename:packed.filename,sha256,manifestSha256:digest(manifestBytes),files:manifest.files};
 fs.writeFileSync(target+'.json',JSON.stringify(record,null,2)+'\n');
 // Remove only this generated stage under the verified runtime-data workspace.
 if(!path.resolve(stage).startsWith(path.join(root,'runtime-data')+path.sep))throw Error('unsafe stage');fs.rmSync(stage,{recursive:true,force:true});
 return {archive:target,record};
}
if(require.main===module){try{console.log(JSON.stringify(build(process.argv[2]?path.resolve(process.argv[2]):undefined),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={build};
