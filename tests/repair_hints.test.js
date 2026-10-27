'use strict';
// Repair hints for rejected v2 contracts: valid refs from the catalog and the
// rule that was broken, so the repair round does not repeat the same error.
const test = require('node:test');
const assert = require('node:assert/strict');
const { hint, suggest } = require('../src/backend/agent_core/pipeline/repair_hints');
const { compile } = require('../src/backend/agent_core/pipeline/query_compiler');

const columns = list => new Map(list.map(([name, type, label = '', pk = false]) => [name.toLowerCase(), { name, type, label, pk }]));
const table = (tableName, cols, extra = {}) => [tableName.toLowerCase(), { tableId: `s::${tableName}`, tableName, schemaName: 'dbo', label: '', columns: columns(cols), defaults: [], ...extra }];
const catalog = {
  dbSourceId: 's',
  tables: new Map([
    table('T_ElectricityOutput', [['ElectricityOutputID', 'int', 'ID', true], ['ElectricityOutputDate', 'datetime', 'Ngày chứng từ'],
      ['CustomerID', 'int'], ['FinalTotalAmount', 'float', 'Tiền sau thuế']], { dateColumn: 'ElectricityOutputDate' }),
    table('M_Customer', [['CustomerID', 'int', '', true], ['CustomerCode', 'nvarchar', 'Mã khách hàng'], ['CustomerName', 'nvarchar', 'Tên khách hàng']])
  ]),
  relations: [{ id: 'r-customer', fromTable: 'T_ElectricityOutput', toTable: 'M_Customer', pairs: [{ source: 'CustomerID', target: 'CustomerID' }], role: 'Khách hàng', display: 'CustomerName' }],
  metrics: [{ id: 'bill_after_tax', table: 'T_ElectricityOutput', column: 'FinalTotalAmount', aggregation: 'SUM', conditions: [] }]
};
const rejected = contract => { try { compile(contract, catalog, { question: 'Khách hàng nào có tiền sau thuế cao nhất tháng 2024-02?' }); } catch (error) { return error; } };
const ranking = { kind: 'data', root: 'T_ElectricityOutput', operation: 'aggregate', measures: [{ metric: 'bill_after_tax' }] };

test('a lookup named through its own key gets the root foreign-key refs', () => {
  const error = rejected({ ...ranking, filters: [{ ref: 'M_Customer.CustomerID->M_Customer.CustomerName', operator: 'notNull', evidence: 'Khách hàng nào' }] });
  assert.equal(error.code, 'V2_LOOKUP_UNKNOWN');
  const text = hint(error, ranking, catalog);
  assert.match(text, /T_ElectricityOutput\.CustomerID->CustomerName/);
  assert.match(text, /T_ElectricityOutput\.FKColumn->LookupColumn/);
  // The closest names come first; the list is bounded.
  assert.deepEqual(suggest(catalog, 'T_ElectricityOutput', 'M_Customer.CustomerName').slice(0, 1), ['T_ElectricityOutput.CustomerID->CustomerName']);
  assert.ok(suggest(catalog, 'T_ElectricityOutput', 'x').length <= 8);
});

test('grain on a name column points to grouping without grain or by the business date', () => {
  const error = rejected({ ...ranking, groupBy: [{ ref: 'T_ElectricityOutput.CustomerID->CustomerName', grain: 'month' }] });
  assert.equal(error.code, 'V2_TIME_NOT_DATE');
  assert.match(hint(error, ranking, catalog), /CustomerName is not one: group by it without grain, or by T_ElectricityOutput\.ElectricityOutputDate with grain/);
});

test('ranking, metric, sort and grounding errors get their rule', () => {
  assert.match(hint(rejected({ ...ranking, measures: undefined }), ranking, catalog), /sort \{by:"measure:0", direction:"DESC"\}/);
  assert.match(hint(rejected({ ...ranking, measures: [{ metric: 'headcount' }] }), ranking, catalog), /approved metric id \(bill_after_tax\)/);
  assert.match(hint(rejected({ ...ranking, sort: { by: 'measure:3' } }), ranking, catalog), /sort\.by is "measure:<index>"/);
  const ungrounded = rejected({ ...ranking, filters: [{ ref: 'T_ElectricityOutput.CustomerID', operator: 'eq', value: 1, evidence: '2024-02' }] });
  assert.equal(ungrounded.code, 'V2_FILTER_UNGROUNDED');
  assert.match(hint(ungrounded, ranking, catalog), /never as an invented numeric ID/);
  assert.equal(hint(Object.assign(new Error('V2_PERIOD_INVALID: x'), { code: 'V2_PERIOD_INVALID' }), ranking, catalog), '');
  assert.equal(hint(Object.assign(new Error('V2_COLUMN_UNKNOWN: x'), { code: 'V2_COLUMN_UNKNOWN' }), { root: 'Missing' }, catalog), '');
});

