'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { compile } = require('../src/backend/services/semantic_lookup_query');
const exportsStage = require('../src/backend/agent_core/harness/group_exports');
const { resolve } = require('../src/backend/agent_core/harness/output_request');
const { partition } = require('../src/backend/agent_core/harness/result_grouping');
const tables = [{ tableName: 'Records', schemaName: 'dbo', columns: [{ columnName: 'ID', isPrimaryKey: true }, { columnName: 'Name' }, { columnName: 'CategoryID' }] },
  { tableName: 'Types', schemaName: 'dbo', columns: [{ columnName: 'ID' }, { columnName: 'Name' }] }];
const joinPlan = { outcome: 'ready', tableRefs: [{ tableId: 'r', tableRefId: 'r#1', tableName: 'Records', alias: 't1' }, { tableId: 't', tableRefId: 't#1', tableName: 'Types', alias: 't2' }],
  edges: [{ fromTableRefId: 'r#1', toTableRefId: 't#1', cardinality: 'many-to-one', displayColumn: 'Name', businessRole: 'Category', columnPairs: [{ sourceColumn: 'CategoryID', targetColumn: 'ID' }] }] };
const contract = { operation: 'list', completeness: { unresolved: [] }, attributes: [{ name: 'ID' }, { name: 'Name' },
  { name: 'Category', requestedAs: 'CategoryID', mappedSource: { table: 'Types', column: 'Name' } }] };

test('mapped record projection compiles only through a verified non-fanout lookup', () => {
  const args = { table: 'Records', operation: 'list', fields: ['ID', 'Name', 'CategoryID'], filters: [{ column: 'ID', operator: 'gte', value: 1 }] };
  const result = compile(args, tables, {}, contract, null, joinPlan);
  assert.match(result.sql, /LEFT JOIN/);
  assert.match(result.sql, /\[t2\]\.\[Name\] AS \[Category\]/);
  assert.match(result.sql, /WHERE \[t1\]\.\[ID\] >= 1/);
  assert.doesNotMatch(result.sql.split(/FROM/)[0], /CategoryID/);
  assert.throws(() => compile(args, tables, {}, contract, null, null), /JOIN_REQUIRED/);
  assert.throws(() => compile(args, [tables[0], { ...tables[1], columns: [{ columnName: 'Name', isVisible: false }] }], {}, contract, null, joinPlan), /JOIN_REQUIRED/);
  assert.throws(() => compile(args, tables, {}, contract, null, { ...joinPlan, edges: [{ ...joinPlan.edges[0], cardinality: 'one-to-many' }] }), /JOIN_REQUIRED/);
});

test('separate-file request survives wording without the export verb and aliases bind in both directions', () => {
  assert.deepEqual(resolve('chia thành 2 file riêng'), { export: true, separate: true, expectedFiles: 2 });
  assert.equal(resolve('xuất file Excel').export, true);
  assert.equal(resolve('Danh sách nhân viên').export, false);
  assert.equal(partition({ result: { rows: [{ Category: 'A' }, { Category: 'B' }] } }, ['CategoryID'], { CategoryID: 'Category' }).length, 2);
});

test('separate XLSX exports contain each verified group exactly once, including all rows', async () => {
  const Manager = require('../src/backend/agent_core/tools/tool_manager');
  const { ExportDataTool } = require('../src/backend/agent_core/tools/builtins');
  const { RequestExecutionBudget } = require('../src/backend/agent_core/harness/request_execution_budget');
  const manager = new Manager(); manager.registerTool(new ExportDataTool());
  const sql = compile({ table: 'Records', operation: 'list', fields: ['ID', 'Name', 'CategoryID'] }, tables, {}, contract, null, joinPlan).sql;
  const rows = [{ ID: 1, Name: 'One', Category: 'Nam' }, { ID: 2, Name: 'Two', Category: 'Nữ' }, { ID: 3, Name: 'Three', Category: 'Nam' }];
  const calls = [{ toolName: 'execute_sql_query', success: true, args: { sql }, result: { sql, rows } }];
  const plan = { table: 'Records', resultGroupBy: ['CategoryID'], columnDisplayNames: { CategoryID: 'Category', ID: 'Identifier' }, exportRequest: { separate: true, expectedFiles: 2 } };
  const result = await exportsStage.run({ plan, calls, manager, context: { allowedToolNames: ['export_data'] }, budget: new RequestExecutionBudget(), check() {} });
  assert.deepEqual(result.failures, []);
  const projected = exportsStage.groups({ ...plan, semanticGroups: [{ label: null }] }, calls);
  assert.equal(projected.length, 2, 'a preserved single query scope must still partition by the requested category');
  const exported = calls.filter(call => call.toolName === 'export_data');
  assert.equal(exported.length, 2); assert.equal(new Set(exported.map(call => call.result.downloadUrl)).size, 2);
  const XLSX = require('xlsx'), path = require('node:path');
  for (const call of exported) {
    assert.equal(call.success, true);
    const workbook = XLSX.readFile(path.join(require('../src/backend/utils/export_paths').getExportsDirectory(), call.result.fileName));
    const actual = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);
    assert.equal(actual.length, call.exportGroup === 'Nam' ? 2 : 1);
    assert.ok(actual.every(row => row.Category === call.exportGroup));
  }
  const none = await exportsStage.run({ plan: { ...plan, exportRequest: { expectedFiles: 3 } }, calls: calls.slice(0, 1), manager, context: {}, budget: new RequestExecutionBudget(), check() {} });
  assert.deepEqual(none.failures, ['EXPORT_GROUP_COUNT_MISMATCH']);
});

