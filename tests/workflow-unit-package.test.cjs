'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {build}=require('../tools/package-workflow-unit.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
test('Unit whitelist uses byte-identical current Core/Adapter and contains no SQLite runtime',()=>{const {record}=build();for(const name of ['workflow','job-form','definition','diagnosis'])assert.equal(record.files[`dist/src/prototype/${name}.js`],sha(fs.readFileSync(path.join(__dirname,`../dist/src/prototype/${name}.js`))));
 for(const name of ['emulator','store','composition'])assert.equal(record.files[`src/adapters/workflow-firestore/${name}.cjs`],sha(fs.readFileSync(path.join(__dirname,`../src/adapters/workflow-firestore/${name}.cjs`))));assert.ok(!Object.keys(record.files).some(p=>/sqlite|simpledb|demo|engine\.js/i.test(p)));});
test('same sources rebuild the same immutable package SHA-256',()=>{assert.equal(build().record.sha256,build().record.sha256);});
