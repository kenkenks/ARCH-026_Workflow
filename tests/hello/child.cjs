'use strict';
const {createHello}=require('../../src/composition/hello.cjs');
(async()=>{
  const [mode,directory]=process.argv.slice(2);
  let handle;
  try {
    handle=await createHello({provider:'local-file',directory});
    if(mode==='seed') console.log(JSON.stringify(await handle.core.add({id:'persisted',message:'hello'})));
    else if(mode==='read') console.log(JSON.stringify(await handle.core.read('persisted')));
    else if(mode==='crash') { process.stdout.write('owned\n',()=>process.exit(0)); return; }
    else console.log('OPENED');
  } catch(error) { console.log(JSON.stringify({code:error.code,diagnostic:error.diagnostic})); process.exitCode=2; }
  finally { if(handle&&mode!=='crash') await handle.close(); }
})();
