'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {build}=require('../tools/package-workflow-unit.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
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
