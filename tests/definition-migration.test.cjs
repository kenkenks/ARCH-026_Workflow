'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {definition,registry}=require('./workflow-definition/fixture.cjs');
const {LocalWorkflowDefinitionRepository}=require('../src/adapters/workflow-definition/local-file.cjs');
const {SimpleDB,STORAGE_SCHEMA,SimpleDBWorkflowDefinitionRepository}=require('../src/adapters/workflow-definition/simpledb.cjs');
const {loadWorkflow,DefinitionError}=require('../dist/src/prototype/definition');
const {CMemoryHistoryStore}=require('../dist/src/prototype/workflow');
const {canonicalDefinition,definitionFingerprint,classifyDefinition,planDefinitionMigration:plan,executeDefinitionMigration:execute}=require('../dist/src/migration/definition');
const manifest=(...versions)=>({manifestVersion:1,definitions:versions.map(definitionVersion=>({definitionId:'saved-example',definitionVersion}))});
const clone=x=>x===null?null:structuredClone(x);
function memory(){const rows=new Map();return {
  rows,adds:0,reads:0,
  async get(id,v){this.reads++;return clone(rows.get(JSON.stringify([id,v]))??null);},
  async add(d){this.adds++;const k=JSON.stringify([d.definitionId,d.definitionVersion]);if(rows.has(k))throw new DefinitionError('DEFINITION_ALREADY_EXISTS');rows.set(k,clone(d));},
  put(d){rows.set(JSON.stringify([d.definitionId,d.definitionVersion]),clone(d));}
};}
async function setup(){const source=memory(),target=memory();source.put(definition());return {source,target,p:await plan(manifest('v1'),source,target,registry())};}
async function temporary(action){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-migration-'));let db;
  try{const file=path.join(dir,'db.sqlite');SimpleDB.initialize(file,STORAGE_SCHEMA);db=SimpleDB.open(file,STORAGE_SCHEMA);await action({dir,json:new LocalWorkflowDefinitionRepository(path.join(dir,'json')),sqlite:new SimpleDBWorkflowDefinitionRepository(db)});}
  finally{db?.close();fs.rmSync(dir,{recursive:true,force:true});}}
