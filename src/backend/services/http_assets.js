'use strict';
const fs = require('node:fs');
const zlib = require('node:zlib');

// Static assets: compressed once per file version, revalidated with ETag, and cached for good
// when the page links them with the server's own fingerprint (?v=<fingerprint>).
const IMMUTABLE = 'private, max-age=31536000, immutable';
const REVALIDATE = 'private, no-cache';
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|manifest\+json)|image\/svg\+xml)/;
const MIN_COMPRESS_BYTES = 1024;
const compressedCache = new Map();
const MAX_CACHED = 400;

function pickEncoding(req) {
  const accept = String(req.headers['accept-encoding'] || '');
  return /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
}

function compress(body, encoding, quality) {
  return encoding === 'br'
    ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
    : zlib.gzipSync(body);
}

const fingerprint = stats => `${stats.size.toString(36)}${Math.trunc(stats.mtimeMs).toString(36)}`;

// Rewrites the page's local .js/.css links to the file's current fingerprint, so a changed file
// always gets a new URL even when nobody bumped its ?v= by hand.
function versionAssetLinks(html, resolveFile) {
  return html.replace(/(\s(?:src|href)=")((?!https?:|\/\/|data:)[^"?#]+\.(?:js|css))(?:\?[^"#]*)?"/g, (match, prefix, url) => {
    const stats = fs.statSync(resolveFile('/' + url.replace(/^\/+/, '')), { throwIfNoEntry: false });
    return stats?.isFile() ? `${prefix}${url}?v=${fingerprint(stats)}"` : match;
  });
}

// Inlines the connection guard right after <head>: a page whose server stops mid-load cannot
// fetch the guard as a separate file. Re-read only when the source file changes.
const GUARD_FILE = require('node:path').join(__dirname, '../../frontend/shared/js/connection_guard.js');
let guardCache = { key: '', tag: '' };
function injectConnectionGuard(html) {
  const stats = fs.statSync(GUARD_FILE, { throwIfNoEntry: false });
  if (!stats) return html;
  const key = fingerprint(stats);
  if (guardCache.key !== key) {
    // The leading comment stays in the source file; pages get only the code.
    const code = fs.readFileSync(GUARD_FILE, 'utf8').replace(/^(?:\/\/[^\n]*\n)+/, '').replace(/<\/script/gi, '<\\/script');
    guardCache = { key, tag: `<script>${code}</script>` };
  }
  return html.replace(/<head(\s[^>]*)?>/i, match => match + guardCache.tag);
}

// Sends a file with ETag/304, a cache policy and on-the-fly compression.
function sendStaticFile(req, res, { filePath, content, stats, contentType, version, headers = {} }) {
  const etag = `"${fingerprint(stats)}"`;
  const cacheControl = version && version === fingerprint(stats) ? IMMUTABLE : REVALIDATE;
  const base = { ...headers, 'Content-Type': contentType, 'Cache-Control': cacheControl, ETag: etag, Vary: 'Accept-Encoding' };
  if (String(req.headers['if-none-match'] || '').split(/\s*,\s*/).includes(etag)) {
    res.writeHead(304, { 'Cache-Control': cacheControl, ETag: etag, Vary: 'Accept-Encoding' });
    res.end();
    return;
  }
  const encoding = COMPRESSIBLE.test(contentType) && content.length >= MIN_COMPRESS_BYTES ? pickEncoding(req) : null;
  if (!encoding) {
    res.writeHead(200, { ...base, 'Content-Length': content.length });
    res.end(content);
    return;
  }
  const key = `${filePath}\0${etag}\0${encoding}`;
  let body = compressedCache.get(key);
  if (!body) {
    body = compress(content, encoding, 6);
    if (compressedCache.size >= MAX_CACHED) compressedCache.delete(compressedCache.keys().next().value);
    compressedCache.set(key, body);
  }
  res.writeHead(200, { ...base, 'Content-Encoding': encoding, 'Content-Length': body.length });
  res.end(body);
}

// Sends a generated page (never cached by the browser) compressed when the client accepts it.
function sendPage(req, res, content, headers) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const encoding = body.length >= MIN_COMPRESS_BYTES ? pickEncoding(req) : null;
  if (!encoding) {
    res.writeHead(200, { ...headers, 'Content-Length': body.length });
    res.end(body);
    return;
  }
  const packed = compress(body, encoding, 5);
  res.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': packed.length, Vary: 'Accept-Encoding' });
  res.end(packed);
}

// Compresses single-shot JSON API responses. Streams (write() before end(), NDJSON, SSE) pass through.
function compressJsonResponses(req, res) {
  const encoding = pickEncoding(req);
  if (!encoding || req.method === 'HEAD') return;
  const { writeHead, write, end } = res;
  let pending = null;
  let passthrough = false;
  // Node's own implicit writeHead (from write()/end()) must reach the socket, not be deferred again.
  const raw = (fn, ...args) => { passthrough = true; try { return fn.apply(res, args); } finally { passthrough = false; } };
  const isJson = type => /^application\/json\b/i.test(String(type || ''));
  const flush = () => { if (pending) { const args = pending; pending = null; raw(writeHead, ...args); } };
  res.writeHead = function (status, ...rest) {
    const headers = typeof rest[0] === 'string' ? rest[1] : rest[0];
    const type = headers && Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
    if (passthrough || !isJson(type ?? res.getHeader('content-type'))) return raw(writeHead, status, ...rest);
    pending = [status, ...rest];
    return res;
  };
  res.write = function (...args) { flush(); return raw(write, ...args); };
  res.end = function (chunk, ...args) {
    const direct = !pending && !res.headersSent && isJson(res.getHeader('content-type'));
    if ((!pending && !direct) || chunk == null || typeof chunk === 'function') { flush(); return raw(end, chunk, ...args); }
    const callback = args.find(arg => typeof arg === 'function');
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof args[0] === 'string' ? args[0] : 'utf8');
    if (body.length < MIN_COMPRESS_BYTES) { flush(); return raw(end, body, callback); }
    const packed = compress(body, encoding, 4);
    if (direct) {
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Content-Length', packed.length);
      res.setHeader('Vary', 'Accept-Encoding');
      return raw(end, packed, callback);
    }
    const [status, ...rest] = pending;
    pending = null;
    const reason = typeof rest[0] === 'string' ? rest[0] : null;
    const headers = Object.fromEntries(Object.entries((reason ? rest[1] : rest[0]) || {}).filter(([name]) => name.toLowerCase() !== 'content-length'));
    res.removeHeader('Content-Length');
    Object.assign(headers, { 'Content-Encoding': encoding, 'Content-Length': packed.length, Vary: 'Accept-Encoding' });
    if (reason) raw(writeHead, status, reason, headers); else raw(writeHead, status, headers);
    return raw(end, packed, callback);
  };
}

module.exports = { versionAssetLinks, injectConnectionGuard, sendStaticFile, sendPage, compressJsonResponses, fingerprint };
