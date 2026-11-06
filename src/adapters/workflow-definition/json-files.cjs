'use strict';
// JSON persistence mechanics extracted from GUI DefinitionStore; no workflow schema or execution here.
const fs=require('node:fs');
const {randomUUID}=require('node:crypto');
function readJsonFile(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function publishJson(file,value,publish){
  const temp=file+'.tmp-'+randomUUID();let fd,primary,stage='OPEN_TEMP';
  const diagnostics=[];
  try{
    fd=fs.openSync(temp,'wx');stage='WRITE_TEMP';fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n','utf8');
    stage='SYNC_TEMP';fs.fsyncSync(fd);stage='CLOSE_TEMP';fs.closeSync(fd);fd=undefined;
    stage='PUBLISH';publish(temp,file);
  }catch(error){
    primary=error;primary.storageStage=stage;
  }finally{
    if(fd!==undefined)try{fs.closeSync(fd);}catch{diagnostics.push('TEMP_CLOSE_FAILED');}
    try{fs.unlinkSync(temp);}catch(error){if(error.code!=='ENOENT')diagnostics.push('TEMP_UNLINK_FAILED');}
  }
  if(primary){if(diagnostics.length)primary.cleanupDiagnostics=diagnostics;throw primary;}
  // Publication is committed. Cleanup failures are diagnostics, never an unsuccessful Add.
  return {cleanupDiagnostics:diagnostics};
}
function writeJsonFile(file,value){return publishJson(file,value,(temp,target)=>fs.renameSync(temp,target));}
function createJsonFile(file,value){return publishJson(file,value,(temp,target)=>fs.linkSync(temp,target));}
module.exports={readJsonFile,writeJsonFile,createJsonFile};
