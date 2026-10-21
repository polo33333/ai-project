'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeScope, matchesScope } = require('../src/backend/agent_core/harness/schema_scope');
const tables = [{ tableName: 'Costs', columns: [{ name: 'Category', description: 'Maintenance has id =42' }] }];
const filter = { table: 'Costs', column: 'Category', value: 42, evidence: 'Maintenance has id =42' };
test('category scope requires exposed metadata and verbatim mapping evidence', () => {
  assert.deepEqual(decodeScope(JSON.stringify({ filters: [filter] }), tables).filters, [filter]);
  for (const changed of [{ column: 'Hidden' }, { value: 99 }, { evidence: 'invented =42' }]) {
    assert.throws(() => decodeScope(JSON.stringify({ filters: [{ ...filter, ...changed }] }), tables));
  }
});
test('SQL category scope rejects broad totals, different values, OR bypass and wrong table', () => {
  assert.equal(matchesScope('SELECT SUM(c.Amount) FROM Costs c WHERE c.Category = 42', [filter]), true);
  assert.equal(matchesScope('SELECT SUM(Amount) FROM Costs WHERE Category = 42 AND Year = 2026', [filter]), true);
  for (const sql of ['SELECT SUM(Amount) FROM Costs', 'SELECT SUM(Amount) FROM Costs WHERE Category = 43', 'SELECT SUM(Amount) FROM Costs WHERE Category = 42 OR 1 = 1', 'SELECT SUM(Amount) FROM OtherCosts WHERE Category = 42']) {
    assert.equal(matchesScope(sql, [filter]), false, sql);
  }
});

test('fenced model JSON and numeric strings retain the configured category type', () => {
  const typedTables = [{ tableName: 'Costs', columns: [{ ...tables[0].columns[0], type: 'SMALLINT' }] }];
  const text = '```json\n' + JSON.stringify({ filters: [{ ...filter, value: '42' }] }) + '\n```';
  assert.equal(decodeScope(text, typedTables).filters[0].value, 42);
});
