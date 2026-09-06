'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSchemaContext, isStandaloneCalculation } = require('../src/backend/intelligent_core/schema_context_service');

test('standalone statistics with an explicit number list bypass SQL schema retrieval', () => {
  assert.equal(
    isStandaloneCalculation('Tính min, max, trung bình của dãy số: 120, 450, 230, 890, 340, 670'),
    true
  );
});

test('schema context routes the reported statistics prompt to general utility tools', async () => {
  const context = await buildSchemaContext(
    'Tính min, max, trung bình của dãy số: 120, 450, 230, 890, 340, 670',
    { dbName: 'IPMS' }
  );
  assert.equal(context.mode, 'general');
  assert.deepEqual(context.selectedTables, []);
});

test('database statistics still use schema retrieval', () => {
  assert.equal(isStandaloneCalculation('Tính min, max cột doanh thu trong bảng hóa đơn'), false);
  assert.equal(
    isStandaloneCalculation('Tính trung bình 120, 450 cho cột doanh thu', { hasSchemaMatch: true }),
    false
  );
});

test('long arithmetic expressions bypass SQL schema retrieval', () => {
  assert.equal(isStandaloneCalculation('Hãy tính giúp tôi (120 + 450 + 230) / 3'), true);
});
