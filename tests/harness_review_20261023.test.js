'use strict';
// Regression cases from docs/HARNESS_SQL_SYSTEM_REVIEW_20261023.html. Each
// finding is paired with a control so tightening a guard cannot silently turn
// into rejecting equivalent, correct SQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { bind, bindEach } = require('../src/backend/agent_core/harness/request_filters');
const { matchesScope } = require('../src/backend/agent_core/harness/schema_scope');
const { assessSqlEvidence, stableFingerprint, evaluateCompletion } = require('../src/backend/agent_core/harness/completion_policy');
const { createRequestContract, assessRequestContract } = require('../src/backend/agent_core/harness/request_contract');
const { validateSqlAgainstJoinPlan } = require('../src/backend/services/sql_join_validator');
const answerStatus = require('../src/backend/agent_core/harness/answer_status');

const tables = [{ tableName: 'Documents', schemaName: 'dbo', columns: [{ name: 'CycleID', type: 'INT' }] }];
const question = 'Details for cycle 20';
const filters = bind([{ table: 'Documents', column: 'CycleID', value: 20, evidence: 'cycle 20' }], tables, question);
const sqlCall = sql => ({ toolName: 'execute_sql_query', success: true, args: { sql }, result: { sql, rows: [{ Total: 0 }] } });

test('F01: one ungrounded filter keeps the bound ones and reports the unresolved qualifier', () => {
  const result = bindEach([{ table: 'Documents', column: 'CycleID', value: 20, evidence: 'cycle 20' },
    { table: 'Customers', column: 'Code', value: 'Details', evidence: 'Details' }], tables, question);
  assert.deepEqual(result.filters.map(item => item.column), ['CycleID']);
  assert.equal(result.unresolved.length, 1);
  // Evidence that is not in the question is not a requested qualifier.
  assert.equal(bindEach([{ table: 'X', column: 'Y', value: 1, evidence: 'not asked' }], tables, question).unresolved.length, 0);
});

test('F09: singleton IN equals equality; schema identity is enforced when known', () => {
  assert.equal(matchesScope('SELECT CycleID FROM Documents WHERE CycleID IN (20)', filters), true);
  assert.equal(matchesScope('SELECT CycleID FROM Documents WHERE CycleID IN (20, 19)', filters), false);
  assert.equal(matchesScope('SELECT CycleID FROM Documents', filters), false);
  assert.equal(matchesScope('SELECT d.CycleID FROM archive.Documents d WHERE d.CycleID=20', filters), false);
  assert.equal(matchesScope('SELECT d.CycleID FROM dbo.Documents d WHERE d.CycleID=20', filters), true);
  assert.equal(matchesScope('SELECT CycleID FROM Documents WHERE CycleID=20', filters), true);
});

test('F02: the projected expression must be the requested aggregate, alias resolved to its table', () => {
  const plan = { table: 'Invoices', intent: 'aggregate', metric: 'Amount', aggregation: 'SUM', conversationState: { operation: 'aggregate' } };
  assert.equal(assessSqlEvidence(sqlCall('SELECT SUM(Amount) * 0 AS Total FROM Invoices'), plan).accepted, false);
  assert.equal(assessSqlEvidence(sqlCall('SELECT SUM(Amount) AS Total FROM Invoices'), plan).accepted, true);
  assert.equal(assessSqlEvidence(sqlCall('SELECT ISNULL(SUM(Amount), 0) AS Total FROM Invoices'), plan).accepted, true);
  assert.equal(assessSqlEvidence(sqlCall('SELECT CAST(ROUND(SUM(Amount), 2) AS DECIMAL(18,2)) AS Total FROM Invoices'), plan).accepted, true);
  const measured = { ...plan, requiredMeasures: [{ table: 'Invoices', column: 'Amount', aggregation: 'SUM' }] };
  assert.equal(assessSqlEvidence(sqlCall('SELECT SUM(Invoices.Amount) AS Total FROM Credits Invoices JOIN Invoices i ON i.ID=Invoices.ID'), measured).accepted, false);
  assert.equal(assessSqlEvidence(sqlCall('SELECT SUM(i.Amount) AS Total FROM Invoices i'), measured).accepted, true);
});

