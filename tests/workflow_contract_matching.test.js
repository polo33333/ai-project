'use strict';
// A workflow the planner chose with quoted inputs is matched by the backend
// (the inputs' filter fields are read from its SQL); only uncertain cases
// spend a model call on the suitability assessment.
const test = require('node:test');
const assert = require('node:assert/strict');
const { assess } = require('../src/backend/memory/workflow_suitability');
const { describeWorkflows } = require('../src/backend/agent/pipeline/contract_pipeline');

const lookup = { id: 'employee/details', name: 'Chi tiết nhân viên', inputs: { query: { schema: { type: 'string' } } },
  bindings: { lookup: { dbSourceId: 's', sql: 'SELECT e.EmployeeName FROM dbo.M_Employee e WHERE e.EmployeeCode = @query OR e.EmployeeName = @query',
    parameters: { query: { slot: 'query' } } } } };
const report = { id: 'electricity/report', name: 'Báo cáo sản lượng', inputs: { months: { schema: { type: 'integer' } } },
  bindings: { rows: { dbSourceId: 's', sql: 'SELECT TOP (@months) x FROM dbo.T_Output', parameters: { months: { slot: 'months' } } } } };
const modelAnswer = { suitable: true, reason: 'model', confirmedSlots: ['query'], inputBindings: [{ slot: 'query', table: 'M_Employee', column: 'EmployeeName' }] };

function dispatcher() {
  const calls = [];
  return { calls, dispatch: async () => { calls.push(1); return { content: JSON.stringify(modelAnswer) }; } };
}

test('a planned run whose quoted value is found in a filter field needs no model call', async () => {
  const { calls, dispatch } = dispatcher();
  const probed = [];
  const result = await assess(dispatch, 'Tra cứu nhân viên NV007', { operation: 'detail', proposedInputs: { query: 'NV007' } }, lookup,
    { planned: true, probe: async (field, value, source) => { probed.push([field.column, value, source]); return field.column === 'EmployeeCode'; } });
  assert.equal(calls.length, 0);
  assert.equal(result.deterministic, true);
  assert.deepEqual(result.inputBindings, [{ slot: 'query', table: 'M_Employee', column: 'EmployeeCode' }]);
  assert.deepEqual(result.confirmedSlots, ['query']);
  assert.deepEqual(probed, [['EmployeeCode', 'NV007', 's']]);
});

test('a planned run without string inputs is accepted after the capability checks', async () => {
  const { calls, dispatch } = dispatcher();
  const result = await assess(dispatch, 'Báo cáo sản lượng 3 tháng', { proposedInputs: { months: 3 } }, report, { planned: true, probe: async () => true });
  assert.equal(calls.length, 0);
  assert.equal(result.suitable, true);
  // Capability checks still come first: a chart the workflow cannot draw is rejected.
  await assert.rejects(assess(dispatch, 'vẽ biểu đồ', { outputs: { chart: true }, proposedInputs: { months: 3 } }, report, { planned: true }),
    { code: 'WORKFLOW_OPERATION_MISMATCH' });
});

test('uncertain or unplanned runs still ask the model', async () => {
  for (const [options, label] of [
    [{ planned: true, probe: async () => false }, 'value not found in any filter field'],
    [{ planned: true, probe: async () => null }, 'probe unavailable (other source)'],
    [{ planned: false, probe: async () => true }, 'chosen by the agent loop, not the planner']]) {
    const { calls, dispatch } = dispatcher();
    const result = await assess(dispatch, 'Tra cứu nhân viên Lê Minh', { operation: 'detail', proposedInputs: { query: 'Lê Minh' } }, lookup, options);
    assert.equal(calls.length, 1, label);
    assert.equal(result.deterministic, undefined, label);
  }
});

test('the planner sees which fields each workflow input filters on', () => {
  const text = describeWorkflows([{ templateId: 'employee/details', name: 'Chi tiết nhân viên', operations: ['detail'],
    inputs: { query: { label: 'Mã hoặc tên', required: true, schema: { type: 'string' } } },
    inputFields: require('../src/backend/automation/sql_input_fields').inputFields(lookup) }]);
  assert.match(text, /query\*\(Mã hoặc tên, string, matches M_Employee\.EmployeeCode or M_Employee\.EmployeeName\)/);
});
