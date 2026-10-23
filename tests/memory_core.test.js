'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MemoryService } = require('../src/backend/memory_core/memory_service');
const { routeMemory } = require('../src/backend/memory_core/memory_router');
const { resolveReference } = require('../src/backend/memory_core/reference_store');
const { getDomain, hasReferencePronoun, isShortContextualFollowup } = require('../src/backend/memory_core/memory_policy');
const { buildContextualQuery } = require('../src/backend/services/web_search_service');
const { fitOptionalMessages } = require('../src/backend/agent_core/harness/context_budget');

test('one-row SQL entity and dataset resolve to the same previous employee', () => {
  const { deriveReferences } = require('../src/backend/memory_core/reference_store');
  const now = Date.now();
  const refs = deriveReferences({ currentPlan: { table: 'M_Employee', dbSourceId: 'ipms', identityColumns: ['EmployeeCode', 'EmployeeName'] },
    toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { rows: [{ EmployeeCode: 'NV004', EmployeeName: 'Yen Duy' }] } }], now: new Date(now).toISOString() });
  const decision = routeMemory({ question: 'nv trên có địa chỉ gì', currentPlan: { dbSourceId: 'ipms' },
    session: { id: 's', references: refs, activeScope: 'employee', lastPlan: { table: 'M_Employee', dbSourceId: 'ipms' } }, now });
  assert.equal(decision.mode, 'reference'); assert.equal(decision.reference.type, 'lastEntity');
  assert.equal(decision.reference.data.filters.EmployeeCode, 'NV004');
  delete refs.lastDataset.rowCount;
  assert.equal(resolveReference('nv trên có địa chỉ gì', refs, now).type, 'lastEntity');
  refs.lastDataset.updatedAt = new Date(now - 1000).toISOString();
  assert.equal(resolveReference('nv trên có địa chỉ gì', refs, now).reason, 'ambiguous_reference');
});

function plan(table, overrides = {}) {
  return {
    intent: 'list', table, requiredColumns: ['Name'], metric: null, timeColumn: null,
    outputs: { data: true, chart: false, export: false }, ...overrides
  };
}

function service(store = { sessions: {} }) {
  return new MemoryService({ store, save: () => {} });
}

test('a newer incomplete turn cannot resolve to an older workflow dataset as the latest entity', t => {
  const previous = process.env.MEMORY_PENDING_TURN_ENABLED;
  process.env.MEMORY_PENDING_TURN_ENABLED = 'true';
  t.after(() => { if (previous === undefined) delete process.env.MEMORY_PENDING_TURN_ENABLED; else process.env.MEMORY_PENDING_TURN_ENABLED = previous; });
  const memory = service();
  const session = memory.getSession('pending-ref', true);
  session.references.lastDataset = { runId: 'old-run', rowCount: 1, updatedAt: new Date(Date.now() - 2000).toISOString() };
  session.pendingTurn = { question: 'list records', updatedAt: new Date(Date.now() - 1000).toISOString(), completionStatus: 'PARTIAL' };
  const context = memory.getResolutionContext({ sessionId: 'pending-ref' });
  assert.equal(context.candidates.some(candidate => candidate.data.runId === 'old-run'), false);
  assert.ok(context.recent.some(message => message.content === 'list records'));
});

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

test('PARTIAL responses stay out of conversation memory but are logged as such', () => {
  const memory = service();
  const result = memory.persistSuccessfulExchange({
    sessionId: 'partial', question: 'data', reply: 'incomplete', currentPlan: plan('M_Employee'),
    completionStatus: 'PARTIAL', responseEvaluation: { valid: false, failures: ['MISSING_SQL'] }
  });
  assert.equal(result.persisted, false);
  const session = memory.getSession('partial');
  // Messages, plan and references (legacy memory) only take verified turns...
  assert.deepEqual(session.messages, []);
  assert.equal(session.lastPlan, null);
  assert.equal(session.references.lastDataset, null);
  // ...while the turn log keeps the question and its status for follow-ups.
  assert.deepEqual(session.turns.map(turn => [turn.question, turn.status]), [['data', 'PARTIAL']]);
});

