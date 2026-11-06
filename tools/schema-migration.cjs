'use strict';
const fs=require('node:fs');
const {planSchemaMigration,executeSchemaMigration}=require('../src/adapters/simpledb/schema-migration.cjs');
try{
  const [mode,...args]=process.argv.slice(2);let result;
  if(mode==='dry-run'&&args.length===3){
    const [kind,file,target]=args;result=planSchemaMigration(file,{kind,targetVersion:Number(target)});
  }else if(mode==='apply'&&args.length===2){
    const [file,planFile]=args;result=executeSchemaMigration(file,JSON.parse(fs.readFileSync(planFile,'utf8')));
  }else throw Error('INVALID_ARGUMENT');
  process.stdout.write(JSON.stringify(result,null,2)+'\n');if(result.ok===false)process.exitCode=2;
}catch(error){
  const known=new Set(['UNKNOWN_DB_KIND','DB_KIND_MISMATCH','UNKNOWN_VERSION','DOWNGRADE_UNSUPPORTED','MIGRATION_PATH_MISSING',
    'PHYSICAL_SCHEMA_MISMATCH','DATA_CORRUPT','INVALID_PLAN','REGISTRY_CHANGED','UNAVAILABLE','MIGRATION_REQUIRED']);
  process.stderr.write((known.has(error?.code)?error.code:'SCHEMA_MIGRATION_FAILED')+'\n');process.exitCode=1;
}
