import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest,fingerprint,validateRegistry,resolveSafe} from '../src/registry.mjs';
import {scan,verificationInputs} from '../src/scanner.mjs';
import {runGroup,verify} from '../src/verifier.mjs';
import {report} from '../src/reporter.mjs';
const put=(root,p,s)=>{fs.mkdirSync(path.dirname(path.join(root,p)),{recursive:true});fs.writeFileSync(path.join(root,p),s);};

test('declared local package binding changes invalidate verification without executing a package',()=>fixture(({root,r,evidence})=>{r.verifications[0].localBindings=[{path:'unit',target:'unit'}];validateRegistry(r);const e=evidence();assert.equal(scan(root,r,e).groups.unit.current,true);r.verifications[0].localBindings[0].path='tests';assert.equal(scan(root,r,e).groups.unit.current,false);assert.ok(Object.values(verificationInputs(root,r.verifications[0]).files).includes(null));r.verifications[0].localBindings[0].target='../outside';assert.throws(()=>validateRegistry(r));}));

test('Framework-local origins distinguish new implementations from migrated sources',()=>fixture(({root,r})=>{
 r.repositories.framework={root:'.'};Object.assign(r.assets[0],{repository:'framework',origin:'NEW',source:null,sourceBaselineSha256:null});
 const result=scan(root,r).assets[0];assert.equal(result.origin,'NEW');assert.ok(!result.warnings.includes('SOURCE_MISSING'));
 r.assets[0].origin='MIGRATED';assert.throws(()=>validateRegistry(r));
}));
test('new implementations still require current verification and explicit approval',()=>fixture(({root,r,evidence})=>{
 Object.assign(r.assets[0],{origin:'NEW',source:null,sourceBaselineSha256:null,destinationVerifiedSha256:digest('destination')});
 assert.equal(scan(root,r,evidence()).assets[0].progress,'VERIFIED');assert.equal(scan(root,r,evidence()).assets[0].skip,false);
 const e=evidence();put(root,'unit/a.js','changed');const a=scan(root,r,e).assets[0];assert.ok(a.warnings.includes('DESTINATION_CHANGED'));assert.ok(a.warnings.includes('VERIFICATION_STALE'));
}));
function fixture(fn){const base=fs.mkdtempSync(path.join(os.tmpdir(),'migration-progress-')),root=path.join(base,'target');fs.mkdirSync(root);try{
 const source=path.join(base,'source');fs.mkdirSync(source);put(source,'a.js','source');put(root,'unit/a.js','destination');put(root,'unit/dependency.js','dependency');put(root,'tests/a.test.cjs','test');
 for(const p of ['verifier.mjs','registry.mjs','network-guard.cjs','scanner.mjs'])put(root,'Migration/src/'+p,'runner');put(root,'Migration/package.json','{}');
 const r={schemaVersion:1,repositories:{old:{root:'../source'}},discoveryRoots:['unit'],verifications:[{id:'unit',kind:'node-test',persistent:true,expectedTests:1,tests:['tests/a.test.cjs'],inputs:['unit']}],assets:[{id:'a',repository:'old',source:'a.js',destination:'unit/a.js',unit:'Test',sourceBaselineSha256:digest('source'),destinationVerifiedSha256:null,verifications:['unit'],decision:{analyzed:true,disposition:'ACTIVE',notes:'fixture'},approval:{approved:false,destinationSha256:null}}]};
 const evidence=()=>({schemaVersion:1,groups:{unit:{persistent:true,outcome:'PASS',fingerprint:fingerprint(verificationInputs(root,r.verifications[0]))}}});
 return fn({root,source,r,evidence,asset:()=>scan(root,r,evidence()).assets[0]});
 }finally{fs.rmSync(base,{recursive:true,force:true});}}
