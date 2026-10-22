'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequestContract, assessRequestContract } = require('../src/backend/agent_core/harness/request_contract');
test('supplementary aggregates cannot remove a verified category scope', () => {
  const { dropsAggregateScope, qualifiedSql } = require('../src/backend/agent_core/harness/completion_policy');
  const scoped = { toolName: 'execute_sql_query', success: true, args: { sql: 'SELECT SUM(Amount) AS Total FROM Costs WHERE Category = 42' }, result: { rows: [{ Total: 123 }] } };
  const broad = { ...scoped, args: { sql: 'SELECT Category, SUM(Amount) AS Total FROM Costs GROUP BY Category' } };
  assert.equal(dropsAggregateScope(broad.args.sql, [scoped]), true);
  assert.equal(dropsAggregateScope('SELECT SUM(c.Amount) AS Total FROM Costs c WHERE c.Category = 42 AND c.Year = 2026', [scoped]), false);
  assert.equal(dropsAggregateScope('SELECT SUM(Amount) FROM OtherCosts', [scoped]), false);
  assert.deepEqual(qualifiedSql([scoped, broad], { conversationState: { operation: 'aggregate' } }), [scoped]);
});
const selection = { tables: [{ tableName: 'records', columns: [
  { name: 'code', label: 'Mã' }, { name: 'team', label: 'Phòng ban' },
  { name: 'dob', description: 'Ngày sinh' }, { name: 'secret', label: 'Hidden', isVisible: false }
] }], joinPlan: { tableRefs: [{ tableRefId: 'root', tableName: 'records' }],
  edges: [{ fromTableRefId: 'root', displayColumn: 'label', businessRole: 'Đơn vị' }] } };
const plan = { table: 'records', intent: 'list', identityColumns: ['code'] };

test('a schema review cannot downgrade a live analytical task into description or guidance', () => {
  const { resolveRequestIntent } = require('../src/backend/agent_core/harness/request_contract');
  for (const operation of ['describe', 'guidance']) {
    const declared = { operation, attributes: [], presentation: 'text' };
    for (const original of ['analyze', 'forecast']) {
      const intent = resolveRequestIntent(declared, { semanticIntent: declared }, { operation: original, dataUse: 'current' });
      assert.equal(intent.operation, original);
    }
    assert.equal(resolveRequestIntent(declared, { semanticIntent: declared, analysisTask: 'anomaly' }).operation, 'analyze');
    assert.equal(resolveRequestIntent(declared, { semanticIntent: declared }).operation, operation, 'Actual schema explanations remain supported');
  }
});

test('schema-grounded review supersedes stale memory detail after root recovery', () => {
  const { resolveRequestIntent } = require('../src/backend/agent_core/harness/request_contract');
  const reviewed = { operation: 'aggregate', attributes: [], presentation: 'text' };
  for (const operation of ['detail', 'attribute', 'list']) {
    const stale = { ...plan, conversationState: { operation }, semanticIntent: reviewed };
    const intent = resolveRequestIntent({ ...reviewed, operation: 'detail' }, stale,
      { operation, attributes: [], relation: 'independent' });
    assert.equal(intent.operation, 'aggregate');
    assert.equal(createRequestContract({ ...stale, conversationState: { operation: intent.operation } }, selection), null);
  }
  const detail = resolveRequestIntent(reviewed, { semanticIntent: { ...reviewed, operation: 'detail' } },
    { operation: 'aggregate' });
  assert.ok(createRequestContract({ ...plan, conversationState: { operation: detail.operation } }, selection));
  assert.equal(resolveRequestIntent(reviewed, { semanticIntent: reviewed },
    { operation: 'conversation', relation: 'independent', dataUse: 'none' }).operation, 'conversation');
});
test('full detail contract uses exposed described fields and mapped roles', () => {
  const contract = createRequestContract({ ...plan, conversationState: { operation: 'detail' } }, selection);
  assert.deepEqual(contract.attributes.map(item => item.name), ['code', 'team', 'dob', 'Đơn vị']);
  assert.equal(contract.completeness.mode, 'visible_business_fields');
  assert.equal(JSON.stringify(contract).includes('secret'), false);
});
test('explicit comparison never expands into a full profile', () => {
  const contract = createRequestContract({ ...plan, conversationState: { operation: 'compare', requestedAttributes: ['Phòng ban'] } }, selection);
  assert.deepEqual(contract.attributes.map(item => item.name), ['team']);
  assert.equal(contract.presentation, 'table');
});

