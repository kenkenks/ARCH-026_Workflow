import { CWorkflow, CDummyJob, CCheckJob, CSequenceBool, CMemoryHistoryStore, CWorkflowMonitor } from './workflow';
async function main() {
  const store = new CMemoryHistoryStore();
  const workflow = new CWorkflow([
    {no: 10, job: new CDummyJob('仮ジョブA'), nextStepNo: 20},
    {no: 20, job: new CCheckJob('判定', new CSequenceBool([false, false, true]), 10, 30)},
    {no: 30, job: new CDummyJob('仮ジョブB'), nextStepNo: 40},
    {no: 40, job: new CDummyJob('仮ジョブC')},
  ], store);
  const result = await workflow.run('demo-001', 10, 30);
  const monitor = new CWorkflowMonitor(store);
  console.log(`実行ID=${result.runId} 状態=${result.status} 現在工程=${result.currentStepNo ?? 'END'}`);
  console.table(result.history.map(({order, stepNo, job, result, nextStepNo}) => ({order, stepNo, job, result, next: nextStepNo ?? 'END'})));
  console.log('工程別サマリー'); console.table(await monitor.summary(result.runId));
  if (result.status !== 'COMPLETED') process.exitCode = 1;
}
main().catch(err => { console.error(err); process.exitCode = 1; });
