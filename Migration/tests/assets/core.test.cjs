'use strict';
const publicRequire=require('node:module').createRequire(require('node:path').resolve(__dirname,'../../../Frwk_Units/Core/package.json'));
const {test}=require('node:test'),assert=require('node:assert/strict');
const {runSteps}=publicRequire('@arch026/core/flow');
const {normalizeStorageId,byteLength}=publicRequire('@arch026/core/storage-id');
test('Core: synchronous result remains synchronous',()=>assert.equal(runSteps((function*(){return (yield 2)+3;})()),5));
test('Core: asynchronous result and rejected-yield propagation',async()=>{assert.equal(await runSteps((function*(){return (yield Promise.resolve(2))+3;})()),5);assert.equal(await runSteps((function*(){try{yield Promise.reject(Error('fixture'));}catch{return 7;}})()),7);});
test('Core: identifier validation and UTF-8 byte limit',()=>{assert.equal(normalizeStorageId('ID-1'),'ID-1');assert.equal(byteLength('日'),3);for(const x of ['','..','a/b','a\\b','日'.repeat(501)])assert.throws(()=>normalizeStorageId(x));});
