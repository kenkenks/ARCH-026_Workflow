'use strict';
const {LocalWorkflowDefinitionRepository}=require('../../src/adapters/workflow-definition/local-file.cjs');
const {CMemoryHistoryStore}=require('../../dist/src/prototype/workflow');
const {loadWorkflow}=require('../../dist/src/prototype/definition');
const {definition,registry}=require('./fixture.cjs');
(async()=>{
  const [mode,directory,version='v1',id='saved-example']=process.argv.slice(2);
  const repo=new LocalWorkflowDefinitionRepository(directory);
  if(mode==='read'){console.log(JSON.stringify(await repo.get(id,version)));return;}
  if(mode==='race'){
    process.on('message',async message=>{
      if(message!=='GO')return;
      try{await repo.add(definition());process.send('ADDED');}catch(error){process.send(error.code);}
      process.disconnect();
    });process.send('READY');return;
  }
  if(mode==='save'){await repo.add(definition(version));console.log(JSON.stringify({saved:true}));return;}
  const rebuilt=await loadWorkflow(repo,'saved-example',version,registry(),new CMemoryHistoryStore());
  const result=await rebuilt.workflow.run('child-run',rebuilt.startStepNo);
  console.log(JSON.stringify({definition:rebuilt.definition,result}));
})().catch(e=>{console.error(e.code||'UNEXPECTED_ERROR');process.exitCode=1;});