test('the turn log keeps the v2 contract and a preview of the rows the user saw', () => {
  const memory = service();
  const rows = [{ Code: 'NV002', Name: 'Demo4' }, { Code: 'NV003', Name: 'Demo2' }];
  memory.persistSuccessfulExchange({ sessionId: 'log', question: 'ds nv CSKH', reply: 'ok', completionStatus: 'SUCCESS',
    responseEvaluation: { valid: true, failures: [] }, currentPlan: { ...plan('M_Employee'), v2: { contract: { root: 'M_Employee' }, dbSourceId: 's' } },
    toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { rows } }] });
  const [turn] = memory.getSession('log').turns;
  assert.deepEqual(turn.contract, { root: 'M_Employee' });
  assert.equal(turn.dbSourceId, 's');
  assert.deepEqual(turn.result, { rowCount: 2, hasMore: false, columns: ['Code', 'Name'], preview: [['NV002', 'Demo4'], ['NV003', 'Demo2']] });
  assert.deepEqual(memory.getResolutionContext({ sessionId: 'log' }, { dbSourceId: 's' }).turns.map(item => item.question), ['ds nv CSKH']);
  assert.deepEqual(memory.getResolutionContext({ sessionId: 'log' }, { dbSourceId: 'other' }).turns, []);
});

test('session caps apply per account before the global backstop', () => {
  const memory = service();
  memory.maxSessionsPerAccount = 2;
  for (const id of ['a1', 'a2', 'a3']) memory.persistSuccessfulExchange({ sessionId: id, accountId: 'alice', question: 'q', reply: 'r',
    currentPlan: plan('M_Employee'), completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] } });
  memory.persistSuccessfulExchange({ sessionId: 'b1', accountId: 'bob', question: 'q', reply: 'r', currentPlan: plan('M_Employee'),
    completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] } });
  const owners = Object.values(memory.store.sessions).map(item => item.accountId).sort();
  assert.deepEqual(owners, ['alice', 'alice', 'bob']);
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

test('frontend history is retained before a backend session exists', () => {
  const memory = service();
  const fallbackHistory = [
    { role: 'user', content: 'tìm nhân viên tên Duy' },
    { role: 'assistant', content: 'Yên Duy là nhân viên NV004, giới tính Nam.' }
  ];
  const decision = memory.route({
    sessionId: 'new-embed-session',
    question: 'nhân viên này có giới tính gì',
    currentPlan: plan('M_Employee'),
    fallbackHistory
  });
  assert.equal(decision.mode, 'recent');
  assert.equal(decision.reason, 'fallback_history');
  assert.deepEqual(memory.getContext(decision), fallbackHistory);
});

test('short web follow-ups reuse recent context and expand the search query', () => {
  const previousPlan = { intent: 'general', table: null, requiredColumns: [], outputs: {} };
  const currentPlan = { intent: 'general', table: null, requiredColumns: [], outputs: {} };
  const decision = routeMemory({
    question: 'tỉ số ntn',
    currentPlan,
    session: { id: 'web', lastPlan: previousPlan, messages: [], references: {} }
  });
  assert.equal(isShortContextualFollowup('tỉ số ntn'), true);
  assert.equal(isShortContextualFollowup('chi tiết nv có mã nv007'), false);
  assert.equal(isShortContextualFollowup('chi tiết hợp đồng có mã 02/HĐTQSDĐ.LG.2010'), false);
  assert.equal(isShortContextualFollowup('chi tiết nv này'), true);
  assert.equal(decision.mode, 'recent');
  assert.equal(decision.reason, 'short_contextual_followup');
  assert.equal(buildContextualQuery('tỉ số ntn', [
    { role: 'user', content: 'kết quả các trận bóng đá hôm nay' },
    { role: 'assistant', content: 'Đây là kết quả bóng đá.' }
  ], true), 'kết quả các trận bóng đá hôm nay\ntỉ số ntn');
});

