'use strict';
// Feedback learning loop: rated turns become drafts, accepted drafts become
// planner examples and regression cases, and the planner sees an example only
// for a similar question whose contract still compiles.
const test = require('node:test');
const assert = require('node:assert/strict');
const learning = require('../src/backend/training/feedback_loop');
const catalogApi = require('../src/backend/agent/pipeline/query_catalog');
const { validateContract } = require('../src/backend/agent/pipeline/contract_pipeline');
const golden = require('./fixtures/live_eval_cases.json');

const billQuestion = 'Tiền hóa đơn điện sau thuế của KA0021 trong 2024-02 là bao nhiêu?';
const billContract = { kind: 'data', root: 'T_ElectricityOutput', operation: 'aggregate',
  measures: [{ ref: 'T_ElectricityOutput.FinalTotalAmount', aggregation: 'SUM' }],
  filters: [{ ref: 'T_ElectricityOutput.CustomerID->CustomerCode', operator: 'eq', value: 'KA0021', evidence: 'KA0021' },
    { ref: 'T_ElectricityOutput.ElectricityOutputDate', operator: 'period', value: '2024-02', evidence: '2024-02' }] };
const record = (id, minute, question, { session = 's1', status = 'SUCCESS', pipeline = 'v2', contract = billContract, reply = 'ok' } = {}) => ({
  id, timestamp: `2026-10-26T01:${String(minute).padStart(2, '0')}:00Z`, status, question, replyText: reply,
  requestPayload: { sessionId: session, diagnostics: { pipeline, ...(pipeline === 'v2' && contract ? { v2Contract: contract } : {}) } } });

test('a liked v2 answer drafts an example; a disliked one drafts a case and takes the re-ask as its example', () => {
  const history = [
    record('a1', 0, 'Danh sách nhân viên phòng Kỹ thuật', { contract: { kind: 'data', root: 'M_Employee', operation: 'list' } }),
    record('b1', 5, 'Tiền điện sau thuế KA0021 2024-02?', { status: 'PARTIAL', pipeline: null, reply: 'Chưa thể hoàn tất' }),
    record('b2', 7, billQuestion),
    record('c1', 9, 'Có bao nhiêu nhân viên nữ?', { status: 'PARTIAL' }),
    record('d1', 12, 'Liệt kê khách hàng', { session: 'eval-run' })
  ];
  const feedback = [{ auditId: 'a1', rating: 'like' },
    { auditId: 'b1', rating: 'dislike', reviewStatus: 'needs_review', reviewExpectedOutcome: 'Tổng tiền là 6.652.704 đồng' },
    { auditId: 'c1', rating: 'dislike' }, { auditId: 'd1', rating: 'dislike' }];
  const drafts = learning.draftItems(history, feedback, { existingCases: golden.cases });
  assert.deepEqual(drafts.map(item => [item.kind, item.turns[0]]), [
    ['correction', 'Tiền điện sau thuế KA0021 2024-02?'], ['confirmed', 'Danh sách nhân viên phòng Kỹ thuật']]);
  const [correction, confirmed] = drafts;
  assert.equal(correction.example.from, 'b2');
  assert.deepEqual(correction.example.contract, billContract);
  assert.deepEqual(correction.case.must, [{ num: 6652704 }]);
  assert.equal(confirmed.case, null);
  assert.equal(confirmed.accept, null);
});

test('only accepted drafts with a valid data contract or checks are promoted', () => {
  const drafts = [
    { id: 'learn-1', accept: true, turns: [billQuestion], example: { question: billQuestion, contract: billContract }, case: { must: [{ num: 6652704 }] } },
    { id: 'learn-2', accept: true, turns: ['x'], example: { question: 'x', contract: { kind: 'chat' } }, case: { must: [] } },
    { id: 'learn-3', accept: true, turns: ['y'], example: { question: 'y', contract: { kind: 'data', root: 'T', operation: 'sideways' } }, case: null },
    { id: 'learn-4', accept: false, turns: ['z'], example: { question: 'z', contract: billContract }, case: { must: [{ num: 1 }] } }
  ];
  const fixture = { cases: [] };
  const result = learning.promoteLearning(drafts, { examples: [], fixture, validateContract, now: '2026-10-26T00:00:00Z' });
  assert.deepEqual(result.added, { examples: ['learn-1'], cases: ['learn-1'] });
  assert.deepEqual(result.skipped.map(item => item.reason).sort(), ['invalid_contract', 'no_checks', 'not_data_contract']);
  assert.equal(result.examples[0].approvedAt, '2026-10-26T00:00:00Z');
  assert.equal(fixture.cases[0].group, 'feedback');
  const again = learning.promoteLearning(drafts.slice(0, 1), { examples: result.examples, fixture: { cases: [] }, validateContract });
  assert.deepEqual(again.skipped.map(item => item.reason), ['duplicate_example']);
});