test('F03: root output fields need physical lineage, not only a matching result key', () => {
  const contract = createRequestContract({ table: 'Invoices', conversationState: { operation: 'attribute', requestedAttributes: ['Amount'] } },
    { tables: [{ tableName: 'Invoices', columns: [{ name: 'Amount', label: 'Số tiền' }] }] });
  const call = sql => ({ success: true, args: { sql }, result: { rows: [{ Amount: 0, 'Số tiền': 0 }] } });
  assert.equal(assessRequestContract(contract, call('SELECT 0 AS Amount FROM Invoices')).complete, false);
  assert.equal(assessRequestContract(contract, call('SELECT Amount FROM Invoices')).complete, true);
  assert.equal(assessRequestContract(contract, call('SELECT i.Amount AS [Số tiền] FROM Invoices i')).complete, true);
  assert.equal(assessRequestContract(contract, call('SELECT ISNULL(i.Amount, 0) AS Amount FROM Invoices i')).complete, true);
  assert.equal(assessRequestContract(contract, call('SELECT c.Amount AS Amount FROM Invoices i JOIN Credits c ON c.ID=i.ID')).complete, false);
});

test('F04: fan-out guard follows columns through expressions, mixed row-level expressions pass', () => {
  const joinPlan = { outcome: 'ready', tableRefs: [{ tableRefId: 'p', tableId: 'p', tableName: 'Parents', schemaName: 'dbo' }, { tableRefId: 'c', tableId: 'c', tableName: 'Children', schemaName: 'dbo' }],
    edges: [{ relationshipId: 'r', fromTableRefId: 'p', toTableRefId: 'c', fromTableId: 'p', toTableId: 'c', cardinality: 'one-to-many', columnPairs: [{ sourceColumn: 'ID', targetColumn: 'ParentID' }] }] };
  const valid = sql => validateSqlAgainstJoinPlan(sql, joinPlan).valid;
  assert.equal(valid('SELECT SUM(p.Amount) AS Total FROM Parents p JOIN Children c ON p.ID=c.ParentID'), false);
  assert.equal(valid('SELECT SUM(COALESCE(p.Amount,0)) AS Total FROM Parents p JOIN Children c ON p.ID=c.ParentID'), false);
  assert.equal(valid('SELECT SUM(CASE WHEN p.Amount > 0 THEN p.Amount END) AS Total FROM Parents p JOIN Children c ON p.ID=c.ParentID'), false);
  assert.equal(valid('SELECT SUM(c.Qty * p.Price) AS Total FROM Parents p JOIN Children c ON p.ID=c.ParentID'), true);
  assert.equal(valid('SELECT SUM(COALESCE(c.Amount,0)) AS Total FROM Parents p JOIN Children c ON p.ID=c.ParentID'), true);
  assert.equal(valid('SELECT COUNT(*) AS Total FROM Parents p JOIN Children c ON p.ID=c.ParentID'), true);
});

test('F06: no-progress fingerprint ignores SQL formatting but not literal values', () => {
  const fp = sql => stableFingerprint('execute_sql_query', { sql });
  assert.equal(fp('SELECT ID FROM Documents'), fp('select  ID\n from [Documents]'));
  assert.notEqual(fp("SELECT ID FROM Documents WHERE Code='a'"), fp("SELECT ID FROM Documents WHERE Code='b'"));
  assert.equal(stableFingerprint('search_schema', { query: 'hóa  đơn' }), stableFingerprint('search_schema', { query: 'hóa đơn' }));
});

test('F07: raw SQL reaching its TOP cap is partial unless the user asked for exactly N or a ranking', async () => {
  const connector = require('../src/backend/services/sql_connector');
  const original = connector.executeSqlQuery;
  connector.executeSqlQuery = async () => [{ ID: 1 }, { ID: 2 }];
  try {
    const { ExecuteSqlTool } = require('../src/backend/agent_core/tools/builtins');
    const run = (sql, requestPlan) => new ExecuteSqlTool().run({ sql }, { dbSourceId: 'synthetic', requestPlan });
    const capped = await run('SELECT TOP 2 ID FROM Documents');
    assert.equal(capped.hasMore, true);
    assert.equal(capped.completeness.status, 'partial');
    assert.equal((await run('SELECT TOP 2 ID FROM Documents', { rowLimit: 2 })).hasMore, false);
    assert.equal((await run('SELECT TOP 5 ID FROM Documents')).hasMore, false);
    assert.equal((await run('SELECT TOP 2 ID FROM Documents ORDER BY ID DESC')).hasMore, false);
    // The security guard caps unlimited SQL; reaching that implicit cap is partial too.
    assert.equal((await run('SELECT ID FROM Documents')).hasMore, false);
    connector.executeSqlQuery = async () => Array.from({ length: 100 }, (_, ID) => ({ ID }));
    const implicit = await run('SELECT ID FROM Documents ORDER BY ID');
    assert.equal(implicit.completeness.appliedLimit, 100);
    assert.equal(implicit.hasMore, true);
  } finally { connector.executeSqlQuery = original; }
});

