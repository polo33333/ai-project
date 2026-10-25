'use strict';
// After a v2 fallback, a question the contract already classified as
// self-contained skips the separate memory-resolution model call; a follow-up
// still goes through it.
const test = require('node:test');
const assert = require('node:assert/strict');

async function runFallback(t, contract, question) {
  process.env.HARNESS_PIPELINE = 'v2';
  t.after(() => { delete process.env.HARNESS_PIPELINE; });
  const table = { tableId: 's::T', tableName: 'T', schemaName: 'dbo', dbSourceId: 's', isActive: true, columns: [{ columnName: 'ID', dataType: 'INT', isPrimaryKey: true }] };
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => [table]);
  t.mock.method(require('../src/backend/services/relationship_service'), 'verifiedRelationships', () => []);
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent_core/tools/base_tool');
  const Manager = require('../src/backend/agent_core/tools/tool_manager');
  const manager = new Manager();
  for (const name of ['search_schema', 'execute_sql_query']) {
    const tool = new Base({ name, description: name, parameters: { type: 'object' } });
    tool.run = async () => ({ mode: 'data', dbSourceId: 's', selectedTables: ['T'], tableDirectory: [{ tableName: 'T' }], intentCatalog: [], tables: [] });
    manager.registerTool(tool);
  }
  const stages = [];
  const harness = new Harness({ toolManager: manager, dispatch: async (_provider, _messages, definitions) => {
    const name = definitions[0]?.function?.name || null;
    stages.push(name);
    // The contract names a table outside the catalog, so v2 falls back.
    if (name === 'plan_query') return { tool_calls: [{ id: '1', type: 'function', function: { name, arguments: JSON.stringify(contract) } }] };
    if (name === 'resolve_conversation') return { content: JSON.stringify({ relation: 'followup', operation: 'list', cardinality: 'collection',
      attributes: [], selectedIds: ['dataset:latest'], clarification: '', dataUse: 'current', sourceScope: 'enterprise' }) };
    return { content: 'Không đủ dữ liệu.' };
  } });
  const result = await harness.run({ userMessage: question, provider: { id: 'p', supportsToolCalling: true },
    enabledToolNames: ['search_schema', 'execute_sql_query'], context: { governedController: true, lockProvider: true, dbSourceId: 's',
      session: { id: 's1', accountId: 'a1' }, requestPlan: { outputs: { data: true } },
      resolutionContext: { candidates: [{ id: 'dataset:latest', kind: 'dataset', data: { table: 'T', rowCount: 3 } },
        { id: 'preference:1', kind: 'preference', data: { title: 'Đơn vị', content: 'Triệu đồng' } }], recent: [{ role: 'user', content: 'ds trước' }], turns: [] } } });
  return { stages, result };
}

test('a self-contained question classified by the contract skips memory resolution', async t => {
  const { stages, result } = await runFallback(t, { kind: 'data', root: 'Missing', operation: 'aggregate',
    measures: [{ ref: '*', aggregation: 'COUNT' }] }, 'Có bao nhiêu bản ghi?');
  assert.ok(result.trace.steps.some(step => step.type === 'V2_FALLBACK'));
  assert.equal(stages.includes('resolve_conversation'), false);
  const resolved = result.trace.steps.find(step => step.type === 'MEMORY_RESOLVED_FROM_CONTRACT');
  assert.equal(resolved?.operation, 'aggregate');
  assert.ok(result.trace.steps.some(step => step.type === 'MEMORY_RESOLVED' && step.relation === 'independent'));
});

test('a follow-up still goes through memory resolution', async t => {
  const { stages, result } = await runFallback(t, { kind: 'data', root: 'Missing', operation: 'list', followup: true }, 'Thêm cột tên cho ds trên');
  assert.equal(stages.includes('resolve_conversation'), true);
  assert.equal(result.trace.steps.some(step => step.type === 'MEMORY_RESOLVED_FROM_CONTRACT'), false);
});