test('declared full comparison overrides incidental planner columns', () => {
  const contract = createRequestContract({ ...plan, requiredColumns: ['code'],
    conversationState: { operation: 'compare', requestedAttributes: [], presentation: 'unspecified' } }, selection);
  assert.equal(contract.completeness.mode, 'visible_business_fields');
  assert.equal(contract.presentation, 'table');
  assert.ok(contract.attributes.some(item => item.name === 'dob'));
});

test('detail and single-attribute contracts preserve requested breadth', () => {
  const detail = createRequestContract({ ...plan, conversationState: { operation: 'detail', requestedAttributes: [] } }, selection);
  assert.ok(detail.attributes.some(field => field.name === 'dob'));
  const attribute = createRequestContract({ ...plan, conversationState: { operation: 'attribute', requestedAttributes: ['Ngày sinh'] } }, selection);
  assert.deepEqual(attribute.attributes.map(field => field.name), ['dob']);
});

test('approved metric contract retains unit/time/grain and checks every requested dimension', () => {
  const { createMetricContract } = require('../src/backend/agent_core/harness/request_contract');
  const result = { metricId: 'approved', metricVersion: 2, sourceId: 'source', units: { value: 'unit' },
    timeRange: { start: '2026-01-01', end: '2026-02-01' }, grain: 'department', rows: [{ value: '1.00' }] };
  const contract = createMetricContract(result, { dimensions: ['department'] });
  assert.equal(contract.scope.units.value, 'unit');
  assert.equal(assessRequestContract(contract, { result }).complete, false);
  result.rows[0].department = 'A';
  assert.equal(assessRequestContract(contract, { result }).complete, true);
  assert.ok(assessRequestContract(contract, { result: { ...result, sourceId: 'different' } }).failures.includes('CONTRACT_SOURCE_MISMATCH'));
  assert.equal(createMetricContract({ metricId: 'invented' }), null);
});

test('structured intent rejects invented scope or permission fields', () => {
  const { decodeIntent } = require('../src/backend/agent_core/harness/request_contract');
  assert.throws(() => decodeIntent({ operation: 'compare', attributes: [], presentation: 'table', permissions: ['admin'] }), /REQUEST_INTENT_INVALID/);
  assert.equal(decodeIntent({ operation: 'compare', attributes: [], presentation: 'table' }).operation, 'compare');
});

test('aggregate requests never inherit full-record completeness from schema discovery', () => {
  const { decodeIntent } = require('../src/backend/agent_core/harness/request_contract');
  assert.equal(decodeIntent({ operation: 'aggregate', attributes: [], presentation: 'table' }).operation, 'aggregate');
  assert.equal(createRequestContract({ ...plan, conversationState: { operation: 'aggregate' } }, selection), null);
  const { qualifiedSql } = require('../src/backend/agent_core/harness/completion_policy');
  const aggregatePlan = { table: 'records', conversationState: { operation: 'aggregate' } };
  const calls = [{ toolName: 'execute_sql_query', success: true, result: { sql: 'SELECT SUM(amount) AS total FROM records', rows: [{ total: 10 }] } },
    { toolName: 'execute_sql_query', success: true, result: { sql: 'SELECT amount FROM records', rows: [{ amount: 10 }] } }];
  assert.equal(qualifiedSql(calls, aggregatePlan).length, 1);
  assert.equal(qualifiedSql(calls, aggregatePlan)[0], calls[0]);
});

test('later partial SQL cannot replace an earlier result with more contract coverage', () => {
  const { qualifiedSql } = require('../src/backend/agent_core/harness/completion_policy');
  const contract = createRequestContract({ ...plan, requiredColumns: ['code', 'Phòng ban'] }, selection);
  const calls = [{ toolName: 'execute_sql_query', success: true, result: { sql: 'SELECT code, team FROM records', rows: [{ code: 'A', team: 'T' }] } },
    { toolName: 'execute_sql_query', success: true, result: { sql: 'SELECT code FROM records', rows: [{ code: 'A' }] } }];
  assert.equal(qualifiedSql(calls, { ...plan, requestContract: contract }).at(-1), calls[0]);
});