test('unregistered files are discovered; registered copies are not duplicated',()=>fixture(({root,r})=>{put(root,'unit/new.js','new');assert.deepEqual(scan(root,r).unregistered,['unit/dependency.js','unit/new.js']);}));
test('missing destination retains analyzed progress',()=>fixture(({root,r})=>{fs.unlinkSync(path.join(root,'unit/a.js'));const a=scan(root,r).assets[0];assert.equal(a.progress,'ANALYZED');assert.ok(a.warnings.includes('DESTINATION_MISSING'));}));
test('unanalysed missing destination is NEW; a status label cannot promote it',()=>fixture(({root,r})=>{fs.unlinkSync(path.join(root,'unit/a.js'));r.assets[0].decision.analyzed=false;r.assets[0].status='COMPLETE';assert.equal(scan(root,r).assets[0].progress,'NEW');}));
test('source baseline change is independent from destination',()=>fixture(({source,r,root})=>{put(source,'a.js','new');assert.ok(scan(root,r).assets[0].warnings.includes('SOURCE_CHANGED'));}));
test('source missing is reported',()=>fixture(({source,r,root})=>{fs.unlinkSync(path.join(source,'a.js'));assert.ok(scan(root,r).assets[0].warnings.includes('SOURCE_MISSING'));}));
test('intentional reference-only modification need not equal the source',()=>fixture(({r,asset})=>{r.assets[0].destinationVerifiedSha256=digest('destination');assert.equal(asset().progress,'VERIFIED');assert.equal(asset().skip,false);}));
test('PASS alone cannot verify an unbound destination hash',()=>fixture(({asset})=>assert.equal(asset().progress,'COPIED')));
test('current verification plus hash-bound explicit approval permits skip',()=>fixture(({r,asset})=>{r.assets[0].destinationVerifiedSha256=digest('destination');r.assets[0].approval={approved:true,destinationSha256:digest('destination'),verificationFingerprint:asset().approvalVerificationFingerprint};assert.equal(asset().progress,'COMPLETE');assert.equal(asset().skip,true);}));
test('source change retains approval and complete evidence but prohibits skip',()=>fixture(({r,source,asset})=>{r.assets[0].destinationVerifiedSha256=digest('destination');r.assets[0].approval={approved:true,destinationSha256:digest('destination'),verificationFingerprint:asset().approvalVerificationFingerprint};put(source,'a.js','changed');assert.equal(asset().progress,'COMPLETE');assert.equal(asset().approved,true);assert.equal(asset().skip,false);}));
test('destination changes invalidate evidence and approval',()=>fixture(({r,root,evidence})=>{r.assets[0].destinationVerifiedSha256=digest('destination');const e=evidence();put(root,'unit/a.js','changed');const a=scan(root,r,e).assets[0];assert.equal(a.progress,'COPIED');assert.ok(a.warnings.includes('DESTINATION_CHANGED'));assert.ok(a.warnings.includes('VERIFICATION_STALE'));assert.equal(a.skip,false);}));
test('dependency and test changes stale a multi-file verification',()=>fixture(({r,root,evidence})=>{r.assets[0].destinationVerifiedSha256=digest('destination');const e=evidence();put(root,'unit/dependency.js','changed');assert.equal(scan(root,r,e).assets[0].progress,'COPIED');put(root,'tests/a.test.cjs','changed');assert.ok(scan(root,r,e).assets[0].warnings.includes('VERIFICATION_STALE'));}));
test('new dependency files change a directory fingerprint',()=>fixture(({r,root,evidence})=>{r.assets[0].destinationVerifiedSha256=digest('destination');const e=evidence();put(root,'unit/new-dependency.js','new');assert.equal(scan(root,r,e).groups.unit.current,false);}));
test('a deleted test is not equivalent to a successful test',()=>fixture(({r,root,evidence})=>{r.assets[0].destinationVerifiedSha256=digest('destination');const e=evidence();fs.unlinkSync(path.join(root,'tests/a.test.cjs'));assert.ok(scan(root,r,e).assets[0].warnings.includes('TEST_MISSING'));}));
test('failed verification is never complete',()=>fixture(({r,root})=>{const a=scan(root,r,{schemaVersion:1,groups:{unit:{outcome:'FAIL'}}}).assets[0];assert.ok(a.warnings.includes('TEST_FAILED'));assert.equal(a.skip,false);}));
test('temporary test reports cannot create persistent verification',()=>fixture(({r,root,evidence})=>{r.assets[0].destinationVerifiedSha256=digest('destination');const e=evidence();e.groups.unit.persistent=false;assert.equal(scan(root,r,e).groups.unit.current,false);}));
test('deferred and excluded retain their classification and never skip',()=>fixture(({r,asset})=>{for(const disposition of ['DEFERRED','EXCLUDED']){r.assets[0].decision={analyzed:true,disposition,notes:'fixture',reason:'await decision'};assert.equal(asset().classification,disposition);assert.equal(asset().skip,false);}}));
test('malformed registry, duplicate identity and path traversal are refused',()=>fixture(({r})=>{assert.throws(()=>validateRegistry(null));for(const mutate of [x=>x.assets.push({...x.assets[0]}),x=>x.assets[0].source='../escape',x=>x.assets[0].source='C:/escape',x=>x.assets[0].sourceBaselineSha256='bad',x=>x.assets[0].verifications=['unknown'],x=>x.repositories.old.root='../../outside']){const c=structuredClone(r);mutate(c);assert.throws(()=>validateRegistry(c));}}));
test('verifier refuses arbitrary test command targets',()=>fixture(({root,r})=>assert.throws(()=>runGroup(root,r.verifications[0]),/NOT_ALLOWED/)));
test('scan and report leave fixtures and registry untouched',()=>fixture(({root,r})=>{const before=JSON.stringify(r),bytes=fs.readFileSync(path.join(root,'unit/a.js'));assert.match(report(scan(root,r)),/EXPLICIT_COMPLETION_APPROVAL_REQUIRED/);assert.equal(JSON.stringify(r),before);assert.deepEqual(fs.readFileSync(path.join(root,'unit/a.js')),bytes);}));
test('network, child process and fetch are blocked by local test guard',()=>{const guard=fileURLToPath(new URL('../src/network-guard.cjs',import.meta.url));const r=spawnSync(process.execPath,['--require',guard,'-e',"const a=require('node:assert/strict');a.throws(()=>require('node:http').get('http://127.0.0.1:1'));a.throws(()=>fetch('https://example.invalid'));a.throws(()=>require('node:child_process').spawn('anything'));"],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);});
test('symbolic links cannot escape input roots',t=>fixture(({root})=>{const link=path.join(root,'link');try{fs.symlinkSync(os.tmpdir(),link,'junction');}catch(e){if(['EPERM','EACCES'].includes(e.code)){t.skip('OS refused junction creation');return;}throw e;}assert.throws(()=>resolveSafe(root,'link/anything'),/SYMLINK/);}));
function executableFixture(fn){return fixture(({root,r})=>{const file='Migration/tests/assets/core.test.cjs';put(root,'Migration/src/network-guard.cjs',fs.readFileSync(new URL('../src/network-guard.cjs',import.meta.url),'utf8'));r.verifications[0].tests=[file];return fn({root,g:r.verifications[0],write:s=>put(root,file,s)});});}
test('real verifier captures PASS against the multi-file fingerprint',()=>executableFixture(({root,g,write})=>{write("require('node:test').test('fixture',()=>{});");const result=runGroup(root,g);assert.equal(result.outcome,'PASS',result.log);assert.equal(result.counts.pass,1);}));
test('zero tests and skipped tests cannot be verified',()=>executableFixture(({root,g,write})=>{for(const code of ["console.log('no tests');","require('node:test').test.skip('fixture',()=>{});"]){write(code);assert.equal(runGroup(root,g).outcome,'FAIL');}}));
test('actual test failures are retained',()=>executableFixture(({root,g,write})=>{write("require('node:test').test('fixture',()=>{throw Error('fault');});");const result=runGroup(root,g);assert.equal(result.outcome,'FAIL');assert.match(result.log,/fault/);}));
test('file mutation during a passing test invalidates verification',()=>executableFixture(({root,g,write})=>{write("require('node:test').test('fixture',()=>require('node:fs').writeFileSync('unit/dependency.js','changed'));");const result=runGroup(root,g);assert.equal(result.outcome,'FAIL');assert.equal(result.diagnostic,'INPUT_CHANGED_DURING_TEST');}));
test('dependency change requires renewed approval even after fresh verification',()=>fixture(({r,root,asset})=>{r.assets[0].destinationVerifiedSha256=digest('destination');r.assets[0].approval={approved:true,destinationSha256:digest('destination'),verificationFingerprint:asset().approvalVerificationFingerprint};put(root,'unit/dependency.js','new');assert.equal(asset().progress,'VERIFIED');assert.equal(asset().skip,false);assert.equal(r.assets[0].approval.approved,true);}));

