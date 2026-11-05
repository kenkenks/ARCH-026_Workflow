'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {validate,DefinitionStore}=require('../gui/workflow-definitions.js');
const sample=require('../src/definitions/exam-workflow.example.json');
test('既存の審査定義を検証できる',()=>assert.deepEqual(validate(sample),[]));
test('不正な参照・重複を拒否',()=>{const d=structuredClone(sample);d.steps[1].nextStepId='MISSING';d.steps[2].id=d.steps[1].id;assert.ok(validate(d).some(x=>x.includes('重複')));assert.ok(validate(d).some(x=>x.includes('MISSING')));});
test('保存・読込・上書き制限・削除',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arch026-'));try{const store=new DefinitionStore(dir);store.save(sample);assert.equal(store.list().length,1);assert.deepEqual(store.get(sample.id,sample.version),sample);assert.throws(()=>store.save(sample),{status:409});store.save(sample,{overwrite:true});assert.equal(store.remove(sample.id,sample.version),true);assert.equal(store.list().length,0);}finally{fs.rmSync(dir,{recursive:true,force:true});}});
