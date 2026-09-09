'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const guard = require('../src/backend/intelligent_core/security_guard');

const allowed = [
  'SELECT [Order ID] FROM [Sales Data]',
  'SELECT id FROM users WHERE id IN (SELECT user_id FROM orders)',
  'WITH recent AS (SELECT id FROM orders) SELECT id FROM recent'
];
const denied = [
  'DELETE FROM users',
  'SELECT 1; DROP TABLE users',
  'WITH changed AS (DELETE FROM users OUTPUT deleted.id) SELECT id FROM changed',
  'EXEC sp_who'
];

for (const sql of allowed) test(`allows read-only corpus: ${sql}`, () => {
  const result = guard.validateSqlQuery(sql);
  assert.equal(result.safe, true, result.error);
  assert.match(result.cleanedSql, /SELECT TOP 100/i);
});
for (const sql of denied) test(`rejects unsafe corpus: ${sql}`, () => {
  assert.equal(guard.validateSqlQuery(sql).safe, false);
});
