'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {readJsonFile,writeJsonFile}=require('../src/adapters/workflow-definition/json-files.cjs');
const STEP_TYPES = new Set(['JOB','CHECK_FINAL','CHECK_PROVISIONAL','CHECK_WAIT','END']);
const ROUTE_MODES = new Set(['BRANCH','REEVALUATE']);
function storeError(code,status,message){const e=new Error(message);e.code=code;e.status=status;return e;}
function storageFailure(error){
  if(error?.status&&error?.code)return error;
  const e=error instanceof SyntaxError
    ? storeError('DEFINITION_DATA_CORRUPT',500,'保存済み定義の形式が不正です。既存ファイルは自動修復しません')
    : error?.storageStage==='PUBLISH'
      ? storeError('OUTCOME_UNKNOWN',503,'保存結果を確定できません。再保存せず、保存内容を確認してください')
      : storeError('DEFINITION_STORE_UNAVAILABLE',503,'定義の保存領域を利用できません');
  if(error?.cleanupDiagnostics)e.cleanupDiagnostics=[...error.cleanupDiagnostics];
  return e;
}
function validate(def) {
  const errors=[];
  if (!def || typeof def !== 'object' || Array.isArray(def)) return ['定義はオブジェクトである必要があります'];
  for(const k of ['id','version','startStepId']) if(typeof def[k]!=='string'||!def[k].trim()) errors.push(`${k} は必須です`);
  if(!Array.isArray(def.steps)||!def.steps.length) errors.push('steps は1件以上必要です');
  if(!Array.isArray(def.eventRoutes)) errors.push('eventRoutes は配列が必要です');
  if(errors.length) return errors;
  const ids=new Set();
  for(const [i,s] of def.steps.entries()) {
    if(!s||typeof s!=='object'){errors.push(`steps[${i}] が不正です`);continue;}
    if(typeof s.id!=='string'||!s.id.trim()) errors.push(`steps[${i}].id は必須です`);
    else if(ids.has(s.id)) errors.push(`工程ID重複: ${s.id}`);
    ids.add(s.id);
    if(!STEP_TYPES.has(s.type)) errors.push(`${s.id}: 不明な工程種別`);
    if(s.type==='JOB' && (typeof s.jobId!=='string'||!s.jobId.trim())) errors.push(`${s.id}: JOBにはjobIdが必要です`);
    if(s.type==='END' && (s.nextStepId||s.retryTargetStepId)) errors.push(`${s.id}: ENDに遷移先は指定できません`);
    if(s.type!=='END' && !s.nextStepId) errors.push(`${s.id}: nextStepId が必要です`);
  }
  if(!ids.has(def.startStepId)) errors.push('開始工程が存在しません');
  for(const s of def.steps) {
    if(!s||typeof s!=='object')continue;
    for(const key of ['nextStepId','retryTargetStepId']) if(s[key]&&!ids.has(s[key])) errors.push(`${s.id}: ${key}=${s[key]} が存在しません`);
  }
  const routeIds=new Set();
  for(const [i,r] of def.eventRoutes.entries()) {
    if(!r||typeof r!=='object'){errors.push(`eventRoutes[${i}] が不正です`);continue;}
    for(const key of ['eventId','eventType','guardId']) if(typeof r[key]!=='string'||!r[key].trim())errors.push(`eventRoutes[${i}].${key} は必須です`);
    if(routeIds.has(r.eventId))errors.push(`イベントID重複: ${r.eventId}`);
    routeIds.add(r.eventId);
    if(!ids.has(r.targetStepId))errors.push(`${r.eventId}: 遷移先が存在しません`);
    if(!ROUTE_MODES.has(r.mode))errors.push(`${r.eventId}: modeが不正です`);
  }
  // Event branches may have independent entry points; check reachability from start or event targets.
  const reachable=new Set(), queue=[def.startStepId,...def.eventRoutes.map(r=>r.targetStepId)];
  const byId=new Map(def.steps.filter(s=>s&&s.id).map(s=>[s.id,s]));
  while(queue.length){const id=queue.shift();if(reachable.has(id)||!byId.has(id))continue;reachable.add(id);const s=byId.get(id);for(const k of ['nextStepId','retryTargetStepId'])if(s[k])queue.push(s[k]);}
  for(const id of ids)if(!reachable.has(id))errors.push(`到達できない工程: ${id}`);
  if(![...reachable].some(id=>byId.get(id)?.type==='END'))errors.push('到達可能なEND工程がありません');
  return errors;
}
class DefinitionStore {
  constructor(directory){this.directory=directory;this.diagnostics=[];fs.mkdirSync(directory,{recursive:true});}
  file(id,version){
    if(![id,version].every(x=>typeof x==='string'&&x.trim()))throw storeError('INVALID_DEFINITION',400,'id と version は必須です');
    try{return path.join(this.directory,`${encodeURIComponent(id)}__${encodeURIComponent(version)}.json`);}
    catch{throw storeError('INVALID_DEFINITION',400,'id または version が不正です');}
  }
  existing(file,id,version){
    let value;try{value=readJsonFile(file);}catch(error){throw storageFailure(error);}
    if(value===null&&!fs.existsSync(file))return null;
    if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.id!=='string'||!value.id.trim()||typeof value.version!=='string'||!value.version.trim())
      throw storeError('DEFINITION_DATA_CORRUPT',500,'保存済み定義の識別情報が不正です。既存ファイルは自動修復しません');
    if(value.id!==id||value.version!==version)
      throw storeError('DEFINITION_STORAGE_COLLISION',409,'保存先が別のID・Versionの定義と衝突しています。上書き・削除できません');
    return value;
  }
  mutate(action){
    // Directory-wide exclusion also covers legacy separator collisions and Windows case aliases.
    // No expiry or automatic removal of a possibly live owner's lock.
    const lock=path.join(this.directory,'.definition-write.lock');
    try{fs.mkdirSync(lock);}catch(error){
      if(error.code==='EEXIST')throw storeError('DEFINITION_STORE_BUSY',409,'定義の保存領域は使用中です。残存lockは所有者を確認してください');
      throw storageFailure(error);
    }
    let primary,result;
    try{result=action();}catch(error){primary=storageFailure(error);}
    finally{
      try{fs.rmdirSync(lock);}catch{
        if(primary)primary.cleanupDiagnostics=[...(primary.cleanupDiagnostics||[]),'LOCK_RELEASE_FAILED'];
        else this.diagnostics.push('LOCK_RELEASE_FAILED');
      }
    }
    if(primary)throw primary;return result;
  }
  list(){return fs.readdirSync(this.directory).filter(f=>f.endsWith('.json')).map(f=>{try{const d=JSON.parse(fs.readFileSync(path.join(this.directory,f),'utf8'));return {id:d.id,version:d.version,steps:d.steps?.length||0};}catch{return null;}}).filter(Boolean).sort((a,b)=>a.id.localeCompare(b.id)||a.version.localeCompare(b.version));}
  get(id,version){return this.existing(this.file(id,version),id,version);}
  save(def,{overwrite=false}={}){
    let snapshot;try{snapshot=JSON.parse(JSON.stringify(def));}catch{throw storeError('INVALID_DEFINITION',400,'定義をJSONとして保存できません');}
    const errors=validate(snapshot);if(errors.length){const e=new Error(errors.join(' / '));e.status=400;e.details=errors;throw e;}
    const file=this.file(snapshot.id,snapshot.version);
    return this.mutate(()=>{
      const current=this.existing(file,snapshot.id,snapshot.version);
      if(current&&!overwrite)throw storeError('DEFINITION_ALREADY_EXISTS',409,'同じIDとバージョンが存在します。上書き指定が必要です');
      const publication=writeJsonFile(file,snapshot);this.diagnostics.push(...publication.cleanupDiagnostics);
      return snapshot;
    });
  }
  remove(id,version){const file=this.file(id,version);return this.mutate(()=>{if(!this.existing(file,id,version))return false;fs.unlinkSync(file);return true;});}
}
module.exports={validate,DefinitionStore};
