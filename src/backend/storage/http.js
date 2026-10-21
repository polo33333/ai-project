'use strict';

const storage = require('./index');
const {sha256}=require('./postgres/crypto');
const crypto=require('node:crypto');
const chatPaths=new Set(['/api/chat','/api/intelligent-core/chat','/api/intelligent-core/chat/stream','/api/embed/chat','/api/v1/chat/completions']);

// Gate durable output at the repository boundary. Progress and transient answer
// previews may stream; verified output/final/cookies require a successful commit.
async function handleStoredRequest(req, res, handler) {
  if (!storage.enabled()) return handler(req, res);
  const native = {
    writeHead: res.writeHead.bind(res), write: res.write.bind(res),
    end: res.end.bind(res), flushHeaders: res.flushHeaders.bind(res)
  };
  let headerArgs;
  let stream = false;
  let ended = false;
  const chunks = [];
  const transientAnswers=new Set();
  const bodyDigest=crypto.createHash('sha256');
  const observe=chunk=>bodyDigest.update(chunk);
  // Observe body bytes without putting IncomingMessage into flowing mode
  // before the router has installed its body parser.
  const emit=req.emit;
  req.emit=function(event,...args){if(event==='data')observe(args[0]);return emit.call(this,event,...args);};
  let receipt;
  let finish;
  const responseQueued = new Promise(resolve => { finish = resolve; });
  res.writeHead = (...args) => {
    headerArgs = args;
    const headers = args.find(value => value && typeof value === 'object') || {};
    stream = /text\/event-stream/i.test(headers['Content-Type'] || headers['content-type'] || res.getHeader('Content-Type') || '');
    return res;
  };
  res.flushHeaders = () => {
    if (stream) { if (headerArgs && !res.headersSent) native.writeHead(...headerArgs); native.flushHeaders(); }
  };
  res.write = (chunk, ...args) => {
    const wire=String(chunk);
    let transient=stream&&wire.startsWith('event: progress\n');
    if(stream&&wire.startsWith('event: answer_')){
      const lines=wire.split('\n'),name=lines[0].slice('event: '.length);
      try{
        const event=JSON.parse(lines.find(line=>line.startsWith('data: '))?.slice(6));
        if(name==='answer_start'&&event.verified===false&&event.id){transientAnswers.add(event.id);transient=true;}
        else if(['answer_delta','answer_reset'].includes(name)&&transientAnswers.has(event.id)){
          transient=true;if(name==='answer_reset')transientAnswers.delete(event.id);
        }
      }catch{ /* Unknown frames retain the normal commit boundary. */ }
    }
    if (transient) {
      if (headerArgs && !res.headersSent) native.writeHead(...headerArgs);
      return native.write(chunk, ...args);
    }
    chunks.push(['write', [chunk, ...args]]);
    return true;
  };
  res.end = (...args) => {
    if (!ended) { ended = true; chunks.push(['end', args]); finish(); }
    return res;
  };
  const disconnected = () => { finish(); };
  res.once('close', disconnected);
  try {
    await storage.run(async () => {
      await handler(req, res);
      await responseQueued; // Static fs callbacks also finish before commit.
      const pathname=new URL(req.url,'http://localhost').pathname;
      if(req.method==='POST'&&chatPaths.has(pathname)&&req.headers['x-request-id']&&req.storageOwner) {
        receipt={key:sha256(`${req.storageOwner}:${pathname}:${req.headers['x-request-id']}`),bodyHash:bodyDigest.digest('hex'),
          response:{headerArgs,chunks:chunks.map(([method,args])=>[method,args.map(value=>Buffer.isBuffer(value)?{$buffer:value.toString('base64')}:value)])}};
        storage.receipt(receipt);
      }
    }, {files:require('./request_stores').requestStores(req)});
    restore();
    if (res.destroyed) return;
    if(receipt?.replay) {
      headerArgs=receipt.replay.headerArgs;
      chunks.splice(0,chunks.length,...receipt.replay.chunks.map(([method,args])=>[method,args.map(value=>value?.$buffer?Buffer.from(value.$buffer,'base64'):value)]));
    }
    if (headerArgs && !res.headersSent) native.writeHead(...headerArgs);
    for (const [method, args] of chunks) native[method](...args);
  } catch (error) {
    restore();
    if (res.destroyed) return;
    const message = ['DATA_CONFLICT','ACCOUNT_CONFLICT'].includes(error.code) ? error.code : 'STORAGE_OPERATION_FAILED';
    console.error('[Storage] Request failed:', JSON.stringify({
      ...require('./postgres/worker_failure').describe(error, storage.getPool()),
      method: req.method, path: new URL(req.url, 'http://localhost').pathname, requestId: req.requestId || null,
      ...(error.conflictTable ? { conflictTable: error.conflictTable, conflictStore: error.conflictStore } : {})
    }));
    if (res.headersSent) native.end(`event: error\ndata: ${JSON.stringify({ status: 'error', message })}\n\n`);
    else {
      res.removeHeader('Set-Cookie');
      native.writeHead(error.statusCode || 503, { 'Content-Type': 'application/json; charset=UTF-8' });
      native.end(JSON.stringify({ status: 'error', message, requestId: req.requestId || null }));
    }
  }
  function restore() {
    res.removeListener('close', disconnected);
    req.emit=emit;
    for (const [name, method] of Object.entries(native)) res[name] = method;
  }
}

module.exports = { handleStoredRequest };
