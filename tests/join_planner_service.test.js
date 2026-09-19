'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dictionaryService = require('../src/backend/services/dictionary_service');
const { withIdentity } = require('../src/backend/services/schema_identity');
const { planJoin, planEnrichment } = require('../src/backend/services/join_planner_service');

function withGraph(run) {
  const oldTables = dictionaryService.tablesStore;
  const oldRelations = dictionaryService.tableRelationships;
  const tables = ['Orders', 'OrderItems', 'Products'].map(tableName => withIdentity({ dbSourceId: 'src', dbName: 'ERP', schemaName: 'dbo', tableName, columns: [{ columnName: 'Id' }] }));
  dictionaryService.tablesStore = tables;
  dictionaryService.tableRelationships = [
    { id: 'r1', sourceTableId: tables[0].tableId, targetTableId: tables[1].tableId, sourceTable: 'Orders', targetTable: 'OrderItems', columnPairs: [{ sourceColumn: 'Id', targetColumn: 'Id' }], status: 'verified', isActive: true, revision: 1, cardinality: 'one-to-many' },
    { id: 'r2', sourceTableId: tables[1].tableId, targetTableId: tables[2].tableId, sourceTable: 'OrderItems', targetTable: 'Products', columnPairs: [{ sourceColumn: 'Id', targetColumn: 'Id' }], status: 'verified', isActive: true, revision: 1, cardinality: 'many-to-one' }
  ];
  try { return run(tables); } finally { dictionaryService.tablesStore = oldTables; dictionaryService.tableRelationships = oldRelations; }
}

test('join planner includes a verified bridge table and ordered edges', () => withGraph(tables => {
  const plan = planJoin([tables[0].tableId, tables[2].tableId], { dbSourceId: 'src' });
  assert.equal(plan.outcome, 'ready');
  assert.deepEqual(plan.edges.map(edge => edge.relationshipId), ['r1', 'r2']);
  assert.equal(plan.tableRefs.some(ref => ref.tableId === tables[1].tableId), true);
}));

test('join planner fails closed when an edge is not verified', () => withGraph(tables => {
  dictionaryService.tableRelationships[1].status = 'suggested';
  assert.equal(planJoin([tables[0].tableId, tables[2].tableId], { dbSourceId: 'src' }).outcome, 'no_path');
}));

test('enrichment planner assigns a distinct alias when fields share a lookup table', () => withGraph(tables => {
  const root = tables[0];
  const lookup = tables[2];
  const relations = ['gender', 'status'].map((id, index) => ({
    id, sourceTableId: root.tableId, targetTableId: lookup.tableId, revision: 1,
    cardinality: 'many-to-one', businessRole: id,
    columnPairs: [{ sourceColumn: `${id}Id`, targetColumn: 'Id' }], defaultJoinType: 'LEFT'
  }));
  const plan = planEnrichment(root.tableId, relations, { dbSourceId: 'src' });
  assert.equal(plan.outcome, 'ready');
  assert.deepEqual(plan.tableRefs.map(ref => ref.alias), ['t1', 't2', 't3']);
  assert.notEqual(plan.edges[0].toTableRefId, plan.edges[1].toTableRefId);
}));
