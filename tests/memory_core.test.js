'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryService } = require('../src/backend/memory_core/memory_service');
const { routeMemory } = require('../src/backend/memory_core/memory_router');
const { resolveReference } = require('../src/backend/memory_core/reference_store');
const { getDomain, hasReferencePronoun } = require('../src/backend/memory_core/memory_policy');

function plan(table, overrides = {}) {
  return {
    intent: 'list', table, requiredColumns: ['Name'], metric: null, timeColumn: null,
    outputs: { data: true, chart: false, export: false }, ...overrides
  };
}

function service(store = { sessions: {} }) {
  return new MemoryService({ store, save: () => {} });
}

test('legacy sessions are migrated in memory with structured defaults', () => {
  const memory = service({ sessions: { old: { id: 'old', messages: [{ role: 'user', content: 'hi' }] } } });
  const session = memory.getSession('old');
  assert.equal(session.activeScope, null);
  assert.equal(session.lastPlan, null);
  assert.deepEqual(session.references, { lastEntity: null, lastDataset: null, lastExport: null });
});

test('configured Data Dictionary domain overrides the legacy name fallback', () => {
  assert.equal(getDomain('M_Employee', [{ tableName: 'M_Employee', domain: 'Human Resources' }]), 'human_resources');
  assert.equal(getDomain('M_Employee', []), 'employee');
  assert.equal(getDomain('CustomLedger', [{ tableName: 'CustomLedger', domain: 'Finance' }]), 'finance');
});

test('biểu đồ is not mistaken for the pronoun đó', () => {
  assert.equal(hasReferencePronoun('vẽ biểu đồ sản lượng điện và gửi file'), false);
  assert.equal(hasReferencePronoun('vẽ lại dữ liệu đó'), true);
});

test('PARTIAL and invalid responses remain outside conversation memory', () => {
  const memory = service();
  const result = memory.persistSuccessfulExchange({
    sessionId: 'partial', question: 'data', reply: 'incomplete', currentPlan: plan('M_Employee'),
    completionStatus: 'PARTIAL', responseEvaluation: { valid: false, failures: ['MISSING_SQL'] }
  });
  assert.equal(result.persisted, false);
  assert.equal(memory.getSession('partial'), null);
});

test('SUCCESS responses pass the quality gate and update plan', () => {
  const memory = service();
  const result = memory.persistSuccessfulExchange({
    sessionId: 'success', question: 'ds nv', reply: 'Có 1 nhân viên', currentPlan: plan('M_Employee'),
    completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] }
  });
  assert.equal(result.persisted, true);
  assert.equal(memory.getSession('success').messages.length, 2);
  assert.equal(memory.getSession('success').lastPlan.table, 'M_Employee');
});

test('topic changes between employee and electricity route to none', () => {
  const decision = routeMemory({
    question: 'Sản lượng điện theo TotalQty?', currentPlan: plan('T_ElectricityOutput'),
    session: { id: 's', activeScope: 'employee', lastPlan: plan('M_Employee'), references: {} }
  });
  assert.equal(decision.mode, 'none');
  assert.equal(decision.reason, 'topic_changed');
});

test('same-table follow-ups use at most four recent messages', () => {
  const memory = service({ sessions: { s: {
    id: 's', messages: Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index) })),
    lastPlan: plan('M_Employee'), references: {}, activeScope: 'employee'
  } } });
  const decision = memory.route({ sessionId: 's', question: 'chỉ lấy phòng kỹ thuật', currentPlan: plan('M_Employee') });
  assert.equal(decision.mode, 'recent');
  assert.ok(decision.maxMessages <= 4);
  assert.equal(memory.getContext(decision).length, 4);
});

test('entity, dataset and export references resolve by intent keyword', () => {
  const now = Date.now();
  const references = {
    lastEntity: { filters: { EmployeeName: 'Yên Duy' }, updatedAt: new Date(now - 3000).toISOString() },
    lastDataset: { table: 'T_ElectricityOutput', updatedAt: new Date(now - 2000).toISOString() },
    lastExport: { downloadUrl: '/api/exports/a.xlsx', updatedAt: new Date(now - 1000).toISOString() }
  };
  assert.equal(resolveReference('người đó là ai', references, now).type, 'lastEntity');
  assert.equal(resolveReference('vẽ biểu đồ dữ liệu trên', references, now).type, 'lastDataset');
  assert.equal(resolveReference('tải file này', references, now).type, 'lastExport');
});

test('expired references are rejected instead of reused', () => {
  const now = Date.now();
  const result = resolveReference('người đó', {
    lastEntity: { filters: { EmployeeName: 'Old' }, updatedAt: new Date(now - 121 * 60 * 1000).toISOString() }
  }, now);
  assert.equal(result.type, null);
  assert.equal(result.reason, 'reference_expired');
});

test('reference context contains only the structured reference', () => {
  const memory = service();
  const context = memory.getContext({
    mode: 'reference', reference: { type: 'lastDataset', data: { table: 'T_ElectricityOutput', updatedAt: new Date().toISOString() } }
  });
  assert.equal(context.length, 1);
  assert.match(context[0].content, /T_ElectricityOutput/);
  assert.doesNotMatch(context[0].content, /unrelated history/i);
});

test('references never cross account boundaries even with the same session id', () => {
  const memory = service();
  memory.persistSuccessfulExchange({
    sessionId: 'shared', accountId: 'account-a', question: 'ds nv', reply: 'ok', currentPlan: plan('M_Employee'),
    completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] },
    toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { rows: [{ EmployeeName: 'A' }] } }]
  });
  const decision = memory.route({ sessionId: 'shared', accountId: 'account-b', question: 'người đó', currentPlan: plan('M_Employee') });
  assert.equal(decision.mode, 'none');
  assert.equal(decision.reason, 'no_prior_context');
});

test('sensitive fields and raw SQL are sanitized before persistence', () => {
  const memory = service();
  memory.persistSuccessfulExchange({
    sessionId: 'sanitize', question: 'email a@example.com', reply: '```sql\nSELECT * FROM Users\n```\nLiên hệ 0901234567',
    currentPlan: plan('M_Employee'), completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] }
  });
  const serialized = JSON.stringify(memory.getSession('sanitize'));
  assert.doesNotMatch(serialized, /a@example\.com|0901234567|SELECT \* FROM/);
  assert.match(serialized, /EMAIL_MASKED|PHONE_MASKED/);
});

test('memory router fails closed to none', () => {
  const throwingPlan = new Proxy({}, { get() { throw new Error('broken plan'); } });
  const decision = routeMemory({ question: 'test', currentPlan: throwingPlan, session: { lastPlan: plan('M_Employee') } });
  assert.equal(decision.mode, 'none');
  assert.equal(decision.reason, 'memory_core_error');
});
