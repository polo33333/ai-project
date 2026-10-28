'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const scope = require('../src/backend/memory/result_scope');
const { deriveReferences } = require('../src/backend/memory/reference_store');
const { MemoryService } = require('../src/backend/memory/memory_service');
const { fromPlan } = require('../src/backend/memory/business_state');
const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
const Base = require('../src/backend/agent/tools/base_tool');
const Manager = require('../src/backend/agent/tools/tool_manager');
const toolCall = (name, args) => ({ tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

for (const table of ['Contracts', 'Employees', 'Orders']) {
  test(`${table}: retain all result groups and validate enriched root identities`, () => {
    const calls = [1, 2].map((value, semanticGroup) => ({ toolName: 'execute_sql_query', success: true, semanticGroup,
      result: { sql: `SELECT ID FROM ${table} WHERE Category = ${value}`, rows: value === 1 ? [{ ID: 11 }, { ID: 57 }] : [] } }));
    const plan = { table, dbSourceId: 'source', identityColumns: ['ID'],
      semanticGroups: [{ label: 'A', query: { table } }, { label: 'B', query: { table } }] };
    const dataset = deriveReferences({ currentPlan: plan, toolCalls: calls }).lastDataset;
    assert.equal(dataset.rowCount, 2);
    assert.deepEqual(dataset.datasets.map(d => d.rowCount), [2, 0]);
    assert.equal(dataset.datasets[1].identityComplete, true);
    const projected = scope.project(`SELECT t.ID, c.Name FROM ${table} t LEFT JOIN Names c ON t.NameID=c.ID`, dataset);
    assert.equal(projected.length, 2);
    const enriched = { args: { sql: projected[0].sql }, result: { rows: [{ ID: 11, Name: 'a' }, { ID: 57, Name: 'b' }] } };
    assert.deepEqual(scope.assess(enriched, dataset), []);
    const sortKeys = value => Array.isArray(value) ? value.map(sortKeys) : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(name => [name, sortKeys(value[name])])) : value;
    const roundTrip = sortKeys({ ...dataset, datasets: [{ ...dataset.datasets[0], scope: scope.describe(projected[0].sql) }] });
    const next = scope.project(`SELECT r.ID, n.Name, n.Code FROM ${table} r LEFT JOIN Names n ON n.ID=r.NameID`, roundTrip);
    assert.deepEqual(scope.assess({ args: { sql: next[0].sql }, result: enriched.result }, roundTrip), [], 'JOIN scope must survive JSONB key reordering and alias changes');
    enriched.result.rows.push({ ID: 246, Name: 'extra' });
    assert.deepEqual(scope.assess(enriched, dataset), ['FOLLOWUP_SCOPE_MISMATCH']);
    assert.deepEqual(scope.assess({ args: { sql: `SELECT ID FROM ${table}` }, result: { rows: [] } }, dataset), ['FOLLOWUP_SCOPE_MISMATCH']);
    assert.deepEqual(scope.assess({ args: { sql: projected[0].sql }, result: { dbSourceId: 'other', rows: [] } }, dataset), ['SQL_SOURCE_MISMATCH']);
    assert.deepEqual(scope.assess({ args: { sql: projected[0].sql.replace(/LEFT JOIN/i, 'INNER JOIN') }, result: { rows: [{ ID: 11 }, { ID: 57 }] } }, dataset), ['FOLLOWUP_SCOPE_MISMATCH']);
    const memory = new MemoryService({ store: { sessions: {} }, save: () => {} });
    const session = memory.getSession('test', true);
    session.references.lastDataset = dataset;
    const context = memory.getResolutionContext({ sessionId: 'test' }, { dbSourceId: 'source' });
    assert.equal(context.candidates.find(c => c.id === 'dataset:latest').data.datasets.length, 2);
    assert.deepEqual(fromPlan(plan).groups, plan.semanticGroups);
    assert.equal(memory.getResolutionContext({ sessionId: 'test' }, { dbSourceId: 'other' }).candidates.length, 0);
  });
}

test('explicit scope changes and independent topics do not inherit a frozen dataset', () => {
  const { preserving, dependsOnPrevious } = require('../src/backend/memory/followup_policy');
  assert.equal(preserving('filter again', { relation: 'followup', operation: 'list', scopeAction: 'revise' }), false);
  assert.equal(preserving('thêm tên cho ds trên', { relation: 'followup', operation: 'list', scopeAction: 'revise' }), true);
  assert.equal(preserving('list customers', { relation: 'independent', operation: 'list' }), false);
  assert.equal(dependsOnPrevious('thêm tên cho ds trên'), true);
  assert.equal(dependsOnPrevious('Danh sách nhân viên'), false);
  assert.equal(dependsOnPrevious('khách hàng trên 30 tuổi'), false);
  assert.equal(scope.describe('WITH x AS (SELECT ID FROM Records) SELECT ID FROM x'), null);
  const reference = { columns: ['ID', 'EndDate'], datasets: [{ scope: scope.describe('SELECT ID, EndDate FROM Records WHERE ID = 1') }] };
  const projected = scope.project('SELECT ID FROM Records', reference, ['ID', 'EndDate']);
  assert.match(projected[0].sql, /EndDate/);
  assert.deepEqual(scope.assess({ args: { sql: projected[0].sql } }, reference), []);
  assert.equal(require('../src/backend/memory/memory_sanitizer').sanitizeObject({ date: new Date('2026-10-23T00:00:00Z') }).date, '2026-10-23T00:00:00.000Z');
  const union = scope.project("SELECT 'A' AS GroupLabel, ID, EndDate FROM Records WHERE ID = 1 UNION ALL SELECT 'B' AS GroupLabel, ID, EndDate FROM Records WHERE ID = 2", reference, ['ID', 'EndDate']);
  assert.doesNotMatch(union[0].sql, /UNION|GroupLabel/);
  assert.deepEqual(scope.assess({ args: { sql: union[0].sql } }, reference), []);
  const primary = deriveReferences({ currentPlan: { table: 'Records', identityColumns: ['ID', 'Date'], recordIdentityColumns: ['ID'] },
    toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { sql: 'SELECT ID FROM Records', rows: [{ ID: 1 }] } }] }).lastDataset;
  assert.equal(primary.datasets[0].identityComplete, true, 'Missing display/date fields must not disable primary-key verification');
  assert.deepEqual(primary.identityColumns, ['ID']);
  const { validateCallAgainstPolicy } = require('../src/backend/agent/harness/local_execution_policy');
  assert.equal(validateCallAgainstPolicy({ name: 'execute_sql_query', arguments: { sql: 'SELECT ID FROM Records' } },
    {}, { maxSqlCalls: 3 }, Array.from({ length: 3 }, () => ({ toolName: 'execute_sql_query', success: false, outcome: 'rejected', effectState: 'not_executed' }))).valid, true);
  assert.equal(validateCallAgainstPolicy({ name: 'execute_sql_query' }, {}, { maxSqlCalls: 3 },
    Array.from({ length: 3 }, () => ({ toolName: 'execute_sql_query', success: true }))).valid, false);
});

