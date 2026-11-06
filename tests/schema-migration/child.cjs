'use strict';
const {SimpleDB,DATA_STORAGE_SCHEMA,SimpleDBDataRepository}=require('../../src/adapters/data/simpledb.cjs');
const db=SimpleDB.open(process.argv[2],DATA_STORAGE_SCHEMA);
new SimpleDBDataRepository(db,'demo-items').read('a').then(stored=>{
  console.log(JSON.stringify({version:db.get('PRAGMA user_version').user_version,stored}));
}).catch(()=>{process.exitCode=1;}).finally(()=>db.close());
