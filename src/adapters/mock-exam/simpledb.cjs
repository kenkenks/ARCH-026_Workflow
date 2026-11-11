'use strict';
const {SimpleDB,SimpleDBError}=require('../simpledb/database.cjs');
const SCHEMA=Object.freeze({applicationId:0x41524558,version:1,sql:`
CREATE TABLE members(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL) STRICT;
CREATE TABLE exam_applications(id TEXT PRIMARY KEY NOT NULL, member_id TEXT NOT NULL REFERENCES members(id)) STRICT;
CREATE TABLE exam_results(application_id TEXT PRIMARY KEY NOT NULL REFERENCES exam_applications(id),
 result TEXT NOT NULL CHECK(result IN ('PASS','FAIL')), score REAL NOT NULL CHECK(score>=0 AND score<=100)) STRICT;`});
function text(value){if(typeof value!=='string'||!value.trim())throw new SimpleDBError('INVALID_ARGUMENT');}
class MockExamSQLiteRepository {
 constructor(database){this.database=database;database.connection.exec('PRAGMA foreign_keys=ON');}
 addMember(value){text(value?.id);text(value?.name);this.database.run('INSERT INTO members VALUES (?,?)',value.id,value.name);}
 addApplication(value){text(value?.id);text(value?.memberId);this.database.run('INSERT INTO exam_applications VALUES (?,?)',value.id,value.memberId);}
 addExamResult(value){text(value?.applicationId);if(!['PASS','FAIL'].includes(value?.result)||typeof value.score!=='number'||!Number.isFinite(value.score)||value.score<0||value.score>100)throw new SimpleDBError('INVALID_ARGUMENT');
  this.database.run('INSERT INTO exam_results VALUES (?,?,?)',value.applicationId,value.result,value.score);}
 async getMember(id){text(id);const row=this.database.get('SELECT * FROM members WHERE id=?',id);return row?{id:row.id,name:row.name}:null;}
 async getApplication(id){text(id);const row=this.database.get('SELECT * FROM exam_applications WHERE id=?',id);return row?{id:row.id,memberId:row.member_id}:null;}
 async getExamResult(id){text(id);const row=this.database.get('SELECT * FROM exam_results WHERE application_id=?',id);return row?{applicationId:row.application_id,result:row.result,score:row.score}:null;}
}
/** Explicit seed of NEW experiment DBs. Duplicate identities fail; never reset/delete. */
function seedMockExam(database){
 const repository=new MockExamSQLiteRepository(database);
 database.transaction(()=>{
  for(const id of ['M001','M002'])repository.addMember({id,name:'Synthetic '+id});
  for(const [id,memberId,result,score] of [['A001','M001','PASS',85],['A002','M002','FAIL',45]]){
   repository.addApplication({id,memberId});repository.addExamResult({applicationId:id,result,score});
  }
 });return repository;
}
module.exports={SCHEMA,SimpleDB,MockExamSQLiteRepository,seedMockExam};