test('successive enrichment retains mapped display aliases without reintroducing foreign keys', () => {
  const reference = { identityColumns: ['ID'], columns: ['ID', 'CustomerID'], displayNames: { CustomerID: 'Customer' },
    datasets: [{ scope: scope.describe('SELECT ID, CustomerID FROM Records WHERE ID = 1') }] };
  const contract = { attributes: [{ name: 'Customer', requestedAs: 'CustomerID', mappedSource: { table: 'Customers', column: 'Name' } }] };
  const first = scope.project('SELECT r.ID, r.CustomerID, c.Name FROM Records r LEFT JOIN Customers c ON r.CustomerID=c.ID', reference, ['ID', 'CustomerID'], ['Name'], contract)[0];
  assert.doesNotMatch(first.sql.split(/FROM/i)[0], /CustomerID/);
  assert.deepEqual(scope.assess({ args: { sql: first.sql } }, reference), []);
  const nextReference = { identityColumns: ['ID'], columns: ['ID', 'Customer'], datasets: [{ scope: scope.describe(first.sql) }] };
  const next = scope.project('SELECT r.ID, c.Name, c.Code FROM Records r LEFT JOIN Customers c ON c.ID=r.CustomerID', nextReference)[0];
  assert.match(next.sql, /AS \[Customer\]/);
  assert.deepEqual(scope.assess({ args: { sql: next.sql } }, nextReference), []);
});

