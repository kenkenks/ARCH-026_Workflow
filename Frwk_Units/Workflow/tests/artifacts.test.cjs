'use strict';
const {test}=require('node:test'),a=require('node:assert/strict');
const api=require('@arch026/workflow');
const {ArtifactManager,CJobForm,CMemoryHistoryStore,reconstructWorkflow,createMemoryProductShelf,getRecorded,ARTIFACT_DEFINITION_SCHEMA_VERSION:version}=api;
class Form extends CJobForm{
 constructor(name,phases={}){super(name);this.phases=phases;}
 collect(p,c){return this.phases.collect?this.phases.collect(p,c):10;}
 make(i,c){return this.phases.make?this.phases.make(i,c):i;}
 record(o,c){return this.phases.record?.(o,c);}
 post(o,c){return this.phases.post?this.phases.post(o,c):super.post(o,c);}
 cleanup(c){return this.phases.cleanup?.(c);}
}
const job=(id,no,box,next)=>({stepId:id,stepNo:no,kind:'JOB',jobId:id,...(box?{output:{box}}:{}),...(next?{nextStepId:next}:{})});
const definition=(steps=[job('p',10)],boxes=['review'])=>({schemaVersion:version,definitionId:'artifacts',definitionVersion:'1',startStepId:steps[0].stepId,artifactBoxes:boxes,steps});
const registry=(forms)=>({jobs:new Map(),checks:new Map(),nativeForms:new Map(Object.entries(forms).map(([id,form])=>[id,{form,artifactKey:'X'}]))});
const build=(d,forms,store=new CMemoryHistoryStore(),continuation,manager)=>reconstructWorkflow(d,registry(forms),store,continuation,manager);
test('artifact manager uses detached Memory shelves, read-only views and separate box identities',()=>{
 const m=new ArtifactManager(['review','other']),value={n:[1]};m.shelf().put('X',value);value.n[0]=9;a.deepEqual(m.reader().get('X'),{n:[1]});const got=m.reader().get('X');got.n[0]=8;a.deepEqual(m.reader().get('X'),{n:[1]});
 m.shelf('review').put('X',20);m.shelf('other').put('X',30);a.equal(m.readPort().box('review').get('X'),20);a.equal(m.reader('other').get('X'),30);a.equal(m.reader('review').put,undefined);a.equal(m.readPort().shelf,undefined);
 m.shelf().put('undefined',undefined);a.equal(m.reader().has('undefined'),true);a.equal(m.reader().get('missing'),undefined);a.equal(m.reader().has('missing'),false);
 for(const names of [['default'],['x','x'],[''],[null]])a.throws(()=>new ArtifactManager(names));a.throws(()=>m.reader('missing'),{code:'UNKNOWN_ARTIFACT_BOX'});
});
test('default output and collect reuse the common products entry',async()=>{
 const d=definition([job('p',10,null,'q'),job('q',20)]),g=build(d,{p:new Form('p'),q:new Form('q',{collect:p=>p.get('X'),make:n=>n+20})});
 a.equal((await g.workflow.run('default',10)).status,'COMPLETED');a.equal(g.artifacts.reader().get('X'),30);
});
test('explicit named output wins; named collect reads through typed Context port while products stays default',async()=>{
 const g=build(definition([job('p',10,'review','q'),job('q',20)]),{p:new Form('p'),q:new Form('q',{collect:(p,c)=>{a.equal(p.has('X'),false);a.equal(c.products.has('X'),false);return c.artifacts.box('review').get('X');},make:n=>n+20})});
 await g.workflow.run('named',10);a.equal(g.artifacts.reader('review').get('X'),10);a.equal(g.artifacts.reader().get('X'),30);
});
test('same key in two named boxes never aliases',async()=>{
 const g=build(definition([job('p',10,'review','q'),job('q',20,'other')],['review','other']),{p:new Form('p'),q:new Form('q',{make:()=>20})});await g.workflow.run('boxes',10);a.equal(g.artifacts.reader('review').get('X'),10);a.equal(g.artifacts.reader('other').get('X'),20);
});
test('same Form concurrently uses independent managers and per-visit contexts',async()=>{
 const contexts=[],form=new Form('shared',{collect:async(p,c)=>{contexts.push(c);await Promise.resolve();return p.get('input');}}),d=definition([job('p',10,'review')]),one=build(d,{p:form}),two=build(d,{p:form});
 one.artifacts.shelf().put('input',1);two.artifacts.shelf().put('input',2);await Promise.all([one.workflow.run('one',10),two.workflow.run('two',10)]);a.notStrictEqual(contexts[0],contexts[1]);a.equal(one.artifacts.reader('review').get('X'),1);a.equal(two.artifacts.reader('review').get('X'),2);
});
test('backward visits reuse the Form with fresh contexts and overwrite only the same box/key',async()=>{
 let count=0;const contexts=[],form=new Form('p',{collect:(_p,c)=>{contexts.push(c);return ++count;}}),d=definition([job('p',10,'review','check'),{stepId:'check',stepNo:20,kind:'CHECK_BOOL',checkId:'done',trueStepId:'end',falseStepId:'p'},job('end',30)]),r=registry({p:form,end:new Form('end')});r.checks.set('done',()=>({evaluate:()=>count===3}));const g=reconstructWorkflow(d,r,new CMemoryHistoryStore());
 a.equal((await g.workflow.run('loop',10)).status,'COMPLETED');a.equal(new Set(contexts).size,3);a.equal(g.artifacts.reader('review').get('X'),3);a.deepEqual(contexts.map(c=>getRecorded(c).value),[1,2,3]);
});
test('record completion stays private until post actually publishes',async()=>{
 let entered,release;const wait=new Promise(r=>entered=r),gate=new Promise(r=>release=r);const g=build(definition([job('p',10,'review')]),{p:new Form('p',{post:async(o,c)=>{entered(c);await gate;return c.outputProducts.put(c.artifactKey,o);}})});const running=g.workflow.run('boundary',10),c=await wait;a.deepEqual(getRecorded(c),{value:10});a.equal(g.artifacts.reader('review').has('X'),false);release();await running;a.equal(g.artifacts.reader('review').get('X'),10);
});
test('record failure never publishes or fabricates an internal result',async()=>{
 let context;const g=build(definition([job('p',10,'review')]),{p:new Form('p',{record:(_o,c)=>{context=c;throw Error('record');}})});a.equal((await g.workflow.run('record-error',10)).status,'FAILED');a.equal(getRecorded(context),null);a.equal(g.artifacts.reader('review').has('X'),false);
});
test('post failure before publication retains internal result only',async()=>{
 let context;const g=build(definition([job('p',10,'review')]),{p:new Form('p',{post:(_o,c)=>{context=c;throw Error('post');}})});a.equal((await g.workflow.run('post-error',10)).status,'FAILED');a.deepEqual(getRecorded(context),{value:10});a.equal(g.artifacts.reader('review').has('X'),false);
});
test('publication then post failure leaves the published product and FAILED history',async()=>{
 const g=build(definition([job('p',10,'review')]),{p:new Form('p',{post:(o,c)=>{c.outputProducts.put(c.artifactKey,o);throw Error('after-publication');}})});const s=await g.workflow.run('partial',10);a.equal(s.status,'FAILED');a.equal(s.history[0].result,'ERROR');a.equal(g.artifacts.reader('review').get('X'),10);
});
test('cleanup failure never removes an already published product',async()=>{
 const g=build(definition([job('p',10,'review')]),{p:new Form('p',{cleanup:()=>{throw Error('cleanup');}})});a.equal((await g.workflow.run('cleanup-error',10)).status,'FAILED');a.equal(g.artifacts.reader('review').get('X'),10);
});
test('overridden post does not automatically run the default publication',async()=>{
 const g=build(definition([job('p',10,'review')]),{p:new Form('p',{post:()=>{}})});a.equal((await g.workflow.run('custom-post',10)).status,'COMPLETED');a.equal(g.artifacts.reader('review').has('X'),false);
});
test('invalid new definitions are rejected before any Job or Check factory',()=>{
 const changes=[d=>d.artifactBoxes=['review','review'],d=>d.artifactBoxes=['default'],d=>d.artifactBoxes=[''],d=>d.artifactBoxes=[0],d=>d.artifactBoxes=null,d=>d.steps[0].output={box:'missing'},d=>d.steps[0].output={box:0},d=>d.steps[0].output=null,d=>d.steps[0].output={box:'review',extra:true}];
 for(const change of changes){const d=definition();change(d);let calls=0;const r=registry({p:new Form('p')});r.jobs.set('unused',()=>{calls++;throw Error('factory');});a.throws(()=>reconstructWorkflow(d,r,new CMemoryHistoryStore()),{code:'INVALID_DEFINITION'});a.equal(calls,0);}
});
test('legacy schemas still reject artifact fields and old registrations remain explicitly unsupported in new schema',()=>{
 for(const schemaVersion of ['prototype-workflow/1','prototype-workflow/2'])a.throws(()=>api.validatePrototypeDefinition({...definition(),schemaVersion}),{code:'INVALID_DEFINITION'});
 let calls=0;const r={jobs:new Map([['p',()=>{calls++;return new api.CDummyJob('legacy');}]]),checks:new Map()};a.throws(()=>reconstructWorkflow(definition(),r,new CMemoryHistoryStore()),{code:'UNSUPPORTED_ARTIFACT_JOB'});a.equal(calls,0);
 const old={jobs:new Map(),checks:new Map(),jobForms:{products:createMemoryProductShelf(),definitions:new Map([['p',{form:{name:'p',collect:()=>1,make:n=>n},artifactKey:'X'}]])}};a.throws(()=>reconstructWorkflow(definition(),old,new CMemoryHistoryStore()),{code:'UNSUPPORTED_ARTIFACT_JOB'});
});
test('explicit shared default Shelf injection retains caller-controlled sharing',async()=>{
 const shared=createMemoryProductShelf(),d=definition(),forms={p:new Form('p')};const r=registry(forms);r.jobForms={products:shared,definitions:new Map()};const one=reconstructWorkflow(d,r,new CMemoryHistoryStore()),two=reconstructWorkflow(d,r,new CMemoryHistoryStore());a.notStrictEqual(one.artifacts,two.artifacts);await one.workflow.run('shared-a',10);a.equal(two.artifacts.reader().get('X'),10);
});
test('LIMIT resume reattaches the same manager and refuses a fresh replacement before Job execution',async()=>{
 let reads=0;const d=definition([job('p',10,'review','q'),job('q',20)]),forms={p:new Form('p'),q:new Form('q',{collect:(_p,c)=>{reads++;return c.artifacts.box('review').get('X');}})},store=new CMemoryHistoryStore(),g=build(d,forms,store),saved=await g.workflow.run('limit',10,1);
 a.throws(()=>build(d,forms,store,{history:saved.history}),{code:'ARTIFACT_RESTORE_UNSUPPORTED'});
 const lost=build(d,forms,store);await a.rejects(lost.workflow.resume(saved),{code:'ARTIFACT_RESTORE_UNSUPPORTED'});a.equal(reads,0);a.deepEqual(store.load('limit'),saved);
 const resumed=build(d,forms,store,{history:saved.history},g.artifacts);a.equal((await resumed.workflow.resume(saved)).status,'COMPLETED');a.equal(reads,1);a.equal(g.artifacts.reader().get('X'),10);
});
test('WAITING resume preserves manager, does not repeat producer and refuses lost-manager claims',async()=>{
 let made=0,claims=0;const d=definition([job('p',10,'review','wait'),{stepId:'wait',stepNo:15,kind:'WAIT',reason:'approval',nextStepId:'q'},job('q',20)]),forms={p:new Form('p',{make:()=>++made}),q:new Form('q',{collect:(_p,c)=>c.artifacts.box('review').get('X')})},store=new CMemoryHistoryStore();
 store.claimWaiting=async saved=>{claims++;const next={...saved,status:'RUNNING',currentStepNo:saved.waiting.nextStepNo};delete next.waiting;store.save(next);return {replayed:false,snapshot:next};};const g=build(d,forms,store),saved=await g.workflow.run('wait',10),op={runId:'wait',operationId:'resume',expectedWaitGeneration:1,expectedRevision:1,result:true};
 await a.rejects(build(d,forms,store).workflow.resumeWaiting(saved,op),{code:'ARTIFACT_RESTORE_UNSUPPORTED'});a.equal(claims,0);const done=await build(d,forms,store,{history:saved.history},g.artifacts).workflow.resumeWaiting(saved,op);a.equal(done.status,'COMPLETED');a.equal(made,1);a.equal(g.artifacts.reader().get('X'),1);
});
test('manager cannot leak prior products into a different runId through graph reuse',async()=>{
 const g=build(definition(),{p:new Form('p')});await g.workflow.run('first',10);await a.rejects(g.workflow.run('second',10),{code:'ARTIFACT_RUN_MISMATCH'});
});
