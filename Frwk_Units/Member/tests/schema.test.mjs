import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

// Test composition uses the existing DB Builder public API, not a runtime
// dependency from Member to DB Builder and not a new YAML/schema framework.
const dbRequire=createRequire(new URL('../../DB/Builder/package.json',import.meta.url));
const {parsePortableDefinition,validatePortableDefinition,transformPortableDefinition}=
  await import(pathToFileURL(dbRequire.resolve('@arch026/db-builder/definition')).href);
const {renderFirestoreSchema,renderFirestoreDocuments,verifyFirestoreDocuments,restoreFirestoreRecord}=
  dbRequire('@arch026/db-builder/firestore');
const {normalizeMemberId,memberObject}=createRequire(new URL('../package.json',import.meta.url))('@arch026/member');
const source=readFileSync(new URL('../schema/Member.yml',import.meta.url),'utf8');
const load=()=>parsePortableDefinition(source);
const render=()=>renderFirestoreSchema(transformPortableDefinition(load()));

// This is the current checked-in Member definition, not a newly proposed
// domain rule. Intentional schema revisions must review this regression list.
const declared=[
  ['member_id','string','Identity'],
  ['member_name','string','Name'],['member_name_kana','string','Name'],
  ['member_type','string','State'],['status','string','State'],
  ['billing_group_id','string','Relation'],
  ['joined_date','string','Track'],['withdrawn_date','string','Track'],
  ['suspension_start_month','string','Track'],['suspension_end_month','string','Track'],
  ['birth_date','string','Profile'],['insurance_type','string','Profile'],
  ['email','string','Profile'],['phone','string','Profile'],['remarks','string','Profile'],
  ['current_rank','string','State'],['rank_source','string','Track'],
  ['rank_updated_at','string','Track'],['rank_start_date','string','Track'],
  ['carried_training_count','number','State'],['eligible_training_count','number','State']
];
function record(){return Object.fromEntries(declared.map(([name,type])=>[name,
  name==='member_id'?'SYNTHETIC-M001':type==='number'?3:'synthetic']));}

test('Member YAML parses with the existing supported Portable Definition grammar',()=>{
  const d=load();assert.equal(d.entity,'member');assert.equal(d.version,'0.1');
  assert.ok(Array.isArray(d.fields));assert.equal(validatePortableDefinition(d),'member_id');
  assert.deepEqual(d.sources,{gas:{sheet:'01_会員マスタ'},firestore:{collection:'members'}});
});

test('all 21 declared fields retain their names, scalar types and semantic groups',()=>{
  const d=load();assert.deepEqual(d.fields,declared.map(([name,type,group],i)=>({name,type,group,...(i===0?{primary_key:true}:{})})));
});

test('primary-key identity is preserved without inventing required flags',()=>{
  const d=load(),t=transformPortableDefinition(d);assert.deepEqual(d.fields.filter(f=>f.primary_key===true).map(f=>f.name),['member_id']);
  assert.equal(t.schema.fields.member_id.type,'string');assert.equal(t.schema.fields.member_id.primaryKey,true);
  assert.ok(Object.values(t.schema.fields).every(f=>f.required===false));
});

test('GAS and Firestore mappings preserve the actual definition and every field',()=>{
  const t=transformPortableDefinition(load()),r=renderFirestoreSchema(t),names=declared.map(f=>f[0]);
  assert.deepEqual(t.writable,names);assert.equal(t.sources.gas.keyField,'member_id');assert.equal(t.sources.gas.keyColumn,1);
  assert.equal(t.sources.gas.sheet,'01_会員マスタ');assert.equal(r.collection,'members');assert.equal(r.documentIdField,'member_id');
  assert.deepEqual(r.fields.map(f=>[f.logicalName,f.physicalName,f.type]),declared.map(([name,type])=>[name,name,type]));
});

test('a fully populated synthetic record roundtrips through the existing renderer',()=>{
  const r=render(),row=record(),before=structuredClone(row),[document]=renderFirestoreDocuments(r,[row]);
  assert.equal(document.id,row.member_id);assert.equal(Object.hasOwn(document.fields,'member_id'),false);
  assert.equal(verifyFirestoreDocuments(r,[document]).ok,true);assert.deepEqual(restoreFirestoreRecord(r,document),row);
  assert.deepEqual(row,before);
});

