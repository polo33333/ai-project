/**
 * KnowledgeHub AI Server - Router Module
 * Handles all REST API routes & static file serving.
 */

const fs = require('fs');
const path = require('path');

const sqlConnector = require('../services/sql_connector');
const dictionaryService = require('../services/dictionary_service');
const text2SqlAgent = require('../services/text2sql_agent');
const aiProviderManager = require('../services/ai_provider_manager');
const loggerService = require('../services/logger_service');
const mcpService = require('../services/mcp_service');
const apiKeyService = require('../services/api_key_service');
const qdrantService = require('../services/qdrant_service');
const authService = require('../services/auth_service');
const settingsService = require('../services/settings_service').createSettingsService();
const embedChatService = require('../services/embed_chat_service');
const { memoryService: conversationMemoryService } = require('../memory_core');
const knowledgeCore = require('../knowledge_core');
const { selectUserFacingSqlExecutions } = require('../utils/chat_result_selector');
const { buildTrainingReport } = require('../training_core');
const trainingResolutionService = require('../training_core/resolution_service');
const domainAliasService = require('../intelligent_core/domain_alias_service');
const crypto = require('crypto');
const { buildChatDiagnostics } = require('../utils/chat_diagnostics');

// ── Intelligent Core (src/backend/intelligent_core/) ──────────────────────────
const { core: intelligentCore, personaService: aiPersonaService, toolRegistry } = require('../intelligent_core');


const FRONTEND_DIR = path.join(__dirname, '../../frontend');
const EXPORTS_DIR = path.join(__dirname, '../../../data/exports');
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
  '/api-docs'
]);

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
const readJsonBody = (req) => {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let size = 0;
    const maxBytes = Math.max(1024, Number(process.env.API_BODY_MAX_BYTES || 1048576));
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
  if (isEmbed) return ['knowledge:read'];
  if (account?.role === 'admin') return ['admin'];
  return ['knowledge:read', 'sql:read'];
}