test('short confirmation replies retain the previous request context', () => {
  const decision = routeMemory({
    question: 'có',
    currentPlan: { intent: 'record_lookup', table: null, requiredColumns: [], outputs: { data: false } },
    session: { id: 'confirm', lastPlan: plan('M_Employee'), activeScope: 'employee', messages: [], references: {} }
  });
  assert.equal(isShortContextualFollowup('có'), true);
  assert.equal(decision.mode, 'recent');
  assert.equal(decision.reason, 'short_contextual_followup');
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

test('generic pronouns do not guess between multiple valid reference types', () => {
  const now = Date.now();
  const result = resolveReference('thông tin đó', {
    lastEntity: { filters: { EmployeeName: 'Yên Duy' }, updatedAt: new Date(now - 2000).toISOString() },
    lastExport: { downloadUrl: '/api/exports/other.xlsx', updatedAt: new Date(now - 1000).toISOString() }
  }, now);
  assert.equal(result.type, null);
  assert.equal(result.reason, 'ambiguous_reference');
});

test('generic pronouns still resolve the only valid reference', () => {
  const now = Date.now();
  const result = resolveReference('thông tin đó', {
    lastEntity: { filters: { EmployeeName: 'Yên Duy' }, updatedAt: new Date(now - 1000).toISOString() }
  }, now);
  assert.equal(result.type, 'lastEntity');
});

test('strict reference resolution can be rolled back with its feature flag', () => {
  const previous = process.env.MEMORY_STRICT_REFERENCE_RESOLUTION;
  process.env.MEMORY_STRICT_REFERENCE_RESOLUTION = 'false';
  try {
    const now = Date.now();
    const result = resolveReference('thông tin đó', {
      lastEntity: { filters: { EmployeeName: 'Yên Duy' }, updatedAt: new Date(now - 2000).toISOString() },
      lastExport: { downloadUrl: '/api/exports/latest.xlsx', updatedAt: new Date(now - 1000).toISOString() }
    }, now);
    assert.equal(result.type, 'lastExport');
  } finally {
    if (previous === undefined) delete process.env.MEMORY_STRICT_REFERENCE_RESOLUTION;
    else process.env.MEMORY_STRICT_REFERENCE_RESOLUTION = previous;
  }
});

test('independent count questions are not short contextual follow-ups', () => {
  assert.equal(isShortContextualFollowup('Phòng Kỹ thuật có bao nhiêu người?'), false);
  assert.equal(isShortContextualFollowup('khách hàng này như thế nào'), false);
  assert.equal(isShortContextualFollowup('tỉ số ntn'), true);
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

test('email and phone remain available in memory while raw SQL is removed', () => {
  const memory = service();
  memory.persistSuccessfulExchange({
    sessionId: 'sanitize', question: 'email a@example.com', reply: '```sql\nSELECT * FROM Users\n```\nLiên hệ 0901234567',
    currentPlan: plan('M_Employee'), completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] }
  });
  const serialized = JSON.stringify(memory.getSession('sanitize'));
  assert.match(serialized, /a@example\.com/);
  assert.match(serialized, /0901234567/);
  assert.doesNotMatch(serialized, /SELECT \* FROM/);
  assert.doesNotMatch(serialized, /EMAIL_MASKED|PHONE_MASKED/);
});

test('memory router fails closed to none', () => {
  const throwingPlan = new Proxy({}, { get() { throw new Error('broken plan'); } });
  const decision = routeMemory({ question: 'test', currentPlan: throwingPlan, session: { lastPlan: plan('M_Employee') } });
  assert.equal(decision.mode, 'none');
  assert.equal(decision.reason, 'memory_core_error');
});

test('multi-row SQL results do not invent a selected entity reference', () => {
  const memory = service();
  memory.persistSuccessfulExchange({
    sessionId: 'many', question: 'danh sách nhân viên', reply: 'Có A và B', currentPlan: plan('M_Employee'),
    completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] },
    toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { rows: [{ EmployeeName: 'A' }, { EmployeeName: 'B' }] } }]
  });
  assert.equal(memory.getSession('many').references.lastEntity, null);
  assert.equal(memory.getSession('many').references.lastDataset.table, 'M_Employee');
});

