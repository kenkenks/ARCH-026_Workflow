'use strict';
// Defense in depth for reviewed local tests; not a hostile-code security sandbox.
const refuse=()=>{throw Object.assign(Error('LOCAL_VERIFICATION_EXTERNAL_OPERATION_REFUSED'),{code:'LOCAL_ONLY'});};
for(const [name,keys]of Object.entries({'node:net':['connect','createConnection','createServer'],'node:tls':['connect','createServer'],'node:http':['request','get','createServer'],'node:https':['request','get','createServer'],'node:http2':['connect','createServer','createSecureServer'],'node:dgram':['createSocket'],'node:dns':['lookup','resolve','resolve4','resolve6'],'node:child_process':['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']})){
  const module=require(name);for(const key of keys)module[key]=refuse;
}
for(const key of Object.keys(require('node:dns').promises))if(typeof require('node:dns').promises[key]==='function')require('node:dns').promises[key]=refuse;
require('node:worker_threads').Worker=class {constructor(){refuse();}};
globalThis.fetch=refuse;globalThis.WebSocket=class {constructor(){refuse();}};
require('node:module').syncBuiltinESMExports();
