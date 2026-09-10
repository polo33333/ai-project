'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sqlConnector = require('../src/backend/services/sql_connector');

test('testDbSource checks the exact live source and reports latency', async t => {
  const originalSources = sqlConnector.dbSources;
  const originalExecute = sqlConnector.executeSqlQuery;
  t.after(() => { sqlConnector.dbSources = originalSources; sqlConnector.executeSqlQuery = originalExecute; });
  sqlConnector.dbSources = [{ id: 'source-1', dbName: 'Fixture', mode: 'live' }];
  let received;
  sqlConnector.executeSqlQuery = async (sql, id) => { received = { sql, id }; return [{ ConnectionHealth: 1 }]; };
  const result = await sqlConnector.testDbSource('source-1');
  assert.deepEqual(received, { sql: 'SELECT 1 AS ConnectionHealth', id: 'source-1' });
  assert.equal(result.dbName, 'Fixture');
  assert.equal(typeof result.latencyMs, 'number');
});

test('testDbSource rejects an unknown id instead of falling back to default', async t => {
  const originalSources = sqlConnector.dbSources;
  t.after(() => { sqlConnector.dbSources = originalSources; });
  sqlConnector.dbSources = [{ id: 'default', dbName: 'Fixture', mode: 'live', isDefault: true }];
  await assert.rejects(() => sqlConnector.testDbSource('missing'), /không tồn tại/i);
});
