'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {fork}=require('node:child_process');
const {startB1}=require('../src/composition/hello-b1.cjs');
const {openNodeHost}=require('../src/adapters/hello-node/host.cjs');
const {openMemory}=require('../src/adapters/hello/memory.cjs');
const {HelloWorld}=require('../dist/src/hello/core');
const {createDispatch,developmentVerifier,operationPolicy}=require('../dist/src/hello-host/dispatch');
const {CommunicationError}=require('../dist/src/hello-client/contracts');
const {createHttpClient}=require('../dist/src/adapters/hello-http/client');
const rec={id:'x',message:'hello'};
const hostOptions={address:'127.0.0.1',port:0,allowMissingOrigin:false,stopTimeoutMs:3000};
const binding=directory=>({applicationId:'hello-world',host:{provider:'node-http'},storage:{provider:'local-file',options:{directory}},auth:{mode:'anonymous'}});
async function temporary(action){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'arch026-b1-'));try{return await action(dir);}finally{await fs.rm(dir,{recursive:true,force:true});}}
function request(origin,{method='POST',url='/api/hello',headers={},body=JSON.stringify({operation:'read',id:'x'}),chunks}={}){
  return new Promise((resolve,reject)=>{
    const u=new URL(origin);const req=http.request({hostname:'127.0.0.1',port:u.port,path:url,method,
      headers:{Host:u.host,Origin:origin,'Content-Type':'application/json',...headers}},res=>{
      const data=[];res.on('data',c=>data.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(Buffer.concat(data).toString())}));
    });req.on('error',reject);if(chunks){for(const c of chunks)req.write(c);req.end();}else req.end(body);
  });
}
function client(origin,credential){return createHttpClient({endpoint:origin+'/api/hello',credentialSource:credential?{async getCredential(){return credential;}}:undefined,
  fetchImpl:(url,init)=>{const headers=new Headers(init.headers);headers.set('Origin',origin);return fetch(url,{...init,headers});}});}