test('exporting an existing joined dataset resolves schema as a list and preserves lookup scope', async t => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const Manager = require('../src/backend/agent_core/tools/tool_manager');
  const Base = require('../src/backend/agent_core/tools/base_tool');
  const { ExportDataTool } = require('../src/backend/agent_core/tools/builtins');
  const { deriveReferences } = require('../src/backend/memory_core/reference_store');
  const raw = tables.map(table => ({ ...table, dbSourceId: 'source', isActive: true }));
  t.mock.method(require('../src/backend/services/dictionary_service'), 'getGroupedTables', () => raw);
  const query = { table: 'Records', operation: 'list', fields: ['ID', 'Name', 'CategoryID'] };
  const sql = compile(query, raw, {}, contract, null, joinPlan).sql;
  const rows = [{ ID: 1, Name: 'One', Category: 'A' }, { ID: 2, Name: 'Two', Category: 'B' }];
  const reference = deriveReferences({ currentPlan: { table: 'Records', dbSourceId: 'source', identityColumns: ['ID'] },
    toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { sql, rows } }] }).lastDataset;
  const manager = new Manager();
  const register = (name, run) => { const tool = new Base({ name, description: name, parameters: { type: 'object', properties: { query: name === 'execute_sql_query' ? require('../src/backend/services/semantic_query').schema : { type: 'string' }, sql: { type: 'string' }, dataQuery: require('../src/backend/services/semantic_query').schema } } }); tool.run = run; manager.registerTool(tool); };
  register('list_workflows', async () => ({ workflows: [] }));
  register('search_schema', async (_, context) => {
    assert.equal(context.conversationResolution.operation, 'list');
    return { mode: 'data', dbSourceId: 'source', selectedTables: ['Records', 'Types'], joinPlan,
      tables: raw.map(table => ({ ...table, columns: table.columns.map(column => ({ name: column.columnName, label: column.columnName })) })),
      requestIntent: { operation: 'list', attributes: ['ID', 'Name', 'CategoryID'], presentation: 'table' } };
  });
  register('execute_sql_query', async args => { assert.match(args.sql, /LEFT JOIN/); return { sql: args.sql, rows }; });
  manager.registerTool(new ExportDataTool());
  const responses = [{ tool_calls: [{ id: 'resolve', type: 'function', function: { name: 'resolve_conversation', arguments: JSON.stringify({
    relation: 'followup', operation: 'export', cardinality: 'collection', attributes: ['CategoryID'], selectedIds: ['dataset:latest'],
    clarification: '', dataUse: 'current', scopeAction: 'preserve', presentation: 'file', resultGroupBy: ['Category'] }) } }] },
    { tool_calls: [{ id: 'schema', type: 'function', function: { name: 'search_schema', arguments: '{"query":"Records"}' } }] }];
  const result = await new Harness({ toolManager: manager, dispatch: async () => responses.shift() || { content: 'done' } }).run({
    userMessage: 'chia thành 2 file riêng', provider: { id: 'fixture', supportsToolCalling: true }, context: {
      governedController: true, lockProvider: true, dbSourceId: 'source', mode: 'data',
      resolutionContext: { candidates: [{ id: 'dataset:latest', kind: 'dataset', data: reference }], recent: [], previousRequest: { operation: 'list', requestedAttributes: ['ID', 'Name', 'CategoryID'] } },
      requestPlan: { table: 'Records', intent: 'list', identityColumns: ['ID'], semanticQuery: query, outputs: { data: true }, schemaColumns: ['ID', 'Name', 'CategoryID'] } } });
  assert.equal(result.trace.completionStatus, 'SUCCESS', JSON.stringify({evaluation:result.trace.training.responseEvaluation,tools:result.toolCalls,steps:result.trace.steps.filter(step=>step.type!=='MODEL_USAGE')}));
  assert.equal(result.toolCalls.filter(call => call.toolName === 'export_data' && call.success).length, 2);
});