test('Member Schema real verification refuses a broken schema and expires on validator changes',()=>{
 const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'member-schema-verification-'));
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
 const schema='Frwk_Units/Member/schema/Member.yml';
 const copied=[schema,'Frwk_Units/Member/tests/schema.test.mjs','Frwk_Units/Member/package.json','Frwk_Units/Member/src/MemberObject.js',
  'Frwk_Units/Core/package.json','Frwk_Units/Core/src/Flow.js','Frwk_Units/Core/src/StorageId.js',
  'Frwk_Units/DB/Builder/package.json','Frwk_Units/DB/Builder/src/portable-data-definition-core.mjs','Frwk_Units/DB/Builder/src/portable-data-definition-builder.mjs','Frwk_Units/DB/Builder/src/Schema_Renderer_Firestore.js',
  'Migration/package.json',...['verifier.mjs','network-guard.cjs','registry.mjs','scanner.mjs'].map(p=>'Migration/src/'+p)];
 try{
  for(const p of copied)put(root,p,fs.readFileSync(path.join(repo,p)));
  const core=path.join(root,'Frwk_Units/Core'),installed=path.join(root,'Frwk_Units/Member/node_modules/@arch026/core');fs.cpSync(core,installed,{recursive:true});
  const original=fs.readFileSync(path.join(root,schema),'utf8'),originalHash=digest(original);put(root,'baseline/Member.yml',original);
  const group={id:'schema',kind:'node-test',persistent:true,expectedTests:17,tests:['Frwk_Units/Member/tests/schema.test.mjs'],inputs:['Frwk_Units/Member','Frwk_Units/DB/Builder','Frwk_Units/Core']};
  const registry={schemaVersion:1,repositories:{framework:{root:'.'}},discoveryRoots:['Frwk_Units/Member/schema'],verifications:[group],assets:[{id:'schema',repository:'framework',source:'baseline/Member.yml',destination:schema,unit:'Member',sourceBaselineSha256:originalHash,destinationVerifiedSha256:null,verifications:['schema'],decision:{analyzed:true,disposition:'ACTIVE',notes:'isolated verification fixture'},approval:{approved:false,destinationSha256:null}}]};
  put(root,'Migration/registry.json',JSON.stringify(registry));
  const good=verify(root,registry);assert.equal(good.evidence.groups.schema.outcome,'PASS',good.evidence.groups.schema.log);assert.equal(scan(root,good.registry,good.evidence).assets[0].progress,'VERIFIED');
  const broken=original.replace('    type: string','    type: invalid-member-type');assert.notEqual(broken,original);put(root,schema,broken);
  const failed=verify(root,good.registry,good.evidence);assert.equal(failed.evidence.groups.schema.outcome,'FAIL');assert.equal(failed.evidence.groups.schema.counts.tests,17);assert.ok(failed.evidence.groups.schema.counts.fail>0);
  assert.equal(failed.registry.assets[0].destinationVerifiedSha256,originalHash);
  const state=scan(root,failed.registry,failed.evidence).assets[0];assert.equal(state.progress,'COPIED');for(const w of ['DESTINATION_CHANGED','TEST_FAILED','VERIFICATION_STALE'])assert.ok(state.warnings.includes(w));assert.equal(state.skip,false);assert.equal(state.approved,false);
  put(root,schema,original);const restored=verify(root,failed.registry,failed.evidence);assert.equal(restored.evidence.groups.schema.outcome,'PASS',restored.evidence.groups.schema.log);
  fs.appendFileSync(path.join(root,'Frwk_Units/DB/Builder/src/portable-data-definition-core.mjs'),'\n// fixture-only dependency change\n');
  const stale=scan(root,restored.registry,restored.evidence).assets[0];assert.equal(stale.progress,'COPIED');assert.ok(stale.warnings.includes('VERIFICATION_STALE'));assert.equal(stale.skip,false);assert.equal(restored.registry.assets[0].approval.approved,false);
 }finally{
  if(path.dirname(path.resolve(root))!==parent||!path.basename(root).startsWith('member-schema-verification-'))throw Error('UNSAFE_FIXTURE_CLEANUP');
  fs.rmSync(root,{recursive:true,force:true});
 }
});