const column = (columnName, dataType, displayName = '', isPrimaryKey = false) => ({ columnName, dataType, displayName, isPrimaryKey });
const tables = [
  { tableId: 's::T_ElectricityOutput', tableName: 'T_ElectricityOutput', schemaName: 'dbo', dbSourceId: 's', isActive: true,
    columns: [column('ElectricityOutputID', 'INT', 'ID chứng từ', true), column('ElectricityOutputDate', 'DATETIME', 'Ngày chứng từ'),
      column('CustomerID', 'INT'), column('FinalTotalAmount', 'FLOAT', 'Tiền sau thuế')] },
  { tableId: 's::M_Customer', tableName: 'M_Customer', schemaName: 'dbo', dbSourceId: 's', isActive: true,
    columns: [column('CustomerID', 'INT', '', true), column('CustomerCode', 'NVARCHAR', 'Mã khách hàng')] }
];
const relation = { id: 'r-customer', sourceTable: 'T_ElectricityOutput', targetTable: 'M_Customer', cardinality: 'many-to-one',
  columnPairs: [{ sourceColumn: 'CustomerID', targetColumn: 'CustomerID' }], businessRole: 'Khách hàng', displayColumn: 'CustomerCode' };
const catalog = (list = tables) => catalogApi.build({ dbSourceId: 's', tableDirectory: list.map(table => ({ tableName: table.tableName })), selectedTables: [list[0].tableName] },
  { dictionary: { getGroupedTables: () => list }, relationships: { verifiedRelationships: () => [relation] }, policy: [], metrics: [] });
const example = { id: 'learn-bill', question: billQuestion, contract: billContract };

test('over the 57 golden questions, an electricity bill example reaches only electricity bill questions', () => {
  const questions = golden.cases.map(item => ({ id: item.id, question: item.turns.at(-1) }));
  assert.ok(questions.length >= 57);
  const reached = questions.filter(item => learning.selectExamples([example], item.question, catalog()).length);
  assert.ok(['bill-ka-feb', 'bill-ka-feb-pretax', 'compare-ka', 'period-2-ka'].every(id => reached.some(item => item.id === id)));
  // Employees, customers, feedback, documents and chat never see it.
  assert.deepEqual(reached.filter(item => !/điện/i.test(item.question)).map(item => item.id), []);
});

test('an example whose contract no longer compiles is not offered', () => {
  const withoutCustomer = [tables[0]];
  assert.equal(learning.selectExamples([example], billQuestion, catalog()).length, 1);
  assert.equal(learning.selectExamples([example], billQuestion, catalog(withoutCustomer)).length, 0);
});

test('v2 shows reviewed examples of similar questions to the planner', async t => {
  process.env.HARNESS_PIPELINE = 'v2';
  t.after(() => { delete process.env.HARNESS_PIPELINE; });
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => tables);
  t.mock.method(require('../src/backend/services/relationship_service'), 'verifiedRelationships', () => [relation]);
  t.mock.method(learning, 'sourceExamples', () => [example, { id: 'learn-staff', question: 'Danh sách nhân viên phòng Kỹ thuật', contract: { kind: 'data', root: 'M_Employee', operation: 'list' } }]);
  const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent/tools/base_tool');
  const Manager = require('../src/backend/agent/tools/tool_manager');
  const manager = new Manager(), prompts = [];
  const register = (name, handler) => { const tool = new Base({ name, description: name, parameters: { type: 'object' } }); tool.run = handler; manager.registerTool(tool); };
  register('search_schema', async () => ({ mode: 'data', dbSourceId: 's', selectedTables: ['T_ElectricityOutput'],
    tableDirectory: tables.map(table => ({ tableName: table.tableName })), intentCatalog: [], tables: [] }));
  register('execute_sql_query', async args => ({ sql: args.sql, rows: [{ 'Tổng Tiền sau thuế': 6159911 }] }));
  const question = 'Tiền hóa đơn điện sau thuế của DC6011 trong 2024-03 là bao nhiêu?';
  const contract = { ...billContract, filters: [{ ...billContract.filters[0], value: 'DC6011', evidence: 'DC6011' }, { ...billContract.filters[1], value: '2024-03', evidence: '2024-03' }] };
  const harness = new Harness({ toolManager: manager, dispatch: async (_provider, messages, definitions) => {
    if (definitions[0]?.function?.name !== 'plan_query') return { content: 'ok' };
    prompts.push(messages.at(-1).content);
    return { tool_calls: [{ id: '1', type: 'function', function: { name: 'plan_query', arguments: JSON.stringify(contract) } }] };
  } });
  const result = await harness.run({ userMessage: question, provider: { id: 'p', supportsToolCalling: true },
    enabledToolNames: ['search_schema', 'execute_sql_query'], context: { governedController: true, lockProvider: true, dbSourceId: 's', requestPlan: { outputs: { data: true } } } });
  assert.match(prompts[0], /EXAMPLES \(reviewed contracts of similar questions/);
  assert.ok(prompts[0].includes(JSON.stringify(billQuestion)));
  assert.ok(!prompts[0].includes('Danh sách nhân viên phòng Kỹ thuật'));
  assert.deepEqual(result.trace.steps.find(step => step.type === 'V2_EXAMPLES').ids, ['learn-bill']);
});