test('failed enrichment retains its verified base without promoting the failed result', t => {
  const previous = process.env.MEMORY_PENDING_TURN_ENABLED;
  process.env.MEMORY_PENDING_TURN_ENABLED = 'true';
  t.after(() => { if (previous === undefined) delete process.env.MEMORY_PENDING_TURN_ENABLED; else process.env.MEMORY_PENDING_TURN_ENABLED = previous; });
  const memory = new MemoryService({ store: { sessions: {} }, save: () => {} });
  const reference = { table: 'Records', dbSourceId: 'source', updatedAt: new Date(Date.now() - 2000).toISOString(), rowCount: 1,
    datasets: [{ scope: scope.describe('SELECT ID FROM Records WHERE Category = 1'), entityKeys: [{ ID: 1 }] }] };
  memory.getSession('pending', true).references.lastDataset = reference;
  memory.recordPendingTurn({ sessionId: 'pending', question: 'add fields', currentPlan: { dbSourceId: 'source', followupScope: reference },
    completionStatus: 'PARTIAL', responseEvaluation: { valid: false, failures: ['SQL_EXECUTION_FAILED'] } });
  const candidate = memory.getResolutionContext({ sessionId: 'pending' }, { dbSourceId: 'source' }).candidates.find(c => c.id === 'dataset:pending-base');
  assert.equal(candidate.data.pendingBase, true);
  assert.equal(memory.getSession('pending').references.lastDataset, reference);
  assert.equal(memory.getResolutionContext({ sessionId: 'pending' }, { dbSourceId: 'other' }).candidates.length, 0);
});

test('authorized date predicates remain valid when date columns are deferred from the projection', async () => {
  const tools = manager();
  tools.getTool('search_schema').run = async () => ({ mode: 'data', dbSourceId: 'source', selectedTables: ['Records'],
    tables: [{ tableName: 'Records', columns: [{ name: 'ID', type: 'INT' }] }],
    intentCatalog: [{ tableName: 'Records', columns: [{ name: 'ID', type: 'INT' }, { name: 'DueDate', type: 'DATE' }] }] });
  const today = require('../src/backend/services/request_time').create('hiện tại cái nào hết hạn').today;
  const responses = [toolCall('search_schema', { query: 'Records' }), toolCall('execute_sql_query', { sql: `SELECT ID FROM Records WHERE DueDate < N'${today}'` })];
  const result = await new Harness({ toolManager: tools, dispatch: async (_, messages) => messages[0]?.content?.startsWith('Return JSON only with operation')
    ? {content:JSON.stringify({operation:'list',analysis:'none',attributes:['ID'],presentation:'table'})}
    : responses.shift() || { content: 'done' } }).run({
    userMessage: 'hiện tại cái nào hết hạn', provider: { id: 'test', supportsToolCalling: true }, context: {
      governedController: true, lockProvider: true, dbSourceId: 'source', mode: 'data',
      requestPlan: { table: 'Records', intent: 'list', schemaColumns: ['ID'], identityColumns: ['ID'], outputs: { data: true },
        conversationState: { operation: 'list', requestedAttributes: ['ID'] } } } });
  assert.equal(result.trace.completionStatus, 'SUCCESS', JSON.stringify(result.trace.training.responseEvaluation));
  assert.equal(result.toolCalls.filter(call => call.toolName === 'execute_sql_query' && call.success).length, 1);
});

