import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const fingerprint = value => digest(JSON.stringify(value));
export function relative(value) {
  if(typeof value!=='string'||!value||value.includes('\\')||value.includes(':')||path.posix.isAbsolute(value)||value.split('/').some(x=>!x||x==='.'||x==='..')) throw Error('INVALID_RELATIVE_PATH');
  return value;
}
export function resolveSafe(root, name) {
  relative(name); const base=path.resolve(root),target=path.resolve(base,name);
  // Reject links, including dangling junctions, at every existing component.
  let current=base;
  try{if(fs.lstatSync(base).isSymbolicLink())throw Error('SYMLINK_REFUSED');}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const part of name.split('/')){current=path.join(current,part);try{if(fs.lstatSync(current).isSymbolicLink())throw Error('SYMLINK_REFUSED');}catch(e){if(e.code!=='ENOENT')throw e;}}
  return target;
}
export function fileHash(root,name){const p=resolveSafe(root,name);try{if(!fs.statSync(p).isFile())throw Error('NOT_A_FILE');return digest(fs.readFileSync(p));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
export function files(root,names){
  const found=[];
  function walk(name){const p=resolveSafe(root,name);let stat;try{stat=fs.statSync(p);}catch(e){if(e.code==='ENOENT'){found.push([name,null]);return;}throw e;}
    if(stat.isDirectory()){const children=fs.readdirSync(p).sort();if(!children.length)found.push([name+'/',null]);for(const child of children)walk(name+'/'+child);}
    else if(stat.isFile())found.push([name,digest(fs.readFileSync(p))]);else throw Error('UNSUPPORTED_FILE');}
  for(const name of names)walk(name);return Object.fromEntries(found.sort(([a],[b])=>a.localeCompare(b,'en')));
}
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const text=x=>typeof x==='string'&&!!x.trim();
export function validateRegistry(r){
  if(!r||r.schemaVersion!==1||!r.repositories||!Array.isArray(r.assets)||!Array.isArray(r.verifications)||!Array.isArray(r.discoveryRoots))throw Error('INVALID_REGISTRY');
  const ids=new Set(),destinations=new Set(),groups=new Set();
  for(const [id,repo]of Object.entries(r.repositories)){if(!text(id)||!repo||typeof repo.root!=='string'||!(repo.root==='.'||/^\.\.\/[A-Za-z0-9_\-\u0080-\uffff]+$/.test(repo.root)))throw Error('INVALID_REPOSITORY_ROOT');}
  for(const g of r.verifications){if(!g||!text(g.id)||groups.has(g.id)||g.kind!=='node-test'||g.persistent!==true||!Number.isSafeInteger(g.expectedTests)||g.expectedTests<1||!Array.isArray(g.tests)||!g.tests.length||!Array.isArray(g.inputs)||!g.inputs.length)throw Error('INVALID_VERIFICATION');groups.add(g.id);for(const p of [...g.tests,...g.inputs])relative(p);}
  for(const a of r.assets){if(!a||!text(a.id)||ids.has(a.id)||!Object.hasOwn(r.repositories,a.repository)||!text(a.unit)||!([undefined,'MIGRATED','NEW'].includes(a.origin))||!(a.origin==='NEW'?a.source===null&&a.sourceBaselineSha256===null:hash(a.sourceBaselineSha256))||!(a.destinationVerifiedSha256===null||hash(a.destinationVerifiedSha256))||!Array.isArray(a.verifications)||a.verifications.some(x=>!groups.has(x))||!a.decision||typeof a.decision.analyzed!=='boolean'||!['ACTIVE','DEFERRED','EXCLUDED'].includes(a.decision.disposition)||!text(a.decision.notes)||!a.approval||typeof a.approval.approved!=='boolean'||!(a.approval.destinationSha256===null||hash(a.approval.destinationSha256)))throw Error('INVALID_ASSET');
    if(a.origin!=='NEW')relative(a.source);relative(a.destination);if(!(a.approval.verificationFingerprint===undefined||a.approval.verificationFingerprint===null||hash(a.approval.verificationFingerprint)))throw Error('INVALID_APPROVAL_FINGERPRINT');
    for(const id of a.verifications){const g=r.verifications.find(x=>x.id===id);if(!g.inputs.some(p=>a.destination===p||a.destination.startsWith(p+'/')))throw Error('ASSET_NOT_IN_VERIFICATION_SCOPE');}
    if(destinations.has(a.destination))throw Error('DUPLICATE_DESTINATION');if(a.decision.disposition!=='ACTIVE'&&!text(a.decision.reason))throw Error('MISSING_DISPOSITION_REASON');ids.add(a.id);destinations.add(a.destination);}
  for(const g of r.verifications){if(g.localBindings!==undefined){if(!Array.isArray(g.localBindings))throw Error('INVALID_LOCAL_BINDING');for(const b of g.localBindings){if(!b||!text(b.path)||!text(b.target))throw Error('INVALID_LOCAL_BINDING');relative(b.path);relative(b.target);if(!g.inputs.some(p=>p===b.target||p.startsWith(b.target+'/')))throw Error('BINDING_TARGET_NOT_IN_SCOPE');}}}
  for(const p of r.discoveryRoots)relative(p);return r;
}
export function loadRegistry(root){return validateRegistry(JSON.parse(fs.readFileSync(resolveSafe(root,'Migration/registry.json'),'utf8')));}
export function repositoryRoot(root,entry){const target=path.resolve(root,entry.root);try{if(fs.lstatSync(target).isSymbolicLink())throw Error('REPOSITORY_SYMLINK_REFUSED');}catch(e){if(e.code!=='ENOENT')throw e;}return target;}
export function writeJson(file,value){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});fs.renameSync(temp,file);}
