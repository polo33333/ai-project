'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
const Base = require('../src/backend/agent_core/tools/base_tool');
const Manager = require('../src/backend/agent_core/tools/tool_manager');
const call = (name, args) => ({ tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
function fixture(search) {
  const manager = new Manager();
  const register = (name, run) => { const tool = new Base({ name, description: name,
    parameters: { type: 'object', properties: { sql: { type: 'string' }, query: { type: 'string' } } } }); tool.run = run; manager.registerTool(tool); };
  register('list_workflows', async () => ({ workflows: [] }));
  register('search_schema', search || (async () => ({ mode: 'data', dbSourceId: 'fixture', selectedTables: ['Records'],
    tables: [{ tableName: 'Records', columns: [{ name: 'Amount' }, { name: 'Category' }] }] })));
  register('execute_sql_query', async args => ({ sql: args.sql, dbSourceId: 'fixture', rows: [{ Amount: 25 }] }));
  return manager;
}
function run(manager, dispatch, requestPlan) {
  return new Harness({ toolManager: manager, dispatch }).run({ userMessage: 'total amount', provider: { id: 'fixture', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, dbSourceId: 'fixture', mode: 'data', requestPlan: requestPlan || {
      table: 'Records', intent: 'aggregate', schemaColumns: ['Amount', 'Category'], outputs: { data: true }, schemaScope: { filters: [] },
      conversationState: { operation: 'aggregate', requestedAttributes: [] } } } });
}

test('a successful raw read is repaired immediately with its actual evidence failure', async () => {
  const responses = [call('list_workflows', {}), call('search_schema', { query: 'Records' }),
    call('execute_sql_query', { sql: 'SELECT Amount FROM Records WHERE Category = 2' }),
    call('execute_sql_query', { sql: 'SELECT SUM(Amount) AS Amount FROM Records WHERE Category = 2' })];
  const requests = [];
  const result = await run(fixture(), async (_, messages) => { requests.push(structuredClone(messages)); return responses.shift() || { content: '25' }; });
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.equal(result.trace.executionBudget.sqlAttempts, 2);
  assert.equal(result.trace.executionBudget.repairAttempts, 1);
  assert.ok(requests[3].some(message => message.role === 'user' && message.content.includes('SQL_AGGREGATION_REQUIRED')));
  assert.ok(requests[3].some(message => message.role === 'tool' && message.content.includes('evidenceAssessment')));
  assert.ok(!requests[3].some(message => message.role === 'user' && message.content.includes('MISSING_SQL')));
  assert.deepEqual(result.trace.sqlEvidence.map(item => item.assessment.accepted), [false, true]);
});

test('schema lookup beyond the stage budget is rejected at dispatch, not silently executed', async () => {
  const queries = [];
  const manager = fixture(async args => {
    queries.push(args.query);
    return { mode: 'data', dbSourceId: 'fixture', selectedTables: ['Records'], tables: [{ tableName: 'Records', columns: [{ name: args.query }] }] };
  });
  const responses = [call('list_workflows', {}), ...['First', 'Second', 'Amount'].map(query => call('search_schema', { query })),
    call('execute_sql_query', { sql: 'SELECT SUM(Amount) AS Amount FROM Records' })];
  const result = await run(manager, async () => responses.shift() || { content: '25' });
  // The stage removed search_schema after two lookups; the third call is a
  // rejected attempt, never a reused or masqueraded previous result.
  assert.deepEqual(queries, ['First', 'Second']);
  const third = result.toolCalls.filter(item => item.toolName === 'search_schema').at(-1);
  assert.equal(third.code, 'TOOL_NOT_IN_STAGE');
  assert.equal(third.effectState, 'not_executed');
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});

test('additional schema repair is bounded and enabled only for unresolved criteria', () => {
  const select = require('../src/backend/agent_core/harness/staged_tools').select;
  const definitions = ['search_schema', 'execute_sql_query'].map(name => ({ function: { name } }));
  const completed = ['list_workflows', 'search_schema', 'search_schema'];
  assert.ok(!select(definitions, { completed }).some(tool => tool.function.name === 'search_schema'));
  assert.ok(select(definitions, { completed, schemaRepairNeeded: true }).some(tool => tool.function.name === 'search_schema'));
  assert.ok(!select(definitions, { completed: [...completed, 'search_schema', 'search_schema'], schemaRepairNeeded: true }).some(tool => tool.function.name === 'search_schema'));
});

test('mandatory workflow discovery is performed before data SQL without a wasted model repair', async () => {
  const responses = [call('search_schema', { query: 'Records' }),
    call('execute_sql_query', { sql: 'SELECT SUM(Amount) AS Amount FROM Records' })];
  let modelCalls = 0;
  const result = await run(fixture(), async () => { modelCalls++; return responses.shift() || { content: '25' }; });
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.equal(modelCalls, 2);
  assert.equal(result.trace.executionBudget.repairAttempts, 0);
  assert.ok(result.trace.steps.some(step => step.type === 'DATA_CATALOG_DISCOVERY'));
  assert.deepEqual(result.toolCalls.map(item => item.toolName), ['search_schema', 'list_workflows', 'execute_sql_query']);
});

test('preflight rejections retain audit attempts without dispatching invalid SQL', async () => {
  const responses = [call('search_schema', { query: 'Records' }),
    call('execute_sql_query', { sql: 'SELECT Amount FROM Unrelated' }),
    call('execute_sql_query', { sql: 'SELECT SUM(Amount) AS Amount FROM Records' })];
  const result = await run(fixture(), async () => responses.shift() || { content: '25' });
  const rejected = result.toolCalls.find(item => item.outcome === 'rejected');
  assert.ok(rejected);
  assert.equal(rejected.effectState, 'not_executed');
  assert.equal(rejected.success, false);
  assert.match(rejected.args.sql, /Unrelated/);
  assert.equal(result.trace.executionBudget.sqlAttempts, 1);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});
