'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSchemaContext, isStandaloneCalculation } = require('../src/backend/intelligent_core/schema_context_service');
const dictionaryService = require('../src/backend/services/dictionary_service');
const { getDomainAliases, normalizeDomainAliases, normalizeDomainKey } = require('../src/backend/intelligent_core/domain_alias_service');

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

test('Vietnamese natural-language contract requests select the configured contract domain', async () => {
  for (const question of ['ds hợp đồng', 'bảng hợp đồng hiện tại có dữ liệu gì']) {
    const context = await buildSchemaContext(question, { dbName: 'IPMS' });
    assert.equal(context.mode, 'data');
    assert.equal(context.selectedTables[0], 'T_Contract');
    assert.match(context.schemaContext, /Business domain: contract/);
  }
});

test('business domains accept Vietnamese natural-language labels', () => {
  assert.equal(dictionaryService.normalizeDomain('Hợp đồng dịch vụ'), 'hop_dong_dich_vu');
  assert.equal(dictionaryService.normalizeDomain('Điện bán ra'), 'dien_ban_ra');
});

test('domain aliases are loaded from the editable data file', () => {
  const aliases = getDomainAliases();
  assert.ok(aliases.contract.includes('hop dong'));
});

test('invalid domain alias entries are safely normalized', () => {
  assert.deepEqual(normalizeDomainAliases({ contract: ['hop dong', '', 'hop dong'], invalid: 'text' }), {
    contract: ['hop dong'],
    invalid: []
  });
});

test('Vietnamese domain keys are normalized for persistent configuration', () => {
  assert.equal(normalizeDomainKey('Hợp đồng dịch vụ'), 'hop_dong_dich_vu');
});
