'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const pipeline = require('../src/backend/agent_core/pipeline/contract_pipeline');

test('coverage check rejects contracts that drop a code, month or year from the question', () => {
  const question = 'Khách hàng nào có tiền điện cao nhất tháng 2024-02?';
  assert.deepEqual(pipeline.uncovered({ filters: [] }, question), ['2024-02']);
  assert.deepEqual(pipeline.uncovered({ filters: [{ evidence: 'tháng 2024-02', value: '2024-02' }] }, question), []);
  assert.deepEqual(pipeline.uncovered({ filters: [{ evidence: 'KA0021', value: 'KA0021' }] }, 'Tiền điện của KA0021 trong năm 2024'), ['2024']);
  assert.deepEqual(pipeline.uncovered({ filters: [] }, 'Hóa đơn của x001 ngày 15/02/2024'), ['15/02/2024', 'x001']);
  // Row limits and plain lists carry no filter.
  assert.deepEqual(pipeline.uncovered({ filters: [], limit: 5 }, 'top 5 khách hàng'), []);
  assert.deepEqual(pipeline.uncovered({ filters: [] }, 'ds nv'), []);
});

test('follow-ups carry forgotten equality filters unless the user widens the scope', () => {
  const previous = { question: 'Tổng tiền điện của KA0021 trong tháng 2024-01?', contract: { filters: [
    { ref: 'T_ElectricityOutput.CustomerID->CustomerCode', operator: 'eq', value: 'KA0021', evidence: 'KA0021' },
    { ref: 'T_ElectricityOutput.ElectricityOutputDate', operator: 'period', value: '2024-01', evidence: '2024-01' }] } };
  const contract = { followup: true, filters: [{ ref: 'T_ElectricityOutput.ElectricityOutputDate', operator: 'period', value: '2024-02', evidence: '2024-02' }] };
  assert.deepEqual(pipeline.carryFilters(contract, previous, 'Còn tháng 2024-02 thì sao?').map(item => item.value), ['KA0021']);
  assert.equal(contract.filters.length, 2);
  // A restated customer replaces the carried one; "tất cả" removes it.
  const other = { followup: true, filters: [{ ref: 'T_ElectricityOutput.CustomerID->CustomerCode', operator: 'eq', value: 'DC6011', evidence: 'DC6011' }] };
  assert.deepEqual(pipeline.carryFilters(other, previous, 'Còn DC6011 thì sao?'), []);
  assert.deepEqual(pipeline.carryFilters({ followup: true, filters: [] }, previous, 'Vậy tất cả khách hàng thì sao?'), []);
  assert.deepEqual(pipeline.carryFilters({ followup: false, filters: [] }, previous, 'ds nv'), []);
});

test('contract decoding accepts COUNT(*) and reports schema errors precisely', () => {
  const call = args => ({ tool_calls: [{ id: '1', type: 'function', function: { name: 'plan_query', arguments: JSON.stringify(args) } }] });
  assert.equal(pipeline.decode(call({ kind: 'data', root: 'M_Employee', operation: 'aggregate', measures: [{ ref: '*', aggregation: 'COUNT' }] })).measures[0].ref, '*');
  assert.throws(() => pipeline.decode(call({ kind: 'data', operation: 'sum' })), error => error.code === 'V2_CONTRACT_INVALID' && error.details.length > 0);
});

test('empty sums are reported as no data while a zero count is an answer', () => {
  const compiled = (alias, operation = 'aggregate') => ({ scope: ['Mã khách hàng = KA0021'], operation, analysis: 'none', outputs: [{ alias, kind: 'measure' }] });
  const call = rows => ({ result: { rows } });
  assert.match(pipeline.render(compiled('Tổng tiền'), call([{ 'Tổng tiền': null }]), 'q'), /^Không tìm thấy dữ liệu phù hợp với phạm vi đã lọc \(Mã khách hàng = KA0021\)/);
  assert.match(pipeline.render(compiled('Số bản ghi'), call([{ 'Số bản ghi': 0 }]), 'q'), /\*\*Số bản ghi:\*\* 0/);
  assert.match(pipeline.render(compiled('Tổng tiền'), call([{ 'Tổng tiền': 6652704 }]), 'q'), /^Phạm vi: Mã khách hàng = KA0021\.\n\n\*\*Tổng tiền:\*\* 6\.652\.704$/);
});

test('contracts infer an omitted kind and accept numeric or boolean workflow inputs', () => {
  const call = args => ({ tool_calls: [{ id: '1', type: 'function', function: { name: 'plan_query', arguments: JSON.stringify(args) } }] });
  const workflow = pipeline.decode(call({ workflow: { templateId: 'w', inputs: { months: 3, drawChart: true }, evidence: { months: '3 tháng' } } }));
  assert.equal(workflow.kind, 'workflow');
  assert.equal(pipeline.decode(call({ root: 'T', operation: 'list', filters: [{ ref: 'T.ID', operator: 'eq', value: 7, evidence: '7' }] })).kind, 'data');
});

test('"biểu đồ" is not read as "đó": a chart request is not a follow-up by itself', () => {
  const { dependsOnPrevious } = require('../src/backend/memory_core/followup_policy');
  assert.equal(dependsOnPrevious('Báo cáo sản lượng điện 3 tháng gần nhất, vẽ biểu đồ'), false);
  assert.equal(dependsOnPrevious('xuất file ds đó'), true);
  assert.equal(dependsOnPrevious('vẽ biểu đồ cho danh sách trên'), true);
});

test('chart arguments come straight from compiled rows', () => {
  const compiled = { outputs: [{ alias: 'Tháng', kind: 'dimension' }, { alias: 'Tổng', kind: 'measure' }] };
  const args = pipeline.chartArgs(compiled, [{ 'Tháng': new Date('2024-01-01T00:00:00Z'), 'Tổng': 5 }, { 'Tháng': new Date('2024-02-01T00:00:00Z'), 'Tổng': '7' }], 'auto', 'q');
  assert.deepEqual(args, { type: 'line', title: 'q', labels: ['2024-01', '2024-02'], datasets: [{ label: 'Tổng', data: [5, 7] }] });
  assert.equal(pipeline.chartArgs({ outputs: [{ alias: 'Tổng', kind: 'measure' }] }, [{ 'Tổng': 1 }], 'bar', 'q'), null);
});
