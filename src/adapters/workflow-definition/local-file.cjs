'use strict';
const fs=require('node:fs'),path=require('node:path');
const {createHash}=require('node:crypto');
const {readJsonFile,createJsonFile}=require('./json-files.cjs');
const {validatePrototypeDefinition,validateDefinitionKey,DefinitionError}=require('../../../dist/src/prototype/definition');
/** @implements {import('../../../dist/src/ports/contracts').DefinitionRepository<import('../../../dist/src/prototype/definition').PrototypeDefinition>} */
class LocalWorkflowDefinitionRepository {
  constructor(directory){
    this.directory=path.resolve(directory);this.diagnostics=[];
    try{fs.mkdirSync(this.directory,{recursive:true});}catch{throw new DefinitionError('UNAVAILABLE');}
    this.checkFormat();
  }
  checkFormat(){
    let names;try{names=fs.readdirSync(this.directory);}catch{throw new DefinitionError('UNAVAILABLE');}
    if(names.some(name=>name.toLowerCase().endsWith('.json')&&!/^definition-[0-9a-f]{64}\.json$/.test(name)))
      throw new DefinitionError('LEGACY_DEFINITION_FORMAT');
  }
  file(id,version){
    validateDefinitionKey(id);validateDefinitionKey(version);
    const key=createHash('sha256').update(JSON.stringify([id,version]),'utf8').digest('hex');
    return path.join(this.directory,'definition-'+key+'.json');
  }
  async add(input){
    const definition=validatePrototypeDefinition(input),file=this.file(definition.definitionId,definition.definitionVersion);
    this.checkFormat();
    try{const result=createJsonFile(file,definition);this.diagnostics.push(...result.cleanupDiagnostics);}catch(error){
      const failure=new DefinitionError(error.code==='EEXIST'?'DEFINITION_ALREADY_EXISTS':'UNAVAILABLE');
      failure.storageStage=error.storageStage;
      if(error.cleanupDiagnostics)failure.cleanupDiagnostics=[...error.cleanupDiagnostics];
      throw failure;
    }
  }
  async get(id,version){
    const file=this.file(id,version);let raw;
    this.checkFormat();
    try{raw=readJsonFile(file);}catch(error){throw new DefinitionError(error instanceof SyntaxError?'DATA_CORRUPT':'UNAVAILABLE');}
    if(raw===null){if(fs.existsSync(file))throw new DefinitionError('DATA_CORRUPT');return null;}
    const definition=validatePrototypeDefinition(raw);
    if(definition.definitionId!==id||definition.definitionVersion!==version)throw new DefinitionError('DEFINITION_IDENTITY_MISMATCH');
    return definition;
  }
}
module.exports={LocalWorkflowDefinitionRepository};
