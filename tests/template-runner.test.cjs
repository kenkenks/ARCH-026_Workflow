const test=require('node:test');const assert=require('node:assert/strict');
const {prepare}=require('../gui/template-runner.js');
const catalog=[{keyword:'demo.one',displayName:'受付',jobClass:'CJob',enabled:true}];
const linear={id:'demo',version:'draft-1',startStepId:'S1',steps:[{id:'S1',type:'JOB',jobId:'demo.one',nextStepId:'S2'},{id:'S2',type:'END'}],eventRoutes:[]};
test('ひな型を表示名付きの模擬実行工程に変換',()=>{const r=prepare(linear,catalog);assert.equal(r.start,10);assert.deepEqual(r.steps.map(x=>x.name),['受付','END']);assert.equal(r.steps[0].next,20);});
test('未登録・無効JOBを拒否',()=>{assert.throws(()=>prepare(linear,[]),/未登録JOB/);assert.throws(()=>prepare(linear,[{...catalog[0],enabled:false}]),/無効JOB/);});
test('審査サンプルの判定とイベントは実行不可として拒否',()=>{const def=require('../src/definitions/exam-workflow.example.json');assert.throws(()=>prepare(def,catalog),/未対応/);});