function buildChatClientPayload(coreResult, execMs, auditId = null) {
  const sqlToolCalls = (coreResult.toolCalls || []).filter(item => item.toolName === 'execute_sql_query' && item.success);
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
    downloadUrl: item.toolName === 'export_data' ? item.result?.downloadUrl || null : null, error: item.error || null,
    durationMs: Number.isFinite(Number(item.durationMs)) ? Number(item.durationMs) : null
  }));
  return {
    status: coreResult.success ? 'success' : 'error', reply: coreResult.replyText, generatedSql, toolResult, sqlExecutions, chartSpec, downloadUrl, toolCalls,
    executionTime: `${execMs}ms`, executionMode: coreResult.executionMode, auditId, tokenUsage: coreResult.tokenUsage || null,
    providerFallbacks: coreResult.providerFallbacks || [], contextSelection: coreResult.contextSelection || null, provider: coreResult.usedProvider,
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
  const configured = String(process.env.CORS_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  const origin = req.headers.origin;
  if (!origin) return null;
  if (configured.includes(origin)) return origin;
  const hostOrigin = `${process.env.TRUST_PROXY === 'true' && req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  return origin === hostOrigin ? origin : null;
}

function isAdminMutation(pathname, method) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  return /^\/api\/(sql|dictionary|glossary|providers|ai-providers|mcp|api-keys|watchfolder|documents|library|workflows|training|system)/.test(pathname);
}

function isAdminOnlyResource(pathname) {
  return /^\/api\/(settings|providers|ai-providers|api-keys|mcp|system-logs|training|workflows)(\/|$)/.test(pathname);
}

function getSessionToken(req) {
  return parseCookies(req).kh_session || '';
}

function setSessionCookie(res, token, maxAge) {
  res.setHeader('Set-Cookie', `kh_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'kh_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function isPublicPath(pathname) {
  return pathname === '/login.html'
    || pathname === '/manifest.webmanifest'
    || pathname === '/service-worker.js'
    || pathname === '/favicon.svg'
    || pathname === '/embed/knowledgehub-chat.js'
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
async function handleRequest(req, res) {
  const requestId = String(req.headers['x-request-id'] || crypto.randomUUID()).slice(0, 128);
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  const allowedOrigin = configuredOrigin(req);
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
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
  const currentAccount = authService.getAccountBySession(getSessionToken(req));
  if (pathname === '/health/live' || pathname === '/health/ready') {
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
  const isChatRoute = ['/api/intelligent-core/chat', '/api/intelligent-core/chat/stream', '/api/embed/chat', '/api/chat', '/api/v1/chat/completions'].includes(pathname);
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
      const { username, password } = await readJsonBody(req);
      const result = authService.login(username, password);
      if (!result) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: 'Sai tài khoản hoặc mật khẩu.' }));
        return;
      }
      setSessionCookie(res, result.token, result.maxAge);
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
    clearSessionCookie(res);
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
    res.writeHead(302, { Location: '/login.html' });
    res.end();
    return;
  }

  if (currentAccount?.role !== 'admin' && (isAdminOnlyResource(pathname) || isAdminMutation(pathname, req.method) || pathname.startsWith('/api/exports/'))) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify({ status: 'error', message: 'FORBIDDEN', requestId }));
    return;
  }

  if (currentAccount && pathname === '/login.html') {
    res.writeHead(302, { Location: '/' });
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
    res.end(JSON.stringify(sqlConnector.getDbSources()));
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
      dictionaryService.saveDictionaryItems(liveTables);
      dictionaryService.syncToQdrant();

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

  // 2. Data Dictionary APIs (Grouped Tables & Active Toggle)
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
      const syncResult = await dictionaryService.syncToQdrant();
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
      const { tableName, isActive } = await readJsonBody(req);
      await dictionaryService.toggleTableActive(tableName, isActive);
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
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
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
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/dictionary/update-table' && req.method === 'POST') {
    try {
      const { tableName, description, domain, defaultMetric, defaultTimeColumn, defaultAggregation } = await readJsonBody(req);
      const updated = await dictionaryService.updateTableMetadata(tableName, { description, domain, defaultMetric, defaultTimeColumn, defaultAggregation });
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

  if (pathname === '/api/dictionary/update-column' && req.method === 'POST') {
    try {
      const { tableName, columnName, description } = await readJsonBody(req);
      await dictionaryService.updateColumnDescription(tableName, columnName, description);
      loggerService.addLog('INFO', 'Data Dictionary', `Cập nhật mô tả cột '${columnName}' của Bảng '${tableName}' & tự động đồng bộ Qdrant.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
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
    try {
      const { question, message, history, embedId, sessionId } = await readJsonBody(req);
      const clientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const authorization = embedChatService.authorize(embedId, req.headers.origin, clientIp);
      if (!authorization.ok) {
        res.writeHead(authorization.status, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: authorization.message }));
        return;
      }
      res.setHeader('Access-Control-Allow-Origin', authorization.origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Cache-Control', 'no-store');
      const queryText = String(question || message || '').trim();
      if (!queryText) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: 'Câu hỏi không được để trống.' }));
        return;
      }
      if (queryText.length > authorization.config.maxQuestionLength) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: `Câu hỏi vượt quá ${authorization.config.maxQuestionLength} ký tự.` }));
        return;
      }
      const safeHistory = Array.isArray(history) ? history
        .filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
        .slice(-authorization.config.maxHistory)
        .map(item => ({ role: item.role, content: item.content.slice(0, authorization.config.maxQuestionLength) })) : [];
      const safeSessionId = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100) || null;
      const coreResult = await intelligentCore.chat(queryText, {
        history: safeHistory,
        useTools: true,
        permissions: permissionsForAccount(null, true),
        session: safeSessionId ? { id: safeSessionId, source: 'embed' } : undefined
      });
      const execMs = Date.now() - startTime;
      const activeProvider = coreResult.usedProvider || aiProviderManager.getActiveProvider();
      if (!coreResult.success) throw new Error(coreResult.error || 'AI provider không phản hồi.');

      let toolResult = null;
      if (Array.isArray(coreResult.executionResult) && coreResult.executionResult.length > 0) {
        const columns = Object.keys(coreResult.executionResult[0]);
        toolResult = { columns, rows: coreResult.executionResult.slice(0, authorization.config.maxRows).map(row => columns.map(column => row[column] ?? '')) };
      }
      loggerService.addChatAudit(queryText, coreResult.replyText, coreResult.sqlQuery || null, activeProvider, execMs, 'SUCCESS', null, {
        endpoint: '/api/embed/chat', embedId: authorization.config.id, origin: authorization.origin, historyCount: safeHistory.length, sessionId: safeSessionId
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({
        status: 'success',
        reply: coreResult.replyText,
        chartSpec: coreResult.chartSpec || null,
        toolResult,
        executionTime: `${execMs}ms`,
        sessionId: safeSessionId
      }));
    } catch (err) {
      const execMs = Date.now() - startTime;
      loggerService.addLog('ERROR', 'Embed Chat', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message, executionTime: `${execMs}ms` }));
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
      const { question, message, history, providerId, sessionId, knowledgeSearchEnabled, knowledgeSourceIds, dbSourceId, webSearch } = await readJsonBody(req);
      const queryText = String(question || message || '').trim();
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
        useTools: true,
        knowledgeSearchEnabled: knowledgeSearchEnabled !== false,
        knowledgeSourceIds: Array.isArray(knowledgeSourceIds) ? knowledgeSourceIds : [],
        dbSourceId: dbSourceId || null,
        webSearch: webSearch === true,
        permissions: permissionsForAccount(currentAccount),
        session: { id: normalizedSessionId, accountId: currentAccount?.id || null },
        signal: requestAbortController.signal,
        onProgress: event => sendEvent('progress', event)
      });
      const execMs = Date.now() - startTime;
      const auditProvider = coreResult.usedProvider || aiProviderManager.getActiveProvider();
      if (!coreResult.success) throw new Error(coreResult.error || 'Mô hình AI không phản hồi.');
      const payload = buildChatClientPayload(coreResult, execMs);
      payload.memoryDecision = coreResult.trace?.memoryDecision || null;
      const auditStatus = coreResult.trace?.completionStatus || 'SUCCESS';
      const memoryPersistence = conversationMemoryService.persistSuccessfulExchange({
        sessionId: normalizedSessionId,
        accountId: currentAccount?.id || null,
        question: queryText,
        reply: coreResult.replyText,
        currentPlan: coreResult.trace?.training?.plan,
        toolCalls: coreResult.toolCalls || [],
        completionStatus: auditStatus,
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
        sendEvent('error', { status: 'error', message: error.message });
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
      const { question, message, model, history, providerId, sessionId, knowledgeSearchEnabled, knowledgeSourceIds, dbSourceId, webSearch } = await readJsonBody(req);
      const queryText = question || message || '';
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
        useTools: true,
        knowledgeSearchEnabled: knowledgeSearchEnabled !== false,
        knowledgeSourceIds: Array.isArray(knowledgeSourceIds) ? knowledgeSourceIds : [],
        dbSourceId: dbSourceId || null,
        webSearch: webSearch === true,
        permissions: permissionsForAccount(currentAccount),
        session: { id: conversationMemoryService.normalizeSessionId(sessionId), accountId: currentAccount?.id || null }
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
      const successfulSqlToolCalls = (coreResult.toolCalls || []).filter(t => t.toolName === 'execute_sql_query' && t.success);
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
        rowCount: t.result?.rows?.length ?? null,
        downloadUrl: t.toolName === 'export_data' ? t.result?.downloadUrl || null : null,
        error: t.error || null,
        durationMs: Number.isFinite(Number(t.durationMs)) ? Number(t.durationMs) : null
      }));

      loggerService.addLog('INFO', 'AI Chat',
        `Chat OK | Tools: ${toolCallsSummary.length} | ${execMs}ms (${coreResult.usedProvider?.name || 'AI'})`
      );
      const memoryPersistence = conversationMemoryService.persistSuccessfulExchange({
        sessionId: conversationMemoryService.normalizeSessionId(sessionId),
        accountId: currentAccount?.id || null,
        question: queryText,
        reply: coreResult.replyText,
        currentPlan: coreResult.trace?.training?.plan,
        toolCalls: coreResult.toolCalls || [],
        completionStatus: coreResult.trace?.completionStatus,
        responseEvaluation: coreResult.trace?.training?.responseEvaluation
      });
      const chatAudit = loggerService.addChatAudit(
        queryText,
        coreResult.replyText,
        generatedSql,
        auditProvider,
        execMs,
        coreResult.trace?.completionStatus || 'SUCCESS',
        null,
        { ...auditPayloadBase, toolCalls: toolCallsSummary, executionMode: coreResult.executionMode, tokenUsage: coreResult.tokenUsage || null, providerFallbacks: coreResult.providerFallbacks || [], contextSelection: coreResult.contextSelection || null, memoryPersisted: memoryPersistence.persisted, diagnostics: buildChatDiagnostics(coreResult.trace) }
      );

      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({
        status: 'success',
        reply: coreResult.replyText,
        generatedSql,
        toolResult,
        sqlExecutions,
        chartSpec,
        downloadUrl: exportToolCall?.result?.downloadUrl || null,
        toolCalls: toolCallsSummary,
        executionTime: `${execMs}ms`,
        executionMode: coreResult.executionMode,
        auditId: chatAudit.id,
        tokenUsage: coreResult.tokenUsage || null,
        providerFallbacks: coreResult.providerFallbacks || [],
        contextSelection: coreResult.contextSelection || null,
        memoryDecision: coreResult.trace?.memoryDecision || null,
        provider: coreResult.usedProvider
      }));

    } catch (err) {
      loggerService.addLog('ERROR', 'AI Chat', `Lỗi: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }


  if (pathname === '/api/persona' && req.method === 'GET') {
    const personaFile = path.join(__dirname, '../../../data/ai_persona.json');
    if (fs.existsSync(personaFile)) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(fs.readFileSync(personaFile, 'utf8'));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ name: "KAI", quickPrompts: [] }));
    }
    return;
  }

  // 3. System Logs & AI Audit APIs
  if (pathname === '/api/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(loggerService.getLogs()));
    return;
  }

  if (pathname === '/api/chat-history' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(loggerService.getChatHistory()));
    return;
  }

  if (pathname === '/api/training-report' && req.method === 'GET') {
    const report = buildTrainingReport(path.join(__dirname, '../../..'));
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

  if (pathname === '/api/chat-feedback' && req.method === 'GET') {
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
      const { auditId, reviewStatus, reviewNote } = await readJsonBody(req);
      const feedback = loggerService.reviewChatFeedback(auditId, reviewStatus, reviewNote);
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
    conversationMemoryService.clearSession(sessionId);
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
      const created = mcpService.addServer(serverData);
      loggerService.addLog('SUCCESS', 'MCP Engine', `Khai báo MCP Data Source mới: '${created.name}' (${created.protocol}).`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success', server: created }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  if (pathname === '/api/mcp/delete' && req.method === 'POST') {
    try {
      const { id } = await readJsonBody(req);
      mcpService.deleteServer(id);
      loggerService.addLog('WARN', 'MCP Engine', `Đã gỡ bỏ MCP Server #${id}.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({ status: 'success' }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
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
      const { message, providerId, history, useTools, dbSourceId } = await readJsonBody(req);
      if (!message) throw new Error('Thiếu trường "message" trong request body.');

      const result = await intelligentCore.chat(message, {
        providerId,
        history: history || [],
        useTools: useTools !== false,
        dbSourceId: dbSourceId || null,
        permissions: permissionsForAccount(currentAccount),
        session: { accountId: currentAccount?.id || null }
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
        result.success ? 'SUCCESS' : 'ERROR', result.error || null, requestPayload);

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
    res.end(JSON.stringify({ tools: toolRegistry.listTools() }));
    return;
  }

  if (pathname === '/api/tools/execute' && req.method === 'POST') {
    try {
      const { toolName, args } = await readJsonBody(req);
      if (!toolName) throw new Error('Thiếu "toolName".');
      const result = await toolRegistry.executeTool(toolName, args || {});
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
        session: { accountId: currentAccount?.id || null, source: 'openai-compatible' }
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
        'SUCCESS',
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
              content: result.sqlQuery ? `${result.replyText}\n\`\`\`sql\n${result.sqlQuery}\n\`\`\`` : result.replyText
            },
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: userPrompt.length,
          completion_tokens: (result.replyText || '').length,
          total_tokens: userPrompt.length + (result.replyText || '').length
        },
        sqlResult: result.executionResult || null
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
      const { question, providerId } = await readJsonBody(req);

      let targetProvider = aiProviderManager.getActiveProvider();
      if (providerId) {
        const found = aiProviderManager.getProviderForExecution(providerId);
        if (found) targetProvider = found;
      }

      const result = await text2SqlAgent.processNaturalLanguageQuery(question || '', targetProvider.id);
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

  // Legacy demo workflow endpoint
  if (pathname === '/api/agent/workflow/run' && req.method === 'POST') {
    try {
      const { workflowId, input } = await readJsonBody(req);
      const agentCore = require('../agent_core');

      let workflow;
      if (workflowId === 'data_export_pipeline' || !workflowId) {
        workflow = agentCore.builtinWorkflows.createDataExportPipeline();
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=UTF-8' });
        res.end(JSON.stringify({ status: 'error', message: `Workflow "${workflowId}" không nằm trong allowlist.` }));
        return;
      }

      const execution = await workflow.run(input || {}, { permissions: ['*'] });
      
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({
        status: execution.success ? 'success' : 'error',
        success: execution.success,
        state: execution.state,
        trace: execution.trace
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
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
  let filePath = path.join(FRONTEND_DIR, isFrontendRoute ? 'index.html' : pathname);
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
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    }
  });
}

module.exports = {
  handleRequest
};