for(const direction of ['json-to-sqlite','sqlite-to-json'])test(`${direction}: migration, versions, repeat and execution equivalence`,()=>temporary(async({json,sqlite})=>{
  const [source,target]=direction==='json-to-sqlite'?[json,sqlite]:[sqlite,json];
  for(const v of ['v1','v2'])await source.add(definition(v));
  const p=await plan(manifest('v1','v2'),source,target,registry());assert.deepEqual(p.items.map(x=>x.action),['CREATE','CREATE']);
  assert.match(p.items[0].sourceFingerprint,/^[0-9a-f]{64}$/);
  const result=await execute(p,source,target,registry());assert.equal(result.ok,true);assert.deepEqual(result.items.map(x=>x.status),['CREATED','CREATED']);
  assert.deepEqual(await target.get('saved-example','v1'),definition());assert.deepEqual(await target.get('saved-example','v2'),definition('v2'));
  const repeated=await execute(await plan(manifest('v1','v2'),source,target,registry()),source,target,registry());
  assert.deepEqual(repeated.items.map(x=>x.status),['ALREADY_EQUAL','ALREADY_EQUAL']);assert.equal(repeated.items.some(x=>x.confirmedAdded),false);
  for(const values of [[false,false,true],[true]]){
    const histories=[];
    for(const repo of [source,target]){const r=await loadWorkflow(repo,'saved-example','v1',registry(values),new CMemoryHistoryStore());const run=await r.workflow.run('test',r.startStepNo);assert.equal(run.status,'COMPLETED');histories.push(run.history.map(({stepNo,result,nextStepNo})=>({stepNo,result,nextStepNo})));}
    assert.deepEqual(histories[0],histories[1]);assert.deepEqual(histories[1].filter(x=>x.stepNo===20).map(x=>x.result),values.map(x=>x?'TRUE':'FALSE'));
  }
}));
test('classifier ignores property order, preserves steps order and never invokes factories',async()=>{
  const d=definition(),reverse=x=>Array.isArray(x)?x.map(reverse):x&&typeof x==='object'?Object.fromEntries(Object.entries(x).reverse().map(([k,v])=>[k,reverse(v)])):x;
  const equal=reverse(d),reg=registry();for(const id of reg.jobs.keys())reg.jobs.set(id,()=>{throw Error('must not invoke');});
  const k=manifest('v1').definitions[0];assert.equal(classifyDefinition(d,null,k,reg).action,'CREATE');assert.equal(classifyDefinition(d,equal,k,reg).action,'ALREADY_EQUAL');
  assert.equal(await definitionFingerprint(d),await definitionFingerprint(equal));assert.equal(canonicalDefinition(d),canonicalDefinition(equal));
  const reordered=clone(d);reordered.steps.reverse();assert.equal(classifyDefinition(d,reordered,k,reg).action,'CONFLICT');assert.notEqual(await definitionFingerprint(d),await definitionFingerprint(reordered));
});
test('content conflict writes nothing and preserves target',async()=>{
  const {source,target}=await setup(),other=definition();other.steps[0].jobId='sample.finish';target.put(other);
  const p=await plan(manifest('v1'),source,target,registry());assert.equal(p.items[0].action,'CONFLICT');
  const result=await execute(p,source,target,registry());assert.equal(result.ok,false);assert.equal(result.items[0].status,'CONFLICT');assert.equal(target.adds,0);assert.deepEqual(await target.get('saved-example','v1'),other);
});
test('duplicate and malformed manifest fail before Repository access',async()=>{
  const source=memory(),target=memory();
  await assert.rejects(plan(manifest('v1','v1'),source,target,registry()),{code:'DUPLICATE_MANIFEST_TARGET'});
  await assert.rejects(plan({manifestVersion:2,definitions:[]},source,target,registry()),{code:'INVALID_MANIFEST'});
  assert.equal(source.reads+target.reads+target.adds,0);
});
test('missing source, invalid schema and wrong source identity are rejected',async()=>{
  for(const [d,code]of [[null,'DEFINITION_NOT_FOUND'],[{...definition(),schemaVersion:'bad'},'SCHEMA_MISMATCH'],[{...definition(),definitionId:'other'},'DEFINITION_IDENTITY_MISMATCH']]){
    const source={get:async()=>d},target=memory(),p=await plan(manifest('v1'),source,target,registry());
    assert.equal(p.items[0].action,'REJECT');assert.equal(p.items[0].reason,code);assert.equal((await execute(p,source,target,registry())).items[0].status,'REJECT');assert.equal(target.adds,0);
  }
});
test('unknown Job/Check and invalid factory results stop before publication',async()=>{
  for(const kind of ['job','check','factory']){
    const {source,target}=await setup(),reg=registry();
    if(kind==='job')reg.jobs.delete('sample.work');else if(kind==='check')reg.checks.delete('sample.sequence');else reg.jobs.set('sample.work',()=>({}));
    const p=await plan(manifest('v1'),source,target,reg),r=await execute(p,source,target,reg);
    if(kind!=='factory'){assert.equal(p.items[0].action,'REJECT');assert.equal(p.items[0].reason,kind==='job'?'UNSUPPORTED_JOB':'UNSUPPORTED_CHECK');}
    else assert.equal(r.items[0].reason,'INVALID_JOB_FACTORY');
    assert.equal(r.ok,false);assert.equal(target.adds,0);
  }
});
test('Dry Run is read-only and produces displayable plan',async()=>{
  const {source,target}=await setup();target.add=()=>{throw Error('write forbidden');};
  const p=await plan(manifest('v1'),source,target,registry());assert.equal(JSON.parse(JSON.stringify(p)).items[0].action,'CREATE');assert.equal(target.adds,0);assert.equal(await target.get('saved-example','v1'),null);
});
test('source change after planning stops before write',async()=>{
  const {source,target,p}=await setup(),changed=definition();changed.steps[0].jobId='sample.finish';source.put(changed);
  const r=await execute(p,source,target,registry());assert.equal(r.items[0].status,'SOURCE_CHANGED');assert.equal(target.adds,0);
});
test('destination changes are reclassified: equal, conflict, removed',async()=>{
  for(const state of ['equal','conflict','removed']){
    const {source,target}=await setup();if(state==='removed')target.put(definition());
    const p=await plan(manifest('v1'),source,target,registry());
    if(state==='removed')target.rows.clear();else{const d=definition();if(state==='conflict')d.steps[0].jobId='sample.finish';target.put(d);}
    const r=await execute(p,source,target,registry());assert.equal(r.items[0].status,{equal:'ALREADY_EQUAL',conflict:'CONFLICT',removed:'CREATED'}[state]);assert.equal(target.adds,state==='removed'?1:0);
  }
});
test('duplicate during Add is reconciled without a retry',async()=>{
  for(const changed of [false,true]){
    const {source,target,p}=await setup();target.add=async d=>{target.adds++;const raced=clone(d);if(changed)raced.steps[0].jobId='sample.finish';target.put(raced);throw new DefinitionError('DEFINITION_ALREADY_EXISTS');};
    const r=await execute(p,source,target,registry());assert.equal(r.items[0].status,changed?'CONFLICT':'ALREADY_EQUAL');assert.equal(target.adds,1);
  }
});
test('two simultaneous executors share an atomic create-only target',async()=>{
  const {source,target,p}=await setup();const results=await Promise.all([execute(p,source,target,registry()),execute(p,source,target,registry())]);
  assert.equal(results.every(x=>x.ok),true);assert.deepEqual(results.map(x=>x.items[0].status).sort(),['ALREADY_EQUAL','CREATED']);assert.equal(target.rows.size,1);
});
test('definite pre-write failure stops and leaks no internal error',async()=>{
  const {source,target,p}=await setup();target.add=async()=>{target.adds++;throw Object.assign(Error('private path'),{code:'UNAVAILABLE'});};
  const r=await execute(p,source,target,registry());assert.equal(r.items[0].status,'FAILED');assert.equal(r.items[0].reason,'UNAVAILABLE');assert.equal(target.adds,1);assert.equal(target.rows.size,0);assert.equal(JSON.stringify(r).includes('private'),false);
});
test('lost write response stays unknown even if read-back matches; never resend',async()=>{
  for(const code of ['OUTCOME_UNKNOWN',undefined]){
    const {source,target,p}=await setup();target.add=async d=>{target.adds++;target.put(d);throw Object.assign(Error('private stack'),{code});};
    const r=await execute(p,source,target,registry());assert.equal(r.ok,false);assert.equal(r.items[0].status,'OUTCOME_UNKNOWN');assert.equal(r.items[0].reconciliation.action,'ALREADY_EQUAL');assert.equal(r.items[0].confirmedAdded,false);assert.equal(target.adds,1);
    const rerun=await execute(await plan(manifest('v1'),source,target,registry()),source,target,registry());assert.equal(rerun.items[0].status,'ALREADY_EQUAL');assert.equal(target.adds,1);
  }
});
test('unknown result with unavailable reconciliation stays unknown',async()=>{
  const {source,target,p}=await setup();target.add=async()=>{target.adds++;target.get=async()=>{throw Error('private');};throw new DefinitionError('OUTCOME_UNKNOWN');};
  const r=await execute(p,source,target,registry());assert.equal(r.items[0].status,'OUTCOME_UNKNOWN');assert.equal(r.items[0].reconciliation.action,'REJECT');assert.equal(target.adds,1);
});
test('post-read mismatch or disappearance is not success after confirmed Add',async()=>{
  for(const disappear of [false,true]){
    const {source,target,p}=await setup();target.add=async d=>{target.adds++;if(!disappear){const wrong=clone(d);wrong.steps[0].jobId='sample.finish';target.put(wrong);}};
    const r=await execute(p,source,target,registry());assert.equal(r.ok,false);assert.equal(r.items[0].confirmedAdded,true);assert.equal(r.items[0].reason,disappear?'DEFINITION_NOT_FOUND':'POST_CHECK_MISMATCH');
  }
});
test('partial batch stops, preserves completed versions, and safely reruns',async()=>{
  const source=memory(),target=memory();for(const v of ['v1','v2','v3'])source.put(definition(v));
  const add=target.add.bind(target);let fault=true;
  target.add=async d=>{if(d.definitionVersion==='v2'&&fault)throw new DefinitionError('UNAVAILABLE');return add(d);};
  const r=await execute(await plan(manifest('v1','v2','v3'),source,target,registry()),source,target,registry());assert.equal(r.stoppedAt,1);assert.deepEqual(r.items.map(x=>x.status),['CREATED','FAILED']);assert.equal(await target.get('saved-example','v3'),null);
  const first=await target.get('saved-example','v1');fault=false;
  const again=await execute(await plan(manifest('v1','v2','v3'),source,target,registry()),source,target,registry());assert.equal(again.ok,true);assert.deepEqual(again.items.map(x=>x.status),['ALREADY_EQUAL','CREATED','CREATED']);assert.deepEqual(await target.get('saved-example','v1'),first);
});
test('repository read failures are reported without writes',async()=>{
  const {source,target}=await setup();target.get=async()=>{throw Error('private');};const p=await plan(manifest('v1'),source,target,registry());assert.equal(p.items[0].reason,'UNAVAILABLE');assert.equal(target.adds,0);
});
test('invalid and duplicate plans are rejected before access',async()=>{
  const {source,target,p}=await setup();source.reads=0;target.reads=0;
  await assert.rejects(execute({...p,items:[p.items[0],p.items[0]]},source,target,registry()),{code:'DUPLICATE_MANIFEST_TARGET'});
  await assert.rejects(execute({...p,items:[{...p.items[0],sourceFingerprint:'bad'}]},source,target,registry()),{code:'INVALID_PLAN'});
  assert.equal(source.reads+target.reads+target.adds,0);
});
test('CLI separates displayed Dry Run and explicit apply using a persisted plan',()=>temporary(async({dir,json})=>{
  await json.add(definition());
  const root=path.resolve(__dirname,'..'),binding=path.join(dir,'binding.cjs'),input=path.join(dir,'manifest.json'),planFile=path.join(dir,'plan.json');
  const targetDir=path.join(dir,'cli-target');
  fs.writeFileSync(binding,`const {LocalWorkflowDefinitionRepository}=require(${JSON.stringify(path.join(root,'src/adapters/workflow-definition/local-file.cjs'))});
const {registry}=require(${JSON.stringify(path.join(root,'tests/workflow-definition/fixture.cjs'))});
module.exports=()=>({source:new LocalWorkflowDefinitionRepository(${JSON.stringify(path.join(dir,'json'))}),destination:new LocalWorkflowDefinitionRepository(${JSON.stringify(targetDir)}),registry:registry(),close(){}});`);
  fs.writeFileSync(input,JSON.stringify(manifest('v1')));
  const run=(mode,file)=>spawnSync(process.execPath,[path.join(root,'tools/definition-migration.cjs'),mode,binding,file],{encoding:'utf8',windowsHide:true,timeout:10000});
  const dry=run('dry-run',input);assert.equal(dry.status,0,dry.stderr);const p=JSON.parse(dry.stdout);assert.equal(p.items[0].action,'CREATE');assert.deepEqual(fs.readdirSync(targetDir),[]);
  fs.writeFileSync(planFile,JSON.stringify(p));const applied=run('apply',planFile);assert.equal(applied.status,0,applied.stderr);assert.equal(JSON.parse(applied.stdout).items[0].status,'CREATED');
  assert.deepEqual(await new LocalWorkflowDefinitionRepository(targetDir).get('saved-example','v1'),definition());
}));