test('"measures:0" sorts by the first measure like "measure:0"', () => {
  const group = [{ ref: 'T_ElectricityOutput.CustomerID->CustomerName' }];
  const a = compile({ ...ranking, groupBy: group, sort: { by: 'measure:0', direction: 'DESC' }, limit: 1 }, catalog);
  const b = compile({ ...ranking, groupBy: group, sort: { by: 'measures:0', direction: 'DESC' }, limit: 1 }, catalog);
  assert.equal(b.sql, a.sql);
  assert.match(a.sql, /ORDER BY \[Tiền sau thuế\] DESC|ORDER BY .* DESC/);
});

test('a question for one record by a column is told to list, sort and limit', () => {
  const error = rejected({ kind: 'data', root: 'T_ElectricityOutput', operation: 'aggregate', sort: { by: 'T_ElectricityOutput.ElectricityOutputDate' }, limit: 1 });
  assert.equal(error.code, 'V2_MEASURE_REQUIRED');
  assert.match(hint(error, ranking, catalog), /operation=list with sort \{by:"Root\.Column"\} and limit 1, without measures; youngest is the latest birth date \(DESC\)/);
});

test('a month filtered on an ID column is sent to the business date with operator=period', () => {
  const error = rejected({ ...ranking, filters: [{ ref: 'T_ElectricityOutput.CustomerID', operator: 'period', value: '2024-02', evidence: '2024-02' }] });
  assert.equal(error.code, 'V2_FILTER_TYPE');
  assert.match(hint(error, ranking, catalog), /^2024-02 is a date, month or year: filter it with operator=period on a date column \(the business date is T_ElectricityOutput\.ElectricityOutputDate\)/);
  // A code on an ID column keeps the lookup hint.
  let code;
  try { compile({ ...ranking, filters: [{ ref: 'T_ElectricityOutput.CustomerID', operator: 'eq', value: 'KA0021', evidence: 'KA0021' }] }, catalog, { question: 'Tiền của KA0021?' }); }
  catch (caught) { code = caught; }
  assert.equal(code.code, 'V2_FILTER_TYPE');
  assert.match(hint(code, ranking, catalog), /^A code or name never matches a numeric ID column/);
});

test('a filter without a value is told that "theo X" is a grouping', () => {
  const error = rejected({ ...ranking, groupBy: [{ ref: 'T_ElectricityOutput.CustomerID->CustomerName' }],
    filters: [{ ref: 'T_ElectricityOutput.CustomerID->CustomerName', operator: 'in', evidence: 'Khách hàng' }] });
  assert.equal(error.code, 'V2_FILTER_VALUE_REQUIRED');
  assert.match(hint(error, ranking, catalog), /^The filter on T_ElectricityOutput\.CustomerID->CustomerName has no value\. .*"theo X" \/ "by X" asks to group by X/);
});

test('a carried filter quoted from the previous question is told to set inherited only in a follow-up', () => {
  const contract = { ...ranking, filters: [{ ref: 'T_ElectricityOutput.CustomerID->CustomerCode', operator: 'eq', value: 'KA0021', evidence: 'KA0021' }] };
  let error;
  try { compile(contract, catalog, { question: 'Còn tháng 2024-01 thì sao?' }); } catch (caught) { error = caught; }
  assert.equal(error.code, 'V2_FILTER_UNGROUNDED');
  assert.match(hint(error, contract, catalog, { followup: true }), /^A filter carried from PREVIOUS keeps the evidence quoted from the previous question and sets inherited=true/);
  assert.doesNotMatch(hint(error, contract, catalog), /inherited/);
  // An invented value is not a carried filter.
  const invented = rejected({ ...ranking, filters: [{ ref: 'T_ElectricityOutput.CustomerID', operator: 'eq', value: 1, evidence: '2024-02' }] });
  assert.doesNotMatch(hint(invented, ranking, catalog, { followup: true }), /inherited/);
});