test('F08: an anomaly verdict without criterion is not complete; an insufficiency statement is', () => {
  const plan = { table: 'Invoices', outputs: { data: true }, analysisTask: 'anomaly' };
  const calls = [sqlCall('SELECT Amount FROM Invoices')];
  const failures = reply => evaluateCompletion({ reply, plan, toolCalls: calls }).failures;
  assert.ok(failures('Tháng này bất thường.').includes('ANALYSIS_CRITERION_MISSING'));
  assert.ok(!failures('Tháng 5 bất thường: vượt ngưỡng trung bình 12 tháng cộng 2 độ lệch chuẩn.').includes('ANALYSIS_CRITERION_MISSING'));
  assert.ok(!failures('Chưa đủ căn cứ xác nhận tháng bất thường vì chỉ có 2 mốc dữ liệu.').includes('ANALYSIS_CRITERION_MISSING'));
});

test('F14: fallback reply states the action that can change the outcome', () => {
  assert.equal(answerStatus.category('REPAIR_BUDGET_EXCEEDED'), 'BUDGET_EXHAUSTED');
  assert.equal(answerStatus.category('REQUEST_DEADLINE_EXCEEDED'), 'RETRYABLE_FAILURE');
  assert.equal(answerStatus.category(null, [{ toolName: 'execute_sql_query', success: false, code: 'JOIN_RELATIONSHIP_MISSING' }]), 'METADATA_REQUIRED');
  assert.equal(answerStatus.category(null), 'INCOMPLETE');
  for (const reason of ['REPAIR_BUDGET_EXCEEDED', 'REQUEST_DEADLINE_EXCEEDED', null])
    assert.ok(answerStatus.fallbackReply(reason).startsWith('Chưa thể hoàn tất'));
});

