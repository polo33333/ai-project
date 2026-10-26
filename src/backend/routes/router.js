/**
 * KnowledgeHub AI Server - Router Module
 * Handles all REST API routes & static file serving.
 */

const fs = require('fs');
const storage = require('../storage');
const path = require('path');
const { getExportsDirectory } = require('../utils/export_paths');

const sqlConnector = require('../services/sql_connector');
const dictionaryService = require('../services/dictionary_service');
const text2SqlAgent = require('../services/text2sql_agent');
const joinPlannerService = require('../services/join_planner_service');
const aiProviderManager = require('../services/ai_provider_manager');
const loggerService = require('../services/logger_service');
const mcpService = require('../services/mcp_service');
const apiKeyService = require('../services/api_key_service');
const qdrantService = require('../services/qdrant_service');
const authService = require('../services/auth_service');
const settingsService = require('../services/settings_service').createSettingsService();
const backupAdmin = require('../services/backup_admin_service');
const embedChatService = require('../services/embed_chat_service');
const { memoryService: conversationMemoryService } = require('../memory_core');
const knowledgeCore = require('../knowledge_core');
const { selectUserFacingSqlExecutions } = require('../utils/chat_result_selector');
const { buildTrainingReport } = require('../training_core');
const trainingResolutionService = require('../training_core/resolution_service');
const skillCore = require('../skill_core');
const domainAliasService = require('../intelligent_core/domain_alias_service');
const crypto = require('crypto');
const { buildChatDiagnostics } = require('../utils/chat_diagnostics');

// ── Intelligent Core (src/backend/intelligent_core/) ──────────────────────────
const { core: intelligentCore, personaService: aiPersonaService, toolRegistry } = require('../intelligent_core');


const FRONTEND_DIR = path.join(__dirname, '../../frontend');
// One folder per client; files both clients use live in shared/, the website widget in embed-client/.
const CLIENT_DIRS = { chat: path.join(FRONTEND_DIR, 'chat-client'), admin: path.join(FRONTEND_DIR, 'admin-client') };
const SHARED_DIR = path.join(FRONTEND_DIR, 'shared');
const EMBED_DIR = path.join(FRONTEND_DIR, 'embed-client');
const EXPORTS_DIR = getExportsDirectory();
const LEGACY_EXPORTS_DIR = path.join(__dirname, '../../data/exports');

const FRONTEND_ROUTES = new Set([
  '/',
  '/overview',
  '/page-chat',
  '/library',
  '/watchfolder',
  '/sql',
  '/dictionary',
  '/glossary',
  '/ai-providers',
  '/analytics',
  '/system-logs',
  '/chat-history',
  '/chat-feedback',
  '/training-core',
  '/workflows',
  '/mcp-sources',
  '/system-tools',
  '/settings',
  '/data-governance',
  '/accounts',
  '/memory',
  '/api-docs',
  '/ai-usage'
]);
// Two clients share the server: the chat client at /chat (the default page) and the admin app
// at /admin. A request under either prefix is handled as the same path without the prefix, so
// both reach the same API; the prefix only says which client is asking (an account may be
// limited to one of them, see auth_service.clientAccess). Requests without a prefix (the API
// called by the admin app, the embed widget, old links) count as the admin client.
// Both clients share one login session: one browser is signed in to one account.
const CHAT_CLIENT_PATH = '/chat';
const ADMIN_CLIENT_PATH = '/admin';
const CLIENT_PATHS = { chat: CHAT_CLIENT_PATH, admin: ADMIN_CLIENT_PATH };
const SESSION_COOKIE = 'kh_session';
// The chat page framed on a customer site (embed "page" mode) keeps its own partitioned cookie.
const FRAME_SESSION_COOKIE = 'kh_frame_session';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function routeClient(req) {
  const url = req.url || '/';
  const pathname = url.split('?')[0], query = url.slice(pathname.length);
  for (const [client, prefix] of Object.entries(CLIENT_PATHS)) {
    if (pathname !== prefix && !pathname.startsWith(prefix + '/')) continue;
    req.khClient = client;
    req.khPrefixed = true;
    req.url = (pathname.slice(prefix.length) || '/') + query;
    return;
  }
  req.khClient = 'admin';
}

// A file of the client's own folder, else of shared/; /embed/* is the website widget.
function resolveStaticFile(client, pathname) {
  const inside = (dir, relative) => {
    const file = path.join(dir, relative);
    return file.startsWith(dir + path.sep) ? file : null;
  };
  if (pathname.startsWith('/embed/')) return inside(EMBED_DIR, pathname.slice('/embed/'.length)) || path.join(EMBED_DIR, 'missing');
  for (const dir of [CLIENT_DIRS[client], SHARED_DIR]) {
    const file = inside(dir, pathname);
    if (file && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
  }
  return path.join(CLIENT_DIRS[client], 'missing');
}

// Keeps the embed id when the chat client moves between its page and its login page.
function chatEmbedQuery(parsedUrl) {
  const id = parsedUrl.searchParams.get('embed');
  return id && /^[a-zA-Z0-9-]{1,64}$/.test(id) ? '?embed=' + id : '';
}

// The chat page may be framed only by the app itself, or by the domains of an active embed
// configuration that uses the "page" mode.
function chatFrameAncestors(parsedUrl) {
  const id = parsedUrl.searchParams.get('embed');
  const config = id ? embedChatService.configs.find(item => item.id === id && item.isActive && item.mode === 'page') : null;
  return ["'self'", ...(config?.allowedOrigins || [])].join(' ');
}

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.webmanifest': 'application/manifest+json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=UTF-8',
  '.xls': 'application/vnd.ms-excel; charset=UTF-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf'
};

// Helper to read UTF-8 JSON Body
const readJsonBody = (req, bodyLimit = null) => {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const maxBytes = bodyLimit || Math.max(1024, Number(process.env.API_BODY_MAX_BYTES || 1048576));
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const error = new Error('Request body vượt quá giới hạn cho phép.');
        error.statusCode = 413;
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        let rawText = Buffer.concat(chunks).toString('utf8').trim();
        if (!rawText) return resolve({});
        try {
          resolve(JSON.parse(rawText));
        } catch (pErr) {
          try {
            // Clean escaped quotes from Windows PowerShell / Command Prompt
            const unescaped = rawText.replace(/\\"/g, '"').replace(/^"|"$/g, '');
            resolve(JSON.parse(unescaped));
          } catch (e2) {
            reject(pErr);
          }
        }
      } catch (e) {
        reject(e);
      }
    });
  });
};

