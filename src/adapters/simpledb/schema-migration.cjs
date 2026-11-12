'use strict';
// Compatibility entry: ARCH defaults are loaded only when explicitly requested or omitted.
const engine=require('./schema-migration-engine.cjs');
function defaultRegistry(){
  return require('./schema-migration-registry.cjs').SCHEMA_MIGRATION_REGISTRY;
}
function planSchemaMigration(file,options,registry=undefined){
  return engine.planSchemaMigration(file,options,registry===undefined?defaultRegistry():registry);
}
function executeSchemaMigration(file,input,registry=undefined){
  return engine.executeSchemaMigration(file,input,registry===undefined?defaultRegistry():registry);
}
Object.defineProperty(module.exports,'SCHEMA_MIGRATION_REGISTRY',{
  enumerable:true,get:defaultRegistry
});
module.exports.planSchemaMigration=planSchemaMigration;
module.exports.executeSchemaMigration=executeSchemaMigration;
