'use strict';
const {MemoryLifecycleBackend,WaitingHistoryStore}=require('./src/adapters/workflow-waiting/lifecycle.cjs');
function options(value){
 const keys=['runId','definitionId','definitionVersion','definitionDigest','ownerId','leaseMs'];
 if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).some(k=>!keys.includes(k)))throw Object.assign(Error('INVALID_ARGUMENT'),{code:'INVALID_ARGUMENT'});
 return {...value};
}
class MemoryWaitingStore {
 #impl;#products;
 constructor(config){this.#impl=new WaitingHistoryStore(new MemoryLifecycleBackend(),options(config));this.#products=Object.freeze({has:k=>this.#impl.products.has(k),get:k=>this.#impl.products.get(k),put:(k,v)=>this.#impl.products.put(k,v)});}
 get products(){return this.#products;}
 get poisoned(){return this.#impl.poisoned;}
 read(){return this.#impl.read();}
 load(id){return this.#impl.load(id);}
 save(value){return this.#impl.save(value);}
 claimStart(id){return this.#impl.claimStart(id);}
 claimWaiting(saved,request){return this.#impl.claimWaiting(saved,request);}
 claimLimit(saved,id){return this.#impl.claimLimit(saved,id);}
 heartbeat(){return this.#impl.heartbeat();}
 getInput(){return this.#impl.getInput();}
}
module.exports={MemoryWaitingStore};
