'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHttpClient,MAX_BODY_BYTES,DEFAULT_TIMEOUT_MS}=require('../dist/src/adapters/hello-http/client');
const {validateHelloRequest,validateHelloResult}=require('../dist/src/hello-client/wire');
const {CommunicationError}=require('../dist/src/hello-client/contracts');
const record={id:'sample-1',message:'hello'};
const stored={record,revision:'opaque-1'};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function safe(code){return e=>{
  assert.ok(e instanceof CommunicationError);assert.equal(e.code,code);assert.equal(e.message,code);
  assert.equal(e.stack,undefined);assert.equal(e.cause,undefined);
  assert.doesNotMatch(JSON.stringify(e),/SECRET|RAW_BODY|PRIVATE/);return true;
};}
for(const operation of ['read','add','write'])test(`${operation} success, wire request and credential, one fetch`,async()=>{
  let count=0;const credentialCalls=[];
  const client=createHttpClient({endpoint:'http://127.0.0.1:3100/api/hello',credentialSource:{async getCredential(refresh){credentialCalls.push(refresh);return 'fixture';}},
    async fetchImpl(url,init){
      count++;assert.equal(url,'http://127.0.0.1:3100/api/hello');assert.equal(init.method,'POST');
      assert.equal(init.headers.get('Content-Type'),'application/json');assert.equal(init.headers.get('Authorization'),'Bearer fixture');
      assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
      assert.deepEqual(JSON.parse(init.body),operation==='read'?{operation,id:record.id}:operation==='add'?{operation,record}:{operation,record,expectedRevision:'old'});
      return json({ok:true,value:stored});
    }});
  const result=await (operation==='read'?client.read(record.id):operation==='add'?client.add(record):client.write(record,'old'));
  assert.deepEqual(result,stored);assert.equal(count,1);assert.deepEqual(credentialCalls,[false]);
});
test('missing Read returns null',async()=>assert.equal(await createHttpClient({fetchImpl:async()=>json({ok:true,value:null})}).read('missing'),null));
for(const [code,status,operation] of [
  ['NOT_FOUND',404,'write'],['ALREADY_EXISTS',409,'add'],['CONFLICT',409,'write'],
  ['VALIDATION_FAILED',400,'add'],['UNAUTHENTICATED',401,'write'],['FORBIDDEN',403,'add'],
  ['UNAVAILABLE',503,'read'],['OUTCOME_UNKNOWN',503,'write'],
])test(`${code} is validated, sanitized, never retried`,async()=>{
  let calls=0;
  const client=createHttpClient({fetchImpl:async()=>{calls++;return json({ok:false,error:{code,issues:[{path:'SECRET',rule:'PRIVATE'}]}},status);}});
  await assert.rejects(operation==='read'?client.read('x'):operation==='add'?client.add(record):client.write(record,'r'),safe(code));
  assert.equal(calls,1);
});
test('invalid input fails before credentials and fetch',async()=>{
  let calls=0;
  const client=createHttpClient({credentialSource:{async getCredential(){calls++;return null;}},fetchImpl:async()=>{calls++;throw Error();}});
  for(const input of [{id:'x'}, {id:'x',message:1}, {id:'x',message:'',extra:true}])await assert.rejects(client.add(input),safe('VALIDATION_FAILED'));
  await assert.rejects(client.read('bad/id'),safe('INVALID_ARGUMENT'));
  await assert.rejects(client.write(record,''),safe('INVALID_ARGUMENT'));
  assert.equal(calls,0);
});
test('64KiB request limit measures UTF-8 envelope bytes',async()=>{
  let calls=0;
  const client=createHttpClient({fetchImpl:async(_,init)=>{calls++;assert.equal(new TextEncoder().encode(init.body).byteLength,MAX_BODY_BYTES);return json({ok:false,error:{code:'ALREADY_EXISTS'}},409);}});
  const overhead=new TextEncoder().encode(JSON.stringify({operation:'add',record:{id:'x',message:''}})).byteLength;
  await assert.rejects(client.add({id:'x',message:'a'.repeat(MAX_BODY_BYTES-overhead)}),safe('ALREADY_EXISTS'));
  await assert.rejects(client.add({id:'x',message:'a'.repeat(MAX_BODY_BYTES-overhead+1)}),safe('INVALID_ARGUMENT'));
  await assert.rejects(client.add({id:'x',message:'あ'.repeat(MAX_BODY_BYTES/2)}),safe('INVALID_ARGUMENT'));
  assert.equal(calls,1);assert.equal(DEFAULT_TIMEOUT_MS,30000);
});
const badResponses=[
  ()=>json({ok:false,error:{code:'UNKNOWN'}},400),
  ()=>json({ok:false,error:{code:'CONFLICT'}},200),
  ()=>json({ok:true,value:stored},409),
  ()=>new Response('SECRET RAW_BODY',{status:200,headers:{'Content-Type':'application/json'}}),
  ()=>json({ok:true,value:{record:{id:'sample-1',message:4},revision:'r'}}),
  ()=>json({ok:true,value:{record,revision:''}}),
  ()=>json({ok:true,value:{record:{id:'other',message:'hello'},revision:'r'}}),
  ()=>json({ok:true,value:stored,stack:'PRIVATE'}),
  ()=>new Response('{}',{headers:{'Content-Type':'text/html'}}),
  ()=>json({ok:false,error:{code:'NOT_FOUND',stack:'PRIVATE'}},404),
];
test('unknown codes, contradictions, invalid JSON/schema/results rejected per operation',async()=>{
  for(const bad of badResponses)for(const op of ['read','add','write']){
    let calls=0;const client=createHttpClient({fetchImpl:async()=>{calls++;return bad();}});
    await assert.rejects(op==='read'?client.read(record.id):op==='add'?client.add(record):client.write(record,'r'),safe(op==='read'?'INTERNAL':'OUTCOME_UNKNOWN'));
    assert.equal(calls,1);
  }
});
test('null is not a successful Add or Write',async()=>{
  const client=createHttpClient({fetchImpl:async()=>json({ok:true,value:null})});
  await assert.rejects(client.add(record),safe('OUTCOME_UNKNOWN'));await assert.rejects(client.write(record,'r'),safe('OUTCOME_UNKNOWN'));
});
for(const phase of ['fetch','body'])test(`${phase} response loss: Read unavailable, mutations unknown, no retry`,async()=>{
  for(const op of ['read','add','write']){
    let calls=0;const client=createHttpClient({fetchImpl:async()=>{
      calls++;if(phase==='fetch')throw Error('SECRET PRIVATE');
      return new Response(new ReadableStream({start(controller){controller.error(Error('SECRET RAW_BODY'));}}));
    }});
    await assert.rejects(op==='read'?client.read('x'):op==='add'?client.add(record):client.write(record,'r'),safe(op==='read'?'UNAVAILABLE':'OUTCOME_UNKNOWN'));assert.equal(calls,1);
  }
});
for(const phase of ['fetch','body'])test(`${phase} timeout even if injected fetch ignores abort`,async()=>{
  for(const op of ['read','add','write']){
    let calls=0,signal;
    const client=createHttpClient({timeoutMs:15,fetchImpl:async(_,init)=>{
      calls++;signal=init.signal;
      if(phase==='fetch')return new Promise(()=>{});
      return new Response(new ReadableStream({pull:()=>new Promise(()=>{})}));
    }});
    await assert.rejects(op==='read'?client.read('x'):op==='add'?client.add(record):client.write(record,'r'),safe(op==='read'?'UNAVAILABLE':'OUTCOME_UNKNOWN'));
    assert.equal(signal.aborted,true);assert.equal(calls,1);
  }
});
test('credential failures and late credentials never send, no raw error leak',async()=>{
  let calls=0;
  const client=createHttpClient({fetchImpl:async()=>{calls++;throw Error();},credentialSource:{async getCredential(){throw Error('SECRET PRIVATE');}}});
  await assert.rejects(client.add(record),safe('UNAVAILABLE'));await assert.rejects(client.read('x'),safe('UNAVAILABLE'));
  let resolve;
  const slow=createHttpClient({timeoutMs:10,fetchImpl:async()=>{calls++;throw Error();},credentialSource:{getCredential:()=>new Promise(r=>{resolve=r;})}});
  await assert.rejects(slow.write(record,'r'),safe('UNAVAILABLE'));resolve('fixture');await new Promise(r=>setTimeout(r,5));assert.equal(calls,0);
});
test('input is snapshotted before asynchronous credentials',async()=>{
  let release;const input={...record};
  const client=createHttpClient({credentialSource:{getCredential:()=>new Promise(r=>{release=r;})},fetchImpl:async(_,init)=>{
    assert.deepEqual(JSON.parse(init.body).record,record);return json({ok:true,value:stored});
  }});
  const pending=client.add(input);input.message='changed';release(null);await pending;
});
test('request validator rejects extra fields and Result validator is pure',()=>{
  assert.throws(()=>validateHelloRequest({operation:'read',id:'x',extra:1}),safe('INVALID_ARGUMENT'));
  assert.throws(()=>validateHelloRequest([{operation:'read',id:'x'}]),safe('INVALID_ARGUMENT'));
  assert.deepEqual(validateHelloRequest({operation:'write',record,expectedRevision:'r'}),{operation:'write',record,expectedRevision:'r'});
  assert.deepEqual(validateHelloResult({ok:true,value:stored},{operation:'read',id:record.id},200),{ok:true,value:stored});
});
test('invalid endpoint or timeout is rejected without network',()=>{
  for(const endpoint of ['https://example.test/other','//example.test/api/hello','file:///api/hello','/api/hello?token=SECRET','http://user:pass@example.test/api/hello'])assert.throws(()=>createHttpClient({endpoint}),{code:'UNSUPPORTED_CONFIGURATION'});
  for(const timeoutMs of [0,-1,NaN,Infinity,2**32])assert.throws(()=>createHttpClient({timeoutMs}),{code:'UNSUPPORTED_CONFIGURATION'});
});

