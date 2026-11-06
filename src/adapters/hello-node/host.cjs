'use strict';
const http = require('node:http');
const { CommunicationError } = require('../../../dist/src/hello-client/contracts');
const { failureResult } = require('../../../dist/src/hello-host/dispatch');
const LIMIT = 64 * 1024;
function statusFor(result) {
  if (result.ok) return 200;
  switch (result.error.code) {
    case 'INVALID_ARGUMENT': case 'VALIDATION_FAILED': return 400;
    case 'UNAUTHENTICATED': return 401;
    case 'FORBIDDEN': return 403;
    case 'NOT_FOUND': return 404;
    case 'ALREADY_EXISTS': case 'CONFLICT': return 409;
    case 'UNAVAILABLE': case 'OUTCOME_UNKNOWN': return 503;
    default: return 500;
  }
}
function validateHostOptions(options) {
  if (!options || options.address !== '127.0.0.1' || !Number.isInteger(options.port) || options.port < 0 || options.port > 65535 ||
      typeof options.allowMissingOrigin !== 'boolean' ||
      !Number.isInteger(options.stopTimeoutMs) || options.stopTimeoutMs < 1 || options.stopTimeoutMs > 2147483647)
    throw new CommunicationError('UNSUPPORTED_CONFIGURATION');
}
async function openNodeHost(options, dispatch) {
  validateHostOptions(options);
  let stopping = false, stopPromise, origin;
  const active = new Set();
  function respond(res, result, status = statusFor(result), mutation = false) {
    if (res.destroyed || res.writableEnded) return;
    let body = JSON.stringify(result);
    if (Buffer.byteLength(body, 'utf8') > LIMIT) {
      result = failureResult(mutation ? 'OUTCOME_UNKNOWN' : 'INTERNAL'); status = statusFor(result); body = JSON.stringify(result);
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body), 'Connection': 'close', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  }
  async function handle(req, res) {
    let mutation = false;
    const reject = (code, status) => { req.resume(); respond(res, failureResult(code), status); };
    if (stopping) return reject('UNAVAILABLE', 503);
    // Reject duplicated authority/origin credentials as well as mismatches.
    const counts = {};
    for (let i=0;i<req.rawHeaders.length;i+=2) { const key=req.rawHeaders[i].toLowerCase(); counts[key]=(counts[key]||0)+1; }
    if (counts.host !== 1 || req.headers.host !== new URL(origin).host) return reject('FORBIDDEN', 403);
    if (counts.origin > 1 || (req.headers.origin === undefined ? !options.allowMissingOrigin : req.headers.origin !== origin)) return reject('FORBIDDEN', 403);
    if (counts.authorization > 1) return reject('UNAUTHENTICATED', 401);
    if (req.url !== '/api/hello') return reject('INVALID_ARGUMENT', 404);
    if (req.method !== 'POST') return reject('INVALID_ARGUMENT', 405);
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return reject('INVALID_ARGUMENT', 415);
    const chunks = []; let size = 0;
    try {
      // Do not use Content-Length as the authority. pause/remove handlers on a rejected body.
      await new Promise((resolve, rejectBody) => {
        const cleanup = () => {req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);};
        const data = chunk => {
          size += chunk.length;
          if (size > LIMIT) {cleanup();req.pause();rejectBody(new CommunicationError('INVALID_ARGUMENT'));return;}
          chunks.push(chunk);
        };
        const end=()=>{cleanup();resolve();};
        const error=()=>{cleanup();rejectBody(new CommunicationError('UNAVAILABLE'));};
        const aborted=()=>error();
        req.on('data',data);req.on('end',end);req.on('error',error);req.on('aborted',aborted);
      });
    } catch { respond(res,failureResult(size>LIMIT?'INVALID_ARGUMENT':'UNAVAILABLE'),size>LIMIT?413:503);return; }
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks))); }
    catch { return respond(res,failureResult('INVALID_ARGUMENT'),400); }
    mutation = payload?.operation === 'add' || payload?.operation === 'write';
    const authorization = req.headers.authorization;
    const credential = authorization === undefined ? null : /^Bearer ([^\r\n]+)$/.exec(authorization)?.[1] ?? '';
    try { respond(res,await dispatch({credential,payload}),undefined,mutation); }
    catch { respond(res,failureResult(mutation?'OUTCOME_UNKNOWN':'INTERNAL')); }
  }
  const server = http.createServer((req,res) => {
    const operation=handle(req,res).catch(()=>{respond(res,failureResult('INTERNAL'));});
    active.add(operation); operation.finally(()=>active.delete(operation));
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  server.on('clientError', (_error,socket) => { if(socket.writable)socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  await new Promise((resolve,reject) => {
    const error=()=>{server.off('listening',ready);reject(new CommunicationError('UNAVAILABLE'));};
    const ready=()=>{server.off('error',error);resolve();};
    server.once('error',error);server.once('listening',ready);
    server.listen(options.port,options.address);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  // Runtime server errors are diagnosed without exposing OS details or crashing an unhandled EventEmitter.
  server.on('error',()=>{});
  return {
    origin,
    stop() {
      if (!stopPromise) {
        stopping=true;
        const closed=new Promise((resolve,reject)=>server.close(error=>error?reject(new CommunicationError('UNAVAILABLE')):resolve()));
        const drained=(async()=>{while(active.size)await Promise.allSettled([...active]);server.closeIdleConnections();await closed;})();
        let timer;
        stopPromise=Promise.race([drained,new Promise((_,reject)=>{timer=setTimeout(()=>{
          server.closeAllConnections();reject(new CommunicationError('OUTCOME_UNKNOWN'));
        },options.stopTimeoutMs);})]).finally(()=>clearTimeout(timer));
      }
      return stopPromise;
    },
  };
}
module.exports={openNodeHost,validateHostOptions};
