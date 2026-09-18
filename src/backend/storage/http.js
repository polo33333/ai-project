'use strict';

const storage = require('./index');
const {sha256}=require('./postgres/crypto');
const crypto=require('node:crypto');
const chatPaths=new Set(['/api/chat','/api/intelligent-core/chat','/api/intelligent-core/chat/stream','/api/embed/chat','/api/v1/chat/completions']);

// Gate the response at the async repository boundary. Progress may stream while
// tools run; final data and cookies are released only after a successful commit.
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
    if (stream && /^event: progress\n/.test(String(chunk))) {
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
    const message = error.code === 'DATA_CONFLICT' ? 'DATA_CONFLICT' : 'STORAGE_OPERATION_FAILED';
    console.error('[Storage] Request failed:', error.code || error.name || 'ERROR');
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