const requestWindows = new Map();
function checkChatRateLimit(key) {
  const now = Date.now();
  const windowMs = Number(process.env.CHAT_RATE_WINDOW_MS || 60000);
  const max = Number(process.env.CHAT_RATE_MAX || 30);
  const current = requestWindows.get(key);
  if (!current || current.resetAt <= now) {
    requestWindows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= max;
}

function permissionsForAccount(account, isEmbed = false) {
  if (isEmbed) return ['knowledge:read', 'sql:read'];
  if (account?.role === 'admin') return ['admin'];
  return account?.permissions || ['knowledge:read', 'sql:read'];
}

function buildChatClientPayload(coreResult, execMs, auditId = null) {
  const sqlToolCalls = (coreResult.toolCalls || []).filter(item => ['execute_sql_query', 'query_sql_metric'].includes(item.toolName) && item.success);
  const chartToolCall = (coreResult.toolCalls || []).find(item => item.toolName === 'render_chart' && item.success);
  const exportToolCall = (coreResult.toolCalls || []).find(item => item.toolName === 'export_data' && item.success);
  const downloadUrl = exportToolCall?.result?.downloadUrl || null;
  const generatedSql = coreResult.sqlQuery || sqlToolCalls[sqlToolCalls.length - 1]?.args?.sql || null;
  const chartSpec = coreResult.chartSpec || chartToolCall?.result?.chartSpec || chartToolCall?.args || null;
  const userFacingExecutions = selectUserFacingSqlExecutions(coreResult.sqlExecutions, {
    hasChart: Boolean(chartSpec),
    hasExport: Boolean(exportToolCall)
  });
  const sqlExecutions = userFacingExecutions.map((execution, index) => {
    const rawRows = Array.isArray(execution.rows) ? execution.rows : [];
    const columns = execution.columns?.length ? execution.columns : (rawRows[0] ? Object.keys(rawRows[0]) : []);
    return { index: index + 1, sql: execution.sql || null, columns, rows: rawRows.map(row => columns.map(column => row?.[column] ?? '')), rowCount: execution.rowCount ?? rawRows.length };
  });
  const rawRows = Array.isArray(coreResult.executionResult) ? coreResult.executionResult : [];
  const columns = rawRows[0] ? Object.keys(rawRows[0]) : [];
  const toolResult = rawRows.length ? { columns, rows: rawRows.map(row => columns.map(column => row?.[column] ?? '')) } : null;
  const toolCalls = (coreResult.toolCalls || []).map(item => ({
    name: item.toolName, success: item.success, rowCount: item.result?.rowCount ?? item.result?.rows?.length ?? null,
    ...(item.toolName === 'execute_sql_query' && item.success === false && typeof item.args?.sql === 'string'
      ? { sql: item.args.sql } : {}),
    downloadUrl: item.toolName === 'export_data' ? item.result?.downloadUrl || null : null, error: item.error || null,
    durationMs: Number.isFinite(Number(item.durationMs)) ? Number(item.durationMs) : null
  }));
  return {
    answerEnvelope: require('../agent_core/harness/answer_envelope').createAnswerEnvelope(coreResult),
    retryDisposition: require('../services/chat_retry_policy').disposition(coreResult),
    status: coreResult.success ? 'success' : 'error', completionStatus: coreResult.trace?.completionStatus || (coreResult.success ? 'PARTIAL' : 'ERROR'), reply: coreResult.replyText, generatedSql, toolResult, sqlExecutions, chartSpec, downloadUrl, toolCalls,
    executionTime: `${execMs}ms`, executionMode: coreResult.executionMode, auditId, tokenUsage: coreResult.tokenUsage || null,
    providerFallbacks: coreResult.providerFallbacks || [], contextSelection: coreResult.contextSelection || null,
    execution: coreResult.execution || null,
    citations: coreResult.citations || [], supportingEvidence: coreResult.supportingEvidence || [],
    citationValidation: coreResult.citationValidation || null, provider: coreResult.usedProvider,
    routing: buildChatDiagnostics(coreResult.trace)?.workflowRouting || null,
    message: coreResult.error || null
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  return header.split(';').reduce((acc, part) => {
    const [key, ...valueParts] = part.trim().split('=');
    if (key) acc[key] = decodeURIComponent(valueParts.join('=') || '');
    return acc;
  }, {});
}

function configuredOrigin(req) {
  const configured = String(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(value => value.trim().replace(/\/$/, '')).filter(Boolean);
  const origin = req.headers.origin;
  if (!origin) return null;
  if (configured.includes(origin)) return origin;
  const protocol = process.env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const hostOrigin = `${protocol || (req.socket?.encrypted ? 'https' : 'http')}://${req.headers.host}`;
  return origin === hostOrigin ? origin : null;
}

function isAdminMutation(pathname, method) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  return /^\/api\/(sql|dictionary|glossary|providers|ai-providers|mcp|api-keys|watchfolder|documents|library|workflows|training|system)/.test(pathname);
}

function isAdminOnlyResource(pathname) {
  if (['/accounts', '/views/accounts.html', '/ai-usage', '/views/ai_usage.html'].includes(pathname)) return true;
  if (pathname === '/api/ai-usage/me') return false; // every user may read their own limit
  return /^\/api\/(accounts|settings|backups|providers|ai-providers|ai-usage|api-keys|mcp|system-logs|training|workflows)(\/|$)/.test(pathname);
}

// The cookie this request is signed in with: the shared one, else the framed chat page's one.
function sessionCookieName(req) {
  if (req.khSessionCookie) return req.khSessionCookie;
  const cookies = parseCookies(req);
  return !cookies[SESSION_COOKIE] && cookies[FRAME_SESSION_COOKIE] ? FRAME_SESSION_COOKIE : SESSION_COOKIE;
}

function getSessionToken(req) {
  return parseCookies(req)[sessionCookieName(req)] || '';
}

function secureRequest(req) {
  return Boolean(req.socket?.encrypted || (process.env.TRUST_PROXY === 'true' && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'));
}

// Browsers keep a cookie set inside a customer site's iframe only when it is partitioned and
// SameSite=None, which must be Secure: possible on https and on localhost.
function canSetFrameCookie(req) {
  const hostname = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return secureRequest(req) || LOCAL_HOSTS.has(hostname);
}

function sessionCookieAttributes(req) {
  return sessionCookieName(req) === FRAME_SESSION_COOKIE
    ? 'HttpOnly; Path=/; SameSite=None; Secure; Partitioned'
    : `HttpOnly; SameSite=Lax; Path=/${secureRequest(req) ? '; Secure' : ''}`;
}

function setSessionCookie(req, res, token, maxAge) {
  res.setHeader('Set-Cookie', `${sessionCookieName(req)}=${encodeURIComponent(token)}; ${sessionCookieAttributes(req)}; Max-Age=${maxAge}`);
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${sessionCookieName(req)}=; ${sessionCookieAttributes(req)}; Max-Age=0`);
}

function isPublicPath(pathname) {
  return pathname === '/login' || pathname === '/login.html' || pathname === '/login/'
    || pathname === '/manifest.webmanifest'
    || pathname === '/service-worker.js'
    || pathname === '/favicon.svg'
    || pathname === '/embed/knowledgehub-chat.js'
    || pathname === '/embed/chat-attachments.js'
    || pathname === '/embed/chat-stream.js'
    || pathname === '/api/embed/chat'
    || pathname === '/api/auth/login'
    || pathname === '/api/auth/logout'
    || pathname === '/api/auth/me'
    || pathname === '/health/live'
    || pathname === '/health/ready'
    || pathname.startsWith('/api/workflows/webhook/')
    || pathname.startsWith('/css/')
    || pathname === '/js/theme.js'
    || pathname.startsWith('/js/login')
    || pathname.startsWith('/assets/')
    || pathname.startsWith('/icons/')
    || pathname === '/favicon.ico';
}

/**
 * Handle incoming HTTP requests
 * @param {import('http').IncomingMessage} req 
 * @param {import('http').ServerResponse} res 
 */
async function handleGovernedRequest(req, res) {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 128);
  req.requestId = requestId;
  require('../governance/context').current().requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  routeClient(req);
  const allowedOrigin = configuredOrigin(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS, DELETE');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-User-Id, X-Room-Id, X-Session-Id, X-Workflow-Secret, X-Request-Id'
  );

  if (req.method === 'OPTIONS') {
    res.writeHead(req.headers.origin && !allowedOrigin ? 403 : 204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  const pageRequest = ['GET', 'HEAD'].includes(req.method);
  // Pages live under a client prefix: / opens the chat client, old admin links move to /admin.
  if (pageRequest && !req.khPrefixed) {
    const login = ['/login', '/login.html', '/login/'].includes(pathname);
    const location = pathname === '/' ? CHAT_CLIENT_PATH
      : login ? ADMIN_CLIENT_PATH + '/login' + parsedUrl.search
        : FRONTEND_ROUTES.has(pathname) || pathname === '/index.html'
          ? ADMIN_CLIENT_PATH + (pathname === '/index.html' ? '' : pathname) + parsedUrl.search : '';
    if (location) { res.writeHead(login ? 308 : 302, { Location: location }); res.end(); return; }
  }
  // The chat client has only its chat page and login page; the admin pages stay in the admin app.
  if (pageRequest && req.khClient === 'chat'
    && (pathname === '/index.html' || (FRONTEND_ROUTES.has(pathname) && pathname !== '/') || ['/login.html', '/login/'].includes(pathname))) {
    res.writeHead(302, { Location: CHAT_CLIENT_PATH + chatEmbedQuery(parsedUrl) });
    res.end();
    return;
  }
  if (pageRequest && req.khClient === 'admin' && ['/login.html', '/login/', '/index.html'].includes(pathname)) {
    res.writeHead(308, { Location: ADMIN_CLIENT_PATH + (pathname === '/index.html' ? '' : '/login') + parsedUrl.search });
    res.end();
    return;
  }
  const sessionToken = getSessionToken(req);
  const client = req.khClient === 'chat' ? 'chat' : 'admin';
  // An account limited to the other client counts as signed out here.
  const sessionAccount = authService.getAccountBySession(sessionToken);
  const currentAccount = sessionAccount && authService.canUseClient(sessionAccount, client) ? sessionAccount : null;
  if (currentAccount) require('../governance/context').setPrincipal({ subject: `account:${currentAccount.id}`, role: currentAccount.role, permissions:currentAccount.permissions, dataAccess:currentAccount.dataAccess, tenantId: currentAccount.tenantId, channel: 'chat' }, () => {
    const found = authService.getAccountBySession(sessionToken, { touch: false });
    const account = found && authService.canUseClient(found, client) ? found : null;
    return account ? { subject: `account:${account.id}`, role: account.role, permissions:account.permissions, dataAccess:account.dataAccess, tenantId: account.tenantId, channel: 'chat' } : null;
  });
  // Keep the browser cookie aligned with the server-side sliding session.
  // Without this refresh, the browser drops an otherwise active session eight
  // hours after the original login.
  if (currentAccount && pathname.startsWith('/api/')) {
    setSessionCookie(req, res, sessionToken, authService.getSessionMaxAge());
  }
  if(currentAccount) req.storageOwner=`account:${currentAccount.id}`;
  if (pathname === '/health/live' || pathname === '/health/ready') {
    if (pathname === '/health/ready') await storage.ready();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'ok', requestId }));
    return;
  }
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (isMutation && req.headers.origin && !allowedOrigin && pathname !== '/api/embed/chat') {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ status: 'error', message: 'ORIGIN_NOT_ALLOWED', requestId }));
    return;
  }
  const isChatRoute = ['/api/intelligent-core/chat', '/api/intelligent-core/chat/stream', '/api/embed/chat', '/api/chat', '/api/v1/chat/completions','/api/chat/attachments'].includes(pathname);
  if (await require('../automation/mcp_host_routes').handle(req, res, pathname, currentAccount, readJsonBody)) return;
  if (isChatRoute) {
    const rateKey = currentAccount?.id || req.socket.remoteAddress || 'anonymous';
    if (!checkChatRateLimit(`${pathname}:${rateKey}`)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=UTF-8', 'Retry-After': '60' });
      res.end(JSON.stringify({ status: 'error', message: 'Bạn gửi yêu cầu quá nhanh. Vui lòng thử lại sau.' }));
      return;
    }
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ authenticated: !!currentAccount, account: currentAccount }));
    return;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const { username, password, framed } = await readJsonBody(req);
      const previousToken = getSessionToken(req);
      const result = authService.login(username, password);
      if (!result) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: 'Sai tài khoản hoặc mật khẩu.' }));
        return;
      }
      if (!authService.canUseClient(result.account, client)) {
        authService.logout(result.token);
        res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: client === 'chat'
          ? 'Tài khoản này chỉ được dùng trang quản lý.'
          : 'Tài khoản này chỉ được dùng trang trò chuyện. Hãy đăng nhập tại ' + CHAT_CLIENT_PATH + '/login.' }));
        return;
      }
      // Both clients share this login. Signing in ends the browser's earlier session (for
      // example an admin session when a chat-only account signs in at /chat).
      if (previousToken && previousToken !== result.token) authService.logout(previousToken);
      req.khSessionCookie = framed === true && req.khClient === 'chat' && canSetFrameCookie(req) ? FRAME_SESSION_COOKIE : SESSION_COOKIE;
      setSessionCookie(req, res, result.token, result.maxAge);
      loggerService.addLog('SUCCESS', 'Authentication', `Đăng nhập thành công: ${result.account.username}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', account: result.account }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    authService.logout(getSessionToken(req));
    clearSessionCookie(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ status: 'success' }));
    return;
  }

  if (!currentAccount && !isPublicPath(pathname)) {
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: 'UNAUTHENTICATED' }));
      return;
    }
    res.writeHead(302, { Location: req.khClient === 'chat' ? CHAT_CLIENT_PATH + '/login' + chatEmbedQuery(parsedUrl) : ADMIN_CLIENT_PATH + '/login' });
    res.end();
    return;
  }

  if (currentAccount?.role !== 'admin' && (isAdminOnlyResource(pathname) || isAdminMutation(pathname, req.method))) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ status: 'error', message: 'FORBIDDEN', requestId }));
    return;
  }
  if (!require('../services/account_access').allowed(currentAccount, req.khClient === 'chat' && pathname === '/' ? CHAT_CLIENT_PATH : pathname)) {
    res.writeHead(403, { 'Content-Type':'application/json; charset=UTF-8' }); res.end(JSON.stringify({message:'Bạn chưa được cấp quyền sử dụng chức năng này.'})); return;
  }

  if (await require('../automation/routes').handle(req, res, pathname, currentAccount, readJsonBody)) return;
  if (await require('../governance/routes').handle(req, res, pathname, currentAccount, readJsonBody)) return;
  if (await require('../memory_core/routes').handle(req, res, pathname, currentAccount, readJsonBody)) return;

  if (pathname === '/api/accounts' || pathname.startsWith('/api/accounts/')) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (pathname === '/api/accounts/embed-identity') {
        authService.requireAccountAdmin(currentAccount.id);
        if (req.method === 'GET') {
          res.writeHead(200, {'Content-Type':'application/json; charset=UTF-8'});
          res.end(JSON.stringify({configs:embedChatService.configs.map(c=>({id:c.id,name:c.name,identity:c.identity || {enabled:false}})),sessions:embedChatService.listSessions()})); return;
        }
        if (req.method !== 'PUT') throw Object.assign(new Error('Method not allowed'),{statusCode:405});
        const body = await readJsonBody(req);
        const identity = embedChatService.saveIdentity(body.embedId, body.identity);
        loggerService.addLog('INFO','Embed identity','Cập nhật server xác thực Embed.',{actorId:currentAccount.id,embedId:body.embedId});
        res.writeHead(200, {'Content-Type':'application/json; charset=UTF-8'});
        res.end(JSON.stringify({identity})); return;
      }
      let account;
      if (pathname === '/api/accounts/roles' && req.method === 'GET') {
        const roles=require('../services/account_roles');
        res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8'});
        res.end(JSON.stringify({roles:roles.list(),capabilities:roles.capabilities,resources:{sql:sqlConnector.dbSources.map(s=>({id:s.id,name:s.name||s.dbName||s.id})),documents:require('../knowledge_core/services/library_service').documents.map(d=>({id:d.id,name:d.title||d.id}))}})); return;
      }
      const roleMatch=pathname.match(/^\/api\/accounts\/roles(?:\/([^/]+))?$/);
      if (roleMatch && (req.method==='POST'||req.method==='PUT')) {
        authService.requireAccountAdmin(currentAccount.id);
        const roleId=roleMatch[1]&&decodeURIComponent(roleMatch[1]), previous=roleId&&require('../services/account_roles').get(roleId);
        const role=require('../services/account_roles').save(await readJsonBody(req),roleId);
        if(previous&&(JSON.stringify(previous.permissions)!==JSON.stringify(role.permissions)||JSON.stringify(previous.dataAccess)!==JSON.stringify(role.dataAccess))) {
          const affected=new Set(authService.accounts.filter(a=>a.role===role.id).map(a=>a.id));
          for(const account of authService.accounts)if(affected.has(account.id)){account.securityVersion=(account.securityVersion||0)+1;account.managementRevision=(account.managementRevision||0)+1;}
          for(const [token,session] of Object.entries(authService.sessions))if(affected.has(session.accountId))delete authService.sessions[token];
          if(affected.size){authService.persistAccounts();authService.persistSessions();}
        }
        loggerService.addLog('INFO','Quản lý tài khoản','Quản trị viên cập nhật vai trò.',{actorId:currentAccount.id,roleId:role.id});
        res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8'});res.end(JSON.stringify({role}));return;
      }
      if (pathname === '/api/accounts' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ accounts: authService.listAccounts(currentAccount.id) })); return;
      }
      if (pathname === '/api/accounts' && req.method === 'POST') account = authService.createAccount(currentAccount.id, await readJsonBody(req));
      else {
        const match = pathname.match(/^\/api\/accounts\/([^/]+)(\/password)?$/);
        if (!match || (match[2] ? req.method !== 'POST' : req.method !== 'PUT'))
          throw Object.assign(new Error('Thao tác không được hỗ trợ.'), { statusCode: 405 });
        const id = decodeURIComponent(match[1]), body = await readJsonBody(req);
        account = match[2] ? authService.resetAccountPassword(currentAccount.id, id, body) : authService.updateAccount(currentAccount.id, id, body);
        if (match[2] && id === currentAccount.id) clearSessionCookie(req, res);
      }
      loggerService.addLog('INFO', 'Quản lý tài khoản', 'Quản trị viên cập nhật tài khoản.', { actorId: currentAccount.id, accountId: account.id,
        action: pathname.endsWith('/password') ? 'reset_password' : req.method === 'POST' ? 'create' : 'update' });
      res.writeHead(req.method === 'POST' && pathname === '/api/accounts' ? 201 : 200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ account }));
    } catch (error) {
      res.writeHead(error.statusCode || 503, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ message: error.statusCode ? error.message : 'Không thể lưu tài khoản.' }));
    }
    return;
  }

  if (pathname === '/api/backups' || pathname.startsWith('/api/backups/')) {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (pathname.startsWith('/api/backups/download/') && req.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/api/backups/download/'.length));
        const { stream, bytes, filename } = await backupAdmin.download(id);
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': bytes });
        await new Promise((resolve, reject) => { stream.on('error', reject); res.on('error', reject); res.on('finish', resolve); res.on('close', () => reject(new Error('Download interrupted.'))); stream.pipe(res); });
        return;
      }
      if (pathname === '/api/backups/upload' && req.method === 'POST') {
        if (req.headers['content-type'] !== 'application/octet-stream') throw Object.assign(new Error('Chỉ nhận file .khbackup.'), { statusCode: 415 });
        const result = await backupAdmin.upload(req);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=UTF-8' }); res.end(JSON.stringify(result)); return;
      }
      res.setHeader('Content-Type', 'application/json; charset=UTF-8');
      let result;
      if (pathname === '/api/backups' && req.method === 'GET') result = await backupAdmin.list();
      else if (pathname === '/api/backups/status' && req.method === 'GET') result = backupAdmin.status();
      else if (pathname === '/api/backups/create' && req.method === 'POST') result = backupAdmin.start('backup');
      else if (pathname === '/api/backups/verify' && req.method === 'POST') result = backupAdmin.start('verify', await readJsonBody(req));
      else if (pathname === '/api/backups/import' && req.method === 'POST') result = backupAdmin.start('import', await readJsonBody(req));
      else if (pathname === '/api/backups/restore-current' && req.method === 'POST') result = await backupAdmin.restoreIntoCurrent(await readJsonBody(req));
      else { res.writeHead(405); res.end(JSON.stringify({ message: 'Phương thức không được hỗ trợ.' })); return; }
      res.writeHead(pathname === '/api/backups' || pathname.endsWith('/status') ? 200 : 202);
      res.end(JSON.stringify(result));
    } catch (error) {
      if (res.headersSent) { if (!res.writableEnded) res.destroy(); return; }
      res.writeHead(error.statusCode || 400);
      res.end(JSON.stringify({ message: error.statusCode ? error.message : 'Không thể thực hiện thao tác backup.' }));
    }
    return;
  }

  if(pathname==='/api/auth/profile'&&req.method==='POST') {
    try {
      const account=authService.updateProfile(currentAccount.id,await readJsonBody(req));
      res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8'});res.end(JSON.stringify({account}));
    }catch(error){res.writeHead(error.statusCode||503,{'Content-Type':'application/json; charset=UTF-8'});res.end(JSON.stringify({message:error.statusCode?error.message:'Không lưu được tài khoản.'}));}
    return;
  }
  if (pathname === '/api/auth/change-password' && req.method === 'POST') {
    try {
      if(!checkChatRateLimit('password-change:'+currentAccount.id)) throw Object.assign(new Error('Bạn thao tác quá nhanh. Hãy thử lại sau.'),{statusCode:429});
      const {currentPassword,newPassword}=await readJsonBody(req);
      authService.changePassword(currentAccount.id,currentPassword,newPassword);
      clearSessionCookie(req, res);
      res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8'});
      res.end(JSON.stringify({status:'success',message:'Đã đổi mật khẩu. Vui lòng đăng nhập lại.'}));
    } catch(error) {
      res.writeHead(error.statusCode||503,{'Content-Type':'application/json; charset=UTF-8'});
      res.end(JSON.stringify({status:'error',message:error.statusCode?error.message:'Không thể đổi mật khẩu. Hãy thử lại.'}));
    }
    return;
  }
  if (currentAccount && pathname === '/login') {
    res.writeHead(302, { Location: req.khClient === 'chat' ? CHAT_CLIENT_PATH + chatEmbedQuery(parsedUrl) : ADMIN_CLIENT_PATH });
    res.end();
    return;
  }

  if (pathname === '/api/settings') {
    res.setHeader('Content-Type', 'application/json; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-store');
    if (currentAccount?.role !== 'admin') {
      res.writeHead(403); res.end(JSON.stringify({ message: 'Chỉ quản trị viên được quản lý cấu hình.' })); return;
    }
    try {
      if (req.method === 'GET') { res.end(JSON.stringify(settingsService.get())); return; }
      if (req.method === 'PUT') {
        const result = settingsService.save(await readJsonBody(req));
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(405, { Allow: 'GET, PUT' }); res.end(JSON.stringify({ message: 'Phương thức không được hỗ trợ.' }));
    } catch (error) {
      res.writeHead(error.statusCode || 500);
      res.end(JSON.stringify({ message: error.statusCode ? error.message : 'Không thể lưu cấu hình. Kiểm tra quyền ghi file trên máy chủ.' }));
    }
    return;
  }

  if (pathname === '/api/settings/restart' && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-store');
    if (currentAccount?.role !== 'admin') {
      res.writeHead(403); res.end(JSON.stringify({ message: 'Chỉ quản trị viên được khởi động lại ứng dụng.' })); return;
    }
    if (process.env.KNOWLEDGEHUB_SUPERVISED !== 'true' || typeof process.send !== 'function') {
      res.writeHead(409); res.end(JSON.stringify({ message: 'Ứng dụng chưa chạy bằng Node supervisor. Hãy khởi động lại một lần bằng npm start.' })); return;
    }
    res.writeHead(202);
    res.end(JSON.stringify({ status: 'success', message: 'Đã lên lịch khởi động lại.' }));
    setTimeout(() => process.send?.({ type: 'restart' }), 150).unref();
    return;
  }

  // 1. SQL Connectors & DB Sources APIs
  if (pathname === '/api/sql/sources' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(sqlConnector.getDbSources().filter(source=>require('../governance/context').canRead(source,'sql'))));
    return;
  }

  if (pathname === '/api/sql/ingest-ddl' && req.method === 'POST') {
    try {
      const { ddlScript, dbName } = await readJsonBody(req);
      const parsed = sqlConnector.parseDdlScript(ddlScript || '', dbName);
      dictionaryService.saveDictionaryItems(parsed);
      await dictionaryService.syncToQdrant();

      loggerService.addLog('SUCCESS', 'SQL Connector', `Nạp DDL Script thành công cho DB '${dbName}' (${parsed.length} bảng). Đã index vào Qdrant DB.`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', parsedCount: parsed.length }));
    } catch (err) {
      loggerService.addLog('ERROR', 'SQL Connector', `Lỗi nạp DDL Script cho DB '${dbName}': ${err.message}`);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/sql/add-live' && req.method === 'POST') {
    let config = {};
    try {
      config = await readJsonBody(req);
      const liveTables = await sqlConnector.addLiveSource(config);
      dictionaryService.saveDictionaryItems(liveTables, { completeSourceId: liveTables[0]?.dbSourceId });
      await dictionaryService.syncToQdrant();

      loggerService.addLog('SUCCESS', 'SQL Connector', `Kết nối Live Read-Only thành công tới SQL Server '${config.host}/${config.dbName}' (${liveTables.length} bảng).`);

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=UTF-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ status: 'success', tablesCount: liveTables.length }));
    } catch (err) {
      loggerService.addLog('ERROR', 'SQL Connector', `Lỗi kết nối SQL Server (${config.host || 'unknown'}): ${err.message}`);

      res.writeHead(200, {
        'Content-Type': 'application/json; charset=UTF-8',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/sql/delete-source' && req.method === 'POST') {
    try {
      const { id } = await readJsonBody(req);
      sqlConnector.deleteDbSource(id);
      loggerService.addLog('INFO', 'SQL Connector', `Đã xóa nguồn DB #${id}.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/sql/set-default-source' && req.method === 'POST') {
    try {
      const { id } = await readJsonBody(req);
      const source = sqlConnector.setDefaultDbSource(id);
      loggerService.addLog('INFO', 'SQL Connector', `Đặt '${source.dbName}' làm nguồn CSDL mặc định.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/sql/test-source' && req.method === 'POST') {
    try {
      const { id } = await readJsonBody(req);
      const result = await sqlConnector.testDbSource(id);
      loggerService.addLog('SUCCESS', 'SQL Connector', `Kiểm tra kết nối '${result.dbName}' thành công (${result.latencyMs}ms).`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', ...result }));
    } catch (err) {
      loggerService.addLog('ERROR', 'SQL Connector', `Kiểm tra kết nối thất bại: ${err.message}`);
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/sql/refresh-source' && req.method === 'POST') {
    try {
      const { id } = await readJsonBody(req);
      const liveTables = await sqlConnector.refreshLiveSource(id);
      dictionaryService.saveDictionaryItems(liveTables, { completeSourceId: id });
      await dictionaryService.syncToQdrant();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', tablesCount: liveTables.length, tables: dictionaryService.getGroupedTables() }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // 2. Data Dictionary APIs (Grouped Tables & Active Toggle)
  if (pathname === '/api/dictionary/workspace' && req.method === 'GET') {
    const workspace = dictionaryService.getWorkspaceForSource(sqlConnector.getDefaultDbSource(), sqlConnector.dbSources);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...workspace, domains: domainAliasService.getDomainAliases(),
      quality: require('../services/schema_quality').audit(workspace.tables, workspace.relationships) }));
    return;
  }
  if (pathname === '/api/dictionary' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(dictionaryService.getGroupedTables()));
    return;
  }

  if (pathname === '/api/dictionary/domains' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(domainAliasService.getDomainAliases()));
    return;
  }

  if (pathname === '/api/dictionary/domains/save' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const domains = domainAliasService.upsertDomainAlias(payload);
      dictionaryService.reassignDomain(payload.oldDomain, payload.domain);
      await dictionaryService.syncToQdrant();
      loggerService.addLog('INFO', 'Data Dictionary', `Cập nhật nhóm nghiệp vụ '${payload.domain}' & tự động đồng bộ Qdrant.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', domains }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/domains/delete' && req.method === 'POST') {
    try {
      const { domain } = await readJsonBody(req);
      const domains = domainAliasService.deleteDomainAlias(domain);
      if (!domains) throw new Error('Không tìm thấy nhóm nghiệp vụ.');
      await dictionaryService.syncToQdrant();
      loggerService.addLog('INFO', 'Data Dictionary', `Xóa nhóm nghiệp vụ '${domain}' & tự động đồng bộ Qdrant.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', domains }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/qdrant/sync' && req.method === 'POST') {
    try {
      const syncResult = await dictionaryService.syncToQdrant({ defer: false });
      loggerService.addLog('SUCCESS', 'Qdrant Vector DB', `Đã đồng bộ toàn bộ bảng dữ liệu vào Qdrant tại http://localhost:6333.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', data: syncResult }));
    } catch (err) {
      loggerService.addLog('ERROR', 'Qdrant Vector DB', `Lỗi đồng bộ Qdrant: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/qdrant/status' && req.method === 'GET') {
    const qStatus = await qdrantService.getStatus();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(qStatus));
    return;
  }

  if (pathname === '/api/dictionary' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(dictionaryService.getDictionary()));
    return;
  }

  if (pathname === '/api/dictionary/toggle-active' && req.method === 'POST') {
    try {
      const { tableId, tableName, isActive } = await readJsonBody(req);
      if (!await dictionaryService.toggleTableActive(tableName, isActive, tableId)) throw new Error('Không tìm thấy bảng cần cập nhật.');
      loggerService.addLog('INFO', 'Data Dictionary', `Đã đổi trạng thái Bảng '${tableName}' sang ${isActive ? 'Active (Cho AI)' : 'Tắt'} & tự động đồng bộ Qdrant.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/relationships' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(dictionaryService.getTableRelationships()));
    return;
  }

  if (pathname === '/api/dictionary/relationships/add' && req.method === 'POST') {
    try {
      const relationship = await dictionaryService.addTableRelationship(await readJsonBody(req));
      loggerService.addLog('SUCCESS', 'Data Dictionary', `Đã tạo quan hệ ${relationship.sourceTable}.${relationship.sourceColumn} → ${relationship.targetTable}.${relationship.targetColumn}.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', relationship, relationships: dictionaryService.getTableRelationships() }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/relationships/add-many-to-many' && req.method === 'POST') {
    try {
      const relationships = await dictionaryService.addManyToManyRelationship(await readJsonBody(req));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', created: relationships, relationships: dictionaryService.getTableRelationships() }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/relationships/delete' && req.method === 'POST') {
    try {
      const { id } = await readJsonBody(req);
      if (!await dictionaryService.deleteTableRelationship(id)) throw new Error('Không tìm thấy quan hệ.');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', relationships: dictionaryService.getTableRelationships() }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/relationships/update' && req.method === 'POST') {
    try {
      const { id, ...updates } = await readJsonBody(req);
      const relationship = await dictionaryService.updateTableRelationship(id, updates);
      if (!relationship) throw new Error('Không tìm thấy quan hệ.');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', relationship, relationships: dictionaryService.getTableRelationships() }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/relationships/status' && req.method === 'POST') {
    try {
      const { id, status, expectedRevision } = await readJsonBody(req);
      const relationship = await dictionaryService.setTableRelationshipStatus(id, status, expectedRevision, currentAccount?.id || null);
      if (!relationship) throw Object.assign(new Error('Không tìm thấy quan hệ.'), { statusCode: 404 });
      loggerService.addLog('INFO', 'Data Dictionary', `${status === 'verified' ? 'Xác minh' : 'Từ chối'} quan hệ ${relationship.sourceTable}.${relationship.sourceColumn} → ${relationship.targetTable}.${relationship.targetColumn}.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', relationship, relationships: dictionaryService.getTableRelationships() }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/relationships/preview' && req.method === 'POST') {
    try {
      if (process.env.SQL_JOIN_PLANNER_ENABLED !== 'true') throw Object.assign(new Error('JOIN planner đang tắt bởi feature flag.'), { statusCode: 409 });
      const { tableIds, dbSourceId, question } = await readJsonBody(req);
      let result;
      if (String(question || '').trim()) {
        const schemaContextService = require('../intelligent_core/schema_context_service');
        const source = dbSourceId ? sqlConnector.getDbSources().find(item => item.id === dbSourceId) : sqlConnector.getDefaultDbSource();
        const selection = await schemaContextService.buildSchemaContext(question, { dbSourceId: source?.id || null, dbName: source?.dbName || null });
        result = selection.joinPlan || { outcome: 'no_path', reason: 'Câu hỏi không xác định được ít nhất hai bảng có quan hệ.' };
      } else {
        if (!Array.isArray(tableIds) || tableIds.length < 2) throw Object.assign(new Error('Cần câu hỏi hoặc ít nhất hai bảng để xem đường JOIN.'), { statusCode: 400 });
        const maxEdges = Math.max(1, Math.min(20, parseInt(process.env.SQL_JOIN_MAX_EDGES || '3', 10) || 3));
        result = joinPlannerService.planJoin(tableIds, { dbSourceId, maxEdges });
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ outcome: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/relationships/discover' && req.method === 'POST') {
    try {
      const created = await dictionaryService.discoverRelationshipCandidates(await readJsonBody(req));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', created, relationships: dictionaryService.getTableRelationships() }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/relationships/profile' && req.method === 'POST') {
    try {
      const { id, expectedRevision } = await readJsonBody(req);
      const relationship = await dictionaryService.profileTableRelationship(id, expectedRevision);
      if (!relationship) throw Object.assign(new Error('Không tìm thấy quan hệ.'), { statusCode: 404 });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', relationship, relationships: dictionaryService.getTableRelationships() }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/update-table' && req.method === 'POST') {
    try {
      const { tableId, tableName, description, domain, defaultMetric, defaultTimeColumn, defaultAggregation } = await readJsonBody(req);
      const updated = await dictionaryService.updateTableMetadata(tableName, { description, domain, defaultMetric, defaultTimeColumn, defaultAggregation }, tableId);
      if (!updated) throw new Error('Không tìm thấy bảng cần cập nhật.');
      loggerService.addLog('INFO', 'Data Dictionary', `Cập nhật metadata Bảng '${tableName}' & tự động đồng bộ Qdrant.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', tables: dictionaryService.getGroupedTables() }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/sync-status' && req.method === 'GET') {
    try {
      let state = { status: 'none', attempts: 0 };
      if (!require('../services/embedding_policy').enabled()) state.status = 'disabled';
      else if (storage.enabled()) {
        const result = await storage.getPool().query(`SELECT status, attempts, updated_at FROM app.outbox_jobs
          WHERE kind='dictionary.sync' AND resource_id='dictionary-schema'
          ORDER BY (status IN ('pending','running')) DESC, created_at DESC LIMIT 1`);
        if (result.rows[0]) state = { status: result.rows[0].status, attempts: result.rows[0].attempts, updatedAt: result.rows[0].updated_at };
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(state));
    } catch (error) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'unavailable' }));
    }
    return;
  }

  if (pathname === '/api/dictionary/save-table-configuration' && req.method === 'POST') {
    try {
      const result = await dictionaryService.saveTableConfiguration(await readJsonBody(req));
      loggerService.addLog('INFO', 'Data Dictionary', `Đã lưu đồng thời cấu hình bảng, cột và quan hệ của '${result.table.tableName}', sau đó đồng bộ Qdrant một lần.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', tables: result.tables, relationships: result.relationships, vectorSync: result.vectorSync, configurationAdjustments: result.configurationAdjustments,
        quality: require('../services/schema_quality').audit(result.tables, result.relationships) }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/update-column' && req.method === 'POST') {
    try {
      const { tableId, tableName, columnName, description, displayName } = await readJsonBody(req);
      if (!await dictionaryService.updateColumnDescription(tableName, columnName, description, displayName, tableId)) throw new Error('Không tìm thấy bảng hoặc cột cần cập nhật.');
      loggerService.addLog('INFO', 'Data Dictionary', `Cập nhật metadata cột '${columnName}' của Bảng '${tableName}' & tự động đồng bộ Qdrant.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/chat/providers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control':'no-store' });
    res.end(JSON.stringify({ providers:aiProviderManager.getProviders().filter(p=>p.enabled!==false&&p.isEnabled!==false)
      .map(p=>({id:p.id,name:p.name,type:p.type,model:p.model,isActive:!!p.isActive})) }));
    return;
  }
  if (pathname === '/api/providers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(aiProviderManager.getProviders()));
    return;
  }

  if (pathname === '/api/glossary' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(dictionaryService.getGlossary()));
    return;
  }

  if (pathname === '/api/glossary/add' && req.method === 'POST') {
    try {
      const { term, fullMeaning, category } = await readJsonBody(req);
      await dictionaryService.addGlossaryTerm(term, fullMeaning, category);
      loggerService.addLog('SUCCESS', 'Business Glossary', `Đã thêm thuật ngữ '${term}' (${fullMeaning}) & tự động đồng bộ Qdrant.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', glossary: dictionaryService.getGlossary() }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/glossary/update' && req.method === 'POST') {
    try {
      const { oldTerm, term, fullMeaning, category } = await readJsonBody(req);
      const updated = await dictionaryService.updateGlossaryTerm(oldTerm, term, fullMeaning, category);
      if (!updated) throw new Error(`Không tìm thấy thuật ngữ '${oldTerm}'.`);
      loggerService.addLog('INFO', 'Business Glossary', `Đã cập nhật thuật ngữ '${oldTerm}' thành '${term}' & tự động đồng bộ Qdrant.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', glossary: dictionaryService.getGlossary() }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/glossary/delete' && req.method === 'POST') {
    try {
      const { term } = await readJsonBody(req);
      await dictionaryService.deleteGlossaryTerm(term);
      loggerService.addLog('INFO', 'Business Glossary', `Đã xóa thuật ngữ '${term}' & tự động đồng bộ Qdrant.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', glossary: dictionaryService.getGlossary() }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // Knowledge Core: Library, Watch Folder and the shared ingestion pipeline.
  if (await knowledgeCore.handleRequest(req, res, pathname, {
    readJsonBody,
    logger: loggerService
  })) return;

  if (pathname === '/api/embed/configs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(embedChatService.getConfigs()));
    return;
  }

  if (pathname === '/api/embed/configs/create' && req.method === 'POST') {
    try {
      const config = embedChatService.createConfig(await readJsonBody(req));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', config }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/embed/configs/toggle' && req.method === 'POST') {
    try {
      const { id, isActive } = await readJsonBody(req);
      const config = embedChatService.toggleConfig(id, isActive);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', config }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/embed/configs/update' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const config = embedChatService.updateConfig(payload.id, payload);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', config }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/embed/configs/delete' && req.method === 'POST') {
    try {
      const { id } = await readJsonBody(req);
      embedChatService.deleteConfig(id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // Public embeddable chat endpoint. Provider selection always follows the active backend priority.
  if (pathname === '/api/embed/chat' && req.method === 'POST') {
    const startTime = Date.now();
    let embedStreaming = false;
    const embedEvent = (name, value) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`); };
    const embedAbortController = new AbortController();
    req.once('aborted', () => embedAbortController.abort());
    res.once('close', () => { if (!res.writableEnded) embedAbortController.abort(); });
    try {
      const body = await readJsonBody(req,28*1024*1024);
      const { question, message, history, embedId, sessionId, preview } = body;
      const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const isAdminPreview = preview === true && currentAccount?.role === 'admin';
      const authorization = embedChatService.authorize(embedId, req.headers.origin, clientIp, { skipOrigin: isAdminPreview, recordUsage: !body.presence && !['get','artifact'].includes(body.workflowAction) });
      if (!authorization.ok) {
        res.writeHead(authorization.status, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: authorization.message }));
        return;
      }
      req.storageOwner=`embed:${authorization.config.id}:${authorization.origin || 'admin-preview'}`;
      require('../governance/context').setPrincipal({ subject: req.storageOwner, channel: 'embed', embedId: authorization.config.id });
      if (authorization.origin) res.setHeader('Access-Control-Allow-Origin', authorization.origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Cache-Control', 'no-store');
      const visitorIdentity = require('../services/embed_identity').verify(authorization.config, body.identityToken);
      if (sessionId) embedChatService.touchSession(authorization.config, sessionId, visitorIdentity, authorization.origin);
      if (body.presence === true) {
        res.writeHead(200, {'Content-Type':'application/json; charset=UTF-8'});
        res.end(JSON.stringify({status:'success',mode:embedChatService.normalizeMode(authorization.config.mode)})); return;
      }
      if(body.files || body.batchId) {
        const uploadOwner=JSON.stringify([req.storageOwner,visitorIdentity?.id||sessionId]);
        if(body.attachmentAction==='file') {
          const file=await require('../services/chat_attachment_service').read(uploadOwner,body.batchId,body.fileId);
          res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8'});
          res.end(JSON.stringify({name:file.name,type:file.type,base64:file.bytes.toString('base64')}));return;
        }
        const aborter=new AbortController();res.on('close',()=>{if(!res.writableEnded)aborter.abort();});
        const result=await require('../services/chat_attachment_service').submit(uploadOwner,{...body,channel:'embed'},{signal:aborter.signal});
        res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8'});
        res.end(JSON.stringify(result));return;
      }
      const queryText = String(question || message || '').trim();
      if (!queryText && !body.workflowAction) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: 'Câu hỏi không được để trống.' }));
        return;
      }
      if (queryText.length > authorization.config.maxQuestionLength) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: `Câu hỏi vượt quá ${authorization.config.maxQuestionLength} ký tự.` }));
        return;
      }
      const workflowIdentity = sessionId ? embedChatService.workflowSession(authorization.config, String(sessionId), body.workflowToken, visitorIdentity) : null;
      require('../governance/context').setPrincipal({ subject: workflowIdentity?.accountId || `embed:${authorization.config.id}:${requestId}`, channel: 'embed', embedId: authorization.config.id });
      if (body.workflowAction) {
        if (!body.workflowToken || !workflowIdentity) throw Object.assign(new Error('Cần phiên nghiệp vụ đã xác thực.'),{statusCode:403});
        if (body.workflowAction === 'export_artifact') {
          const filename = String(body.filename || '');
          await require('../governance/context').refresh();
          require('../governance/artifacts').authorize(filename);
          const filePath = path.join(EXPORTS_DIR, filename), stats = await fs.promises.stat(filePath);
          if (!stats.isFile() || stats.size > 20 * 1024 * 1024) throw Object.assign(new Error('File không khả dụng hoặc vượt giới hạn tải.'), { statusCode: 413 });
          res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filename).toLowerCase()] || 'application/octet-stream',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Content-Length': stats.size, 'Cache-Control': 'private, no-store' });
          res.end(await fs.promises.readFile(filePath)); return;
        }
        const automation=require('../automation'); await automation.settings();
        const context={accountId:workflowIdentity.accountId,tenantId:workflowIdentity.tenantId,permissions:permissionsForAccount(null,true)};
        if(body.workflowAction==='artifact') {
          const artifact=await automation.runtime.artifact(body.runId,body.artifactId,context);
          const buffer=await fs.promises.readFile(artifact.path);
          res.writeHead(200,{'Content-Type':artifact.contentType||(artifact.filename.endsWith('.csv')?'text/csv; charset=UTF-8':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(artifact.filename)}`,'Content-Length':buffer.length,'Cache-Control':'private, no-store'});
          res.end(buffer);return;
        }
        let execution;
        if(body.workflowAction==='get') execution=automation.runtime.view(await automation.runtime.owned(body.runId,context));
        else if(body.workflowAction==='inputs') execution=await automation.runtime.inputs(body.runId,body.inputs||{},context,body.revision);
        else if(body.workflowAction==='cancel') execution=await automation.runtime.cancel(body.runId,context,body.revision);
        else if(body.workflowAction==='create') execution=await automation.runtime.create(body.templateId,{},context,{conversationId:embedChatService.conversationId(authorization.config, sessionId, visitorIdentity),requestId:body.requestId,parentRunId:body.parentRunId});
        else throw Object.assign(new Error('Thao tác không hợp lệ.'),{statusCode:400});
        execution.artifacts=(execution.artifacts||[]).map(({id,filename,expiresAt})=>({id,filename,expiresAt}));
        for(const value of Object.values(execution.result||{})) if(Array.isArray(value)) value.splice(authorization.config.maxRows);
        res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8','Cache-Control':'no-store'});res.end(JSON.stringify({status:'success',execution,workflowToken:workflowIdentity.token}));return;
      }
      const safeHistory = Array.isArray(history) ? history
        .filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
        .slice(-authorization.config.maxHistory)
        .map(item => ({ role: item.role, content: item.content.slice(0, authorization.config.maxQuestionLength) })) : [];
      const safeSessionId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100) || null;
      // Scope public memory by embed configuration so two widgets cannot read
      // each other's state even if a client-provided session id collides.
      const memorySessionId = safeSessionId
        ? conversationMemoryService.normalizeSessionId(embedChatService.conversationId(authorization.config, safeSessionId, visitorIdentity))
        : null;
      if (body.stream === true) {
        embedStreaming = true;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=UTF-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders?.();
      }
      const coreResult = await intelligentCore.chat(queryText, {
        history: safeHistory,
        onAnswer:embedStreaming?event=>embedEvent(event.type,event):undefined,
        onProgress: embedStreaming ? event => {
          if (event.type === 'reasoning_delta') return;
          embedEvent('progress', { type: event.type, label: event.label, status: event.status, toolName: event.toolName, durationMs: event.durationMs });
        } : undefined,
        useTools: true,
        signal: embedAbortController.signal,
        permissions: permissionsForAccount(null, true),
        session: memorySessionId ? { id: memorySessionId, accountId:workflowIdentity.accountId,tenantId:workflowIdentity.tenantId,source:'embed' } : undefined
      });
      const execMs = Date.now() - startTime;
      const activeProvider = coreResult.usedProvider || aiProviderManager.getActiveProvider();
      if (embedAbortController.signal.aborted) return;
      if (!coreResult.success) throw Object.assign(new Error(coreResult.error || 'AI provider không phản hồi.'), {
        code: coreResult.errorCode, routing: buildChatDiagnostics(coreResult.trace)?.workflowRouting || null
      });

      const payload = buildChatClientPayload(coreResult, execMs);
      payload.streaming=coreResult.trace?.streaming;
      payload.workflowToken=workflowIdentity?.token;
      if(payload.execution) { payload.execution.artifacts=(payload.execution.artifacts||[]).map(({id,filename,expiresAt})=>({id,filename,expiresAt})); for(const value of Object.values(payload.execution.result||{})) if(Array.isArray(value)) value.splice(authorization.config.maxRows); }
      if (payload.toolResult?.rows) payload.toolResult.rows = payload.toolResult.rows.slice(0, authorization.config.maxRows);
      const auditStatus = coreResult.trace?.completionStatus || 'PARTIAL';
      const memoryPersistence = conversationMemoryService.persistSuccessfulExchange({
        sessionId: memorySessionId,
        accountId: workflowIdentity?.accountId || null,
        embedId: authorization.config.id,
        question: queryText,
        reply: coreResult.replyText,
        currentPlan: coreResult.trace?.training?.plan,
        toolCalls: coreResult.toolCalls || [],
        completionStatus: auditStatus,
        responseEvaluation: coreResult.trace?.training?.responseEvaluation
      });
      const pendingPersistence = memoryPersistence.persisted ? { recorded: false, reason: 'successful_exchange' }
        : conversationMemoryService.recordPendingTurn({
          sessionId: memorySessionId,
          accountId: workflowIdentity?.accountId || null,
          embedId: authorization.config.id,
          question: queryText,
          currentPlan: coreResult.trace?.training?.plan,
          completionStatus: auditStatus,
          responseEvaluation: coreResult.trace?.training?.responseEvaluation
        });
      const audit = loggerService.addChatAudit(queryText, coreResult.replyText, payload.generatedSql, activeProvider, execMs, auditStatus, null, {
        endpoint: '/api/embed/chat', embedId: authorization.config.id, origin: authorization.origin, preview: isAdminPreview,
        historyCount: safeHistory.length, sessionId: safeSessionId, visitorIdentity, toolCalls: payload.toolCalls,
        executionMode: coreResult.executionMode, tokenUsage: coreResult.tokenUsage || null,
        contextSelection: coreResult.contextSelection || null,
        memoryDecision: coreResult.trace?.memoryDecision || null,
        memoryPersisted: memoryPersistence.persisted,
        pendingTurnRecorded: pendingPersistence.recorded,
        diagnostics: buildChatDiagnostics(coreResult.trace)
      });
      const embedPayload = {
        status: payload.status,
        reply: payload.reply,
        chartSpec: payload.chartSpec,
        toolResult: payload.toolResult,
        toolCalls: (payload.toolCalls || []).map(({ name, success, rowCount, error, durationMs }) => ({ name, success, rowCount, error, durationMs })),
        downloadUrl: payload.downloadUrl,
        executionTime: payload.executionTime,
        auditId: audit.id,
        completionStatus: auditStatus,
        citations: payload.citations || [],
        answerEnvelope: payload.answerEnvelope,
        supportingEvidence: payload.supportingEvidence || [],
        citationValidation: payload.citationValidation || null,
        sessionId: safeSessionId,
        execution:payload.execution, workflowToken:payload.workflowToken, tokenUsage:payload.tokenUsage, routing:payload.routing
      };
      if (embedStreaming) { embedEvent('result', embedPayload); res.end(); }
      else { res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' }); res.end(JSON.stringify(embedPayload)); }
    } catch (err) {
      const execMs = Date.now() - startTime;
      loggerService.addLog('ERROR', 'Embed Chat', err.message);
      if (embedAbortController.signal.aborted || res.destroyed) return;
      if (embedStreaming) { embedEvent('error', { status: 'error', message: err.message, errorCode: err.code }); res.end(); return; }
      res.writeHead(err.statusCode || 500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message, errorCode: err.code, routing: err.routing || null, executionTime: `${execMs}ms` }));
    }
    return;
  }

  // Realtime progress stream for the main chat UI.
  if (pathname === '/api/intelligent-core/chat/stream' && req.method === 'POST') {
    const startTime = Date.now();
    let streamOpen = true;
    const requestAbortController = new AbortController();
    req.on('aborted', () => requestAbortController.abort());
    res.on('close', () => {
      streamOpen = false;
      if (!res.writableEnded) requestAbortController.abort();
    });
    const sendEvent = (eventName, payload) => {
      if (!streamOpen || res.writableEnded) return;
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    try {
      const { question, message, history:suppliedHistory, providerId, sessionId, knowledgeSearchEnabled, knowledgeSourceIds, dbSourceId, webSearch, retryMessageIndex, continuationContext } = require('../services/chat_request_context').normalize(await readJsonBody(req));
      const retryState=await require('../services/page_chat_history_service').assertCanChat(currentAccount?.id,sessionId,retryMessageIndex);
      const history=require('../services/chat_request_context').normalize({history:retryState?.history || suppliedHistory}).history;
      const queryText = String(retryState?.question || question || message || '').trim();
      const requestMemory = conversationMemoryService.requestView({sessionId,accountId:currentAccount?.id || null,question:queryText,history,retry:retryMessageIndex!==undefined,latest:retryState?.latest});
      if (!queryText) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: 'Câu hỏi không được để trống.' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=UTF-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders?.();
      const normalizedSessionId = conversationMemoryService.normalizeSessionId(sessionId);
      const memoryHistory = Array.isArray(history) ? history : [];
      const coreResult = await intelligentCore.chat(queryText, {
        providerId: providerId || null,
        history: memoryHistory,
        continuationContext, memoryService:requestMemory,
        useTools: true,
        knowledgeSearchEnabled: knowledgeSearchEnabled !== false,
        knowledgeSourceIds: Array.isArray(knowledgeSourceIds) ? knowledgeSourceIds : [],
        dbSourceId: dbSourceId || null,
        webSearch: webSearch === true,
        permissions: permissionsForAccount(currentAccount),
        session: { id: normalizedSessionId, accountId: currentAccount?.id || null, tenantId: currentAccount?.tenantId },
        signal: requestAbortController.signal,
        onProgress: event => sendEvent('progress', event),
        onAnswer:event=>sendEvent(event.type,event)
      });
      const execMs = Date.now() - startTime;
      const auditProvider = coreResult.usedProvider || aiProviderManager.getActiveProvider();
      if (!coreResult.success) throw Object.assign(new Error(coreResult.error || 'Mô hình AI không phản hồi.'), {
        code: coreResult.errorCode, routing: buildChatDiagnostics(coreResult.trace)?.workflowRouting || null
      });
      const payload = buildChatClientPayload(coreResult, execMs);
      payload.streaming=coreResult.trace?.streaming;
      payload.memoryDecision = coreResult.trace?.memoryDecision || null;
      const auditStatus = coreResult.trace?.completionStatus || 'PARTIAL';
      const memoryPersistence = requestMemory.persistSuccessfulExchange({
        sessionId: normalizedSessionId,
        accountId: currentAccount?.id || null,
        question: queryText,
        reply: coreResult.replyText,
        currentPlan: coreResult.trace?.training?.plan,
        toolCalls: coreResult.toolCalls || [],
        completionStatus: auditStatus,
        responseEvaluation: coreResult.trace?.training?.responseEvaluation
      });
      if(memoryPersistence.persisted) requestMemory.commitRetry?.();
      const pendingPersistence = memoryPersistence.persisted ? { recorded: false, reason: 'successful_exchange' }
        : requestMemory.recordPendingTurn({
          sessionId: normalizedSessionId, accountId: currentAccount?.id || null, question: queryText,
          currentPlan: coreResult.trace?.training?.plan, completionStatus: auditStatus,
          responseEvaluation: coreResult.trace?.training?.responseEvaluation
        });
      const audit = loggerService.addChatAudit(queryText, coreResult.replyText, payload.generatedSql, auditProvider, execMs, auditStatus, null, {
        endpoint: '/api/intelligent-core/chat/stream', providerId: auditProvider?.id || providerId || null,
        providerName: auditProvider?.name || null, model: auditProvider?.model || null, historyCount: memoryHistory.length,
        webSearchEnabled: webSearch === true,
        webSearch: coreResult.contextSelection?.webSearch || null,
        sessionId: normalizedSessionId, toolCalls: payload.toolCalls, executionMode: coreResult.executionMode,
        tokenUsage: coreResult.tokenUsage || null, providerFallbacks: coreResult.providerFallbacks || [], contextSelection: coreResult.contextSelection || null,
        memoryDecision: coreResult.trace?.memoryDecision || null, memoryPersisted: memoryPersistence.persisted,
        pendingTurnRecorded: pendingPersistence.recorded,
        diagnostics: buildChatDiagnostics(coreResult.trace)
      });
      payload.auditId = audit.id;
      sendEvent('final', payload);
      if (!res.writableEnded) res.end();
    } catch (error) {
      const abortMessage = String(error?.message || '').toLowerCase();
      const isAbortError = error?.name === 'AbortError'
        || error?.code === 'ABORT_ERR'
        || abortMessage.includes('operation was aborted')
        || abortMessage.includes('request aborted');
      if (requestAbortController.signal.aborted || isAbortError) {
        if (!res.writableEnded) res.end();
        return;
      }
      loggerService.addLog('ERROR', 'AI Chat Stream', error.message);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: error.message }));
      } else {
        sendEvent('error', { status: 'error', message: error.message, errorCode: error.code, routing: error.routing || null });
        if (!res.writableEnded) res.end();
      }
    }
    return;
  }

  // Intelligent Core Chat API — Real Agentic Loop (LLM + Tool Calling + SQL DB)
  if (pathname === '/api/intelligent-core/chat' && req.method === 'POST') {
    const startTime = Date.now();
    let auditQuestionText = 'N/A';
    let auditProviderId = null;
    try {
      const { question, message, model, history:suppliedHistory, providerId, sessionId, knowledgeSearchEnabled, knowledgeSourceIds, dbSourceId, webSearch, retryMessageIndex, continuationContext } = require('../services/chat_request_context').normalize(await readJsonBody(req));
      const retryState=await require('../services/page_chat_history_service').assertCanChat(currentAccount?.id,sessionId,retryMessageIndex);
      const history=require('../services/chat_request_context').normalize({history:retryState?.history || suppliedHistory}).history;
      const queryText = String(retryState?.question || question || message || '').trim();
      const requestMemory = conversationMemoryService.requestView({sessionId,accountId:currentAccount?.id || null,question:queryText,history,retry:retryMessageIndex!==undefined,latest:retryState?.latest});
      auditQuestionText = queryText || 'N/A';
      auditProviderId = providerId || null;

      if (!queryText.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: 'Câu hỏi không được để trống.' }));
        return;
      }

      const memoryHistory = Array.isArray(history) ? history : [];

      // ── Gọi IntelligentCore.chat() — Agentic Loop thật ──────────────────
      // Flow: User → LLM → Tool Calls (execute_sql_query / qdrant search) → LLM → Reply
      const coreResult = await intelligentCore.chat(queryText, {
        providerId: providerId || null,
        history: memoryHistory,
        continuationContext, memoryService:requestMemory,
        useTools: true,
        knowledgeSearchEnabled: knowledgeSearchEnabled !== false,
        knowledgeSourceIds: Array.isArray(knowledgeSourceIds) ? knowledgeSourceIds : [],
        dbSourceId: dbSourceId || null,
        webSearch: webSearch === true,
        permissions: permissionsForAccount(currentAccount),
        session: { id: conversationMemoryService.normalizeSessionId(sessionId), accountId: currentAccount?.id || null, tenantId: currentAccount?.tenantId }
      });

      const execMs = Date.now() - startTime;
      const auditProvider = coreResult.usedProvider || aiProviderManager.getActiveProvider();
      const auditPayloadBase = {
        endpoint: '/api/intelligent-core/chat',
        question: queryText,
        providerId: auditProvider?.id || providerId || null,
        providerName: auditProvider?.name || null,
        model: auditProvider?.model || null,
        historyCount: memoryHistory.length,
        sessionId: conversationMemoryService.normalizeSessionId(sessionId),
        useTools: true,
        knowledgeSearchEnabled: knowledgeSearchEnabled !== false,
        knowledgeSourceIds: Array.isArray(knowledgeSourceIds) ? knowledgeSourceIds : []
        ,dbSourceId: dbSourceId || null,
        webSearchEnabled: webSearch === true,
        webSearch: coreResult.contextSelection?.webSearch || null,
        memoryDecision: coreResult?.trace?.memoryDecision || null
      };

      if (!coreResult.success && coreResult.errorCode) {
        loggerService.addChatAudit(queryText, null, null, auditProvider, execMs, 'ERROR', coreResult.error,
          { ...auditPayloadBase, diagnostics: buildChatDiagnostics(coreResult.trace) });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: coreResult.error, errorCode: coreResult.errorCode,
          routing: buildChatDiagnostics(coreResult.trace)?.workflowRouting || null, tokenUsage: coreResult.tokenUsage || null,
          provider: coreResult.usedProvider, executionTime: `${execMs}ms` }));
        return;
      }
      if (!coreResult.success) {
        // LLM không khả dụng — trả về fallback thân thiện
        const fallbackReply = 'Mô hình AI hiện tại không phản hồi.';

        loggerService.addLog('WARN', 'AI Chat', 'Mô hình AI không phản hồi.');
        loggerService.addChatAudit(
          queryText,
          fallbackReply,
          null,
          auditProvider,
          execMs,
          'ERROR',
          coreResult.error || 'LLM unavailable',
          { ...auditPayloadBase, status: 'fallback' }
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({
          status: 'fallback',
          reply: fallbackReply,
          generatedSql: null,
          toolResult: null,
          toolCalls: [],
          executionTime: `${execMs}ms`,
          provider: coreResult.usedProvider
        }));
        return;
      }

      // ── Map kết quả Tool Calling sang format frontend cần ────────────────
      const successfulSqlToolCalls = (coreResult.toolCalls || []).filter(t => ['execute_sql_query', 'query_sql_metric'].includes(t.toolName) && t.success);
      const sqlToolCall   = successfulSqlToolCalls[successfulSqlToolCalls.length - 1];
      const chartToolCall = coreResult.toolCalls?.find(t => t.toolName === 'render_chart' && t.success);
      const exportToolCall = coreResult.toolCalls?.find(t => t.toolName === 'export_data' && t.success);
      const generatedSql  = coreResult.sqlQuery || sqlToolCall?.args?.sql || null;
      const chartSpec     = coreResult.chartSpec || chartToolCall?.result?.chartSpec || chartToolCall?.args || null;

      const userFacingExecutions = selectUserFacingSqlExecutions(coreResult.sqlExecutions, {
        hasChart: Boolean(chartSpec),
        hasExport: Boolean(exportToolCall)
      });
      const sqlExecutions = userFacingExecutions.map((execution, index) => {
        const rawExecutionRows = Array.isArray(execution.rows) ? execution.rows : [];
        const columns = execution.columns?.length
          ? execution.columns
          : (rawExecutionRows[0] ? Object.keys(rawExecutionRows[0]) : []);
        return {
          index: index + 1,
          sql: execution.sql || null,
          columns,
          rows: rawExecutionRows.map(row => columns.map(column => row?.[column] ?? '')),
          rowCount: execution.rowCount ?? rawExecutionRows.length
        };
      });

      // Chuẩn hóa executionResult → { columns, rows }
      let toolResult = null;
      const rawRows = coreResult.executionResult;
      if (rawRows && Array.isArray(rawRows) && rawRows.length > 0) {
        const columns = Object.keys(rawRows[0]);
        const rows = rawRows.map(row => columns.map(col => row[col] ?? ''));
        toolResult = { columns, rows };
      }

      // Tóm tắt các tool calls đã chạy
      const toolCallsSummary = (coreResult.toolCalls || []).map(t => ({
        name: t.toolName,
        success: t.success,
        ...(t.toolName === 'execute_sql_query' && t.success === false && typeof t.args?.sql === 'string'
          ? { sql: t.args.sql } : {}),
        rowCount: t.result?.rows?.length ?? null,
        downloadUrl: t.toolName === 'export_data' ? t.result?.downloadUrl || null : null,
        error: t.error || null,
        durationMs: Number.isFinite(Number(t.durationMs)) ? Number(t.durationMs) : null
      }));

      loggerService.addLog('INFO', 'AI Chat',
        `Chat OK | Tools: ${toolCallsSummary.length} | ${execMs}ms (${coreResult.usedProvider?.name || 'AI'})`
      );
      const memoryPersistence = requestMemory.persistSuccessfulExchange({
        sessionId: conversationMemoryService.normalizeSessionId(sessionId),
        accountId: currentAccount?.id || null,
        question: queryText,
        reply: coreResult.replyText,
        currentPlan: coreResult.trace?.training?.plan,
        toolCalls: coreResult.toolCalls || [],
        completionStatus: coreResult.trace?.completionStatus,
        responseEvaluation: coreResult.trace?.training?.responseEvaluation
      });
      if(memoryPersistence.persisted) requestMemory.commitRetry?.();
      const pendingPersistence = memoryPersistence.persisted ? { recorded: false, reason: 'successful_exchange' }
        : requestMemory.recordPendingTurn({
          sessionId: conversationMemoryService.normalizeSessionId(sessionId), accountId: currentAccount?.id || null,
          question: queryText, currentPlan: coreResult.trace?.training?.plan,
          completionStatus: coreResult.trace?.completionStatus,
          responseEvaluation: coreResult.trace?.training?.responseEvaluation
        });
      const chatAudit = loggerService.addChatAudit(
        queryText,
        coreResult.replyText,
        generatedSql,
        auditProvider,
        execMs,
        coreResult.trace?.completionStatus || 'PARTIAL',
        null,
        { ...auditPayloadBase, toolCalls: toolCallsSummary, executionMode: coreResult.executionMode, tokenUsage: coreResult.tokenUsage || null, providerFallbacks: coreResult.providerFallbacks || [], contextSelection: coreResult.contextSelection || null, memoryDecision: coreResult.trace?.memoryDecision || null, memoryPersisted: memoryPersistence.persisted, pendingTurnRecorded: pendingPersistence.recorded, diagnostics: buildChatDiagnostics(coreResult.trace) }
      );

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({
        status: 'success',
        reply: coreResult.replyText,
        completionStatus: coreResult.trace?.completionStatus || 'PARTIAL',
        generatedSql,
        answerEnvelope: require('../agent_core/harness/answer_envelope').createAnswerEnvelope(coreResult),
        toolResult,
        sqlExecutions,
        chartSpec,
        downloadUrl: exportToolCall?.result?.downloadUrl || null,
        toolCalls: toolCallsSummary,
        executionTime: `${execMs}ms`,
        executionMode: coreResult.executionMode,
        auditId: chatAudit.id,
        execution: coreResult.execution || null,
        tokenUsage: coreResult.tokenUsage || null,
        providerFallbacks: coreResult.providerFallbacks || [],
        contextSelection: coreResult.contextSelection || null,
        citations: coreResult.citations || [],
        supportingEvidence: coreResult.supportingEvidence || [],
        citationValidation: coreResult.citationValidation || null,
        memoryDecision: coreResult.trace?.memoryDecision || null,
        provider: coreResult.usedProvider,
        routing: buildChatDiagnostics(coreResult.trace)?.workflowRouting || null
      }));

    } catch (err) {
      loggerService.addLog('ERROR', 'AI Chat', `Lỗi: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }


  if (pathname === '/api/persona' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(aiPersonaService.getPersona()));
    return;
  }

  // 3. System Logs & AI Audit APIs
  if (pathname === '/api/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(loggerService.getLogs()));
    return;
  }

  if(pathname==='/api/chat/attachments/file'&&req.method==='GET') {
    try {
      const file=await require('../services/chat_attachment_service').read(currentAccount?.id,parsedUrl.searchParams.get('batchId'),parsedUrl.searchParams.get('fileId'));
      res.writeHead(200,{'Content-Type':file.type,'Content-Length':file.size,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store','Content-Security-Policy':"sandbox; default-src 'none'"});
      res.end(file.bytes);
    }catch(error){res.writeHead(error.statusCode||500,{'Content-Type':'application/json; charset=UTF-8'});res.end(JSON.stringify({message:error.statusCode?error.message:'Không đọc được tệp.'}));}
    return;
  }
  if(pathname==='/api/chat/attachments'&&req.method==='GET') {
    try {
      const files=await require('../services/chat_attachment_service').list(currentAccount?.id,parsedUrl.searchParams.get('sessionId'));
      res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8','Cache-Control':'no-store'});
      res.end(JSON.stringify({files}));
    }catch(error){res.writeHead(error.statusCode||500,{'Content-Type':'application/json; charset=UTF-8'});res.end(JSON.stringify({message:error.statusCode?error.message:'Không tải được danh sách tệp.'}));}
    return;
  }
  if(pathname==='/api/chat/attachments'&&req.method==='DELETE') {
    try {
      const body=await readJsonBody(req,4096);
      const result=await require('../services/chat_attachment_service').hideFromList(currentAccount?.id,body);
      res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8'});res.end(JSON.stringify(result));
    }catch(error){res.writeHead(error.statusCode||500,{'Content-Type':'application/json; charset=UTF-8'});res.end(JSON.stringify({message:error.statusCode?error.message:'Không xóa được tệp khỏi danh sách.'}));}
    return;
  }
  if(pathname==='/api/chat/attachments'&&req.method==='POST') {
    try {
      const body=await readJsonBody(req,28*1024*1024);
      if(body.sessionId)await require('../services/page_chat_history_service').assertCanChat(currentAccount?.id,body.sessionId,body.retryMessageIndex);
      const aborter=new AbortController();res.on('close',()=>{if(!res.writableEnded)aborter.abort();});
      const started=Date.now();
      const result=await require('../services/chat_attachment_service').submit(currentAccount?.id,{...body,channel:'chat'},{signal:aborter.signal});
      const audit=loggerService.addChatAudit(body.question||'',result.replyText,null,{name:result.providerName,model:result.modelName},Date.now()-started,result.completionStatus,result.completionStatus==='ERROR'?result.replyText:null,
        {endpoint:'/api/chat/attachments',accountId:currentAccount?.id,sessionId:body.sessionId,providerId:result.providerId,tokenUsage:result.tokenUsage,attachments:result.attachments});
      result.auditId=audit.id;
      res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8','Cache-Control':'no-store'});
      res.end(JSON.stringify(result));
    }catch(error){
      res.writeHead(error.statusCode||500,{'Content-Type':'application/json; charset=UTF-8'});
      res.end(JSON.stringify({status:'error',message:error.statusCode?error.message:'Không lưu được tệp. Hãy thử lại.'}));
    }
    return;
  }
  if (pathname === '/api/page-chat/sessions' && ['GET','POST'].includes(req.method)) {
    try {
      const history = require('../services/page_chat_history_service');
      const query=parsedUrl.searchParams;
      const body=req.method==='POST' ? await readJsonBody(req,8*1024*1024) : null;
      const result = req.method === 'GET'
        ? query.has('continuation')
          ? await history.continuation(currentAccount.id,query.get('sessionId'),Number(query.get('version')))
          : query.has('sessionId')
          ? {session:await history.page(currentAccount.id,query.get('sessionId'),Number(query.get('before')),Number(query.get('version')))}
          : {sessions:await history.list(currentAccount.id,true)}
        : body.action==='summarize' ? await history.summarize(currentAccount.id,body)
          : body.action==='replaceAnswer' ? await history.replaceAnswer(currentAccount.id,body)
            : body.action==='suggestReplies' ? await history.suggestReplies(currentAccount.id,body) : await history.save(currentAccount.id,body);
      res.writeHead(200, {'Content-Type':'application/json; charset=UTF-8','Cache-Control':'no-store'});
      res.end(JSON.stringify(result));
    } catch(error) {
      res.writeHead(error.statusCode||503, {'Content-Type':'application/json; charset=UTF-8'});
      res.end(JSON.stringify({message:error.statusCode?error.message:'CHAT_HISTORY_STORAGE_FAILED'}));
    }
    return;
  }
  if (pathname === '/api/chat-history' && req.method === 'GET') {
    const params=new URL(req.url,'http://localhost').searchParams;
    if(params.has('id')||params.get('list')==='1') {
      try {
        const reader=require('../services/audit_reader');
        const data=params.has('id')?await reader.detail(params.get('id'),currentAccount):await reader.list(currentAccount);
        res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8','Cache-Control':'private, no-store'});res.end(JSON.stringify(data));
      }catch(error){res.writeHead(error.statusCode||500,{'Content-Type':'application/json; charset=UTF-8'});res.end(JSON.stringify({message:error.statusCode===404?error.message:'Không thể tải lịch sử chat.'}));}
      return;
    }
    if(new URL(req.url,'http://localhost').searchParams.get('summary')==='1') {
      const summary=await require('../services/analytics_summary').history(currentAccount);
      res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8','Cache-Control':'private, no-store'});
      res.end(JSON.stringify(summary));return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    const history=loggerService.getChatHistory();
    res.end(JSON.stringify(currentAccount?.role==='admin'?history:history.filter(item=>item.requestPayload?.principalRef===`account:${currentAccount.id}`||item.requestPayload?.memoryDecision?.accountId===currentAccount.id)));
    return;
  }

  if (pathname === '/api/training-report' && req.method === 'GET') {
    let data;
    if(storage.enabled()) {
      const feedback=loggerService.chatFeedback;
      const reviewed=[...new Map(feedback.map(item=>[item.auditId,item])).values()].filter(item=>item.reviewStatus==='needs_review');
      data={feedback,history:await require('../services/audit_reader').records(reviewed.map(item=>item.auditId).filter(Boolean))};
    }
    const report = buildTrainingReport(path.join(__dirname, '../../..'),data);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(report));
    return;
  }

  if (pathname === '/api/training-report/resolve' && req.method === 'POST') {
    try {
      if (currentAccount?.role !== 'admin') throw Object.assign(new Error('Chỉ admin được cập nhật trạng thái xử lý.'), { statusCode: 403 });
      const { caseId, resolved } = await readJsonBody(req);
      if (typeof resolved !== 'boolean') throw new Error('Trạng thái xử lý không hợp lệ.');
      const resolution = trainingResolutionService.set(caseId, resolved, currentAccount.username || currentAccount.id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', resolution }));
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/training/skills' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      skills: skillCore.getSkills(),
      examples: skillCore.getExampleCatalog(),
      flags: {
        skillCoreEnabled: process.env.LOCAL_MODEL_SKILL_CORE_ENABLED === 'true',
        fewShotEnabled: process.env.LOCAL_MODEL_FEW_SHOT_ENABLED === 'true'
      }
    }));
    return;
  }

  if (pathname === '/api/training/skills/save' && req.method === 'POST') {
    try {
      const skill = skillCore.saveSkill(await readJsonBody(req));
      loggerService.addLog('INFO', 'Skill Core', `Cập nhật skill '${skill.id}' từ Training Core.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', skill }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/chat-feedback' && req.method === 'GET') {
    if(new URL(req.url,'http://localhost').searchParams.get('list')==='1') {
      const data=await require('../services/audit_reader').feedback();
      res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8','Cache-Control':'private, no-store'});res.end(JSON.stringify(data));return;
    }
    if(new URL(req.url,'http://localhost').searchParams.get('summary')==='1') {
      const summary=await require('../services/analytics_summary').feedback();
      res.writeHead(200,{'Content-Type':'application/json; charset=UTF-8','Cache-Control':'private, no-store'});
      res.end(JSON.stringify(summary));return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(loggerService.getChatFeedback()));
    return;
  }

  if (pathname === '/api/chat-feedback' && req.method === 'POST') {
    try {
      const { auditId, rating, providerId, model } = await readJsonBody(req);
      const feedback = loggerService.addChatFeedback(auditId, rating, { providerId, model });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', feedback }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/chat-feedback/review' && req.method === 'PUT') {
    try {
      const { auditId, reviewStatus, reviewNote, expectedOutcome } = await readJsonBody(req);
      const feedback = loggerService.reviewChatFeedback(auditId, reviewStatus, reviewNote, { expectedOutcome, reviewer: currentAccount?.id });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', feedback }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/conversation-memory/clear' && req.method === 'POST') {
    const { sessionId } = await readJsonBody(req);
    conversationMemoryService.clearSession(sessionId, currentAccount?.id || null);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ status: 'success' }));
    return;
  }

  if (pathname === '/api/logs/clear' && req.method === 'POST') {
    loggerService.clearLogs();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ status: 'success' }));
    return;
  }

  // 4. MCP Data Sources APIs
  if (pathname === '/api/mcp/servers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(mcpService.getServers()));
    return;
  }

  if (pathname === '/api/mcp/add' && req.method === 'POST') {
    try {
      const serverData = await readJsonBody(req);
      const created = await mcpService.addServer(serverData);
      const publicServer = mcpService.getServers().find(item => item.id === created.id);
      loggerService.addLog('SUCCESS', 'MCP Engine', `Khai báo MCP Data Source mới: '${created.name}' (${created.protocol}).`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', server: publicServer }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/mcp/review-read-only' && req.method === 'POST') {
    try {
      if (currentAccount?.role !== 'admin') throw Object.assign(new Error('Cần quyền quản trị.'), { statusCode: 403 });
      const body = await readJsonBody(req);
      const server = mcpService.reviewReadOnly(body.id, body, currentAccount.id);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', server }));
    } catch (error) {
      res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: error.message }));
    }
    return;
  }

  if (pathname === '/api/mcp/delete' && req.method === 'POST') {
    try {
      const { id } = await readJsonBody(req);
      await mcpService.deleteServer(id);
      loggerService.addLog('WARN', 'MCP Engine', `Đã gỡ bỏ MCP Server #${id}.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/mcp/connect' && req.method === 'POST') {
    try {
      const { id } = await readJsonBody(req);
      const connected = await mcpService.connectServer(id);
      const server = mcpService.getServers().find(item => item.id === connected.id);
      loggerService.addLog('SUCCESS', 'MCP Engine', `Đã kết nối MCP Server '${connected.name}': ${connected.tools.length} tools, ${connected.resources.length} resources.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', server }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // 5. 3rd-Party API Keys Management APIs
  if (pathname === '/api/keys' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(apiKeyService.getKeys()));
    return;
  }

  if (pathname === '/api/keys/generate' && req.method === 'POST') {
    try {
      const { name, rateLimit } = await readJsonBody(req);
      const created = apiKeyService.generateKey(name, rateLimit);
      loggerService.addLog('SUCCESS', 'API Gateway', `Sinh API Key mới cho Bên thứ 3: '${created.name}'.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', apiKey: created }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/keys/revoke' && req.method === 'POST') {
    try {
      const { id } = await readJsonBody(req);
      apiKeyService.revokeKey(id);
      loggerService.addLog('WARN', 'API Gateway', `Thu hồi API Key #${id}.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // ── Intelligent Core: Main Chat API ───────────────────────────────────────
  if (pathname === '/api/chat' && req.method === 'POST') {
    const startTime = Date.now();
    try {
      const { message, providerId, history, useTools, dbSourceId, sessionId } = await readJsonBody(req);
      if (!message) throw new Error('Thiếu trường "message" trong request body.');

      const result = await intelligentCore.chat(message, {
        providerId,
        history: history || [],
        useTools: useTools !== false,
        dbSourceId: dbSourceId || null,
        permissions: permissionsForAccount(currentAccount),
        session: { id: sessionId ? conversationMemoryService.normalizeSessionId(sessionId) : null, accountId: currentAccount?.id || null, tenantId: currentAccount?.tenantId }
      });

      const latencyMs = Date.now() - startTime;
      const provider = result.usedProvider || aiProviderManager.getActiveProvider();
      const requestPayload = {
        endpoint: '/api/chat',
        message,
        providerId: provider?.id || providerId || null,
        providerName: provider?.name || null,
        model: provider?.model || null,
        historyCount: Array.isArray(history) ? history.length : 0,
        useTools: useTools !== false
      };
      loggerService.addChatAudit(message, result.replyText, result.sqlQuery, provider, latencyMs,
        result.success ? (result.trace?.completionStatus || 'PARTIAL') : 'ERROR', result.error || null, requestPayload);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(result));
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      loggerService.addLog('ERROR', 'Intelligent Core', `Lỗi xử lý chat: ${err.message}`);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ── AI Persona APIs ────────────────────────────────────────────────────────
  if (pathname === '/api/persona' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(aiPersonaService.getPersona()));
    return;
  }

  if (pathname === '/api/persona' && req.method === 'POST') {
    try {
      const updates = await readJsonBody(req);
      const updated = aiPersonaService.updatePersona(updates);
      loggerService.addLog('INFO', 'AI Persona', `Cập nhật Persona AI: ${updated.name} (${updated.tone}).`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', persona: updated }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // ── Tool Registry APIs ─────────────────────────────────────────────────────
  if (pathname === '/api/tools' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ canManage: currentAccount?.role === 'admin', tools: toolRegistry.listTools(null, { permissions: permissionsForAccount(currentAccount), includeDisabled: true })
      .map(tool => ({ ...tool, enabled: require('../services/tool_settings_service').isEnabled(tool.name) })) }));
    return;
  }

  if (pathname === '/api/tools/state' && req.method === 'POST') {
    try {
      if (currentAccount?.role !== 'admin') throw Object.assign(new Error('Chỉ quản trị viên được bật/tắt công cụ.'), { statusCode: 403 });
      const { toolName, enabled, expectedEnabled } = await readJsonBody(req);
      if (!toolRegistry.listTools(null, { permissions: permissionsForAccount(currentAccount), includeDisabled: true }).some(tool => tool.name === toolName)) throw Object.assign(new Error('Công cụ không tồn tại hoặc không khả dụng.'), { statusCode: 404 });
      const state = require('../services/tool_settings_service').setEnabled(toolName, enabled, expectedEnabled, currentAccount.id);
      loggerService.addLog('INFO', 'System Tools', `${currentAccount.username}: ${enabled ? 'bật' : 'tắt'} ${toolName}`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ success: true, ...state }));
    } catch (error) {
      res.writeHead(error.statusCode || 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ success: false, message: error.message }));
    }
    return;
  }

  if (pathname === '/api/tools/execute' && req.method === 'POST') {
    try {
      const { toolName, args, dbSourceId } = await readJsonBody(req);
      if (!toolName) throw new Error('Thiếu "toolName".');
      const result = await toolRegistry.executeTool(toolName, args || {}, {
        dbSourceId: dbSourceId || null, accountId: currentAccount?.id,
        permissions: permissionsForAccount(currentAccount)
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ── Provider Update API ────────────────────────────────────────────────────
  if (pathname === '/api/ai-providers/update' && req.method === 'POST') {
    try {
      const { providerId, ...updates } = await readJsonBody(req);
      const updated = aiProviderManager.updateProvider(providerId, updates);
      loggerService.addLog('INFO', 'AI Router', `Cập nhật Provider [${updated.name}]: format=${updated.apiFormat}, toolCalling=${updated.supportsToolCalling}.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', provider: updated }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // 6. 3rd-Party OpenAI-Compatible Chat Completion REST API Endpoint
  if (pathname === '/api/v1/chat/completions' && req.method === 'POST') {
    const startTime = Date.now();
    try {
      const body = await readJsonBody(req);
      const messages = body.messages || [];
      const userPrompt = messages.length > 0 ? (messages[messages.length - 1].content || '') : (body.prompt || '');

      const history = messages.slice(0, -1).filter(item => ['system', 'user', 'assistant'].includes(item?.role));
      const result = await intelligentCore.chat(userPrompt, {
        history,
        useTools: body.useTools !== false,
        providerId: body.providerId || null,
        dbSourceId: body.dbSourceId || null,
        permissions: permissionsForAccount(currentAccount),
        session: { id: body.sessionId ? conversationMemoryService.normalizeSessionId(body.sessionId) : null, accountId: currentAccount?.id || null, tenantId: currentAccount?.tenantId, source: 'openai-compatible' }
      });
      const activeProvider = result.usedProvider || aiProviderManager.getActiveProvider();
      if (!result.success) throw new Error(result.error || 'AI provider không phản hồi.');
      const latencyMs = Date.now() - startTime;

      loggerService.addChatAudit(
        userPrompt,
        result.replyText,
        result.sqlQuery,
        activeProvider,
        latencyMs,
        result.trace?.completionStatus || 'PARTIAL',
        null,
        {
          endpoint: '/api/v1/chat/completions',
          model: activeProvider.model,
          messageCount: messages.length,
          prompt: userPrompt
        }
      );

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: activeProvider.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.replyText
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: userPrompt.length,
          completion_tokens: (result.replyText || '').length,
          total_tokens: userPrompt.length + (result.replyText || '').length
        },
        sqlResult: result.executionResult || null,
        answerEnvelope: require('../agent_core/harness/answer_envelope').createAnswerEnvelope(result),
        execution: result.execution || null,
        completionStatus: result.trace?.completionStatus || (result.success ? 'PARTIAL' : 'ERROR')
      }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: { message: err.message, type: "invalid_request_error" } }));
    }
    return;
  }

  // 7. Text-to-SQL & General Chat Agent API (Accepts dynamic providerId)
  if (pathname === '/api/text2sql' && req.method === 'POST') {
    const startTime = Date.now();
    try {
      const { question, providerId, dbSourceId } = await readJsonBody(req);

      let targetProvider = aiProviderManager.getActiveProvider();
      if (providerId) {
        const found = aiProviderManager.getProviderForExecution(providerId);
        if (found) targetProvider = found;
      }

      const selectedSource = dbSourceId ? sqlConnector.getDbSources().find(source => source.id === dbSourceId) : sqlConnector.getDefaultDbSource();
      if (dbSourceId && !selectedSource) throw Object.assign(new Error('Nguồn CSDL không tồn tại.'), { statusCode: 404 });
      const result = await text2SqlAgent.processNaturalLanguageQuery(question || '', targetProvider.id, { dbSourceId: selectedSource?.id || null, dbName: selectedSource?.dbName || null });
      const latencyMs = Date.now() - startTime;

      loggerService.addChatAudit(
        question,
        result.replyText,
        result.sqlQuery,
        targetProvider,
        latencyMs,
        'SUCCESS',
        null,
        {
          endpoint: '/api/text2sql',
          question: question || '',
          providerId: targetProvider.id,
          providerName: targetProvider.name,
          model: targetProvider.model
        }
      );

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({
        ...result,
        usedProvider: {
          id: targetProvider.id,
          name: targetProvider.name,
          model: targetProvider.model,
          type: targetProvider.type
        }
      }));
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      const activeProvider = aiProviderManager.getActiveProvider();
      loggerService.addChatAudit('N/A', '', null, activeProvider, latencyMs, 'ERROR', err.message);

      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // 8. AI Providers APIs
  if (pathname === '/api/ai-providers/fetch-models' && req.method === 'POST') {
    try {
      const { type, baseUrl, apiKey } = await readJsonBody(req);
      let models = [];

      if (type === 'Ollama (Local)' || (baseUrl && baseUrl.includes('11434'))) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 2500);
          const res = await fetch(`${baseUrl || 'http://localhost:11434'}/api/tags`, { signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) {
            const data = await res.json();
            models = (data.models || []).map(m => m.name);
          }
        } catch (e) { }
        if (models.length === 0) {
          models = ['qwen2.5-coder', 'llama3', 'mistral', 'codellama'];
        }
      } else if (type === 'Google Gemini API' || (baseUrl && baseUrl.includes('googleapis.com'))) {
        try {
          const geminiApiUrl = `${baseUrl || 'https://generativelanguage.googleapis.com'}/v1beta/models?key=${apiKey}`;
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4000);
          const res = await fetch(geminiApiUrl, { signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) {
            const data = await res.json();
            const fetched = (data.models || [])
              .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
              .map(m => m.name.replace(/^models\//, ''));
            if (fetched.length > 0) {
              models = fetched;
            }
          }
        } catch (e) {
          console.error("Lỗi khi fetch models từ Google Gemini API:", e.message);
        }
        if (models.length === 0) {
          models = [];
        }
      } else if (type === 'LM Studio' || type === 'OpenAI API' || type === 'OpenAI Compatible' || type === 'DeepSeek API' || (baseUrl && (baseUrl.includes('1234') || baseUrl.includes('openai.com') || baseUrl.includes('deepseek')))) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 4000);
          const headers = { 'Content-Type': 'application/json' };
          if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
          }
          const res = await fetch(`${baseUrl}/models`, { headers, signal: controller.signal });
          clearTimeout(timer);
          if (res.ok) {
            const data = await res.json();
            models = (data.data || []).map(m => m.id);
          }
        } catch (e) {
          console.error("Lỗi khi fetch models từ OpenAI-compat:", e.message);
        }
        if (models.length === 0) {
          if (type === 'LM Studio' || (baseUrl && baseUrl.includes('1234'))) {
            models = ['meta-llama-3-8b-instruct'];
          } else if (type === 'DeepSeek API') {
            models = ['deepseek-chat', 'deepseek-coder'];
          } else {
            models = ['gpt-4o-mini', 'gpt-4o'];
          }
        }
      } else {
        models = ['custom-model-v1', 'default-llm'];
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', models }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/ai-usage/me' && req.method === 'GET') {
    if (!currentAccount) { res.writeHead(401, { 'Content-Type': 'application/json; charset=UTF-8' }); res.end(JSON.stringify({ error: 'Cần đăng nhập.' })); return; }
    const status = await require('../services/ai_usage_service').service.accountStatus(currentAccount.id);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...status, canManage: currentAccount.role === 'admin' }));
    return;
  }

  if (pathname === '/api/ai-usage' && req.method === 'GET') {
    // Admin-only (isAdminOnlyResource): limits, locks and today/this-month usage per account and per model.
    const usageService = require('../services/ai_usage_service');
    const [limits, usage] = await Promise.all([usageService.service.limits(), usageService.service.usage()]);
    const limitOf = (scope, id) => limits.find(item => item.scope === scope && item.targetId === id) || null;
    const usageOf = (scope, id) => usage[`${scope}|${id}`] || usageService.emptyUsage();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      timeZone: usageService.TIME_ZONE, periods: usageService.periodKeys(), setupRequired: usageService.service.missing === true,
      accounts: authService.listAccounts(currentAccount.id).map(account => ({ id: account.id, username: account.username, displayName: account.displayName, role: account.role, roleLabel: account.roleLabel, isActive: account.isActive,
        limit: limitOf('account', account.id), usage: usageOf('account', account.id) })),
      providers: aiProviderManager.getProviders().map(provider => ({ id: provider.id, name: provider.name, model: provider.model, type: provider.type, isActive: Boolean(provider.isActive),
        limit: limitOf('provider', provider.id), usage: usageOf('provider', provider.id) }))
    }));
    return;
  }

  if (pathname === '/api/ai-usage/reset' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const known = body?.scope === 'account' ? authService.listAccounts(currentAccount.id).some(account => account.id === body.targetId)
        : body?.scope === 'provider' && aiProviderManager.getProviders().some(provider => provider.id === body.targetId);
      if (!known) throw Object.assign(new Error('Không tìm thấy tài khoản hoặc mô hình cần đặt lại.'), { statusCode: 404 });
      const result = await require('../services/ai_usage_service').service.resetUsage(body);
      loggerService.addLog('INFO', 'AI Usage', `Đặt lại mức dùng AI ${result.scope}:${result.targetId} — đã xóa ${result.cleared.day} token hôm nay, ${result.cleared.week} tuần này, ${result.cleared.month} tháng này.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname === '/api/ai-usage/limits' && req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const known = body?.scope === 'account' ? authService.listAccounts(currentAccount.id).some(account => account.id === body.targetId)
        : body?.scope === 'provider' && aiProviderManager.getProviders().some(provider => provider.id === body.targetId);
      if (!known) throw Object.assign(new Error('Không tìm thấy tài khoản hoặc mô hình cần đặt hạn mức.'), { statusCode: 404 });
      const limit = await require('../services/ai_usage_service').service.setLimit(body, currentAccount.id);
      loggerService.addLog('INFO', 'AI Usage', `Cập nhật hạn mức AI ${limit.scope}:${limit.targetId} — ${limit.locked ? 'khóa' : 'mở'}, ${limit.tokenLimit === null ? 'không giới hạn' : `${limit.tokenLimit} token/${limit.period === 'day' ? 'ngày' : 'tháng'}`}.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ limit }));
    } catch (error) {
      res.writeHead(error.statusCode || 500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (pathname === '/api/ai-providers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({
      providers: aiProviderManager.getProviders(),
      activeProvider: aiProviderManager.publicProvider(aiProviderManager.getActiveProvider())
    }));
    return;
  }

  if (pathname === '/api/ai-providers/activate' && req.method === 'POST') {
    try {
      const { providerId } = await readJsonBody(req);
      const active = aiProviderManager.setActiveProvider(providerId);
      loggerService.addLog('SUCCESS', 'AI Router', `Đã đổi Active AI Provider sang [${active.name} - ${active.model}].`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', activeProvider: active }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/ai-providers/add' && req.method === 'POST') {
    try {
      const newProvData = await readJsonBody(req);
      const created = aiProviderManager.addProvider(newProvData);
      loggerService.addLog('INFO', 'AI Router', `Khai báo AI Provider mới: [${created.name} - ${created.model}].`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', provider: created }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/ai-providers/test' && req.method === 'POST') {
    try {
      const { providerId } = await readJsonBody(req);
      const result = await aiProviderManager.testConnection(providerId);
      loggerService.addLog('INFO', 'AI Router', `Test kết nối tới Provider #${providerId}: ${result.message} (${result.latencyMs}ms).`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', ...result }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/ai-providers/delete' && req.method === 'POST') {
    try {
      const { providerId } = await readJsonBody(req);
      aiProviderManager.deleteProvider(providerId);
      loggerService.addLog('WARN', 'AI Router', `Đã xóa AI Provider #${providerId}.`);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // Automation Workflows API (independent from chat/LLM)
  if (pathname === '/api/workflows' && req.method === 'GET') {
    const { workflowService } = require('../agent_core');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ workflows: workflowService.list() }));
    return;
  }

  if (pathname === '/api/workflows' && req.method === 'POST') {
    try {
      const { workflowService } = require('../agent_core');
      const workflow = workflowService.save(await readJsonBody(req));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', workflow }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  const workflowRunMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/run$/);
  if (workflowRunMatch && req.method === 'POST') {
    try {
      const { workflowService } = require('../agent_core');
      const body = await readJsonBody(req);
      const execution = await workflowService.run(decodeURIComponent(workflowRunMatch[1]), body.input || body, {
        triggerType: 'manual',
        actor: currentAccount,
        permissions: currentAccount?.role === 'admin' ? ['*'] : []
      });
      res.writeHead(execution.success ? 200 : 422, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(execution));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  const workflowDeleteMatch = pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if (workflowDeleteMatch && req.method === 'DELETE') {
    const { workflowService } = require('../agent_core');
    const removed = workflowService.remove(decodeURIComponent(workflowDeleteMatch[1]));
    res.writeHead(removed ? 200 : 404, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ status: removed ? 'success' : 'error' }));
    return;
  }

  if (pathname === '/api/workflows/runs' && req.method === 'GET') {
    const { workflowService } = require('../agent_core');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ runs: workflowService.history(parsedUrl.searchParams.get('workflowId')) }));
    return;
  }

  const webhookMatch = pathname.match(/^\/api\/workflows\/webhook\/([^/]+)$/);
  if (webhookMatch && req.method === 'POST') {
    try {
      const { workflowService } = require('../agent_core');
      const secret = req.headers['x-workflow-secret'] || parsedUrl.searchParams.get('secret');
      const execution = await workflowService.runWebhook(decodeURIComponent(webhookMatch[1]), secret, await readJsonBody(req));
      res.writeHead(execution.success ? 200 : 422, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(execution));
    } catch (err) {
      res.writeHead(err.message === 'Invalid webhook secret' ? 403 : 400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  // 9. Static File Server
  if (pathname.startsWith('/api/exports/') && req.method === 'GET') {
    const requestedName = decodeURIComponent(pathname.slice('/api/exports/'.length));
    const safeName = path.basename(requestedName);
    if (!safeName || safeName !== requestedName) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: 'Tên file không hợp lệ.' }));
      return;
    }
    try { await require('../governance/context').refresh(); require('../governance/artifacts').authorize(safeName); }
    catch (error) { res.writeHead(error.statusCode || 403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: error.message, code: error.code })); return; }
    const primaryExportPath = path.join(EXPORTS_DIR, safeName);
    const legacyExportPath = path.join(LEGACY_EXPORTS_DIR, safeName);
    const exportPath = fs.existsSync(primaryExportPath) ? primaryExportPath : legacyExportPath;
    if (!fs.existsSync(exportPath) || !fs.statSync(exportPath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: 'Không tìm thấy file export.' }));
      return;
    }
    const extension = path.extname(safeName).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Length': fs.statSync(exportPath).size,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      'Cache-Control': 'private, no-store'
    });
    fs.createReadStream(exportPath).pipe(res);
    return;
  }

  const isFrontendRoute = req.method === 'GET' && FRONTEND_ROUTES.has(pathname);
  const isLoginRoute = ['GET', 'HEAD'].includes(req.method) && pathname === '/login';
  const isChatPage = req.khClient === 'chat' && req.method === 'GET' && pathname === '/';
  const isChatLogin = req.khClient === 'chat' && isLoginRoute;
  const isAdminPage = req.khClient === 'admin' && isFrontendRoute;
  // Read the embed settings here, inside the request: app storage is not available in the file callback.
  const chatFramePolicy = isChatPage || isChatLogin ? `frame-ancestors ${chatFrameAncestors(parsedUrl)}` : '';
  const filePath = isLoginRoute ? path.join(CLIENT_DIRS[req.khClient], 'login.html')
    : isChatPage || isAdminPage ? path.join(CLIENT_DIRS[req.khClient], 'index.html')
      : resolveStaticFile(req.khClient, pathname);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end(`Server Error: ${err.code}`);
      }
    } else {
      const headers = { 'Content-Type': contentType };
      if (chatFramePolicy) headers['Content-Security-Policy'] = chatFramePolicy;
      if (isLoginRoute) {
        try {
          const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf8'));
          const safeVersion = String(version).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
          content = content.toString('utf8').replace('{{APP_VERSION}}', () => safeVersion);
        } catch {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8', 'Cache-Control': 'no-store' });
          res.end('Unable to load application version');
          return;
        }
      }
      if (isAdminPage) {
        content = require('../services/dashboard_shell').render(content.toString('utf8'), pathname);
      }
      if (/\.(?:html|js|css)$/i.test(filePath)) {
        headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      }
      res.writeHead(200, headers);
      res.end(content);
    }
  });
}

module.exports = {
  handleRequest: (req, res) => require('../governance/context').run(() => handleGovernedRequest(req, res))
};
