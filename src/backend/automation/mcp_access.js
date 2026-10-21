'use strict';
const crypto = require('node:crypto');
const automation = require('./index');
const { error, ensure } = require('./contract');
const { requireAdmin } = require('./registry');
const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const store = () => automation.repository;
const get = id => store().get('catalog', id);
const put = (value, revision = null) => store().put('catalog', value, revision);
const now = () => Date.now();
const scope = 'workflows:author';
function origin(value) {
  let url;
  try { url = new URL(value); } catch { throw error('Nhập địa chỉ host HTTP/HTTPS hợp lệ.'); }
  ensure(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'Host chỉ gồm giao thức và tên miền/cổng.');
  ensure(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), 'Host công khai cần HTTPS.');
  return url.origin;
}
async function settings() { return await get('_mcp_host') || { id: '_mcp_host', enabled: false, publicOrigin: '', revision: null }; }
async function configure(body, account) {
  requireAdmin({ permissions: account.role === 'admin' ? ['admin'] : [] });
  ensure(typeof body.enabled === 'boolean', 'enabled phải là boolean.');
  const current = await settings();
  ensure(body.revision === current.revision, 'Cấu hình đã đổi; mở lại kết nối AI.');
  return put({ id: '_mcp_host', enabled: body.enabled, publicOrigin: origin(body.publicOrigin), updatedBy: account.id }, current.revision);
}
function activeOwner(token) {
  const auth = require('../services/auth_service');
  const owner = auth.accounts.find(account => account.id === token.accountId && account.isActive !== false && account.role === 'admin'
    && (account.securityVersion || 0) === (token.securityVersion || 0));
  return owner ? auth.publicAccount(owner) : null;
}
async function issue(account, label, days = 7, extra = {}) {
  ensure(Number.isInteger(days) && days >= 1 && days <= 90, 'Thời hạn token từ 1 đến 90 ngày.');
  const raw = 'kh_mcp_' + secret();
  const owner = require('../services/auth_service').accounts.find(item => item.id === account.id);
  const record = await put({ id: '_mcp_token_' + digest(raw), kind: 'mcp_access', accountId: account.id,
    securityVersion: owner?.securityVersion || 0, label: String(label || 'AI').slice(0, 100), createdAt: now(), expiresAt: now() + days * 86400000,
    resource: (await settings()).publicOrigin + '/mcp/workflows', ...extra });
  return { token: raw, connection: publicToken(record) };
}
const publicToken = record => ({ id: record.id, label: record.label, createdAt: record.createdAt, expiresAt: record.grantExpiresAt || record.expiresAt, revoked: Boolean(record.revoked), clientId: record.clientId || null });
async function connections(account) {
  return (await store().list('catalog')).filter(item => item.kind === 'mcp_access' && !item.parentId && item.accountId === account.id).map(publicToken);
}
async function revoke(id, account) {
  const record = await get(id);
  if (!record || record.kind !== 'mcp_access' || record.accountId !== account.id) throw error('Không tìm thấy kết nối.', 404);
  if (!record.revoked) await put({ ...record, revoked: true }, record.revision);
}
async function authenticate(raw) {
  const config = await settings();
  if (!config.enabled || !raw) return null;
  const record = await get('_mcp_token_' + digest(raw));
  if (record?.kind !== 'mcp_access' || record.revoked || record.expiresAt <= now() || record.resource !== config.publicOrigin + '/mcp/workflows') return null;
  if (record.parentId) {
    const parent = await get(record.parentId);
    if (!parent || parent.revoked || parent.grantExpiresAt <= now()) return null;
  }
  return activeOwner(record);
}
async function register(body) {
  ensure(body.token_endpoint_auth_method === undefined || body.token_endpoint_auth_method === 'none', 'Chỉ hỗ trợ public client dùng PKCE.');
  ensure(Array.isArray(body.redirect_uris) && body.redirect_uris.length >= 1 && body.redirect_uris.length <= 8, 'Cần redirect_uris.');
  const redirectUris = body.redirect_uris.map(value => {
    const url = new URL(value);
    ensure(!url.hash && !url.username && !url.password && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))), 'Redirect cần HTTPS hoặc loopback HTTP.');
    return url.href;
  });
  const clientId = secret();
  const client = { id: '_mcp_client_' + clientId, client_id: clientId, client_name: String(body.client_name || 'AI client').slice(0, 100), redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], createdAt: now() };
  await put(client);
  const { id, revision, updatedAt, createdAt, ...metadata } = client;
  return metadata;
}
async function begin(params, config) {
  const client = await get('_mcp_client_' + params.get('client_id'));
  ensure(client && client.redirect_uris.includes(params.get('redirect_uri')), 'Client hoặc redirect_uri không hợp lệ.');
  ensure(params.get('response_type') === 'code' && params.get('code_challenge_method') === 'S256', 'Cần authorization code và PKCE S256.');
  const challenge = params.get('code_challenge') || '';
  ensure(challenge.length === 43 && [...challenge].every(char => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'.includes(char)), 'PKCE challenge không hợp lệ.');
  ensure(!params.get('scope') || params.get('scope') === scope, 'Scope không được hỗ trợ.');
  const resource = params.get('resource') || config.publicOrigin + '/mcp/workflows';
  ensure(resource === config.publicOrigin + '/mcp/workflows', 'Resource không hợp lệ.');
  const id = '_mcp_request_' + secret();
  await put({ id, clientId: client.client_id, redirectUri: params.get('redirect_uri'), challenge, state: (params.get('state') || '').slice(0, 2048), resource, expiresAt: now() + 300000 });
  return { id, name: client.client_name, redirectOrigin: new URL(params.get('redirect_uri')).origin };
}
async function consent(id, account, approve) {
  const request = await get(id);
  ensure(request && id.startsWith('_mcp_request_') && request.expiresAt > now() && !request.used, 'Yêu cầu đã hết hạn hoặc đã sử dụng.');
  await put({ ...request, used: true }, request.revision);
  const redirect = new URL(request.redirectUri);
  if (request.state) redirect.searchParams.set('state', request.state);
  if (!approve) redirect.searchParams.set('error', 'access_denied');
  else {
    const code = secret();
    const owner = require('../services/auth_service').accounts.find(item => item.id === account.id);
    await put({ id: '_mcp_code_' + digest(code), ...Object.fromEntries(['clientId', 'redirectUri', 'challenge', 'resource'].map(key => [key, request[key]])), accountId: account.id,
      securityVersion: owner?.securityVersion || 0, expiresAt: now() + 60000 });
    redirect.searchParams.set('code', code);
  }
  return redirect.href;
}
async function exchange(body, config) {
  const isRefresh = body.grant_type === 'refresh_token';
  ensure(isRefresh || body.grant_type === 'authorization_code', 'grant_type không được hỗ trợ.');
  const record = await get((isRefresh ? '_mcp_refresh_' : '_mcp_code_') + digest(isRefresh ? body.refresh_token : body.code));
  ensure(record && !record.used && record.expiresAt > now() && record.clientId === body.client_id && record.resource === config.publicOrigin + '/mcp/workflows', 'Grant không hợp lệ hoặc đã hết hạn.');
  if (body.resource) ensure(body.resource === record.resource, 'Resource không hợp lệ.');
  if (!isRefresh) {
    ensure(body.redirect_uri === record.redirectUri, 'redirect_uri không khớp.');
    const verifier = body.code_verifier || '';
    ensure(verifier.length >= 43 && verifier.length <= 128 && crypto.createHash('sha256').update(verifier).digest('base64url') === record.challenge, 'PKCE verifier không khớp.');
  } else {
    const access = await get(record.accessId);
    ensure(access && !access.revoked, 'Kết nối đã bị thu hồi.');
  }
  const account = activeOwner(record);
  ensure(account, 'Tài khoản không còn quyền quản trị.');
  await put({ ...record, used: true }, record.revision);
  const client = await get('_mcp_client_' + record.clientId);
  const issued = await issue(account, client?.client_name || 'OAuth client', 1, { clientId: record.clientId, expiresAt: now() + 3600000 });
  // Keep one revocable connection for an OAuth grant: rotating refresh tokens refer to the original connection.
  const rootId = isRefresh ? record.accessId : issued.connection.id;
  const refresh = secret();
  await put({ id: '_mcp_refresh_' + digest(refresh), accountId: account.id, securityVersion: record.securityVersion,
    clientId: record.clientId, resource: record.resource, accessId: rootId, expiresAt: isRefresh ? record.expiresAt : now() + 30 * 86400000 });
  if (isRefresh) {
    const child = await get(issued.connection.id);
    await put({ ...child, parentId: rootId }, child.revision);
  } else {
    const root = await get(rootId);
    await put({ ...root, grantExpiresAt: now() + 30 * 86400000 }, root.revision);
  }
  return { access_token: issued.token, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope };
}
module.exports = { settings, configure, connections, issue, revoke, authenticate, register, begin, consent, exchange, get, scope };
