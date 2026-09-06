const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { getAvailableExportBase } = require('../src/backend/agent_core/tools/builtins');

test('export keeps requested filename when it is available', () => {
  assert.equal(getAvailableExportBase('exports', 'Bao_Cao', ['.csv'], () => false), 'Bao_Cao');
});

test('export adds a unique suffix when requested filename already exists', () => {
  const existing = new Set([path.join('exports', 'Bao_Cao.csv')]);
  const result = getAvailableExportBase('exports', 'Bao_Cao', ['.csv'], file => existing.has(file));
  assert.match(result, /^Bao_Cao_\d{17}$/);
});

test('xlsx allocation checks both generated xlsx and xls files', () => {
  const existing = new Set([path.join('exports', 'Bao_Cao.xls')]);
  const result = getAvailableExportBase('exports', 'Bao_Cao', ['.xlsx', '.xls'], file => existing.has(file));
  assert.notEqual(result, 'Bao_Cao');
});
