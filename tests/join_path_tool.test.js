'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dictionary = require('../src/backend/services/dictionary_service');
const connector = require('../src/backend/services/sql_connector');
const { withIdentity } = require('../src/backend/services/schema_identity');
const { execute } = require('../src/backend/agent_core/tools/join_path');

function fixture(t) {
  const oldTables = dictionary.tablesStore, oldRelations = dictionary.tableRelationships, oldSources = connector.dbSources;
  t.after(() => { dictionary.tablesStore = oldTables; dictionary.tableRelationships = oldRelations; connector.dbSources = oldSources; });
  const tables = ['A', 'Bridge', 'B'].map(tableName => withIdentity({ dbSourceId: 'src', dbName: 'ERP', schemaName: 'dbo', tableName, isActive: true, columns: [{ columnName: 'Id' }] }));
  dictionary.tablesStore = tables;
  connector.dbSources = [{ id: 'src', dbName: 'ERP' }];
  dictionary.tableRelationships = [0, 1].map((i) => ({ id: `r${i}`, sourceTableId: tables[i].tableId, targetTableId: tables[i + 1].tableId,
    sourceTable: tables[i].tableName, targetTable: tables[i + 1].tableName, columnPairs: [{ sourceColumn: 'Id', targetColumn: 'Id' }],
    status: 'verified', revision: 1, cardinality: i === 0 ? 'one-to-many' : 'many-to-one' }));
  return { permissions: ['sql:read'], dbSourceId: 'src' };
}
const args = { fromTable: 'dbo.A', toTable: 'B' };

test('join tool reuses planner, installs validation plan and flags fanout', t => {
  const context = fixture(t), result = execute(args, context);
  assert.equal(result.outcome, 'ready');
  assert.deepEqual(result.tableRefs.map(r => r.tableName), ['A', 'Bridge', 'B']);
  assert.deepEqual(result.edges.map(e => e.cardinality), ['one-to-many', 'many-to-one']);
  assert.equal(result.aggregationRisk, 'fanout');
  assert.equal(result.defaultFilters, null);
  assert.equal(context.joinPlan.planId, result.planId);
  const reverse = execute({ fromTable: 'B', toTable: 'A' }, context);
  assert.deepEqual(reverse.edges.map(e => e.cardinality), ['one-to-many', 'many-to-one']);
});

test('join tool fails closed for unverified, hidden or policy-blocked bridge', t => {
  const context = fixture(t);
  dictionary.tableRelationships[0].status = 'suggested';
  assert.equal(execute(args, context).outcome, 'no_path');
  dictionary.tableRelationships[0].status = 'verified';
  dictionary.tablesStore[1].columns[0].isVisible = false;
  assert.equal(execute(args, context).outcome, 'no_path');
  dictionary.tablesStore[1].columns[0].isVisible = true;
  connector.dbSources[0].governedPolicy = { allowedTables: ['A', 'B'] };
  assert.equal(execute(args, context).outcome, 'no_path');
  connector.dbSources[0].governedPolicy = { blockedColumns: ['Id'] };
  assert.equal(execute(args, context).outcome, 'no_path');
});

test('join tool preserves ambiguity, limits hops and requires SQL permission', t => {
  const context = fixture(t);
  assert.equal(execute({ ...args, maxHops: 1 }, context).outcome, 'no_path');
  dictionary.tableRelationships.push({ ...dictionary.tableRelationships[0], id: 'alternative' });
  assert.equal(execute(args, context).outcome, 'ambiguous');
  assert.throws(() => execute(args, { ...context, permissions: [] }), { code: 'SQL_READ_REQUIRED' });
  assert.throws(() => execute(args, { ...context, dbSourceId: 'other' }), { code: 'SQL_SOURCE_REQUIRED' });
});

test('both gateways register the tool and reject invalid parameters', async t => {
  const context = fixture(t);
  const registry = require('../src/backend/intelligent_core/tool_registry');
  const { defaultToolManager } = require('../src/backend/agent_core');
  assert.equal((await registry.executeTool('get_join_path', args, context)).success, true);
  assert.equal((await defaultToolManager.executeTool('get_join_path', args, context)).success, true);
  assert.equal((await registry.executeTool('get_join_path', { ...args, maxHops: 5 }, context)).success, false);
  assert.equal((await registry.executeTool('get_join_path', args, { permissions: [] })).success, false);
  const select = require('../src/backend/agent_core/harness/staged_tools').select;
  assert.equal(select(registry.listTools(), { completed: ['search_schema'] }).some(t => t.name === 'get_join_path'), true);
});

test('source governance denies unauthorized metadata access', t => {
  const context = fixture(t), governance = require('../src/backend/governance/context');
  governance.run(() => {
    governance.setPrincipal({ subject: 'user', role: 'user', permissions: ['sql:read'], dataAccess: { sql: [] } });
    assert.throws(() => execute(args, context), { code: 'RESOURCE_ACCESS_DENIED' });
  });
});