test('verified multi-row results persist bounded canonical dataset entity keys', () => {
  const memory = service();
  memory.persistSuccessfulExchange({
    sessionId: 'dataset-keys', question: 'nhân viên nữ', reply: 'Có 2 kết quả',
    currentPlan: plan('M_Employee', {
      schemaColumns: ['EmployeeID', 'EmployeeCode', 'EmployeeName'],
      identityColumns: ['EmployeeID', 'EmployeeCode', 'EmployeeName'],
      columnDisplayNames: { EmployeeCode: 'Mã nhân viên', EmployeeName: 'Tên nhân viên' }
    }),
    completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] },
    toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { rows: [
      { EmployeeID: 5, 'Mã nhân viên': 'NV005', 'Tên nhân viên': 'Demo3' },
      { EmployeeID: 6, 'Mã nhân viên': 'NV006', 'Tên nhân viên': 'Nguyễn Văn A' }
    ] } }]
  });
  assert.deepEqual(memory.getSession('dataset-keys').references.lastDataset.entityKeys, [
    { EmployeeID: 5, EmployeeCode: 'NV005', EmployeeName: 'Demo3' },
    { EmployeeID: 6, EmployeeCode: 'NV006', EmployeeName: 'Nguyễn Văn A' }
  ]);
});

test('plural follow-up selects the verified dataset instead of a single entity', () => {
  const now = new Date().toISOString();
  const decision = routeMemory({
    question: '2 nhân viên này thuộc phòng ban gì?', currentPlan: plan('M_Employee'),
    session: { id: 'plural', activeScope: 'employee', lastPlan: plan('M_Employee'), references: {
      lastEntity: { table: 'M_Employee', filters: { EmployeeID: 4 }, updatedAt: now },
      lastDataset: { table: 'M_Employee', entityKeys: [{ EmployeeID: 5 }, { EmployeeID: 6 }], updatedAt: now }
    } }
  });
  assert.equal(decision.mode, 'reference');
  assert.equal(decision.reason, 'collection_reference_detected');
  assert.equal(decision.reference.type, 'lastDataset');
});

test('future-dated references are invalid', () => {
  const now = Date.now();
  assert.equal(resolveReference('người đó', {
    lastEntity: { filters: { EmployeeName: 'Future' }, updatedAt: new Date(now + 60000).toISOString() }
  }, now).type, null);
});

test('pending turn is isolated from successful messages and cleared on success', () => {
  const previous = process.env.MEMORY_PENDING_TURN_ENABLED;
  process.env.MEMORY_PENDING_TURN_ENABLED = 'true';
  try {
    const memory = service();
    const pending = memory.recordPendingTurn({
      sessionId: 'pending', question: 'lọc phòng kỹ thuật', currentPlan: plan('M_Employee'),
      completionStatus: 'PARTIAL', responseEvaluation: { failures: ['MISSING_SQL'] }
    });
    assert.equal(pending.recorded, true);
    assert.equal(memory.getSession('pending').messages.length, 0);
    assert.match(memory.getContext({ mode: 'recent', sessionId: 'pending', currentScope: 'employee' })[0].content, /chưa hoàn tất/);
    memory.persistSuccessfulExchange({
      sessionId: 'pending', question: 'thử lại', reply: 'xong', currentPlan: plan('M_Employee'),
      completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] }
    });
    assert.equal(memory.getSession('pending').pendingTurn, null);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_PENDING_TURN_ENABLED;
    else process.env.MEMORY_PENDING_TURN_ENABLED = previous;
  }
});

test('pending temporal clarification exposes only a source-scoped task, never fabricated record evidence', () => {
  const previous = process.env.MEMORY_PENDING_TURN_ENABLED;
  process.env.MEMORY_PENDING_TURN_ENABLED = 'true';
  try {
    const memory = service();
    memory.recordPendingTurn({ sessionId: 'time-window', question: 'Which records expire soon?', currentPlan: { dbSourceId: 'allowed' },
      completionStatus: 'PARTIAL', responseEvaluation: { failures: ['TEMPORAL_HORIZON_REQUIRED'] } });
    const context = memory.getResolutionContext({ sessionId: 'time-window' }, { dbSourceId: 'allowed' });
    assert.equal(context.candidates[0].kind, 'task');
    assert.equal(context.candidates[0].data.clarification, 'temporal_horizon');
    assert.equal(context.candidates[0].data.rows, undefined);
    assert.equal(context.candidates[0].data.key, undefined);
    assert.equal(memory.getResolutionContext({ sessionId: 'time-window' }, { dbSourceId: 'other' }).candidates.length, 0);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_PENDING_TURN_ENABLED;
    else process.env.MEMORY_PENDING_TURN_ENABLED = previous;
  }
});

