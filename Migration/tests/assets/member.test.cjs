'use strict';
const publicRequire=require('node:module').createRequire(require('node:path').resolve(__dirname,'../../../Frwk_Units/Member/package.json'));
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {normalizeMemberId,memberObject}=publicRequire('@arch026/member');
test('Member: installed Core dependency matches its source package',()=>{for(const name of ['package.json','src/StorageId.js'])assert.deepEqual(fs.readFileSync(path.join(__dirname,'../../../Frwk_Units/Member/node_modules/@arch026/core',name)),fs.readFileSync(path.join(__dirname,'../../../Frwk_Units/Core',name)));assert.equal(normalizeMemberId(' M001 '),'M001');});
test('Member: rejects invalid identifiers and malformed document',()=>{for(const x of [null,3,'..','a/b','日'.repeat(501)])assert.throws(()=>normalizeMemberId(x));assert.throws(()=>memberObject({member_id:'M002',name:'Synthetic',status:'active'},'M001'));});
test('Member: minimal legacy object contract',()=>assert.deepEqual(memberObject({member_id:'M001',name:'Synthetic',status:'active',extra:1},'M001'),{member_id:'M001',name:'Synthetic',status:'active'}));
// Member.yml is intentionally not claimed as verified by these object tests.
