import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {validateRegistry,fingerprint,resolveSafe,writeJson,fileHash} from './registry.mjs';
import {verificationInputs} from './scanner.mjs';
// Deliberate allowlist: no shell command, npm script or registry-supplied executable.
export const allowedTests=new Set([
 'Frwk_Units/DB/Builder/tests/verify-portable-data-definition-core.mjs',
 'Frwk_Units/DB/Builder/tests/verify-portable-data-definition-builder.mjs',
 'Frwk_Units/DB/Builder/tests/verify-portable-data-definition-firestore-mapping.mjs',
 'Migration/tests/assets/core.test.cjs','Migration/tests/assets/member.test.cjs','Migration/tests/assets/timetrip.test.cjs',
 'Frwk_Units/Workflow/tests/workflow.test.cjs',
 'Frwk_Units/TimeTrip/tests/timetrip.test.cjs',
 'Migration/tests/public-api.test.cjs',
 'Frwk_Units/Member/tests/schema.test.mjs',
 'tests/workflow-artifact-checkpoint.test.cjs',
 'tests/workflow-artifact-resume.test.cjs',
 'tests/workflow-execution-ownership.test.cjs'
]);
export function runGroup(root,g){
  if(g.kind!=='node-test'||g.tests.some(p=>!allowedTests.has(p)))throw Error('VERIFICATION_NOT_ALLOWED');
  const before=verificationInputs(root,g);if(Object.values(before.files).some(x=>x===null))return {persistent:true,outcome:'FAIL',fingerprint:fingerprint(before),diagnostic:'INPUT_MISSING',log:''};
  // node:test counts an empty file itself as a passing test. The reviewed
  // allowlist uses explicit test(...) declarations; refuse empty replacements.
  if(g.tests.some(p=>! /\btest\s*\(/.test(fs.readFileSync(resolveSafe(root,p),'utf8'))))return {persistent:true,outcome:'FAIL',fingerprint:fingerprint(before),diagnostic:'NO_EXPLICIT_TEST_DECLARATION',log:''};
  const env={...process.env};for(const key of ['NODE_OPTIONS','NODE_PATH','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT','GCLOUD_PROJECT','FIREBASE_CONFIG','FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST',...Object.keys(env).filter(k=>k.startsWith('NODE_TEST_'))])delete env[key];
  const result=spawnSync(process.execPath,['--require',resolveSafe(root,'Migration/src/network-guard.cjs'),'--test','--test-isolation=none','--test-reporter=tap',...g.tests.map(p=>resolveSafe(root,p))],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:2*1024*1024});
  const after=verificationInputs(root,g),unchanged=fingerprint(before)===fingerprint(after);
  const log=(result.stdout||'')+(result.stderr||'');
  const count=name=>{const match=(result.stdout||'').match(new RegExp('^# '+name+' (\\d+)$','m'));return match?Number(match[1]):null;};
  const counts={tests:count('tests'),pass:count('pass'),fail:count('fail'),skipped:count('skipped')};
  const allPassed=counts.tests===g.expectedTests&&counts.pass===g.expectedTests&&counts.fail===0&&counts.skipped===0;
  return {persistent:true,outcome:result.status===0&&!result.error&&unchanged&&allPassed?'PASS':'FAIL',fingerprint:fingerprint(before),inputs:before,exitCode:result.status,counts,diagnostic:!unchanged?'INPUT_CHANGED_DURING_TEST':result.error?'EXECUTION_FAILED':!allPassed?'TEST_COUNT_OR_RESULT_MISMATCH':null,log};
}
export function verify(root,registry,evidence={schemaVersion:1,groups:{}}){
  validateRegistry(registry);const next=structuredClone(registry),results={schemaVersion:1,groups:{...evidence.groups}};
  for(const g of registry.verifications){const r=runGroup(root,g);results.groups[g.id]={...r,recordedAt:new Date().toISOString()};}
  for(const a of next.assets)if(a.verifications.length&&a.verifications.every(id=>results.groups[id].outcome==='PASS'))a.destinationVerifiedSha256=fileHash(root,a.destination);
  const directory=resolveSafe(root,'Migration/reports');fs.mkdirSync(directory,{recursive:true});
  // Evidence first. Interruption cannot promote a hash without its successful evidence.
  writeJson(path.join(directory,'latest.json'),results);
  if(JSON.stringify(next)!==JSON.stringify(registry))writeJson(resolveSafe(root,'Migration/registry.json'),next);
  return {registry:next,evidence:results};
}
