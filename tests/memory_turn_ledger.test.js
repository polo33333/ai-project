'use strict';
// Conversation state lives in the turn log: snapshots on successful turns,
// pending marks on the others. Readers see the same state as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryService } = require('../src/backend/memory/memory_service');
const { run } = require('./helpers/memory_scenario');

const sql = rows => ({ toolName: 'execute_sql_query', success: true, args: { sql: 'SELECT CustomerCode FROM M_Customer' },
  result: { sql: 'SELECT CustomerCode FROM M_Customer', rows, rowCount: rows.length } });
const service = () => new MemoryService({ store: { sessions: {} }, save() {} });
const success = (memory, question, rows = [{ CustomerCode: 'KA0021' }, { CustomerCode: 'DC6011' }]) => memory.persistSuccessfulExchange({
  sessionId: 's1', accountId: 'a1', question, reply: 'ok', currentPlan: { table: 'M_Customer', dbSourceId: 'db', intent: 'list' },
  toolCalls: [sql(rows)], completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] } });
const partial = (memory, question) => {
  memory.persistSuccessfulExchange({ sessionId: 's1', accountId: 'a1', question, reply: '?', currentPlan: { table: 'M_Customer', dbSourceId: 'db' },
    toolCalls: [], completionStatus: 'PARTIAL', responseEvaluation: { valid: false, failures: ['MISSING_SQL'] } });
  memory.recordPendingTurn({ sessionId: 's1', accountId: 'a1', question, currentPlan: { table: 'M_Customer', dbSourceId: 'db' },
    completionStatus: 'PARTIAL', responseEvaluation: { valid: false, failures: ['MISSING_SQL'] } });
};
function withFlags(t, flags) {
  const saved = Object.fromEntries(Object.keys(flags).map(key => [key, process.env[key]]));
  Object.assign(process.env, flags);
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
}

test('every reader sees the same state as before the turn log held it', () => {
  assert.deepEqual(run(), require('./fixtures/memory_state_characterization.json'));
});

test('the stored session holds state only in its turns', t => {
  withFlags(t, { MEMORY_PENDING_TURN_ENABLED: 'true' });
  const memory = service();
  success(memory, 'danh sách khách hàng');
  partial(memory, 'thêm cột địa chỉ');
  const stored = JSON.parse(JSON.stringify(memory.store.sessions.a1__s1));
  for (const field of ['lastPlan', 'references', 'entityReferences', 'conversationState', 'businessState', 'lastWorkflowRun', 'activeScope', 'summary', 'pendingTurn'])
    assert.equal(Object.hasOwn(stored, field), false, field);
  assert.deepEqual(stored.turns.map(turn => [Boolean(turn.memory), turn.pending?.question || null]), [[true, null], [false, 'thêm cột địa chỉ']]);
  const session = memory.getSession('s1', false, 'a1');
  assert.equal(session.references.lastDataset.rowCount, 2);
  assert.equal(session.pendingTurn.question, 'thêm cột địa chỉ');
  // A later success supersedes the waiting turn.
  success(memory, 'danh sách khách hàng KA0021', [{ CustomerCode: 'KA0021' }]);
  assert.equal(memory.getSession('s1', false, 'a1').pendingTurn, null);
  assert.equal(memory.getSession('s1', false, 'a1').references.lastDataset.rowCount, 1);
});

test('only the newest snapshots are kept', () => {
  const memory = service();
  for (let index = 0; index < 5; index++) success(memory, `câu ${index}`);
  assert.equal(memory.store.sessions.a1__s1.turns.filter(turn => turn.memory).length, 2);
  assert.equal(memory.getSession('s1', false, 'a1').lastPlan.table, 'M_Customer');
});

test('sessions stored before the turn log keep their state as the base state', () => {
  const legacy = { sessions: { a1__s1: { id: 's1', accountId: 'a1', messages: [], lastPlan: { table: 'M_Employee', dbSourceId: 'db' },
    references: { lastDataset: { table: 'M_Employee', rowCount: 3, updatedAt: new Date().toISOString() } }, activeScope: 'employee',
    pendingTurn: { question: 'cũ', updatedAt: new Date().toISOString() } } } };
  const memory = new MemoryService({ store: legacy, save() {} });
  const session = memory.getSession('s1', false, 'a1');
  assert.equal(session.lastPlan.table, 'M_Employee');
  assert.equal(session.references.lastDataset.rowCount, 3);
  assert.equal(session.pendingTurn.question, 'cũ');
  const stored = JSON.parse(JSON.stringify(memory.store.sessions.a1__s1));
  assert.equal(Object.hasOwn(stored, 'lastPlan'), false);
  assert.equal(stored.baseState.lastPlan.table, 'M_Employee');
  success(memory, 'danh sách khách hàng');
  assert.equal(memory.getSession('s1', false, 'a1').lastPlan.table, 'M_Customer');
  assert.equal(memory.getSession('s1', false, 'a1').pendingTurn, null);
});

test('trimming the log never drops the current state', t => {
  withFlags(t, { MEMORY_PENDING_TURN_ENABLED: 'true', AI_MEMORY_MAX_TURNS: '4' });
  const memory = service();
  success(memory, 'danh sách khách hàng');
  for (let index = 0; index < 6; index++) partial(memory, `chưa xong ${index}`);
  const session = memory.getSession('s1', false, 'a1');
  assert.equal(session.turns.length, 4);
  assert.equal(session.turns.some(turn => turn.memory), false);
  assert.equal(session.references.lastDataset.rowCount, 2, 'the state moved to the base state');
  assert.equal(session.pendingTurn.question, 'chưa xong 5');
});

test('a success and a concurrent waiting turn both survive a merge', t => {
  withFlags(t, { MEMORY_PENDING_TURN_ENABLED: 'true' });
  const { mergeDocument } = require('../src/backend/storage/postgres/repository');
  const source = require('../src/backend/storage/postgres/catalog').sources.find(item => item.file === 'conversation_memory.json');
  const memory = service();
  success(memory, 'danh sách khách hàng');
  const base = JSON.parse(JSON.stringify(memory.store));
  const left = new MemoryService({ store: structuredClone(base), save() {} });
  const right = new MemoryService({ store: structuredClone(base), save() {} });
  partial(left, 'thêm cột địa chỉ');
  success(right, 'thông tin KA0021', [{ CustomerCode: 'KA0021' }]);
  const merged = mergeDocument(source, base, JSON.parse(JSON.stringify(left.store)), JSON.parse(JSON.stringify(right.store)));
  const session = new MemoryService({ store: merged, save() {} }).getSession('s1', false, 'a1');
  // Both requests' turns are kept (their order follows their times, equal here).
  assert.deepEqual(session.turns.map(turn => turn.question).sort(), ['danh sách khách hàng', 'thêm cột địa chỉ', 'thông tin KA0021']);
  assert.equal(session.references.lastDataset.rowCount, 1, 'state from the newest snapshot');
});
