'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
test('employee lookup definition validates and covers code, duplicate names and no match', async () => {
  const bundle = require('../docs/templates/employee_lookup.json');
  const { validatePackage, validateInputs } = require('../src/backend/automation/contract');
  validatePackage(bundle);
  assert.equal(validateInputs(bundle.templates[0], {}).valid, false);
  assert.equal(validateInputs(bundle.templates[0], { query: 'NV004' }).valid, true);
  const { PluginRegistry } = require('../src/backend/automation/registry');
  assert.equal((await new PluginRegistry(null).testBundle(bundle)).passed, true);
  const { tableAvailable } = require('../src/backend/automation/sql');
  const dictionary = require('../src/backend/services/dictionary_service');
  const previous = dictionary.tablesStore;
  try {
    const binding = { dbSourceId: 'employee-test' };
    dictionary.tablesStore = [{ dbSourceId: 'employee-test', schemaName: 'dbo', tableName: 'M_Employee', isActive: true }];
    assert.equal(tableAvailable(binding, 'dbo.M_Employee', { schemas: [] }), true);
    dictionary.tablesStore[0].isActive = false;
    assert.equal(tableAvailable(binding, 'dbo.M_Employee', { schemas: [dictionary.tablesStore[0]] }), false);
    const automation = require('../src/backend/automation');
    const definition = structuredClone(bundle.templates[0]);
    dictionary.tablesStore = [{ tableId: definition.bindings.employee.resultMapping[0].tableId, dbSourceId: definition.bindings.employee.dbSourceId, tableName: 'M_Employee', schemaName: 'dbo', columns: [
      { columnName: 'EmployeeCode', displayName: 'Mã NV', isVisible: true, ordinalPosition: 2 },
      { columnName: 'EmployeeName', displayName: 'Tên nhân viên', isVisible: true, ordinalPosition: 1 },
      { columnName: 'BankAccountNo', isVisible: false }
    ] }];
    const run = { definition, input: {}, missing: [], invalid: [], attempts: {}, status: 'SUCCEEDED', result: { employees: [{ EmployeeCode: 'T001', EmployeeName: 'Test', BankAccountNo: 'hidden' }], count: 1, empty: false } };
    const view = automation.runtime.view(run);
    assert.deepEqual(view.presentation.columns.employees, ['EmployeeName', 'EmployeeCode']);
    assert.equal(view.presentation.labels['employees.EmployeeName'], 'Tên nhân viên');
    assert.equal(view.result.employees[0].BankAccountNo, undefined);
    dictionary.tablesStore[0].columns[0].isVisible = false;
    assert.deepEqual(automation.runtime.view(run).presentation.columns.employees, ['EmployeeName']);
    assert.equal(run.result.employees[0].BankAccountNo, 'hidden');
  } finally { dictionary.tablesStore = previous; }
});
