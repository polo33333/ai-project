'use strict';
// Structured answers a model writes as text, and workflow results that must
// stay attached to the question that started them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonContent } = require('../src/backend/agent_core/harness/tool_call_normalizer');

test('a structured answer is read from bare text or a ```json block, never from a list or prose', () => {
  assert.deepEqual(parseJsonContent('{"suitable":true}'), { suitable: true });
  assert.deepEqual(parseJsonContent('```json\n{\n  "suitable": true,\n  "reason": "ok"\n}\n```'), { suitable: true, reason: 'ok' });
  assert.deepEqual(parseJsonContent('Kết quả:\n```\n{"a":1}\n```'), { a: 1 });
  assert.equal(parseJsonContent('[1,2]'), undefined);
  assert.equal(parseJsonContent('Không phù hợp.'), undefined);
  assert.equal(parseJsonContent(''), undefined);
});

test('a workflow assessment written in a ```json block is accepted', async () => {
  const lookup = { inputs: { query: { schema: { type: 'string' } } }, bindings: { lookup: { sql: 'SELECT e.EmployeeName FROM dbo.Employees e WHERE e.EmployeeCode = @query',
    parameters: { query: { slot: 'query' } } } } };
  const answer = { suitable: true, reason: 'Tra cứu đúng nhân viên theo mã.', confirmedSlots: ['query'], inputBindings: [{ slot: 'query', table: 'Employees', column: 'EmployeeCode' }] };
  const result = await require('../src/backend/memory_core/workflow_suitability').assess(async () => ({ content: `\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\``, finish_reason: 'STOP' }),
    'Tra cứu thông tin nhân viên NV104', { operation: 'detail', proposedInputs: { query: 'NV104' } }, lookup);
  assert.equal(result.suitable, true);
});

test('a memory resolution written in a ```json block is accepted', () => {
  const { decode } = require('../src/backend/memory_core/conversation_resolver');
  const value = { relation: 'independent', operation: 'list', cardinality: 'collection', attributes: [], selectedIds: [], clarification: '', dataUse: 'current', sourceScope: 'enterprise' };
  assert.equal(decode({ content: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }, []).relation, 'independent');
});

test('a finished workflow result completes the turn that started it', () => {
  const { MemoryService } = require('../src/backend/memory_core/memory_service');
  const memory = new MemoryService({ store: { sessions: {} }, save() {} });
  const question = 'Báo cáo sản lượng điện 3 tháng gần nhất';
  memory.persistSuccessfulExchange({ sessionId: 's1', accountId: 'a1', question, reply: 'Đang chạy quy trình.', completionStatus: 'PARTIAL',
    responseEvaluation: { valid: false, failures: ['WORKFLOW_HANDOFF'] }, currentPlan: {},
    toolCalls: [{ toolName: 'run_workflow', success: true, result: { runId: 'run-1', execution: { id: 'run-1', status: 'RUNNING' } } }] });
  const started = memory.getSession('s1', false, 'a1').turns;
  assert.equal(started.length, 1);
  assert.equal(started[0].workflowRunId, 'run-1');

  memory.persistWorkflowExchange({ sessionId: 's1', accountId: 'a1', rows: [{ Thang: '2026-09', SanLuong: 10 }, { Thang: '2026-10', SanLuong: 12 }],
    workflow: { runId: 'run-1', templateId: 'report', name: 'Báo cáo sản lượng', inputs: { months: 3 }, dbSourceId: 'db',
      updatedAt: new Date().toISOString(), datasets: [{ field: 'rows', columns: ['Thang', 'SanLuong'], rowCount: 2, preview: [] }] } });
  const turns = memory.getSession('s1', false, 'a1').turns;
  assert.equal(turns.length, 1, 'no separate system turn for the result');
  assert.equal(turns[0].id, started[0].id);
  assert.equal(turns[0].question, question);
  assert.equal(turns[0].status, 'SUCCESS');
  assert.equal(turns[0].workflow.runId, 'run-1');
  assert.deepEqual(turns[0].result.preview, [['2026-09', 10], ['2026-10', 12]]);

  // A result whose run no turn started (e.g. run from the workflow screen) is its own turn.
  memory.persistWorkflowExchange({ sessionId: 's1', accountId: 'a1', rows: [{ A: 1 }],
    workflow: { runId: 'run-2', templateId: 'other', name: 'Khác', inputs: {}, dbSourceId: 'db', updatedAt: new Date().toISOString(),
      datasets: [{ field: 'rows', columns: ['A'], rowCount: 1, preview: [] }] } });
  assert.equal(memory.getSession('s1', false, 'a1').turns.length, 2);
});

