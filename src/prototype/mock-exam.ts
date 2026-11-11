import type { CJobForm, ProductReader } from './job-form';
import type { JobFormRegistration } from './definition';

/** Synthetic experiment model, not the dojo's business schema. */
export interface MockMember { id:string; name:string }
export interface MockApplication { id:string; memberId:string }
export interface MockExamResult { applicationId:string; result:'PASS'|'FAIL'; score:number }
export interface MockExamRepository {
  getMember(id:string):Promise<MockMember|null>;
  getApplication(id:string):Promise<MockApplication|null>;
  getExamResult(applicationId:string):Promise<MockExamResult|null>;
}
export class MockBusinessError extends Error {
  constructor(public readonly code:'BUSINESS_NOT_FOUND'|'BUSINESS_INPUT_INVALID') { super(code); }
}
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new MockBusinessError('BUSINESS_INPUT_INVALID');
  return value as Record<string,unknown>;
}
function text(value:unknown):string {
  if(typeof value!=='string'||!value.trim())throw new MockBusinessError('BUSINESS_INPUT_INVALID');return value;
}
function request(reader:ProductReader){
  const value=object(reader.get('request'));
  return {memberId:text(value.memberId),applicationId:text(value.applicationId)};
}
/** Shared form definitions depend on a repository port, never an SQLite SDK. */
export function createMockExamJobForms(repository:MockExamRepository):ReadonlyMap<string,JobFormRegistration>{
  const member:CJobForm<string,MockMember>={name:'get-member',collect:r=>request(r).memberId,
    make:async id=>{const value=await repository.getMember(id);if(!value)throw new MockBusinessError('BUSINESS_NOT_FOUND');return value;}};
  const application:CJobForm<{id:string;memberId:string},MockApplication>={name:'get-application',
    collect:r=>({id:request(r).applicationId,memberId:text(object(r.get('member')).id)}),
    make:async input=>{const value=await repository.getApplication(input.id);if(!value)throw new MockBusinessError('BUSINESS_NOT_FOUND');
      if(value.memberId!==input.memberId)throw new MockBusinessError('BUSINESS_INPUT_INVALID');return value;}};
  const result:CJobForm<string,MockExamResult>={name:'get-result',collect:r=>text(object(r.get('application')).id),
    make:async id=>{const value=await repository.getExamResult(id);if(!value)throw new MockBusinessError('BUSINESS_NOT_FOUND');return value;}};
  return new Map([
    ['mock.member',{form:member,artifactKey:'member'}],
    ['mock.application',{form:application,artifactKey:'application'}],
    ['mock.result',{form:result,artifactKey:'examResult'}],
  ]);
}
