'use strict';
// Experiment-only: no ADC, no production endpoint, no network discovery.
const {Firestore,Timestamp,FieldValue}=require('@google-cloud/firestore');
class PersistenceError extends Error {constructor(code){super(code);this.code=code;this.name='PersistenceError';}}
const fail=code=>{throw new PersistenceError(code);};
function validateEnvironment(env){
 if(!env||!/^127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(env.FIRESTORE_EMULATOR_HOST||''))fail('EMULATOR_REQUIRED');
 if(Number(env.FIRESTORE_EMULATOR_HOST.split(':')[1])>65535)fail('EMULATOR_REQUIRED');
 if(!/^demo-arch026-c2(?:-[a-z0-9-]+)?$/.test(env.projectId||''))fail('DEMO_PROJECT_REQUIRED');
 if(!/^c2-[a-z0-9-]{1,80}$/.test(env.namespace||''))fail('NAMESPACE_REQUIRED');
 return {...env};
}
async function connectEmulator(options){
 const env=validateEnvironment(options);
 if(process.env.FIRESTORE_EMULATOR_HOST!==env.FIRESTORE_EMULATOR_HOST)fail('EMULATOR_ENV_MISMATCH');
 // Probe the emulator-only API before constructing the SDK. Never fall back.
 let response;
 try{response=await fetch(`http://${env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${env.projectId}:ruleCoverage`,{signal:AbortSignal.timeout(3000),redirect:'error'});}catch{fail('EMULATOR_UNAVAILABLE');}
 if(!response.ok)fail('EMULATOR_UNAVAILABLE');
 let probe;try{probe=await response.json();}catch{fail('EMULATOR_UNAVAILABLE');}
 if(!probe||typeof probe!=='object'||!Object.hasOwn(probe,'rules'))fail('EMULATOR_UNAVAILABLE');
 const db=new Firestore({projectId:env.projectId,host:env.FIRESTORE_EMULATOR_HOST,ssl:false,
   credentials:{client_email:'emulator-only@invalid.example',private_key:'unused'},preferRest:false});
 return {db,root:db.collection('arch026_c2').doc(env.namespace),close:()=>db.terminate()};
}
// Comparison is at the server read point, NOT an assertion about commit time.
function leaseValid(expires,readTime){
 if(!(expires instanceof Timestamp)||!(readTime instanceof Timestamp))fail('CLOCK_UNAVAILABLE');
 return expires.seconds>readTime.seconds||(expires.seconds===readTime.seconds&&expires.nanoseconds>readTime.nanoseconds);
}
module.exports={connectEmulator,validateEnvironment,leaseValid,PersistenceError,fail,Timestamp,FieldValue};
