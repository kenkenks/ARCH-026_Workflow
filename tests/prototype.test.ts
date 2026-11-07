import assert from 'node:assert/strict';
import test from 'node:test';
import { CWorkflow, CDummyJob, CCheckJob, CSequenceBool, CMemoryHistoryStore, CWorkflowMonitor } from '../src/prototype/workflow';
function setup(values: boolean[]) {
  const store = new CMemoryHistoryStore();
  const workflow = new CWorkflow([
    {no: 10, job: new CDummyJob('A'), nextStepNo: 20},
    {no: 20, job: new CCheckJob('check', new CSequenceBool(values), 10, 30)},
    {no: 30, job: new CDummyJob('B')},
  ], store);
  return {workflow, store};
}
test('true advances', async () => {
  const {workflow} = setup([true]); const s = await workflow.run('a', 10);
  assert.equal(s.status, 'COMPLETED'); assert.deepEqual(s.history.map(e => e.stepNo), [10,20,30]);
});
test('false false true returns twice then advances', async () => {
  const {workflow,store} = setup([false,false,true]); const s = await workflow.run('b', 10);
  assert.equal(s.status, 'COMPLETED');
  assert.deepEqual(s.history.map(e => e.stepNo), [10,20,10,20,10,20,30]);
  const monitor = new CWorkflowMonitor(store);
  assert.equal((await monitor.summary('b')).find(x => x.stepNo===10)?.executions, 3);
});
test('infinite false is bounded', async () => {
  const {workflow} = setup([false]); const s = await workflow.run('c', 10, 6);
  assert.equal(s.status, 'LIMIT_REACHED'); assert.equal(s.history.length, 6);
});
test('invalid target rejected', () => {
  assert.throws(() => new CWorkflow([{no:10,job:new CDummyJob('A'),nextStepNo:999}],new CMemoryHistoryStore()), /Unknown target/);
});
test('job failure retained', async () => {
  const store = new CMemoryHistoryStore();
  const wf = new CWorkflow([{no:10,job:new CDummyJob('bad',()=>{throw Error('boom')})}],store);
  const s = await wf.run('d',10); assert.equal(s.status,'FAILED'); assert.equal(s.history[0].result,'ERROR');
});
test('duplicate run ID rejected', async () => {
  const {workflow} = setup([true]); await workflow.run('x',10);
  await assert.rejects(workflow.run('x',10),/already exists/);
});

test('CDummyJob awaits async callback success and rejection under CJob contract', async () => {
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter=resolve; });
  const gate = new Promise<void>(resolve => { release=resolve; });
  const store = new CMemoryHistoryStore();
  const wf = new CWorkflow([{no:1,job:new CDummyJob('async',async()=>{enter();await gate;})}],store);
  const running=wf.run('async-success',1);await entered;
  assert.equal(store.load('async-success')?.status,'RUNNING');assert.equal(store.load('async-success')?.history.length,0);
  release();assert.equal((await running).status,'COMPLETED');
  const fail=new CWorkflow([{no:1,job:new CDummyJob('reject',async()=>{throw Error('callback reject');})}],new CMemoryHistoryStore());
  const result=await fail.run('async-failure',1);assert.equal(result.status,'FAILED');assert.equal(result.history[0].result,'ERROR');assert.match(result.history[0].error,/callback reject/);
});
