import fs from 'node:fs';
import path from 'node:path';
import {validateRegistry,repositoryRoot,fileHash,files,fingerprint,resolveSafe} from './registry.mjs';
export const runnerInputs=['Migration/src/verifier.mjs','Migration/src/network-guard.cjs','Migration/src/registry.mjs','Migration/src/scanner.mjs','Migration/package.json'];
export function verificationInputs(root,g){
  const hashes=files(root,[...g.inputs,...g.tests,...runnerInputs]);
  // Explicit local package bindings only. Do not follow arbitrary links while
  // traversing source trees; the declared canonical target is hashed above.
  for(const b of g.localBindings||[]){let value=null;try{const actual=fs.realpathSync(path.resolve(root,b.path)),expected=fs.realpathSync(resolveSafe(root,b.target));if(actual===expected)value=fingerprint({target:b.target});}catch{}hashes['binding:'+b.path]=value;}
  return {runtime:process.version,group:g,files:hashes};
}
export function scan(root,registry,evidence={schemaVersion:1,groups:{}}){
  validateRegistry(registry);const groups={};
  for(const g of registry.verifications){const inputs=verificationInputs(root,g),record=evidence?.schemaVersion===1?evidence.groups?.[g.id]:undefined;
    const testsExist=g.tests.every(p=>fileHash(root,p)!==null),complete=Object.values(inputs.files).every(x=>x!==null);
    const current=record?.outcome==='PASS'&&record.persistent===true&&record.fingerprint===fingerprint(inputs)&&complete&&testsExist;
    groups[g.id]={testsExist,current,outcome:record?.outcome||'NOT_RUN',fingerprint:fingerprint(inputs)};
  }
  const assets=registry.assets.map(a=>{
    const sourceHash=a.origin==='NEW'?null:fileHash(repositoryRoot(root,registry.repositories[a.repository]),a.source),destinationHash=fileHash(root,a.destination),warnings=[];
    if(a.origin!=='NEW'){if(sourceHash===null)warnings.push('SOURCE_MISSING');else if(sourceHash!==a.sourceBaselineSha256)warnings.push('SOURCE_CHANGED');}
    if(destinationHash===null)warnings.push('DESTINATION_MISSING');else if(a.destinationVerifiedSha256&&destinationHash!==a.destinationVerifiedSha256)warnings.push('DESTINATION_CHANGED');
    const associated=a.verifications.map(id=>groups[id]);
    if(!associated.length||associated.some(g=>!g.testsExist))warnings.push('TEST_MISSING');
    if(associated.some(g=>g.outcome==='FAIL'))warnings.push('TEST_FAILED');
    const verified=!!destinationHash&&destinationHash===a.destinationVerifiedSha256&&associated.length>0&&associated.every(g=>g.current);
    if((a.destinationVerifiedSha256||associated.some(g=>g.outcome!=='NOT_RUN'))&&!verified)warnings.push('VERIFICATION_STALE');
    let progress=verified?'VERIFIED':destinationHash?'COPIED':a.decision.analyzed?'ANALYZED':'NEW';
    const approvalVerificationFingerprint=fingerprint(a.verifications.map(id=>({id,fingerprint:groups[id].fingerprint})));
    const approved=a.approval.approved&&a.approval.destinationSha256===destinationHash&&a.approval.verificationFingerprint===approvalVerificationFingerprint;
    if(verified&&approved)progress='COMPLETE';
    const skip=progress==='COMPLETE'&&warnings.length===0&&a.decision.disposition==='ACTIVE';
    return {id:a.id,unit:a.unit,origin:a.origin||'MIGRATED',source:a.source,destination:a.destination,sourceHash,destinationHash,approvalVerificationFingerprint,progress,classification:a.decision.disposition,warnings,approved,skip,
      reasons:[...(!verified?['CURRENT_VERIFICATION_REQUIRED']:[]),...(!approved?['EXPLICIT_COMPLETION_APPROVAL_REQUIRED']:[]),...(a.decision.disposition!=='ACTIVE'?[a.decision.reason]:[])]};
  });
  const registered=new Set(assets.map(a=>a.destination));
  const unregistered=Object.keys(files(root,registry.discoveryRoots)).filter(p=>!p.endsWith('/')&&!registered.has(p)&&fileHash(root,p)!==null);
  return {assets,groups,unregistered};
}
export function loadEvidence(root){const p=resolveSafe(root,'Migration/reports/latest.json');try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT')return {schemaVersion:1,groups:{}};throw Error('INVALID_EVIDENCE');}}
