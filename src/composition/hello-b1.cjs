'use strict';
const {HelloWorld}=require('../../dist/src/hello/core');
const {RepositoryError}=require('../../dist/src/hello/contracts');
const {CommunicationError,failureCodes}=require('../../dist/src/hello-client/contracts');
const {createDispatch,developmentVerifier,operationPolicy}=require('../../dist/src/hello-host/dispatch');
const {openLocalFile}=require('../adapters/hello/local-file.cjs');
const {openNodeHost,validateHostOptions}=require('../adapters/hello-node/host.cjs');
const hostCapabilities=['host.json-http','host.authn-boundary','host.authz-boundary','host.loopback-only'];
const storageCapabilities=['repository.atomic-create','repository.revision-write','storage.restart-persistence'];
const offers=Object.freeze({host:Object.freeze(hostCapabilities.map(name=>Object.freeze({name,version:1}))),storage:Object.freeze(storageCapabilities.map(name=>Object.freeze({name,version:1})))});
async function startB1(binding, dependencies={}) {
  const hostOptions={address:'127.0.0.1',port:0,allowMissingOrigin:false,stopTimeoutMs:30000,...binding?.host?.options};
  validateHostOptions(hostOptions);
  if(binding?.applicationId!=='hello-world'||binding.host?.provider!=='node-http'||binding.storage?.provider!=='local-file'||
      typeof binding.storage?.options?.directory!=='string'||!binding.storage.options.directory||!['anonymous','fake'].includes(binding.auth?.mode))
    throw new CommunicationError('UNSUPPORTED_CONFIGURATION');
  for(const slot of ['host','storage']) {
    const requirements=binding.requires?.[slot]??offers[slot];
    if(!Array.isArray(requirements)||requirements.some(request=>!request||!offers[slot].some(offer=>offer.name===request.name&&offer.version===request.version)))
      throw new CommunicationError('UNSUPPORTED_CONFIGURATION');
  }
  let storage,host;
  try {
    storage=await (dependencies.openStorage||openLocalFile)(binding.storage.options.directory);
    const core=new HelloWorld(storage.port);
    const dispatch=createDispatch(core,developmentVerifier(binding.auth.mode),operationPolicy);
    host=await (dependencies.openHost||openNodeHost)(hostOptions,dispatch);
    return {origin:host.origin,developmentOnly:true,
      stop: (()=>{let stopped;return ()=>stopped??(stopped=(async()=>{
        // Never close storage while a timed-out Host may still be mutating it.
        await host.stop();await storage.close();
      })());})(),
    };
  } catch(error) {
    const primary=error instanceof CommunicationError?error:new CommunicationError(
      error instanceof RepositoryError&&failureCodes.includes(error.code)?error.code:'UNAVAILABLE');
    for(const cleanup of [host&&(()=>host.stop()),storage&&(()=>storage.close())].filter(Boolean)) {
      try{await cleanup();}catch{primary.cleanupDiagnostics=[...(primary.cleanupDiagnostics||[]),'CLEANUP_FAILED'];}
    }
    throw primary;
  }
}
module.exports={startB1,offers};