function manager() {
  const tools = new Manager();
  for (const [name, run] of Object.entries({ list_workflows: async () => ({ workflows: [] }),
    search_schema: async () => ({ mode: 'data', dbSourceId: 'source', selectedTables: ['Records'],
      tables: [{ tableName: 'Records', columns: [{ name: 'ID' }, { name: 'Category' }, { name: 'Name' }] }] }),
    execute_sql_query: async args => ({ sql: args.sql, rows: /Category\]?\s*=\s*1/i.test(args.sql) ? [{ ID: 1, Name: 'One' }] : [] }) })) {
    const tool = new Base({ name, description: name, parameters: { type: 'object', properties: { sql: { type: 'string' }, query: { type: 'string' } } } });
    tool.run = run; tools.registerTool(tool);
  }
  return tools;
}

test('invalid resolver IDs stop a dependent follow-up without SQL or memory success', async () => {
  let calls = 0;
  const result = await new Harness({ toolManager: manager(), dispatch: async () => {
    calls++; return toolCall('resolve_conversation', { relation: 'followup', operation: 'list', cardinality: 'collection',
      attributes: ['Name'], selectedIds: ['invented'], clarification: '', dataUse: 'current' });
  } }).run({ userMessage: 'thêm tên cho ds trên', provider: { id: 'test', supportsToolCalling: true }, context: {
    governedController: true, lockProvider: true, dbSourceId: 'source', resolutionContext: { candidates: [], recent: [{ role: 'user', content: 'list records' }] },
    requestPlan: { table: 'Records', intent: 'list', outputs: { data: true } } } });
  assert.equal(calls, 2);
  assert.equal(result.toolCalls.length, 0);
  assert.notEqual(result.trace.completionStatus, 'SUCCESS');
  assert.match(result.replyText, /danh sách|nhóm/);
});

test('validated follow-up projects both scopes and does not run the unfiltered replacement', async () => {
  const previous = [1, 2].map((value, semanticGroup) => ({ toolName: 'execute_sql_query', success: true, semanticGroup,
    result: { sql: `SELECT ID FROM Records WHERE Category = ${value}`, rows: value === 1 ? [{ ID: 1 }] : [] } }));
  const reference = deriveReferences({ currentPlan: { table: 'Records', dbSourceId: 'source', identityColumns: ['ID'],
    semanticGroups: [{ label: 'A' }, { label: 'B' }] }, toolCalls: previous }).lastDataset;
  const responses = [toolCall('resolve_conversation', { relation: 'followup', operation: 'continuation', cardinality: 'collection', scopeAction: 'revise',
    attributes: ['Name'], selectedIds: ['dataset:latest'], clarification: '', dataUse: 'current', resultGroupBy: ['A', 'B'] }),
    toolCall('search_schema', { query: 'Records' }), toolCall('execute_sql_query', { sql: 'SELECT ID, Name FROM Records' })];
  const result = await new Harness({ toolManager: manager(), dispatch: async () => responses.shift() || { content: 'done' } }).run({
    userMessage: 'thêm tên cho danh sách trên', provider: { id: 'test', supportsToolCalling: true }, context: {
      governedController: true, lockProvider: true, dbSourceId: 'source', mode: 'data',
      resolutionContext: { candidates: [{ id: 'dataset:latest', kind: 'dataset', data: reference }], recent: [{ role: 'user', content: 'list two groups' }], previousRequest: { requestedAttributes: ['ID'] } },
      requestPlan: { table: 'Records', intent: 'list', schemaColumns: ['ID', 'Name', 'Category'], identityColumns: ['ID'], outputs: { data: true },
        conversationState: { operation: 'list', requestedAttributes: ['ID', 'Name'] } } } });
  assert.equal(result.toolCalls.filter(c => c.toolName === 'execute_sql_query' && c.success).length, 2);
  assert.ok(result.toolCalls.filter(c => c.toolName === 'execute_sql_query').every(c => /WHERE/.test(c.args.sql)));
  assert.match(result.replyText, /\*\*A\*\*/);
  assert.match(result.replyText, /\*\*B\*\*/);
  assert.equal(result.trace.completionStatus, 'SUCCESS', JSON.stringify({evaluation:result.trace.training?.responseEvaluation,scope:result.trace.sqlEvidence,steps:result.trace.steps}));
});
