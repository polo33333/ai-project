'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

test('HTTP and SSE routes expose PARTIAL consistently and never mark it as successful memory', async t => {
  process.env.BOOTSTRAP_ADMIN_PASSWORD = 'isolated-test-password-only';
  const auth = require('../src/backend/services/auth_service');
  const core = require('../src/backend/intelligent_core/core');
  const logger = require('../src/backend/services/logger_service');
  const { memoryService } = require('../src/backend/memory_core');
  const { handleRequest } = require('../src/backend/routes/router');
  t.mock.method(auth, 'getAccountBySession', () => ({ id: 'test-admin', role: 'admin' }));
  const statuses = [];
  t.mock.method(logger, 'addChatAudit', (...args) => { statuses.push(args[5]); return { id: 'test-audit' }; });
  const decisions = [];
  const originalPersist = memoryService.persistSuccessfulExchange.bind(memoryService);
  t.mock.method(memoryService, 'persistSuccessfulExchange', input => {
    const result = originalPersist(input); decisions.push(result); return result;
  });
  t.mock.method(core, 'chat', async (_, options) => {
    options.onProgress?.({ type: 'policy_repair', label: 'Đang điều chỉnh', status: 'warning' });
    return { success: true, replyText: 'Chưa thể hoàn tất yêu cầu với kết quả đã xác minh.', toolCalls: [], sqlExecutions: [],
      usedProvider: { id: 'fixture', name: 'Fixture', model: 'test' },
      trace: { completionStatus: 'PARTIAL', training: { plan: { outputs: { data: true } }, responseEvaluation: { valid: false, failures: ['MISSING_SQL'] } } } };
  });
  const server = http.createServer((req, res) => { handleRequest(req, res).catch(error => { res.statusCode = 500; res.end(error.message); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = path => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'ds hợp đồng', sessionId: 'fixture-session' }) });
  const normal = await post('/api/intelligent-core/chat');
  assert.equal(normal.status, 200);
  assert.equal((await normal.json()).completionStatus, 'PARTIAL');
  const stream = await post('/api/intelligent-core/chat/stream');
  assert.equal(stream.status, 200);
  const body = await stream.text();
  assert.ok(body.indexOf('event: progress') < body.indexOf('event: final'));
  assert.equal((body.match(/event: final/g) || []).length, 1);
  assert.match(body, /"completionStatus":"PARTIAL"/);
  assert.doesNotMatch(body, /SELECT|```sql/);
  assert.deepEqual(statuses, ['PARTIAL', 'PARTIAL']);
  assert.equal(decisions.length, 2);
  assert.ok(decisions.every(decision => decision.persisted === false));
});