test('context budget keeps newest optional messages within the available estimate', () => {
  const result = fitOptionalMessages([
    { role: 'user', content: 'a'.repeat(100) },
    { role: 'assistant', content: 'b'.repeat(100) },
    { role: 'user', content: 'new' }
  ], { contextWindow: 100, outputReserve: 20, requiredTokens: 20, margin: 10 });
  assert.equal(result.messages.at(-1).content, 'new');
  assert.ok(result.estimate.used <= result.estimate.available);
  assert.ok(result.estimate.dropped > 0);
});

test('context budget never separates a user and assistant turn', () => {
  const result = fitOptionalMessages([
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: 'x'.repeat(200) },
    { role: 'user', content: 'new question' },
    { role: 'assistant', content: 'new answer' }
  ], { contextWindow: 80, outputReserve: 20, requiredTokens: 20, margin: 10 });
  assert.deepEqual(result.messages.map(item => item.content), ['new question', 'new answer']);
});

test('recent context excludes stored messages from another explicit scope', () => {
  const memory = service({ sessions: { scoped: {
    id: 'scoped', lastPlan: plan('T_ElectricityOutput'), activeScope: 'electricity', references: {}, messages: [
      { role: 'user', content: 'nhân viên A', scope: 'employee' },
      { role: 'assistant', content: 'A', scope: 'employee' },
      { role: 'user', content: 'sản lượng điện', scope: 'electricity' },
      { role: 'assistant', content: '10', scope: 'electricity' }
    ]
  } } });
  const context = memory.getContext({ mode: 'recent', sessionId: 'scoped', currentScope: 'electricity', maxMessages: 4 });
  assert.deepEqual(context.map(item => item.content), ['sản lượng điện', '10']);
});

test('recent context falls back to the session active scope when current scope is unknown', () => {
  const memory = service({ sessions: { scoped: {
    id: 'scoped', activeScope: 'electricity', references: {}, messages: [
      { role: 'user', content: 'nhân viên A', scope: 'employee' },
      { role: 'assistant', content: 'A', scope: 'employee' },
      { role: 'user', content: 'sản lượng điện', scope: 'electricity' },
      { role: 'assistant', content: '10', scope: 'electricity' }
    ]
  } } });
  const context = memory.getContext({ mode: 'recent', sessionId: 'scoped', currentScope: null, maxMessages: 4 });
  assert.deepEqual(context.map(item => item.content), ['sản lượng điện', '10']);
});

test('retrying a turn sees only the turn log written before that turn', () => {
  const memory = service();
  const ok = { completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] }, currentPlan: plan('M_Employee') };
  const ask = (question, history) => memory.requestView({ sessionId: 'retry', question, history });
  ask('Q1', []).persistSuccessfulExchange({ sessionId: 'retry', question: 'Q1', reply: 'A1', ...ok });
  const history = [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }];
  ask('Q2', history).persistSuccessfulExchange({ sessionId: 'retry', question: 'Q2', reply: 'A2 wrong', ...ok });
  const view = memory.requestView({ sessionId: 'retry', question: 'Q2', history, retry: true, latest: true });
  assert.deepEqual(view.getResolutionContext({ sessionId: 'retry' }).turns.map(turn => turn.question), ['Q1']);
  view.persistSuccessfulExchange({ sessionId: 'retry', question: 'Q2', reply: 'A2 fixed', ...ok });
  view.commitRetry();
  assert.deepEqual(memory.getSession('retry').turns.map(turn => turn.reply), ['A1', 'A2 fixed']);
});
