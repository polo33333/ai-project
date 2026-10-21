'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const context = require('../src/backend/governance/context');
const metrics = require('../src/backend/governance/metrics');
const connector = require('../src/backend/services/sql_connector');
const definition = { metricId: 'revenue', owner: 'Finance', definition: 'Approved fixture only', table: 'dbo.Orders', valueColumn: 'Amount', aggregation: 'SUM',
  unit: 'VND', grain: 'order', timeColumn: 'CreatedAt', timezone: 'Asia/Ho_Chi_Minh', dimensions: ['Region'], nullRule: 'exclude', rounding: 2, approved: false };
test('metric compiler uses typed exclusive date range, decimal aggregation and permitted dimensions', () => {
  const result = metrics.compile(definition, { start: '2026-01-01', end: '2026-02-01', dimensions: ['Region'] });
  assert.ok(result.sql.includes('SUM(CAST([Amount] AS DECIMAL(38,8)))')); assert.ok(result.sql.includes('[CreatedAt] < @metric_end'));
  assert.equal(result.parameters[0].type, 'date'); assert.ok(result.sql.includes('GROUP BY [Region]')); assert.equal(result.normalizedQueryHash.length, 64);
  for (const input of [{ start: '2026-02-30', end: '2026-03-01' }, { start: '2026-02-01', end: '2026-01-01' }, { start: '2026-01-01', end: '2026-02-01', dimensions: ['Secret'] }]) assert.throws(() => metrics.compile(definition, input));
  assert.equal(metrics.validate({ ...definition, table: 'dbo.Orders;DROP' }), false);
});
test('versioned metric drafts are hidden, approved query rechecks source ACL and preserves lineage', async () => context.run(async () => {
  const original = connector.executeSqlQuery, source = { id: 'metric-fixture', governedPolicy: { visibility: 'restricted', subjects: ['account:a'], allowedTables: ['dbo.Orders'] } };
  connector.dbSources.push(source); context.setPrincipal({ subject: 'account:a', role: 'admin' });
  try {
    metrics.save(source.id, definition, 0); assert.ok(!metrics.list().some(metric => metric.sourceId === source.id));
    assert.throws(() => metrics.save(source.id, definition, 0), { code: 'METRIC_REVISION_CONFLICT' });
    metrics.save(source.id, { ...definition, approved: true }, 1);
    connector.executeSqlQuery = async (sql, sourceId, signal, parameters) => { assert.equal(sourceId, source.id); assert.equal(parameters.length, 2); return [{ value: 125 }]; };
    context.setPrincipal({ subject: 'account:a', role: 'user' });
    const result = await metrics.execute({ metricId: 'revenue', sourceId: source.id, start: '2026-01-01', end: '2026-02-01' }, { permissions: ['sql:read'] });
    assert.equal(result.metricVersion, 2); assert.equal(result.units.value, 'VND'); assert.equal(result.complete, true); assert.equal(result.lineage.length, 1);
    context.setPrincipal({ subject: 'account:b', role: 'user' });
    await assert.rejects(metrics.execute({ metricId: 'revenue', sourceId: source.id }, { permissions: ['sql:read'] }), { code: 'METRIC_NOT_FOUND' });
  } finally { connector.executeSqlQuery = original; connector.dbSources = connector.dbSources.filter(item => item.id !== source.id); connector.persist(); }
}));