const invoke=(client,op)=>op==='read'?client.read(record.id):op==='add'?client.add(record):client.write(record,'old');
test('invalid issues are rejected with the exact operation-specific code',async()=>{
  for(const issues of [null,{},[{path:1,rule:'x'}],[{path:'x',rule:1}],[{path:'x',rule:'x',extra:true}]]){
    for(const op of ['read','add','write']){
      let calls=0;
      const client=createHttpClient({fetchImpl:async()=>{calls++;return json({ok:false,error:{code:'CONFLICT',issues}},409);}});
      await assert.rejects(invoke(client,op),safe(op==='read'?'INTERNAL':'OUTCOME_UNKNOWN'));
      assert.equal(calls,1);
    }
  }
});
test('mutation success must match the requested record and Write must renew Revision',async()=>{
  for(const op of ['add','write'])for(const value of [
    {record:{...record,message:'different'},revision:'new'},
    {record:{...record,id:'other'},revision:'new'},
    ...(op==='write'?[{record,revision:'old'}]:[]),
  ]){
    let calls=0;const client=createHttpClient({fetchImpl:async()=>{calls++;return json({ok:true,value});}});
    await assert.rejects(invoke(client,op),safe('OUTCOME_UNKNOWN'));assert.equal(calls,1);
  }
  // No ordering/numeric interpretation: only nonempty string and inequality matter.
  const client=createHttpClient({fetchImpl:async()=>json({ok:true,value:{record,revision:'0'}})});
  assert.equal((await client.write(record,'999')).revision,'0');
});
function byteStream(bytes, headers={}, onCancel=()=>{}) {
  let offset=0;
  return new Response(new ReadableStream({
    pull(controller){
      if(offset===bytes.length){controller.close();return;}
      const end=Math.min(offset+1024,bytes.length);controller.enqueue(bytes.slice(offset,end));offset=end;
    },cancel:onCancel,
  },{highWaterMark:0}),{headers:{'Content-Type':'application/json',...headers}});
}
test('response at 64KiB succeeds using actual bytes regardless of Content-Length',async()=>{
  for(const op of ['read','add','write'])for(const length of [undefined,'1','999999']){
    const text=JSON.stringify({ok:true,value:stored});
    const bytes=new TextEncoder().encode(text+' '.repeat(MAX_BODY_BYTES-new TextEncoder().encode(text).length));
    let calls=0;
    const client=createHttpClient({fetchImpl:async()=>{calls++;return byteStream(bytes,length===undefined?{}:{'Content-Length':length});}});
    assert.deepEqual(await invoke(client,op),stored);assert.equal(calls,1);
  }
});
test('response over 64KiB cancels reading and never retries, even with forged length',async()=>{
  for(const op of ['read','add','write'])for(const length of [undefined,'1']){
    const bytes=new TextEncoder().encode('あ'.repeat(Math.floor(MAX_BODY_BYTES/3)+1));
    assert.ok(bytes.length>MAX_BODY_BYTES);
    let calls=0,canceled=0,signal;
    const client=createHttpClient({fetchImpl:async(_,init)=>{calls++;signal=init.signal;return byteStream(bytes,length===undefined?{}:{'Content-Length':length},()=>{canceled++;});}});
    await assert.rejects(invoke(client,op),safe(op==='read'?'INTERNAL':'OUTCOME_UNKNOWN'));
    assert.equal(calls,1);assert.equal(canceled,1);assert.equal(signal.aborted,true);
  }
});
test('UTF-8 split across stream chunks is decoded after bounded byte collection',async()=>{
  const value={record:{id:record.id,message:'あいう'},revision:'opaque'};
  const bytes=new TextEncoder().encode(JSON.stringify({ok:true,value}));let offset=0;
  const client=createHttpClient({fetchImpl:async()=>new Response(new ReadableStream({pull(c){if(offset===bytes.length)c.close();else c.enqueue(bytes.slice(offset,++offset));}}),{headers:{'Content-Type':'application/json'}})});
  assert.deepEqual(await client.read(record.id),value);
});
test('stream cancellation/release failures do not replace the oversized-response error',async()=>{
  for(const mode of ['reject','throw','hang'])for(const op of ['read','add','write']){
    let cancel=0,release=0;
    const client=createHttpClient({timeoutMs:100,fetchImpl:async()=>({
      body:{getReader:()=>({read:async()=>({done:false,value:new Uint8Array(MAX_BODY_BYTES+1)}),
        cancel(){cancel++;if(mode==='throw')throw Error('SECRET');if(mode==='hang')return new Promise(()=>{});return Promise.reject(Error('PRIVATE'));},
        releaseLock(){release++;throw Error('RAW_BODY');},
      })},
    })});
    await assert.rejects(invoke(client,op),safe(op==='read'?'INTERNAL':'OUTCOME_UNKNOWN'));
    assert.ok(cancel>=1);assert.equal(release,1);
  }
});
test('timeout cancels a pending response stream without cleanup overriding the error',async()=>{
  for(const op of ['read','add','write']){
    let cancel=0,calls=0,signal;
    const client=createHttpClient({timeoutMs:15,fetchImpl:async(_,init)=>{
      calls++;signal=init.signal;
      return new Response(new ReadableStream({pull:()=>new Promise(()=>{}),cancel(){cancel++;throw Error('SECRET');}}));
    }});
    await assert.rejects(invoke(client,op),safe(op==='read'?'UNAVAILABLE':'OUTCOME_UNKNOWN'));
    assert.equal(calls,1);assert.ok(cancel>=1);assert.equal(signal.aborted,true);
  }
});
test('response arriving after timeout is canceled without starting a body read',async()=>{
  let deliver,cancel=0,pull=0,calls=0;
  const client=createHttpClient({timeoutMs:10,fetchImpl:()=>{calls++;return new Promise(resolve=>{deliver=resolve;});}});
  await assert.rejects(client.add(record),safe('OUTCOME_UNKNOWN'));
  deliver(new Response(new ReadableStream({pull(){pull++;return new Promise(()=>{});},cancel(){cancel++;}}, {highWaterMark:0})));
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls,1);assert.equal(cancel,1);assert.equal(pull,0);
});