test('incidental document discovery does not require a citation for a SQL-only result table', () => {
  const { evaluateCompletion } = require('../src/backend/agent_core/harness/completion_policy');
  const input = { reply: '| Total |\n| --- |\n| 10 |', plan: { table: 'records', outputs: { data: true } }, toolCalls: [
    { toolName: 'execute_sql_query', success: true, result: { sql: 'SELECT SUM(amount) AS total FROM records', rows: [{ total: 10 }] } },
    { toolName: 'search_knowledge_base', success: true, result: { documents: [{ citationIndex: 1 }] } }
  ] };
  assert.equal(evaluateCompletion(input).valid, true);
  assert.ok(evaluateCompletion({ ...input, context: { knowledgeGrounding: { required: true } } }).failures.includes('MISSING_KNOWLEDGE_CITATION'));
});

test('schema discovery is bounded without hiding the SQL execution capability', () => {
  const select = require('../src/backend/agent_core/harness/staged_tools').select;
  const definitions = ['search_schema', 'execute_sql_query'].map(name => ({ function: { name } }));
  assert.deepEqual(select(definitions, { completed: ['list_workflows', 'search_schema', 'search_schema'] }).map(tool => tool.function.name), ['execute_sql_query']);
  assert.equal(select(definitions, { completed: ['search_schema'], catalog: true }).length, 2);
  assert.deepEqual(select(definitions, { completed: ['search_schema'] }).map(tool=>tool.function.name), ['search_schema']);
});

test('compacted schema mappings retain source and target columns at tool-result depth', () => {
  const { compactToolResult } = require('../src/backend/agent_core/harness/local_result_compactor');
  const result = JSON.parse(compactToolResult({ success: true, result: { mappedRelationships: [{
    businessRole: 'Role', columnPairs: [{ sourceColumn: 'role_id', targetColumn: 'id' }]
  }] } }, 12000));
  assert.equal(result.result.mappedRelationships[0].columnPairs[0].sourceColumn, 'role_id');
  assert.equal(result.result.mappedRelationships[0].columnPairs[0].targetColumn, 'id');
});
test('unexposed and ambiguous attributes stay unresolved without disclosing hidden metadata', () => {
  const contract = createRequestContract({ ...plan, requiredColumns: ['Hidden', 'address'] }, selection);
  assert.equal(contract.attributes.length, 0);
  assert.equal(contract.completeness.unresolved.length, 2);
  assert.equal(JSON.stringify(contract).includes('secret'), false);
});
test('NULL is queried data; a missing key in any row is not queried', () => {
  const contract = createRequestContract({ ...plan, requiredColumns: ['Ngày sinh'] }, selection);
  const call = rows => ({ toolName: 'execute_sql_query', result: { rows } });
  assert.equal(assessRequestContract(contract, call([{ dob: null }])).complete, true);
  assert.equal(assessRequestContract(contract, call([{ dob: null }])).fields[0].status, 'null');
  assert.equal(assessRequestContract(contract, call([{ dob: '2000-01-01' }, {}])).complete, false);
  assert.equal(assessRequestContract(contract, call([])).fields[0].status, 'empty_result');
});
test('aliases are supported but duplicate matches cannot prove coverage', () => {
  const contract = createRequestContract({ ...plan, requiredColumns: ['Phòng ban'] }, selection);
  assert.equal(assessRequestContract(contract, { result: { rows: [{ 'Phòng ban': 'A' }] } }).complete, true);
  assert.equal(assessRequestContract(contract, { result: { rows: [{ team: 'A', 'Phòng ban': 'B' }] } }).complete, false);
});
test('truncated scope and absent metadata never count as complete', () => {
  const contract = createRequestContract(plan, selection);
  assert.ok(assessRequestContract(contract, { result: { rows: [], hasMore: true } }).failures.includes('CONTRACT_SCOPE_PARTIAL'));
  assert.ok(assessRequestContract(createRequestContract(plan), { result: { rows: [] } }).failures.includes('CONTRACT_METADATA_UNAVAILABLE'));
  assert.equal(createRequestContract({ intent: 'aggregate_timeseries' }, selection), null);
});

