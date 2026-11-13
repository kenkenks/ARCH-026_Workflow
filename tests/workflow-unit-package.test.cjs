'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {build}=require('../tools/package-workflow-unit.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('a separate process with only a saved snapshot cannot resume missing Memory artifacts',async()=>{
 const cp=require('node:child_process'),api=require('../Frwk_Units/Workflow'),unit=path.resolve(__dirname,'../Frwk_Units/Workflow');
 class Form extends api.CJobForm{collect(){return 10;}make(n){return n;}}
 const d={schemaVersion:api.ARTIFACT_DEFINITION_SCHEMA_VERSION,definitionId:'restart',definitionVersion:'1',startStepId:'p',artifactBoxes:['review'],steps:[{stepId:'p',stepNo:10,kind:'JOB',jobId:'p',output:{box:'review'},nextStepId:'q'},{stepId:'q',stepNo:20,kind:'JOB',jobId:'q'}]},r={jobs:new Map(),checks:new Map(),nativeForms:new Map(['p','q'].map(id=>[id,{form:new Form(id),artifactKey:'X'}]))};
 const g=api.reconstructWorkflow(d,r,new api.CMemoryHistoryStore()),saved=await g.workflow.run('restart',10,1);
 const code=`const a=require('./');class F extends a.CJobForm{}const d=${JSON.stringify(d)},s=${JSON.stringify(saved)},store=new a.CMemoryHistoryStore();store.save(s);const r={jobs:new Map(),checks:new Map(),nativeForms:new Map(['p','q'].map(id=>[id,{form:new F(id),artifactKey:'X'}]))};a.reconstructWorkflow(d,r,store).workflow.resume(s).then(()=>process.exitCode=1,e=>{if(e.code!=='ARTIFACT_RESTORE_UNSUPPORTED')process.exitCode=1;});`;
 const result=cp.spawnSync(process.execPath,['-e',code],{cwd:unit,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
});
test('formal package exposes typed Memory artifact contracts without checkout source',()=>{
 const os=require('node:os'),cp=require('node:child_process'),root=path.resolve(__dirname,'..'),parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'workflow-artifact-package-'));
 try{
  const npmCli=process.env.npm_execpath||path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
  const packed=cp.spawnSync(process.execPath,[npmCli,'pack',path.join(root,'Frwk_Units/Workflow'),'--ignore-scripts','--offline','--pack-destination',dir],{encoding:'utf8',windowsHide:true});assert.equal(packed.status,0,packed.stderr);
  const archive=fs.readdirSync(dir).find(p=>p.endsWith('.tgz'));assert.ok(archive);
  const extracted=cp.spawnSync('tar',['-xf',path.join(dir,archive),'-C',dir],{encoding:'utf8',windowsHide:true});assert.equal(extracted.status,0,extracted.stderr);
  const code=`const a=require('./package');class Form extends a.CJobForm{collect(){return 42;}make(v){return v;}}const d={schemaVersion:a.ARTIFACT_DEFINITION_SCHEMA_VERSION,definitionId:'pack',definitionVersion:'1',startStepId:'p',artifactBoxes:['review'],steps:[{stepId:'p',stepNo:1,kind:'JOB',jobId:'p',output:{box:'review'}}]};const g=a.reconstructWorkflow(d,{jobs:new Map(),checks:new Map(),nativeForms:new Map([['p',{form:new Form('p'),artifactKey:'X'}]])},new a.CMemoryHistoryStore());g.workflow.run('pack',1).then(r=>{require('node:assert/strict').equal(r.status,'COMPLETED');require('node:assert/strict').equal(g.artifacts.reader('review').get('X'),42);require('node:assert/strict').equal(g.artifacts.reader().has('X'),false);}).catch(e=>{console.error(e);process.exitCode=1;});`;
  const result=cp.spawnSync(process.execPath,['-e',code],{cwd:dir,encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);
  fs.writeFileSync(path.join(dir,'consumer.ts'),`import {ArtifactManager,ArtifactReadPort,ExecutionContext,CJobForm,ARTIFACT_DEFINITION_SCHEMA_VERSION} from './package';const manager=new ArtifactManager(['review']);const port:ArtifactReadPort=manager.readPort();const value:unknown=port.box('review').get('X');class Form extends CJobForm<number,number>{protected collect(_p:unknown,c:ExecutionContext):number{return Number(c.artifacts?.box('review').get('X'));}protected make(n:number):number{return n;}}void new Form('p');void value;void ARTIFACT_DEFINITION_SCHEMA_VERSION;`);
  fs.writeFileSync(path.join(dir,'tsconfig.json'),JSON.stringify({compilerOptions:{strict:true,noEmit:true,target:'ES2022',module:'commonjs',types:[]},files:['consumer.ts']}));
  const typed=cp.spawnSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p',path.join(dir,'tsconfig.json')],{encoding:'utf8',windowsHide:true});assert.equal(typed.status,0,typed.stdout+typed.stderr);
 }finally{if(path.dirname(path.resolve(dir))!==parent||!path.basename(dir).startsWith('workflow-artifact-package-'))throw Error('UNSAFE_PACKAGE_FIXTURE');fs.rmSync(dir,{recursive:true,force:true});}
});
test('Unit whitelist uses byte-identical current Core/Adapter and contains no SQLite runtime',()=>{const {record}=build();for(const name of ['workflow','job-form','definition','diagnosis'])assert.equal(record.files[`dist/src/prototype/${name}.js`],sha(fs.readFileSync(path.join(__dirname,`../dist/src/prototype/${name}.js`))));
 for(const name of ['emulator','store','composition'])assert.equal(record.files[`src/adapters/workflow-firestore/${name}.cjs`],sha(fs.readFileSync(path.join(__dirname,`../src/adapters/workflow-firestore/${name}.cjs`))));assert.ok(!Object.keys(record.files).some(p=>/sqlite|simpledb|demo|engine\.js/i.test(p)));});
test('same sources rebuild the same immutable package SHA-256',()=>{assert.equal(build().record.sha256,build().record.sha256);});
test('package compiled modules exist in a clean build without obsolete Prototype Port declarations',()=>{
 const os=require('node:os'),cp=require('node:child_process'),parent=fs.realpathSync(os.tmpdir()),dir=fs.mkdtempSync(path.join(parent,'workflow-builder-clean-'));
 try{
  const root=path.resolve(__dirname,'..'),result=cp.spawnSync(process.execPath,[path.join(root,'node_modules/typescript/bin/tsc'),'-p',path.join(root,'tsconfig.workflow-unit.json'),'--outDir',dir],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stdout+result.stderr);
  const {record}=build();for(const file of Object.keys(record.files).filter(p=>p.startsWith('dist/')))assert.equal(sha(fs.readFileSync(path.join(dir,file.slice(5)))),record.files[file],file);
  assert.ok(!Object.keys(record.files).some(p=>/dist\/src\/(ports|core)\//.test(p)));
 }finally{if(path.dirname(path.resolve(dir))!==parent||!path.basename(dir).startsWith('workflow-builder-clean-'))throw Error('UNSAFE_PACKAGE_FIXTURE');fs.rmSync(dir,{recursive:true,force:true});}
});
test('packaged compatibility Builder includes canonical modules and runs without checkout source',()=>{
 const os=require('node:os'),cp=require('node:child_process'),{archive,record}=build(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-builder-package-'));
 try{
  for(const base of ['Definition','WorkflowRegistry','WorkflowBuilder'])for(const ext of ['js','d.ts'])assert.ok(record.files[`dist/Frwk_Units/Workflow/src/${base}.${ext}`]);
  const extracted=cp.spawnSync('tar',['-xf',archive,'-C',dir],{encoding:'utf8',windowsHide:true});assert.equal(extracted.status,0,extracted.stderr);
  const code=`const a=require('./package');const d={schemaVersion:'prototype-workflow/1',definitionId:'pack',definitionVersion:'1',startStepId:'a',steps:[{stepId:'a',stepNo:1,kind:'JOB',jobId:'a'}]};const g=a.reconstructWorkflow(d,{jobs:new Map([['a',()=>new a.CDummyJob('a')]]),checks:new Map()},new a.CMemoryHistoryStore());g.workflow.run('pack',g.startStepNo).then(r=>{if(r.status!=='COMPLETED')process.exitCode=1;});`;
  const r=cp.spawnSync(process.execPath,['-e',code],{cwd:dir,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);
 }finally{if(!path.basename(dir).startsWith('workflow-builder-package-')||path.dirname(path.resolve(dir))!==fs.realpathSync(os.tmpdir()))throw Error('UNSAFE_PACKAGE_FIXTURE');fs.rmSync(dir,{recursive:true,force:true});}
});