test('two writes to one conversation keep both turn-log changes', () => {
  const { mergeDocument } = require('../src/backend/storage/postgres/repository');
  const source = require('../src/backend/storage/postgres/catalog').sources.find(item => item.file === 'conversation_memory.json');
  const message = (role, content) => ({ role, content, id: `${role}-${content}` });
  const started = { id: 't1', at: '2026-10-26T01:00:00.000Z', question: 'Báo cáo', status: 'PARTIAL', workflowRunId: 'run-1' };
  const finished = { ...started, status: 'SUCCESS', workflow: { runId: 'run-1' }, completedAt: '2026-10-26T01:00:10.000Z' };
  const followup = { id: 't2', at: '2026-10-26T01:00:09.000Z', question: 'Vẽ biểu đồ', status: 'PARTIAL' };
  const session = fields => ({ id: 's1', accountId: 'a1', messages: [message('user', 'q0'), message('assistant', 'a0')], turns: [started], updatedAt: '2026-10-26T01:00:01.000Z', ...fields });
  const base = { sessions: { a1__s1: session() } };
  // The workflow result completes turn 1 and appends its exchange.
  const fresh = { sessions: { a1__s1: session({ turns: [finished], updatedAt: '2026-10-26T01:00:10.000Z',
    messages: [message('user', 'q0'), message('assistant', 'a0'), message('user', 'wf'), message('assistant', 'wf-done')] }) } };
  // Meanwhile a PARTIAL follow-up logged turn 2 and a pending turn from the older copy.
  const partial = { sessions: { a1__s1: session({ turns: [started, followup], pendingTurn: { question: 'Vẽ biểu đồ' }, updatedAt: '2026-10-26T01:00:11.000Z' }) } };
  const merged = mergeDocument(source, base, partial, fresh).sessions.a1__s1;
  assert.deepEqual(merged.turns.map(turn => [turn.id, turn.status]), [['t1', 'SUCCESS'], ['t2', 'PARTIAL']]);
  assert.equal(merged.messages.length, 4);
  assert.equal(merged.pendingTurn.question, 'Vẽ biểu đồ');

  // A successful follow-up that appends messages keeps the completed turn 1 too.
  const answered = { sessions: { a1__s1: session({ turns: [started, { ...followup, status: 'SUCCESS' }], updatedAt: '2026-10-26T01:00:12.000Z',
    messages: [message('user', 'q0'), message('assistant', 'a0'), message('user', 'Vẽ biểu đồ'), message('assistant', 'Biểu đồ')] }) } };
  const appended = mergeDocument(source, base, answered, fresh).sessions.a1__s1;
  assert.deepEqual(appended.turns.map(turn => [turn.id, turn.status]), [['t1', 'SUCCESS'], ['t2', 'SUCCESS']]);
  assert.equal(appended.messages.length, 6);
});

test('the contract step reads a finished run its turn started before memory records it', async t => {
  const conversationMemory = require('../src/backend/automation/conversation_memory');
  t.mock.method(conversationMemory, 'readRun', async runId => runId === 'run-1'
    ? { runId: 'run-1', templateId: 'report', name: 'Báo cáo sản lượng', result: { rows: [{ Thang: '2025-01', SanLuong: 10 }, { Thang: '2025-02', SanLuong: 12 }] } }
    : Promise.reject(new Error('Workflow result is unavailable in this conversation.')));
  process.env.HARNESS_PIPELINE = 'v2';
  t.after(() => { delete process.env.HARNESS_PIPELINE; });
  const table = { tableId: 's::t', tableName: 'T', schemaName: 'dbo', dbSourceId: 's', isActive: true, columns: [{ columnName: 'ID', dataType: 'INT', isPrimaryKey: true }] };
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => [table]);
  t.mock.method(require('../src/backend/services/relationship_service'), 'verifiedRelationships', () => []);
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent_core/tools/base_tool');
  const Manager = require('../src/backend/agent_core/tools/tool_manager');
  const manager = new Manager();
  const tool = new Base({ name: 'search_schema', description: 'schema', parameters: { type: 'object' } });
  tool.run = async () => ({ mode: 'data', dbSourceId: 's', selectedTables: ['T'], tableDirectory: [{ tableName: 'T' }], intentCatalog: [], tables: [] });
  manager.registerTool(tool);
  const sql = new Base({ name: 'execute_sql_query', description: 'sql', parameters: { type: 'object' } });
  sql.run = async () => { throw new Error('No query is needed for shown rows.'); };
  manager.registerTool(sql);
  const turns = [{ id: 't1', question: 'Báo cáo sản lượng 2 tháng', status: 'PARTIAL', dbSourceId: 's', workflowRunId: 'run-1', result: null },
    { id: 't0', question: 'Câu khác', status: 'PARTIAL', dbSourceId: 's', workflowRunId: 'run-gone', result: null }];
  let prompt;
  const harness = new Harness({ toolManager: manager, dispatch: async (_provider, messages, definitions) => {
    if (definitions[0]?.function?.name === 'plan_query') {
      prompt = messages.at(-1).content;
      return { tool_calls: [{ id: '1', type: 'function', function: { name: 'plan_query', arguments: JSON.stringify({ kind: 'previous', previous: { turn: 1, rows: [2] } }) } }] };
    }
    return { content: 'ok' };
  } });
  const result = await harness.run({ userMessage: 'Tháng thứ 2 trong kết quả trên là bao nhiêu?', provider: { id: 'p', supportsToolCalling: true },
    enabledToolNames: ['search_schema', 'execute_sql_query'], context: { governedController: true, lockProvider: true, dbSourceId: 's',
      session: { id: 's1', accountId: 'a1' }, requestPlan: { outputs: { data: true } }, resolutionContext: { candidates: [], recent: [], turns } } });
  assert.match(prompt, /"workflow":"Báo cáo sản lượng"/);
  assert.match(result.replyText, /Dòng 2:\*\* Thang: 2025-02; SanLuong: 12/);
  assert.ok(result.trace.steps.some(step => step.type === 'V2_WORKFLOW_TURN_COMPLETED' && step.runId === 'run-1'));
  assert.equal(turns[0].workflow, undefined, 'the session turn itself is not changed');
});