test('real HTTP via existing client: Add Read Write, missing, duplicate, Schema, CAS',()=>temporary(async dir=>{
  const app=await startB1(binding(dir));try{
    const c=client(app.origin);const a=await c.add(rec);assert.deepEqual(a.record,rec);assert.deepEqual(await c.read('x'),a);
    const changed={id:'x',message:'updated'};const b=await c.write(changed,a.revision);assert.deepEqual((await c.read('x')).record,changed);assert.notEqual(b.revision,a.revision);
    assert.equal(await c.read('missing'),null);
    await assert.rejects(c.write({id:'missing',message:''},'r'),{code:'NOT_FOUND'});
    await assert.rejects(c.add(rec),{code:'ALREADY_EXISTS'});await assert.rejects(c.write(rec,a.revision),{code:'CONFLICT'});
    const bad=await request(app.origin,{body:JSON.stringify({operation:'add',record:{id:'bad',message:2}})});
    assert.equal(bad.status,400);assert.equal(bad.body.error.code,'VALIDATION_FAILED');assert.equal(await c.read('bad'),null);
  }finally{await app.stop();}
}));
for(const [label,options,status,code] of [
  ['oversized chunked request',{chunks:[Buffer.alloc(65536,' '),Buffer.from(' ')]},413,'INVALID_ARGUMENT'],
  ['invalid JSON',{body:'PRIVATE_RAW'},400,'INVALID_ARGUMENT'],
  ['invalid content type',{headers:{'Content-Type':'text/plain'}},415,'INVALID_ARGUMENT'],
  ['unsupported method',{method:'GET',body:''},405,'INVALID_ARGUMENT'],
  ['unsupported path',{url:'/private/file'},404,'INVALID_ARGUMENT'],
  ['wrong Origin',{headers:{Origin:'http://other.invalid'}},403,'FORBIDDEN'],
  ['wrong Host',{headers:{Host:'other.invalid'}},403,'FORBIDDEN'],
  ['missing Origin',{headers:{Origin:undefined}},403,'FORBIDDEN'],
])test(label,()=>temporary(async dir=>{
  const app=await startB1(binding(dir));try{
    // Omit header rather than handing undefined to node:http.
    let result;
    if(label==='missing Origin')result=await fetch(app.origin+'/api/hello',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(async r=>({status:r.status,body:await r.json()}));
    else result=await request(app.origin,options);
    assert.equal(result.status,status);assert.deepEqual(result.body,{ok:false,error:{code}});
  }finally{await app.stop();}
}));
test('64KiB exact body accepted, response limit, invalid UTF-8 and forged Principal rejected',()=>temporary(async dir=>{
  const app=await startB1(binding(dir));try{
    const text=JSON.stringify({operation:'read',id:'x'});
    const exact=await request(app.origin,{body:text+' '.repeat(65536-Buffer.byteLength(text))});assert.equal(exact.status,200);assert.equal(exact.body.value,null);
    const forged=await request(app.origin,{body:JSON.stringify({operation:'add',record:rec,principal:{role:'writer'}})});assert.equal(forged.body.error.code,'INVALID_ARGUMENT');
    const invalid=await request(app.origin,{chunks:[Buffer.from([0xff])]});assert.equal(invalid.status,400);
    // A valid request near the limit can produce a larger Stored envelope; never send an oversized Result.
    const prefix=JSON.stringify({operation:'add',record:{id:'large',message:''}});
    const large=await request(app.origin,{body:JSON.stringify({operation:'add',record:{id:'large',message:'a'.repeat(65536-Buffer.byteLength(prefix))}})});
    assert.equal(large.body.error.code,'OUTCOME_UNKNOWN');
    const read=await request(app.origin,{body:JSON.stringify({operation:'read',id:'large'})});assert.equal(read.body.error.code,'INTERNAL');
  }finally{await app.stop();}
}));
test('Fake credentials and authorization reject without Core or Repository calls',async()=>{
  let coreCalls=0,repositoryCalls=0;
  const repo={read:async()=>{repositoryCalls++;return null;},add:async()=>{repositoryCalls++;throw Error();},write:async()=>{repositoryCalls++;throw Error();}};
  const real=new HelloWorld(repo);
  const spy={read:(...a)=>{coreCalls++;return real.read(...a);},add:(...a)=>{coreCalls++;return real.add(...a);},write:(...a)=>{coreCalls++;return real.write(...a);}};
  const host=await openNodeHost(hostOptions,createDispatch(spy,developmentVerifier('fake'),operationPolicy));
  try{
    for(const credential of [undefined,'unknown'])await assert.rejects(client(host.origin,credential).read('x'),{code:'UNAUTHENTICATED'});
    await assert.rejects(client(host.origin,'fixture-reader').add(rec),{code:'FORBIDDEN'});
    await assert.rejects(client(host.origin,'fixture-reader').write(rec,'r'),{code:'FORBIDDEN'});
    assert.equal(coreCalls,0);assert.equal(repositoryCalls,0);
    assert.equal(await client(host.origin,'fixture-reader').read('x'),null);assert.equal(coreCalls,1);assert.equal(repositoryCalls,1);
  }finally{await host.stop();}
});
test('fake writer Composition and explicit nonbrowser mode',()=>temporary(async dir=>{
  const b=binding(dir);b.auth.mode='fake';b.host.options={allowMissingOrigin:true};
  const app=await startB1(b);try{
    const c=createHttpClient({endpoint:app.origin+'/api/hello',credentialSource:{async getCredential(){return 'fixture-writer';}}});
    assert.deepEqual((await c.add(rec)).record,rec);
  }finally{await app.stop();}
}));
test('capability/configuration rejection occurs before storage open',async()=>{
  let opened=0;
  for(const change of [b=>{b.requires={host:[{name:'missing',version:1}]};},b=>{b.requires={storage:[{name:'repository.atomic-create',version:2}]};},b=>{b.host.options={address:'0.0.0.0'};},b=>{b.auth.mode='production';}]){
    const b=binding('unused');change(b);
    await assert.rejects(startB1(b,{openStorage:async()=>{opened++;throw Error();}}),{code:'UNSUPPORTED_CONFIGURATION'});
  }
  assert.equal(opened,0);
});
test('Host restart preserves record/Revision and normal stop releases lock',()=>temporary(async dir=>{
  const app=await startB1(binding(dir));const a=await client(app.origin).add(rec);
  await app.stop();await app.stop();await assert.rejects(fs.stat(path.join(dir,'owner.lock')),{code:'ENOENT'});
  const next=await startB1(binding(dir));try{assert.deepEqual(await client(next.origin).read('x'),a);}finally{await next.stop();}
}));
test('listen failure closes already-opened Storage; original error survives cleanup failure',()=>temporary(async dir=>{
  const first=await startB1(binding(path.join(dir,'first')));
  try{
    const b=binding(path.join(dir,'second'));b.host.options={port:Number(new URL(first.origin).port)};
    await assert.rejects(startB1(b),{code:'UNAVAILABLE'});await assert.rejects(fs.stat(path.join(dir,'second','owner.lock')),{code:'ENOENT'});
    await assert.rejects(startB1(binding(path.join(dir,'third')),{
      openStorage:async()=>({port:{},async close(){throw Error('PRIVATE');}}),
      openHost:async()=>{throw new CommunicationError('OUTCOME_UNKNOWN');},
    }),e=>e.code==='OUTCOME_UNKNOWN'&&JSON.stringify(e.cleanupDiagnostics)==='["CLEANUP_FAILED"]'&&!JSON.stringify(e).includes('PRIVATE'));
  }finally{await first.stop();}
}));
test('accepted mutation drains before Storage close',()=>temporary(async dir=>{
  let release,entered;const started=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});let closed=false;
  const {openLocalFile}=require('../src/adapters/hello/local-file.cjs');
  const app=await startB1(binding(dir),{openStorage:async directory=>{
    const real=await openLocalFile(directory);
    return {port:{...real.port,async add(rec){entered();await gate;assert.equal(closed,false);return real.port.add(rec);}},async close(){closed=true;await real.close();}};
  }});
  const pending=client(app.origin).add(rec);await started;const stopping=app.stop();
  await new Promise(r=>setTimeout(r,20));assert.equal(closed,false);release();assert.deepEqual((await pending).record,rec);await stopping;assert.equal(closed,true);
  const next=await startB1(binding(dir));try{assert.deepEqual((await client(next.origin).read('x')).record,rec);}finally{await next.stop();}
}));
test('Common Dispatch normalizes failures and never serializes raw causes',async()=>{
  for(const [op,expected]of [['read','INTERNAL'],['add','OUTCOME_UNKNOWN'],['write','OUTCOME_UNKNOWN']]){
    const core={read:async()=>{throw Error('PRIVATE');},add:async()=>{throw Error('PRIVATE');},write:async()=>{throw Error('PRIVATE');}};
    const dispatch=createDispatch(core,developmentVerifier('anonymous'),operationPolicy);
    const result=await dispatch({credential:null,payload:op==='read'?{operation:op,id:'x'}:op==='add'?{operation:op,record:rec}:{operation:op,record:rec,expectedRevision:'r'}});
    assert.deepEqual(result,{ok:false,error:{code:expected}});
  }
});
test('Storage initialization error keeps OUTCOME_UNKNOWN without exposing its stack',async()=>{
  const {RepositoryError}=require('../dist/src/hello/contracts');
  await assert.rejects(startB1(binding('unused'),{openStorage:async()=>{throw new RepositoryError('OUTCOME_UNKNOWN');}}),e=>e.code==='OUTCOME_UNKNOWN'&&e.stack===undefined);
});
test('stop timeout never closes Storage while an accepted write is pending',()=>temporary(async dir=>{
  let release,entered;const started=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});let storage;
  const b=binding(dir);b.host.options={stopTimeoutMs:20};
  const {openLocalFile}=require('../src/adapters/hello/local-file.cjs');
  const app=await startB1(b,{openStorage:async directory=>{
    storage=await openLocalFile(directory);
    return {port:{...storage.port,async add(record){entered();await gate;return storage.port.add(record);}},async close(){throw Error('must not close before draining');}};
  }});
  const pending=client(app.origin).add(rec);const observed=pending.catch(e=>e);await started;
  await assert.rejects(app.stop(),{code:'OUTCOME_UNKNOWN'});
  assert.ok(await fs.stat(path.join(dir,'owner.lock')));release();await observed;
  // The test explicitly drains and closes its own fixture; production keeps the lock on failed stop.
  for(let i=0;i<50;i++){if(await storage.port.read('x'))break;await new Promise(r=>setTimeout(r,5));}
  await storage.close();
}));
test('Windows-compatible child Host IPC ready/stop exits and releases lock',()=>temporary(async dir=>{
  const child=fork(path.join(__dirname,'../tools/hello-b1.cjs'),[dir],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
  let exited=false;
  const exit=new Promise((resolve,reject)=>{child.once('exit',code=>{exited=true;code===0?resolve():reject(Error('child failed'));});});
  const message=type=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.off('message',listener);reject(Error('IPC timeout'));},5000);
    const listener=m=>{if(m.type===type){clearTimeout(timer);child.off('message',listener);resolve(m);}};child.on('message',listener);
  });
  try{
    const ready=await message('ready');assert.equal(ready.developmentOnly,true);await client(ready.origin).add(rec);
    const stopped=message('stopped');child.send({type:'stop'});await stopped;await exit;await assert.rejects(fs.stat(path.join(dir,'owner.lock')),{code:'ENOENT'});
  }finally{if(!exited){child.kill();await exit.catch(()=>{});}}
}));