test('undeclared mandatory fields are not added: optional omissions and nulls remain optional',()=>{
  const r=render(),row={member_id:'SYNTHETIC-M001',member_name:null,carried_training_count:null};
  const [document]=renderFirestoreDocuments(r,[row]);assert.deepEqual(document,{id:row.member_id,fields:{}});
  assert.equal(verifyFirestoreDocuments(r,[document]).ok,true);assert.deepEqual(restoreFirestoreRecord(r,document),{member_id:row.member_id});
});

test('the public Member API agrees on shared member_id and status scalar values',()=>{
  const id=normalizeMemberId(' SYNTHETIC-M001 '),r=render(),row={member_id:id,status:'synthetic'};
  assert.equal(load().fields.find(f=>f.name==='status').type,'string');
  const object=memberObject({...row,name:'Synthetic'},id);assert.equal(object.member_id,id);assert.equal(object.status,row.status);
  assert.equal(renderFirestoreDocuments(r,[row])[0].id,id);
});

test('schema member_name is not silently remapped to the public API name field',()=>{
  const row={member_id:'SYNTHETIC-M001',member_name:'Synthetic',status:'synthetic'};
  assert.equal(verifyFirestoreDocuments(render(),renderFirestoreDocuments(render(),[row])).ok,true);
  assert.throws(()=>memberObject(row,row.member_id),/INVALID_MEMBER_DOCUMENT/);
  assert.equal(load().fields.some(f=>f.name==='name'),false);
});

test('the public DTO status requirement is not silently added to the schema',()=>{
  const id='SYNTHETIC-M001',r=render();
  assert.equal(verifyFirestoreDocuments(r,renderFirestoreDocuments(r,[{member_id:id}])).ok,true);
  assert.throws(()=>memberObject({member_id:id,name:'Synthetic'},id),/INVALID_MEMBER_DOCUMENT/);
});

test('unsupported malformed field indentation is rejected by the current YAML reader',()=>{
  assert.throws(()=>parsePortableDefinition(source.replace('    type: string','   type: string')),/Unsupported fields YAML/);
});

test('missing entity, version or fields is rejected by the existing definition validator',()=>{
  for(const key of ['entity','version','fields']){const d=load();delete d[key];assert.throws(()=>validatePortableDefinition(d));}
  const d=load();d.fields=[];assert.throws(()=>validatePortableDefinition(d),/fields are required/);
});

test('duplicate field names and missing field types are rejected',()=>{
  const duplicate=load();duplicate.fields.push({...duplicate.fields[1]});assert.throws(()=>validatePortableDefinition(duplicate),/unique/);
  const untyped=load();delete untyped.fields[1].type;assert.throws(()=>validatePortableDefinition(untyped),/Field type is required/);
});

test('zero or multiple primary keys are rejected',()=>{
  const missing=load();delete missing.fields[0].primary_key;assert.throws(()=>validatePortableDefinition(missing),/Primary key is required/);
  const multiple=load();multiple.fields[1].primary_key=true;assert.throws(()=>validatePortableDefinition(multiple),/one primary key/);
});

test('unknown semantic groups are rejected',()=>{
  const d=load();d.fields[1].group='UnknownGroup';assert.throws(()=>validatePortableDefinition(d),/Unsupported field group/);
});

test('missing Firestore collection and invalid declared GAS sheet mappings are rejected',()=>{
  const firestore=load();delete firestore.sources.firestore.collection;assert.throws(()=>validatePortableDefinition(firestore),/collection mapping/);
  const gas=load();gas.sources.gas.sheet='';assert.throws(()=>validatePortableDefinition(gas),/GAS sheet mapping/);
});

test('record values incompatible with the declared string/finite-number types are rejected',()=>{
  const r=render();for(const [field,value]of [['member_name',42],['carried_training_count','3'],['eligible_training_count',NaN],['eligible_training_count',Infinity]]){
    assert.throws(()=>renderFirestoreDocuments(r,[{...record(),[field]:value}]),/TYPE_MISMATCH/);
  }
});

test('missing identifiers and contradictory physical identifier values are rejected',()=>{
  const r=render();assert.throws(()=>renderFirestoreDocuments(r,[{}]),/DOCUMENT_ID_REQUIRED/);
  const bad={id:'SYNTHETIC-M001',fields:{member_id:'OTHER'}};
  assert.equal(verifyFirestoreDocuments(r,[bad]).ok,false);assert.throws(()=>restoreFirestoreRecord(r,bad),/DOCUMENT_ID_FIELD_MISMATCH/);
});