test('mapped foreign keys require the configured display role instead of raw identifiers', () => {
  const mappedSelection = structuredClone(selection);
  mappedSelection.joinPlan.edges[0].columnPairs = [{ sourceColumn: 'team', targetColumn: 'id' }];
  const contract = createRequestContract({ ...plan, requiredColumns: ['team'] }, mappedSelection);
  assert.deepEqual(contract.attributes.map(item => item.name), ['Đơn vị']);
  assert.equal(assessRequestContract(contract, { result: { rows: [{ team: 1 }] } }).complete, false);
  assert.equal(assessRequestContract(contract, { result: { rows: [{ 'Đơn vị': 'A' }] } }).complete, true);
});

test('verified exposed relationship resolves display criteria even without an executable join plan', () => {
  const selected = { tables: [{ tableName: 'records', columns: [{ name: 'role_id' }] },
    { tableName: 'roles', columns: [{ name: 'title' }] }], mappedRelationships: [{
    sourceTable: 'records', targetTable: 'roles', businessRole: 'Role', displayColumn: 'title',
    columnPairs: [{ sourceColumn: 'role_id', targetColumn: 'id' }]
  }] };
  const contract = createRequestContract({ table: 'records', conversationState: { operation: 'attribute', requestedAttributes: ['role_id'] } }, selected);
  assert.equal(assessRequestContract(contract, { result: { rows: [{ Role: 'A' }] } }).complete, true);
  const byDisplay = createRequestContract({ table: 'records', conversationState: { operation: 'attribute', requestedAttributes: ['title'] } }, selected);
  assert.deepEqual(byDisplay.attributes.map(item => item.name), ['Role']);
  assert.equal(assessRequestContract(contract, { result: { sql: 'SELECT r.role_id AS Role FROM records r', rows: [{ Role: 3 }] } }).complete, false);
  assert.equal(assessRequestContract(contract, { result: { sql: 'SELECT t.title AS Display FROM records r LEFT JOIN roles t ON r.role_id = t.id', rows: [{ Display: 'A' }] } }).complete, true);
  selected.tables[1].columns[0].isVisible = false;
  assert.equal(assessRequestContract(createRequestContract({ table: 'records', conversationState: { operation: 'attribute', requestedAttributes: ['role_id'] } }, selected),
    { result: { rows: [{ Role: 'A' }] } }).complete, false);
});

test('governed harness repairs a missing criterion and keeps NULL as verified data', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const BaseTool = require('../src/backend/agent_core/tools/base_tool');
  const ToolManager = require('../src/backend/agent_core/tools/tool_manager');
  const manager = new ToolManager();
  const tool = (name, run) => {
    const instance = new BaseTool({ name, description: name, parameters: { type: 'object', properties: { sql: { type: 'string' }, query: { type: 'string' } } } });
    instance.run = run; manager.registerTool(instance);
  };
  tool('search_schema', async () => ({ mode: 'data', ...selection, selectedTables: ['records'] }));
  tool('list_workflows', async () => ({ workflows: [] }));
  tool('execute_sql_query', async args => ({ sql: args.sql, rows: args.sql.includes('dob')
    ? [{ code: 'A', dob: null }] : [{ code: 'A' }] }));
  const call = (name, args) => ({ tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const responses = [call('list_workflows', {}), call('search_schema', { query: 'records' }),
    call('execute_sql_query', { sql: 'SELECT code FROM records' }), { content: 'All complete.' },
    call('execute_sql_query', { sql: 'SELECT code, dob FROM records' }), { content: 'Verified rows.' }];
  const harness = new Harness({ toolManager: manager, dispatch: async () => responses.shift() });
  const result = await harness.run({ userMessage: 'list records', provider: { id: 'offline', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, mode: 'data', requestPlan: { ...plan,
      outputs: { data: true }, conversationState: { operation: 'list', requestedAttributes: ['Ngày sinh'] } } } });
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.equal(result.trace.executionBudget.repairAttempts, 1);
  assert.equal(result.trace.contractAssessment.complete, true);
  assert.equal(result.trace.contractAssessment.fields[0].status, 'null');
  assert.ok(result.trace.steps.some(step => step.type === 'VERIFIED_READ_COMPLETE'));
  assert.equal(responses.length, 1, 'No final model call after verified data is complete.');
  assert.ok(result.trace.steps.some(step => step.failures?.includes('CONTRACT_FIELDS_NOT_QUERIED')));
});
