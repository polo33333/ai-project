'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { compact, footprint } = require('../src/backend/agent/harness/context_lifecycle');
const { ContextResultStore } = require('../src/backend/agent/harness/context_result_store');
const { compactAgentToolResult } = require('../src/backend/agent/harness/agent_context');
const tool = (id, name, result) => ({ role: 'tool', name, tool_call_id: id, content: JSON.stringify({ success: true, result }) });
test('exact duplicates shrink without losing tool IDs or distinct schema evidence', () => {
  const a = tool('a', 'search_schema', { dbSourceId: 'x', tables: [{ tableName: 'A', columns: ['Code', 'Name'], description: 'x'.repeat(900) }] });
  const b = { ...a, tool_call_id: 'b' }, c = tool('c', 'search_schema', { dbSourceId: 'x', tables: [{ tableName: 'A', columns: ['Code'] }] });
  const original = [a, b, c], value = compact(original);
  assert.ok(value.afterTokens < value.beforeTokens);
  assert.equal(JSON.parse(value.messages[0].content).retainedToolCallId, 'b');
  assert.deepEqual(value.messages.slice(1), [b, c]);
  assert.equal(original[0].content, a.content);
});
test('pressure removes only narration, preserving user input, failures, actions and pending state', () => {
  const messages = [{ role: 'user', content: 'NV007 năm 2025' }, { role: 'assistant', content: 'Planning '.repeat(100), tool_calls: [{ id: 'a', function: { name: 'run_workflow', arguments: '{}' } }] },
    { role: 'tool', name: 'run_workflow', tool_call_id: 'a', content: JSON.stringify({ success: true, result: { status: 'WAITING_INPUT', missingInputs: [{ key: 'code', ask: 'Mã hợp đồng?' }] } }) },
    { role: 'tool', name: 'execute_sql_query', content: JSON.stringify({ success: false, error: 'Missing filter' }) }];
  const value = compact(messages, { targetTokens: 1 });
  assert.equal(value.messages[1].content, '');
  assert.deepEqual(value.messages[1].tool_calls, messages[1].tool_calls);
  for (const index of [0, 2, 3]) assert.deepEqual(value.messages[index], messages[index]);
  assert.ok(footprint(messages).parts.workflow > 0);
});
test('oversized table offloads exact cells and can read later rows; no cross-request access', async () => {
  const store = new ContextResultStore();
  const rows = Array.from({ length: 100 }, (_, i) => ({ Code: `NV${i}`, Amount: i === 0 ? null : i, Note: 'n'.repeat(2000) }));
  const original = { success: true, result: { rows, rowCount: 150, hasMore: true, units: { Amount: 'VNĐ' } } };
  const value = JSON.parse(compactAgentToolResult('execute_sql_query', original, 1600, store));
  assert.ok(value.result.resultId);
  assert.equal(value.result.previewOnly, true);
  assert.equal(value.result.rows.length, 0);
  const page = await store.read({ resultId: value.result.resultId, offset: 99, limit: 1 });
  assert.deepEqual(page.rows[0], rows[99]);
  assert.equal(page.sourceHasMore, true);
  assert.equal(page.rowCount, 150);
  assert.equal((await store.read({ resultId: value.result.resultId, limit: 1, columns: ['Amount'] })).rows[0].Amount, null);
  await assert.rejects(new ContextResultStore().read({ resultId: value.result.resultId }), /NOT_AVAILABLE/);
  await assert.rejects(store.read({ resultId: value.result.resultId, columns: ['hidden'] }), /COLUMN_INVALID/);
  await assert.rejects(store.read({ resultId: value.result.resultId, limit: 100 }), /PAGE_INVALID/);
  assert.equal(original.result.rows.length, 100);
});
test('stored data is immutable and permission revocation rejects reads', async () => {
  let allowed = true;
  const store = new ContextResultStore(async () => { if (!allowed) throw new Error('revoked'); });
  const rows = [{ Code: 'A', Amount: 0 }], id = store.put({ rows });
  rows[0].Amount = 99;
  const page = await store.read({ resultId: id });
  assert.equal(page.rows[0].Amount, 0);
  page.rows[0].Amount = 1;
  assert.equal((await store.read({ resultId: id })).rows[0].Amount, 0);
  allowed = false;
  await assert.rejects(store.read({ resultId: id }), /revoked/);
});
test('50-turn context compaction preserves every question, distinct filter and pending input', () => {
  const messages = [];
  for (let i = 0; i < 50; i++) {
    messages.push({ role: 'user', content: `Tra cứu KH${i} năm ${2020 + i % 5}` });
    messages.push({ role: 'assistant', content: 'đang xử lý '.repeat(30), tool_calls: [{ id: `call-${i}`, function: { name: 'execute_sql_query', arguments: JSON.stringify({ filter: `KH${i}` }) } }] });
    messages.push(tool(`call-${i}`, 'execute_sql_query', { rows: [{ Code: `KH${i}`, Amount: i }], filters: { Code: `KH${i}` } }));
  }
  const output = compact(messages, { targetTokens: 1 });
  assert.equal(output.messages.length, messages.length);
  for (let i = 0; i < 50; i++) {
    assert.deepEqual(output.messages[i * 3], messages[i * 3]);
    assert.deepEqual(output.messages[i * 3 + 2], messages[i * 3 + 2]);
  }
  assert.ok(output.afterTokens < output.beforeTokens);
});
test('50 exchanges retain bounded exact business state and do not expose it to another source or owner', () => {
  const { MemoryService } = require('../src/backend/memory/memory_service');
  const service = new MemoryService({ store: { sessions: {} }, save() {} });
  for (let i = 0; i < 50; i++) service.persistSuccessfulExchange({ sessionId: 'long', accountId: 'owner',
    question: `Tra cứu TEST${i}`, reply: 'Kết quả thử bộ nhớ', completionStatus: 'SUCCESS', responseEvaluation: { valid: true },
    currentPlan: { table: 'TestRecords', dbSourceId: 'isolated-test', conversationState: { operation: 'aggregate', requestedAttributes: ['Amount'] },
      semanticQuery: { table: 'TestRecords', operation: 'aggregate', filters: [{ column: 'Code', operator: 'eq', value: `TEST${i}` }], time: { column: 'Date', grain: 'month' } },
      schemaScope: { filters: [{ column: 'Category', value: 21 }] } } });
  const session = service.getSession('long', false, 'owner');
  assert.equal(session.messages.length, service.maxStored);
  const state = service.getResolutionContext({ sessionId: 'long', accountId: 'owner' }, { dbSourceId: 'isolated-test' });
  assert.ok(state.recent.length <= 4);
  assert.equal(state.previousRequest.businessState.query.filters[0].value, 'TEST49');
  assert.equal(state.previousRequest.businessState.query.time.grain, 'month');
  assert.equal(state.previousRequest.businessState.categoryFilters[0].value, 21);
  assert.equal(service.getResolutionContext({ sessionId: 'long', accountId: 'owner' }, { dbSourceId: 'other' }).previousRequest.businessState, undefined);
  assert.deepEqual(service.getResolutionContext({ sessionId: 'long', accountId: 'stranger' }).candidates, []);
});
test('structured summary never silently truncates an oversized filter', () => {
  const { fromPlan } = require('../src/backend/memory/business_state');
  assert.ok(fromPlan({ semanticQuery: { filters: [{ value: 'x'.repeat(9000) }] } }).unavailable);
});
test('result reader is staged after data and unavailable without a request-local reader', async () => {
  const ToolManager = require('../src/backend/agent/tools/tool_manager');
  const { ReadContextResultTool } = require('../src/backend/agent/tools/builtins');
  const manager = new ToolManager();
  manager.registerTool(new ReadContextResultTool());
  assert.equal(manager.getToolDefinitions({}).length, 0);
  const store = new ContextResultStore(), id = store.put({ rows: [{ Code: 'TEST', Amount: 0 }] });
  const context = { allowedToolNames: ['read_context_result'], readContextResult: args => store.read(args) };
  const definitions = manager.getToolDefinitions(context), select = require('../src/backend/agent/harness/staged_tools').select;
  assert.equal(select(definitions).length, 0);
  assert.equal(select(definitions, { completed: ['execute_sql_query'] }).length, 1);
  const result = await manager.executeTool('read_context_result', { resultId: id }, context);
  assert.equal(result.success, true);
  assert.equal(result.result.rows[0].Amount, 0);
  const denied = await manager.executeTool('read_context_result', { resultId: id }, {});
  assert.equal(denied.success, false);
});
