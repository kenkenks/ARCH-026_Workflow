'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
// One suite, only the fixture factory changes. Exercise both Core and raw Repository boundaries.
function repositoryContract(name, fixture) {
  function check(label, action) {
    test(`${name}: ${label}`, async () => { const f = await fixture(); try { await action(f); } finally { await f.close(); } });
  }
  check('A1 Add Read', async ({core}) => {
    const added = await core.add({id:'sample-1',message:'hello'});
    assert.deepEqual(added.record,{id:'sample-1',message:'hello'});
    assert.equal(typeof added.revision,'string'); assert.ok(added.revision);
    assert.deepEqual(await core.read('sample-1'),added);
    assert.deepEqual((await core.read('sample-1')).record,{id:'sample-1',message:'hello'});
  });
  check('A2 Write Read and identical Write changes Revision', async ({core}) => {
    const a = await core.add({id:'sample-1',message:''});
    const b = await core.write({...a.record,message:'updated'},a.revision);
    assert.deepEqual(b.record,{id:'sample-1',message:'updated'});
    assert.deepEqual((await core.read('sample-1')).record,{id:'sample-1',message:'updated'});
    assert.notEqual(a.revision,b.revision); assert.deepEqual(await core.read('sample-1'),b);
    const c = await core.write(b.record,b.revision); assert.notEqual(c.revision,b.revision);
    await assert.rejects(core.write(a.record,a.revision),{code:'CONFLICT'});
  });
  check('A3 missing Read', async ({core}) => assert.equal(await core.read('missing'),null));
  check('A4 missing Write is not upsert', async ({core}) => {
    await assert.rejects(core.write({id:'missing',message:'x'},'opaque'),{code:'NOT_FOUND'});
    assert.equal(await core.read('missing'),null);
  });
  check('A5 duplicate Add preserves original', async ({core}) => {
    const a = await core.add({id:'sample-1',message:'original'});
    await assert.rejects(core.add({id:'sample-1',message:'other'}),{code:'ALREADY_EXISTS'});
    assert.deepEqual(await core.read('sample-1'),a);
  });
  check('A6 Core and Adapter share validation', async ({core,repository}) => {
    for (const api of [core,repository]) {
      for (const input of [null,[],{}, {id:'x'}, {id:'x',message:1}, {id:'x',message:'',extra:1}]) {
        await assert.rejects(api.add(input),{code:'VALIDATION_FAILED'});
        await assert.rejects(api.write(input,'rev'),{code:'VALIDATION_FAILED'});
      }
      for (const id of ['', ' a','a/b','a'.repeat(65),'x\n']) {
        await assert.rejects(api.read(id),{code:'INVALID_ARGUMENT'});
        await assert.rejects(api.add({id,message:''}),{code:'INVALID_ARGUMENT'});
      }
      await assert.rejects(api.write({id:'x',message:''},''),{code:'INVALID_ARGUMENT'});
    }
    assert.equal(await core.read('x'),null);
  });
  check('A9 parallel Write is CAS', async ({core}) => {
    const a = await core.add({id:'sample-1',message:'original'});
    const results = await Promise.allSettled(['one','two'].map(message => core.write({id:'sample-1',message},a.revision)));
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.find(x=>x.status==='rejected').reason.code,'CONFLICT');
    assert.deepEqual(await core.read('sample-1'),results.find(x=>x.status==='fulfilled').value);
  });
  check('A10 parallel Add is create-only', async ({core}) => {
    const results = await Promise.allSettled(['one','two'].map(message=>core.add({id:'sample-1',message})));
    assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(results.find(x=>x.status==='rejected').reason.code,'ALREADY_EXISTS');
    assert.deepEqual(await core.read('sample-1'),results.find(x=>x.status==='fulfilled').value);
  });
  check('A11 inputs and outputs are detached, including queued input', async ({core,repository}) => {
    const input = {id:'sample-1',message:'original'};
    const pending = repository.add(input); input.message='mutated';
    const added = await pending; const revision=added.revision; added.record.message='mutated';
    const first = await core.read('sample-1'); assert.equal(first.record.message,'original'); first.record.message='mutated';
    const update={id:'sample-1',message:'updated'};
    const writing=repository.write(update,revision); update.message='mutated'; await writing;
    assert.equal((await core.read('sample-1')).record.message,'updated');
  });
}
module.exports={repositoryContract};
