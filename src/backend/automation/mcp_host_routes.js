'use strict';
const access = require('./mcp_access');
const { requireAdmin } = require('./registry');
const { error, ensure } = require('./contract');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createServer } = require('./mcp_tools');
const { AuthoringClient } = require('./mcp_authoring_client');
const rates = new Map();
function rate(req, limit = 120) {
  const key = `${req.socket.remoteAddress}:${limit}`, time = Date.now();
  if (rates.size > 2000) for (const [id, value] of rates) if (value.until < time) rates.delete(id);
  if (!rates.has(key)) { if (rates.size >= 2000) throw error('Too many requests.', 429); rates.set(key, { count: 0, until: time + 60000 }); }
  let item = rates.get(key);
  if (item.until < time) { item = { count: 0, until: time + 60000 }; rates.set(key, item); }
  if (++item.count > limit) throw error('Too many requests.', 429);
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function form(req) {
  ensure(String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded'), 'Cần application/x-www-form-urlencoded.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 32768) throw error('Request too large.', 413); chunks.push(chunk); }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
}
async function handle(req, res, pathname, account, readJsonBody) {
  const management = pathname === '/api/workflow-plugins/mcp' || pathname.startsWith('/api/workflow-plugins/mcp/');
  const publicPath = pathname === '/mcp/workflows' || pathname.startsWith('/mcp/workflows/')
    || ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp/workflows', '/.well-known/oauth-protected-resource/mcp/workflows', '/.well-known/oauth-protected-resource'].includes(pathname);
  if (!management && !publicPath) return false;
  try {
    if (management) {
      if (!account) throw error('UNAUTHENTICATED', 401);
      requireAdmin({ permissions: account.role === 'admin' ? ['admin'] : [] });
      if (pathname === '/api/workflow-plugins/mcp' && req.method === 'GET') {
        const [settings, connections] = await Promise.all([access.settings(), access.connections(account)]);
        json(res, { settings, connections });
      }
      else if (pathname === '/api/workflow-plugins/mcp' && req.method === 'PUT') json(res, { settings: await access.configure(await readJsonBody(req), account) });
      else if (pathname === '/api/workflow-plugins/mcp/tokens' && req.method === 'POST') {
        const body = await readJsonBody(req); const config = await access.settings();
        ensure(config.enabled, 'Bật kết nối AI trước khi tạo token.');
        json(res, await access.issue(account, body.label, body.days ?? 7), 201);
      } else if (pathname === '/api/workflow-plugins/mcp/revoke' && req.method === 'POST') {
        await access.revoke((await readJsonBody(req)).id, account); json(res, { revoked: true });
      } else if (pathname === '/api/workflow-plugins/mcp/authorize' && req.method === 'POST') {
        const body = await readJsonBody(req);
        ensure((await access.settings()).enabled, 'MCP đã tắt.');
        ensure(typeof body.approve === 'boolean' && typeof body.requestId === 'string', 'Yêu cầu không hợp lệ.');
        json(res, { redirect: await access.consent(body.requestId, account, body.approve) });
      } else throw error('Phương thức không được hỗ trợ.', 405);
      return true;
    }
    const config = await access.settings();
    if (!config.enabled || !config.publicOrigin) throw error('Kết nối AI chưa được bật trên host.', 503);
    const base = config.publicOrigin, resource = base + '/mcp/workflows';
    if (pathname.startsWith('/.well-known/')) {
      if (req.method !== 'GET') throw error('Method not allowed.', 405);
      res.setHeader('Access-Control-Allow-Origin', '*');
      json(res, pathname.includes('oauth-protected-resource') ? { resource, authorization_servers: [base], scopes_supported: [access.scope], bearer_methods_supported: ['header'] }
        : { issuer: base, authorization_endpoint: resource + '/authorize', token_endpoint: resource + '/token', registration_endpoint: resource + '/register',
          response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'], scopes_supported: [access.scope] });
      return true;
    }
    rate(req, pathname === '/mcp/workflows' ? 120 : 30);
    if (pathname === '/mcp/workflows/register' && req.method === 'POST') { json(res, await access.register(await readJsonBody(req, 32768)), 201); return true; }
    if (pathname === '/mcp/workflows/token' && req.method === 'POST') {
      try { json(res, await access.exchange(await form(req), config)); }
      catch (failure) { json(res, { error: 'invalid_grant', error_description: failure.message }, 400); }
      return true;
    }
    if (pathname === '/mcp/workflows/authorize' && req.method === 'GET') {
      const request = await access.begin(new URL(req.url, base).searchParams, config);
      const html = require('./mcp_consent_page').render(request);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Referrer-Policy': 'no-referrer' });
      res.end(html); return true;
    }
    if (pathname !== '/mcp/workflows') throw error('Not found.', 404);
    const header = String(req.headers.authorization || '');
    const owner = await access.authenticate(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!owner) {
      res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/workflows", scope="${access.scope}"`);
      throw error('MCP_TOKEN_REQUIRED', 401);
    }
    require('../governance/context').setPrincipal({ subject: `account:${owner.id}`, role: owner.role, permissions: owner.permissions, dataAccess: owner.dataAccess, tenantId: owner.tenantId, channel: 'mcp' });
    req.storageOwner = `account:${owner.id}`;
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw error('Stateless MCP uses POST.', 405); }
    const body = await readJsonBody(req);
    const server = createServer(new AuthoringClient(owner));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try { await server.connect(transport); await transport.handleRequest(req, res, body); }
    finally { await server.close(); }
    return true;
  } catch (failure) {
    if (!res.headersSent) json(res, { error: failure.message }, failure.statusCode || 400);
    else if (!res.writableEnded) res.end();
    return true;
  }
}
module.exports = { handle };