test('F05: a tool removed from the current stage is rejected at dispatch', async () => {
  const Harness = require('../src/backend/agent_core/harness/guarded_agent_harness');
  const Base = require('../src/backend/agent_core/tools/base_tool');
  const Manager = require('../src/backend/agent_core/tools/tool_manager');
  const manager = new Manager(), executed = [];
  for (const name of ['list_workflows', 'search_schema', 'execute_sql_query']) {
    const tool = new Base({ name, description: name, parameters: { type: 'object', properties: { sql: { type: 'string' }, query: { type: 'string' } } } });
    tool.run = async args => name === 'list_workflows' ? { workflows: [] } : name === 'search_schema'
      ? (executed.push(args.query), { mode: 'data', dbSourceId: 'fixture', selectedTables: ['Records'], tables: [{ tableName: 'Records', columns: [{ name: args.query }] }] })
      : { sql: args.sql, rows: [{ Amount: 25 }] };
    manager.registerTool(tool);
  }
  const call = (name, args) => ({ tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const responses = [call('list_workflows', {}), ...['First', 'Second', 'Amount'].map(query => call('search_schema', { query })),
    call('execute_sql_query', { sql: 'SELECT SUM(Amount) AS Amount FROM Records' })];
  const result = await new Harness({ toolManager: manager, dispatch: async () => responses.shift() || { content: '25' } }).run({
    userMessage: 'total amount', provider: { id: 'fixture', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, dbSourceId: 'fixture', mode: 'data',
      requestPlan: { table: 'Records', intent: 'aggregate', schemaColumns: ['Amount'], outputs: { data: true }, schemaScope: { filters: [] },
        conversationState: { operation: 'aggregate', requestedAttributes: [] } } } });
  assert.deepEqual(executed, ['First', 'Second']);
  assert.ok(result.toolCalls.some(item => item.code === 'TOOL_NOT_IN_STAGE' && item.toolName === 'search_schema'));
  assert.ok(result.trace.executionProfile);
});

test('fan trap: two facts joined through a shared lookup cannot be aggregated', () => {
  const ref = (id, tableName) => ({ tableRefId: id, tableId: id, tableName, schemaName: 'dbo' });
  const edge = (id, from, to) => ({ relationshipId: id, fromTableRefId: from, toTableRefId: to, fromTableId: from, toTableId: to,
    cardinality: 'many-to-one', columnPairs: [{ sourceColumn: 'CustomerID', targetColumn: 'CustomerID' }] });
  const plan = { outcome: 'ready', tableRefs: [ref('d', 'T_CustomerDebt'), ref('c', 'M_Customer'), ref('o', 'T_ElectricityOutput'), ref('e', 'M_Employee')],
    edges: [edge('r1', 'd', 'c'), edge('r2', 'o', 'c'),
      { ...edge('r3', 'd', 'e'), columnPairs: [{ sourceColumn: 'EmployeeID', targetColumn: 'EmployeeID' }] }] };
  const valid = sql => validateSqlAgainstJoinPlan(sql, plan).valid;
  const trap = 'FROM T_CustomerDebt d JOIN M_Customer c ON d.CustomerID=c.CustomerID JOIN T_ElectricityOutput o ON o.CustomerID=c.CustomerID';
  assert.equal(valid(`SELECT SUM(d.ClosingBalance_Debit) AS T ${trap}`), false);
  assert.equal(valid(`SELECT SUM(o.FinalAmount) AS T ${trap}`), false);
  assert.equal(valid(`SELECT c.CustomerName, d.ClosingBalance_Debit ${trap}`), true);
  // Controls: a fact with its lookups, and a shared lookup used only in EXISTS.
  assert.equal(valid('SELECT c.CustomerName, SUM(d.ClosingBalance_Debit) AS T FROM T_CustomerDebt d JOIN M_Customer c ON d.CustomerID=c.CustomerID JOIN M_Employee e ON d.EmployeeID=e.EmployeeID GROUP BY c.CustomerName'), true);
  assert.equal(valid('SELECT SUM(d.ClosingBalance_Debit) AS T FROM T_CustomerDebt d JOIN M_Customer c ON d.CustomerID=c.CustomerID WHERE EXISTS (SELECT 1 FROM T_ElectricityOutput o WHERE o.CustomerID=c.CustomerID)'), true);
});

test('a period on a date column binds as a half-open range and accepts equivalent SQL only', () => {
  const tables = [{ tableName: 'T_ElectricityOutput', schemaName: 'dbo', columns: [{ name: 'ElectricityOutputDate', type: 'DATETIME' }, { name: 'DocDay', type: 'DATE' }] },
    { tableName: 'M_Customer', schemaName: 'dbo', columns: [{ name: 'CustomerCode', type: 'NVARCHAR' }] }];
  const question = 'Tiền điện trên hóa đơn của KA0021 trong 2024-02 là bao nhiêu?';
  const [customer, period] = bind([{ table: 'M_Customer', column: 'CustomerCode', value: 'KA0021', evidence: 'KA0021' },
    { table: 'T_ElectricityOutput', column: 'ElectricityOutputDate', value: '2024-02', evidence: '2024-02' }], tables, question);
  assert.deepEqual([period.from, period.to, period.dateOnly], ['2024-02-01', '2024-03-01', false]);
  const filters = [customer, period];
  const base = "SELECT SUM(o.FinalAmount) AS Total FROM T_ElectricityOutput o JOIN M_Customer c ON c.CustomerID = o.CustomerID WHERE c.CustomerCode = N'KA0021' AND ";
  const ok = where => matchesScope(base + where, filters);
  assert.equal(ok("o.ElectricityOutputDate >= '2024-02-01' AND o.ElectricityOutputDate < '2024-03-01'"), true);
  assert.equal(ok("o.ElectricityOutputDate < N'20240301' AND '2024-02-01' <= o.ElectricityOutputDate"), true);
  assert.equal(ok('YEAR(o.ElectricityOutputDate) = 2024 AND MONTH(o.ElectricityOutputDate) = 2'), true);
  assert.equal(ok("o.ElectricityOutputDate >= DATEFROMPARTS(2024,2,1) AND o.ElectricityOutputDate <= '2024-02-29 23:59:59'"), true);
  // Wider, narrower, or the end-of-month trap on DATETIME are rejected.
  assert.equal(ok("o.ElectricityOutputDate >= '2024-01-01' AND o.ElectricityOutputDate < '2024-03-01'"), false);
  assert.equal(ok("o.ElectricityOutputDate BETWEEN '2024-02-01' AND '2024-02-29'"), false);
  assert.equal(ok("o.ElectricityOutputDate >= '2024-02-01' AND o.ElectricityOutputDate < '2024-03-01' AND o.ElectricityOutputDate >= '2024-02-10'"), false);
  assert.equal(ok('YEAR(o.ElectricityOutputDate) = 2024'), false);
  assert.equal(matchesScope("SELECT SUM(o.FinalAmount) FROM T_ElectricityOutput o WHERE o.ElectricityOutputDate >= '2024-02-01' AND o.ElectricityOutputDate < '2024-03-01'", filters), false);
  // On a DATE column, BETWEEN the last day is exact.
  const [day] = bind([{ table: 'T_ElectricityOutput', column: 'DocDay', value: '02/2024', evidence: '02/2024' }], tables, 'trong 02/2024');
  assert.equal(matchesScope("SELECT 1 FROM T_ElectricityOutput o WHERE o.DocDay BETWEEN '2024-02-01' AND '2024-02-29'", [day]), true);
  assert.throws(() => bind([{ table: 'T_ElectricityOutput', column: 'ElectricityOutputDate', value: 'tháng này', evidence: 'tháng này' }], tables, 'tháng này'), /UNGROUNDED/);
});
