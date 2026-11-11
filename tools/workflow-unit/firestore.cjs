'use strict';
const emulator=require('./src/adapters/workflow-firestore/emulator.cjs'),legacy=require('./src/adapters/workflow-firestore/store.cjs'),composition=require('./src/adapters/workflow-firestore/composition.cjs');
const {FirestoreWaitingStore:Implementation}=require('./src/adapters/workflow-firestore/waiting.cjs');
class FirestoreWaitingStore {
 #impl;#products;
 constructor(connection,config){
  const keys=['runId','definitionId','definitionVersion','definitionDigest','ownerId','leaseMs'];
  if(!config||typeof config!=='object'||Array.isArray(config)||Reflect.ownKeys(config).some(k=>!keys.includes(k)))throw Object.assign(Error('INVALID_ARGUMENT'),{code:'INVALID_ARGUMENT'});
  this.#impl=new Implementation(connection,{...config});this.#products=Object.freeze({has:k=>this.#impl.products.has(k),get:k=>this.#impl.products.get(k),put:(k,v)=>this.#impl.products.put(k,v)});
 }
 get products(){return this.#products;}
 get poisoned(){return this.#impl.poisoned;}
 get lastMutationId(){return this.#impl.lastMutationId;}
 read(){return this.#impl.read();}
 load(id){return this.#impl.load(id);}
 save(value){return this.#impl.save(value);}
 claimStart(id){return this.#impl.claimStart(id);}
 claimWaiting(saved,request){return this.#impl.claimWaiting(saved,request);}
 claimLimit(saved,id){return this.#impl.claimLimit(saved,id);}
 heartbeat(){return this.#impl.heartbeat();}
 getInput(){return this.#impl.getInput();}
 observeMutation(id){return this.#impl.observeMutation(id);}
 observeOperation(request,options){return this.#impl.observeOperation(request,options);}
}
exports.connectEmulator=emulator.connectEmulator;
exports.validateEnvironment=emulator.validateEnvironment;
exports.leaseValid=emulator.leaseValid;
exports.PersistenceError=emulator.PersistenceError;
// Legacy compatibility only; not a new Lifecycle capability.
exports.fail=emulator.fail;
exports.Timestamp=emulator.Timestamp;
exports.FieldValue=emulator.FieldValue;
exports.FirestoreExperimentStore=legacy.FirestoreExperimentStore;
exports.hash=legacy.hash;
exports.createExecution=composition.createExecution;
exports.FirestoreWaitingStore=FirestoreWaitingStore;
