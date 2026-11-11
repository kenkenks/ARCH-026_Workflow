'use strict';
const {inspect,claim,resume}=require('../../src/adapters/job-execution/resume.cjs');
const input=JSON.parse(process.argv[2]);
(async()=>{
 if(input.mode==='claim'){const i=await inspect(input.options,input.policy);return claim(input.options,i,'child-host');}
 const calls=[];
 const result=await resume(input.options,input.ownership,({products,onCreate})=>({jobs:new Map(),checks:new Map(),jobForms:{products,onCreate,definitions:new Map(['a','b','c'].map(name=>[name,{artifactKey:name==='c'?'Z':'X',form:{name,collect:p=>name==='a'?10:p.get('X'),make:x=>{calls.push(name);return name==='a'?x:x+10;}}}]))}}));
 return {status:result.snapshot.status,history:result.snapshot.history,calls,products:result.products};
})().then(result=>process.stdout.write(JSON.stringify({ok:true,result})),error=>{process.stdout.write(JSON.stringify({ok:false,code:error?.code??'UNEXPECTED'}));process.exitCode=0;});
