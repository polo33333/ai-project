const test = require('node:test');
const assert = require('node:assert/strict');
const BaseTool = require('../src/backend/agent_core/tools/base_tool');
const ToolManager = require('../src/backend/agent_core/tools/tool_manager');
const LocalModelHarness = require('../src/backend/agent_core/harness/local_model_harness');
const { buildRequestedLatestMonthsSql, buildEntityLookupSql, buildPlannedTablePreviewSql, buildModelIntentRecoverySql, isBusinessSqlCall, ensureDownloadLink, isInsufficientSqlAnswer } = LocalModelHarness;
const { formatDisplayDate } = require('../src/backend/agent_core/harness/grounded_reply');
const { isLocalProvider } = require('../src/backend/agent_core/harness/provider_classifier');
const { normalizeAssistantResponse } = require('../src/backend/agent_core/harness/tool_call_normalizer');
const { validateToolCall } = require('../src/backend/agent_core/harness/tool_argument_validator');
const { convertMessagesToOllama } = require('../src/backend/intelligent_core/adapters/ollama');
const { isListRequest, listAnswerMentionsRowValue } = require('../src/backend/agent_core/harness/local_model_harness');
const { compactToolResult } = require('../src/backend/agent_core/harness/local_result_compactor');
const { getRequestPolicy, validateCallAgainstPolicy, sanitizeFinalText } = require('../src/backend/agent_core/harness/local_execution_policy');
const { sanitizeProgressEvent } = require('../src/backend/agent_core/harness/progress_events');
const { buildEnrichedListSql, contextualLookupQuestion, extractNamedEntityValue } = require('../src/backend/services/sql_enrichment_builder');

class EchoTool extends BaseTool {
  constructor() {
    super({
      name: 'echo_value',
      description: 'Echo a value.',
      parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] }
    });
  }
  async run(args) { return { echoed: args.value }; }
}

test('plain export URLs are normalized into clickable download links', () => {
  const url = '/api/exports/Bao_cao_1788438553837.xlsx';
  assert.equal(
    ensureDownloadLink(`Tải file báo cáo tại: ${url}`, url),
    `Tải file báo cáo tại: [Tải file tại đây](${url})`
  );
  assert.equal(
    ensureDownloadLink(`[Tải xuống](${url})`, url),
    `[Tải xuống](${url})`
  );
});

class SqlTool extends BaseTool {
  constructor(rows = [{ OutputMonth: new Date('2024-01-01T00:00:00Z'), TotalQty: 10 }]) {
    super({ name: 'execute_sql_query', description: 'Query data.', parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } });
    this.rows = rows;
  }
  async run(args) { return { sql: args.sql, rows: this.rows, rowCount: this.rows.length }; }
}

test('entity lookup recovery follows a ready join plan and removes question suffix from the name', () => {
  const employee = {
    tableName: 'M_Employee',
    columns: [
      { columnName: 'EmployeeID', dataType: 'int', isPrimaryKey: true },
      { columnName: 'EmployeeName', dataType: 'nvarchar' },
      { columnName: 'GenderID', dataType: 'int' },
      { columnName: 'DepartmentID', dataType: 'int' }
    ]
  };
  const plan = {
    outcome: 'ready',
    tableRefs: [
      { tableId: 'employee', tableName: 'M_Employee', schemaName: 'dbo', alias: 't1' },
      { tableId: 'constant', tableName: 'M_Constant', schemaName: 'dbo', alias: 't2' },
      { tableId: 'master', tableName: 'M_Master', schemaName: 'dbo', alias: 't3' }
    ],
    edges: [{
      fromTableId: 'employee', targetTableId: 'constant', toTableId: 'constant', joinType: 'LEFT',
      businessRole: 'gi\u1edbi t\u00ednh', displayColumn: 'ConstantName',
      columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }]
    }, {
      fromTableId: 'employee', targetTableId: 'master', toTableId: 'master', joinType: 'LEFT',
      businessRole: 'Ph\u00f2ng ban', displayColumn: 'Name',
      columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'MasterID' }]
    }]
  };
  const sql = buildEntityLookupSql('gi\u1edbi t\u00ednh nv c\u00f3 t\u00ean duy l\u00e0 g\u00ec', { tables: [employee] }, plan);
  assert.match(sql, /FROM \[dbo\]\.\[M_Employee\] t1 LEFT JOIN \[dbo\]\.\[M_Constant\] t2/);
  assert.match(sql, /t1\.\[GenderID\] = t2\.\[ConstantID\]/);
  assert.doesNotMatch(sql, /DepartmentID/);
  assert.doesNotMatch(sql, /M_Master/);
  assert.match(sql, /LIKE N'%duy%'/);
  assert.doesNotMatch(sql, /duy là gì/);
});

test('entity lookup combines every relationship field explicitly requested in one query', () => {
  const employee = {
    tableName: 'M_Employee',
    columns: [
      { columnName: 'EmployeeID', dataType: 'int', isPrimaryKey: true },
      { columnName: 'EmployeeCode', dataType: 'nvarchar', displayName: 'Mã nhân viên' },
      { columnName: 'EmployeeName', dataType: 'nvarchar', displayName: 'Tên nhân viên' },
      { columnName: 'GenderID', dataType: 'int' },
      { columnName: 'DepartmentID', dataType: 'int' },
      { columnName: 'CompanyID', dataType: 'int' }
    ]
  };
  const plan = {
    outcome: 'ready', purpose: 'enrichment',
    tableRefs: [
      { tableId: 'employee', tableName: 'M_Employee', schemaName: 'dbo', alias: 't1' },
      { tableId: 'constant', tableName: 'M_Constant', schemaName: 'dbo', alias: 't2' },
      { tableId: 'master', tableName: 'M_Master', schemaName: 'dbo', alias: 't3' }
    ],
    edges: [{
      relationshipId: 'employee_gender', fromTableId: 'employee', toTableId: 'constant', joinType: 'LEFT',
      businessRole: 'Giới tính', displayColumn: 'ConstantName',
      columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }]
    }, {
      relationshipId: 'employee_department', fromTableId: 'employee', toTableId: 'master', joinType: 'LEFT',
      businessRole: 'Phòng ban', displayColumn: 'Name',
      columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'MasterID' }]
    }]
  };
  const sql = buildEntityLookupSql('giới tính và phòng ban nv có tên admin', { tables: [employee] }, plan);
  assert.match(sql, /JOIN \[dbo\]\.\[M_Constant\] t2/);
  assert.match(sql, /JOIN \[dbo\]\.\[M_Master\] t3/);
  assert.match(sql, /t2\.\[ConstantName\] AS \[Giới tính\]/);
  assert.match(sql, /t3\.\[Name\] AS \[Phòng ban\]/);
  assert.doesNotMatch(sql, /t1\.\[CompanyID\]/);
});

test('entity lookup recovery removes Vietnamese yes-no suffix from the name', () => {
  const employee = { tableName: 'M_Employee', columns: [
    { columnName: 'EmployeeID', dataType: 'int', isPrimaryKey: true },
    { columnName: 'EmployeeName', dataType: 'nvarchar' }
  ] };
  const sql = buildEntityLookupSql('có nv nào tên Duy ko', { tables: [employee] });
  assert.match(sql, /LIKE N'%Duy%'/);
  assert.doesNotMatch(sql, /Duy ko/);
});

test('attribute filters after an employee subject are not treated as an employee name', () => {
  const employee = { tableName: 'M_Employee', columns: [
    { columnName: 'EmployeeID', dataType: 'int', isPrimaryKey: true },
    { columnName: 'EmployeeName', dataType: 'nvarchar' }
  ] };
  assert.equal(extractNamedEntityValue('có nv nào giới tính nữ'), '');
  assert.equal(extractNamedEntityValue('có nhân viên nào phòng ban kế toán'), '');
  assert.equal(buildEntityLookupSql('có nv nào giới tính nữ', { tables: [employee] }), '');
});

test('detailed entity lookup selects every visible column while a yes-no lookup stays compact', () => {
  const employee = { tableName: 'M_Employee', columns: [
    { columnName: 'EmployeeID', dataType: 'int', isPrimaryKey: true },
    { columnName: 'EmployeeCode', dataType: 'nvarchar' },
    { columnName: 'EmployeeName', dataType: 'nvarchar', displayName: 'Tên nhân viên' },
    { columnName: 'DOB', dataType: 'datetime', displayName: 'Ngày sinh' },
    { columnName: 'InternalNote', dataType: 'nvarchar', isVisible: false }
  ] };
  const compact = buildEntityLookupSql('c\u00f3 nv n\u00e0o t\u00ean Duy ko', { tables: [employee] });
  const detailed = buildEntityLookupSql('th\u00f4ng tin chi ti\u1ebft nv t\u00ean Duy', { tables: [employee] });
  assert.doesNotMatch(compact, /\[DOB\]/);
  assert.match(detailed, /\[DOB\] AS \[Ngày sinh\]/);
  assert.match(detailed, /\[EmployeeName\] AS \[Tên nhân viên\]/);
  assert.doesNotMatch(detailed, /\[InternalNote\]/);
});

test('relationship recovery inherits the last explicit entity name for a pronoun follow-up', () => {
  const previous = 'có nv nào tên Duy?';
  assert.equal(extractNamedEntityValue(previous), 'Duy');
  assert.equal(contextualLookupQuestion('nv này có giới tính gì', [
    { role: 'user', content: previous },
    { role: 'assistant', content: 'Có một nhân viên phù hợp.' },
    { role: 'user', content: 'nv này có giới tính gì' }
  ]), 'nv này có giới tính gì tên Duy');
});

test('follow-up lookup inherits an employee written without the word name', () => {
  const previous = 'Giới tính và phòng ban của nhân viên admin';
  assert.equal(extractNamedEntityValue(previous), 'admin');
  assert.equal(extractNamedEntityValue('thông tin chi tiết nv trên'), '');
  assert.equal(contextualLookupQuestion('thông tin chi tiết nv trên', [
    { role: 'user', content: previous },
    { role: 'assistant', content: 'Nhân viên administrator có giới tính Nam.' },
    { role: 'user', content: 'thông tin chi tiết nv trên' }
  ]), 'thông tin chi tiết nv trên tên admin');
});

test('limited list recovery preserves TOP and enriches every planned lookup', () => {
  const plan = { intent: 'list', table: 'M_Employee', rowLimit: 5, question: 'có nv nào có giới tính nữ ko', schemaColumns: ['EmployeeID', 'EmployeeCode', 'EmployeeName', 'DOB', 'GenderID', 'DepartmentID'] };
  const joinPlan = {
    outcome: 'ready', purpose: 'enrichment',
    tableRefs: [
      { tableRefId: 'employee#1', tableId: 'employee', tableName: 'M_Employee', schemaName: 'dbo', alias: 't1' },
      { tableRefId: 'constant#2', tableId: 'constant', tableName: 'M_Constant', schemaName: 'dbo', alias: 't2' }
    ],
    edges: [{ fromTableId: 'employee', toTableId: 'constant', fromTableRefId: 'employee#1', toTableRefId: 'constant#2',
      joinType: 'LEFT', businessRole: 'Giới tính', displayColumn: 'ConstantName', columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }] }]
  };
  const sql = buildPlannedTablePreviewSql(plan, joinPlan);
  assert.match(sql, /^SELECT TOP 5 t1\.\[EmployeeCode\], t1\.\[EmployeeName\], t2\.\[ConstantName\] AS \[Giới tính\], t1\.\[DOB\], t1\.\[EmployeeID\], t1\.\[DepartmentID\]/);
  assert.doesNotMatch(sql.split(/\s+FROM\s+/i)[0], /t1\.\[GenderID\]/);
  assert.match(sql, /LEFT JOIN \[dbo\]\.\[M_Constant\] t2 ON t1\.\[GenderID\] = t2\.\[ConstantID\]/);
  assert.match(sql, /WHERE t2\.\[ConstantName\] LIKE N'%nữ%'/);
});

test('gender list filter works without the optional word có after nào', () => {
  const plan = { intent: 'list', table: 'M_Employee', rowLimit: 100, question: 'có nv nào giới tính nữ',
    schemaColumns: ['EmployeeID', 'EmployeeCode', 'EmployeeName', 'GenderID'] };
  const joinPlan = { outcome: 'ready', purpose: 'enrichment', tableRefs: [
    { tableRefId: 'employee#1', tableId: 'employee', tableName: 'M_Employee', schemaName: 'dbo', alias: 't1' },
    { tableRefId: 'constant#2', tableId: 'constant', tableName: 'M_Constant', schemaName: 'dbo', alias: 't2' }
  ], edges: [{ relationshipId: 'gender', fromTableId: 'employee', toTableId: 'constant',
    fromTableRefId: 'employee#1', toTableRefId: 'constant#2', joinType: 'LEFT', businessRole: 'Giới tính',
    displayColumn: 'ConstantName', columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }] }] };
  const sql = buildPlannedTablePreviewSql(plan, joinPlan);
  assert.doesNotMatch(sql, /EmployeeName\] LIKE/);
  assert.match(sql, /t2\.\[ConstantName\] LIKE N'%nữ%'/);
});

test('enrichment recovery filters a plural follow-up by verified dataset keys', () => {
  const plan = { intent: 'record_lookup', table: 'M_Employee', question: '2 nhân viên này thuộc phòng ban gì',
    schemaColumns: ['EmployeeID', 'EmployeeCode', 'EmployeeName', 'DepartmentID'],
    datasetReference: { type: 'lastDataset', data: { table: 'M_Employee', entityKeys: [
      { EmployeeID: 5, EmployeeCode: 'NV005' }, { EmployeeID: 6, EmployeeCode: 'NV006' }
    ] } } };
  const joinPlan = { outcome: 'ready', purpose: 'enrichment', tableRefs: [
    { tableRefId: 'employee#1', tableId: 'employee', tableName: 'M_Employee', schemaName: 'dbo', alias: 't1' },
    { tableRefId: 'master#2', tableId: 'master', tableName: 'M_Master', schemaName: 'dbo', alias: 't2' }
  ], edges: [{ relationshipId: 'department', fromTableId: 'employee', toTableId: 'master',
    fromTableRefId: 'employee#1', toTableRefId: 'master#2', joinType: 'LEFT', businessRole: 'Phòng ban',
    displayColumn: 'Name', columnPairs: [{ sourceColumn: 'DepartmentID', targetColumn: 'MasterID' }] }] };
  const sql = buildEnrichedListSql(plan, joinPlan);
  assert.match(sql, /t2\.\[Name\] AS \[Phòng ban\]/);
  assert.match(sql, /\(t1\.\[EmployeeID\] = 5 AND t1\.\[EmployeeCode\] = N'NV005'\) OR \(t1\.\[EmployeeID\] = 6 AND t1\.\[EmployeeCode\] = N'NV006'\)/);
  assert.doesNotMatch(sql.split(/\s+FROM\s+/i)[0], /DepartmentID/);
});

test('list recovery aliases physical columns with configured result headers', () => {
  const sql = buildPlannedTablePreviewSql({ intent: 'list', table: 'T_Contract', rowLimit: 5,
    schemaColumns: ['ContractID', 'ContractNo'], columnDisplayNames: { ContractNo: 'Số HĐ' } });
  assert.equal(sql, 'SELECT TOP 5 [ContractID], [ContractNo] AS [Số HĐ] FROM [T_Contract]');
});

class ChartTool extends BaseTool {
  constructor() { super({ name: 'render_chart', description: 'Render chart.', parameters: { type: 'object', properties: { type: { type: 'string' }, labels: { type: 'array' }, datasets: { type: 'array' } }, required: ['type', 'labels', 'datasets'] } }); }
  async run(args) { return { chartSpec: args }; }
}

class ExportTool extends BaseTool {
  constructor() { super({ name: 'export_data', description: 'Export rows.', parameters: { type: 'object', properties: { data: { type: 'array' }, format: { type: 'string' }, filename: { type: 'string' } }, required: ['data', 'format'] } }); }
  async run(args) { return { downloadUrl: `/api/exports/${args.filename}.xlsx` }; }
}

function manager() {
  const result = new ToolManager();
  result.registerTool(new EchoTool());
  return result;
}

const localProvider = {
  id: 'test-local', name: 'Test local', type: 'local', apiFormat: 'ollama',
  baseUrl: 'http://127.0.0.1:11434', model: 'test', supportsToolCalling: true
};

test('provider classifier honors explicit class before URL heuristics', () => {
  assert.equal(isLocalProvider({ executionClass: 'local', baseUrl: 'https://example.com' }), true);
  assert.equal(isLocalProvider({ executionClass: 'remote', baseUrl: 'http://localhost:11434' }), false);
  assert.equal(isLocalProvider(localProvider), true);
});

test('progress events expose safe summaries without arbitrary payload fields', () => {
  const event = sanitizeProgressEvent({
    type: 'tool_completed', label: 'Truy vấn xong', status: 'done', toolName: 'execute_sql_query', rowCount: 5,
    sql: 'SELECT secret', rawReasoning: 'private reasoning', apiKey: 'secret'
  });
  assert.equal(event.toolName, 'execute_sql_query');
  assert.equal(event.rowCount, 5);
  assert.equal(event.sql, undefined);
  assert.equal(event.rawReasoning, undefined);
  assert.equal(event.apiKey, undefined);
});

test('normalizer accepts native calls and fenced JSON fallback', () => {
  const native = normalizeAssistantResponse({ tool_calls: [{ function: { name: 'echo_value', arguments: '{"value":"a"}' } }] });
  assert.equal(native.calls[0].name, 'echo_value');
  assert.deepEqual(native.calls[0].arguments, { value: 'a' });

  const fallback = normalizeAssistantResponse({ content: '```json\n{"tool":"echo_value","arguments":{"value":"b"}}\n```' });
  assert.equal(fallback.kind, 'tool_call');
  assert.deepEqual(fallback.calls[0].arguments, { value: 'b' });
  assert.equal(fallback.calls[0].source, 'content_json');
});

test('Ollama adapter keeps tool arguments as objects in multi-turn history', () => {
  const converted = convertMessagesToOllama([
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'echo_value', arguments: '{"value":"hello"}' } }] },
    { role: 'tool', tool_call_id: 'call-1', name: 'echo_value', content: '{"success":true}' }
  ]);
  assert.deepEqual(converted[0].tool_calls[0].function.arguments, { value: 'hello' });
  assert.equal(converted[1].tool_name, 'echo_value');
  assert.equal(converted[1].tool_call_id, undefined);
});

test('tool-result compactor serializes Date values as ISO strings', () => {
  const compacted = JSON.parse(compactToolResult({ success: true, result: { rows: [{ date: new Date('2024-02-01T00:00:00Z') }] } }));
  assert.equal(compacted.result.rows[0].date, '2024-02-01T00:00:00.000Z');
});

test('SQL result display formats ISO dates without changing ordinary values', () => {
  assert.equal(formatDisplayDate('2002-05-24T00:00:00.000Z'), '24/05/2002');
  assert.equal(formatDisplayDate('2026-09-20'), '20/09/2026');
  assert.equal(formatDisplayDate('2026-09-20T14:30:45.000Z'), '20/09/2026 14:30:45');
  assert.equal(formatDisplayDate('NV005'), 'NV005');
});

test('temporal chart policy rejects TOP raw rows and placeholder images', () => {
  const policy = getRequestPolicy('vẽ biểu đồ sản lượng trong 5 tháng gần nhất');
  assert.equal(policy.chartRequired, true);
  assert.equal(policy.temporalMonths, 5);
  assert.equal(policy.dataRequired, true);
  const rejected = validateCallAgainstPolicy(
    { name: 'execute_sql_query' },
    { sql: 'SELECT TOP 5 ElectricityOutputDate, TotalQty FROM T_ElectricityOutput ORDER BY ElectricityOutputDate DESC' },
    policy,
    []
  );
  assert.equal(rejected.valid, false);
  assert.equal(rejected.category, 'TEMPORAL_SQL_POLICY');
  assert.equal(sanitizeFinalText('![chart](https://example.com/chart-placeholder.png)', false), '');
});

test('local policy detects a required downloadable file', () => {
  const policy = getRequestPolicy('vẽ biểu đồ 7 tháng gần nhất và gửi file Excel');
  assert.equal(policy.chartRequired, true);
  assert.equal(policy.exportRequired, true);
});

test('local policy treats a detailed employee lookup as a data request', () => {
  assert.equal(getRequestPolicy('thông tin chi tiết nv tên Duy').dataRequired, true);
});

test('local harness accepts a web-grounded price answer without demanding SQL', async () => {
  let dispatchCount = 0;
  const harness = new LocalModelHarness({
    toolManager: manager(),
    dispatch: async () => {
      dispatchCount += 1;
      return { content: 'RTX 5070 hiện có giá khoảng 15 triệu đồng.', tool_calls: null };
    }
  });

  const result = await harness.run({
    userMessage: 'giá card 5070 hiện tại là bao nhiêu',
    provider: localProvider,
    enabledToolNames: [],
    context: { webSearch: true }
  });

  assert.equal(dispatchCount, 1);
  assert.match(result.replyText, /15 triệu/);
  assert.equal(result.trace.training.responseEvaluation.valid, true);
});

test('local harness builds the requested business query from explicit table, metric and month count', () => {
  const sql = buildRequestedLatestMonthsSql('vẽ biểu đồ T_ElectricityOutput theo cột TotalQty trong 7 tháng gần nhất', 7);
  assert.match(sql, /TOP 7/i);
  assert.match(sql, /FROM \[T_ElectricityOutput\]/i);
  assert.match(sql, /SUM\(\[TotalQty\]\)/i);
  assert.match(sql, /FORMAT\(\[ElectricityOutputDate\]/i);
});

test('local harness builds a monthly query from the retrieved table when the table name is omitted', () => {
  const sql = buildRequestedLatestMonthsSql(
    'vẽ biểu đồ sản lượng điện theo cột TotalQty trong 7 tháng gần nhất theo ngày ElectricityOutputDate',
    7,
    ['T_ElectricityOutput', 'T_ElectricityInput']
  );
  assert.match(sql, /FROM \[T_ElectricityOutput\]/i);
  assert.match(sql, /SUM\(\[TotalQty\]\)/i);
  assert.match(sql, /FORMAT\(\[ElectricityOutputDate\]/i);
});

test('business SQL must contain every explicitly requested column', () => {
  const call = {
    success: true,
    args: { sql: "SELECT FORMAT(ElectricityOutputDate, 'yyyy-MM') Period, SUM(PowerMoney) Total FROM T_ElectricityOutput GROUP BY FORMAT(ElectricityOutputDate, 'yyyy-MM')" },
    result: { rows: [{ Period: '2024-01', Total: 0 }] }
  };
  const refs = {
    tables: [{ tableName: 'T_ElectricityOutput' }],
    columns: [{ columnName: 'ElectricityOutputDate' }, { columnName: 'TotalQty' }]
  };
  assert.equal(isBusinessSqlCall(call, refs), false);
});

test('local harness never treats schema metadata rows as business data', () => {
  const call = {
    success: true,
    args: { sql: 'SELECT TABLE_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS' },
    result: { rows: [{ TABLE_NAME: 'T_ElectricityOutput', COLUMN_NAME: 'TotalQty' }] }
  };
  assert.equal(isBusinessSqlCall(call, {}), false);
});

test('local harness retries an answer that ignores a selected knowledge source', async () => {
  const responses = [
    { content: 'Tôi không có thông tin cụ thể. Bạn muốn tải app nào?' },
    { content: 'Bạn có thể tải IPMS trên Google Play tại https://play.google.com/store/apps/details?id=com.tpsoft.ipms [1].' }
  ];
  const harness = new LocalModelHarness({ toolManager: manager(), dispatch: async () => responses.shift(), maxIterations: 3 });
  const result = await harness.run({
    userMessage: 'có cách tải app nào', provider: localProvider,
    messages: [{ role: 'user', content: 'có cách tải app nào' }], enabledToolNames: [],
    context: {
      knowledgeGrounding: {
        required: true,
        sourceTitles: ['HDSD IPMS'],
        documentContext: '[Tài liệu 1: HDSD IPMS · đoạn 1]\nTải IPMS trên Google Play: https://play.google.com/store/apps/details?id=com.tpsoft.ipms'
      }
    }
  });
  assert.match(result.replyText, /com\.tpsoft\.ipms/);
  assert.equal(result.trace.steps.some(step => step.type === 'UNGROUNDED_KNOWLEDGE_RESPONSE'), true);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});

test('validator rejects unknown fields and missing required values', () => {
  const toolManager = manager();
  const valid = validateToolCall(toolManager, { name: 'echo_value', arguments: { value: 'ok', invented: true } }, ['echo_value']);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.args, { value: 'ok' });
  const invalid = validateToolCall(toolManager, { name: 'echo_value', arguments: {} }, ['echo_value']);
  assert.equal(invalid.valid, false);
  assert.equal(invalid.category, 'INVALID_ARGUMENTS');
});

test('local harness executes content JSON tool call then returns final answer', async () => {
  const responses = [
    { content: '{"tool":"echo_value","arguments":{"value":"hello"}}' },
    { content: 'Kết quả là hello.' }
  ];
  const harness = new LocalModelHarness({ toolManager: manager(), dispatch: async () => responses.shift(), maxIterations: 3 });
  const result = await harness.run({
    provider: localProvider,
    messages: [{ role: 'system', content: 'Be concise.' }, { role: 'user', content: 'Echo hello' }],
    enabledToolNames: ['echo_value']
  });
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].success, true);
  assert.equal(result.replyText, 'Kết quả là hello.');
  assert.equal(result.trace.harness, 'local');
});

test('local harness emits realtime model and tool progress events', async () => {
  const responses = [
    { content: '', tool_calls: [{ function: { name: 'echo_value', arguments: { value: 'hello' } } }] },
    { content: 'Xong.' }
  ];
  const events = [];
  const harness = new LocalModelHarness({ toolManager: manager(), dispatch: async () => responses.shift(), maxIterations: 3 });
  const result = await harness.run({
    provider: localProvider, messages: [{ role: 'user', content: 'Echo hello' }], enabledToolNames: ['echo_value'],
    onProgress: event => events.push(event)
  });
  assert.equal(result.replyText, 'Xong.');
  assert.equal(events.some(event => event.type === 'model_started'), true);
  assert.equal(events.some(event => event.type === 'tool_started' && event.toolName === 'echo_value'), true);
  assert.equal(events.some(event => event.type === 'tool_completed' && event.status === 'done'), true);
  assert.equal(events.at(-1).type, 'request_completed');
});

test('local harness returns a deterministic answer when synthesis fails after a successful tool', async () => {
  let calls = 0;
  const harness = new LocalModelHarness({
    toolManager: manager(), maxIterations: 3,
    dispatch: async () => {
      calls += 1;
      if (calls === 1) return { content: '', tool_calls: [{ function: { name: 'echo_value', arguments: { value: 'hello' } } }] };
      throw new Error('strict Ollama rejected follow-up');
    }
  });
  const result = await harness.run({ provider: localProvider, messages: [{ role: 'user', content: 'Echo hello' }], enabledToolNames: ['echo_value'] });
  assert.equal(result.toolCalls[0].success, true);
  assert.equal(result.replyText, 'Đã thực thi công cụ **echo_value** thành công.');
  assert.equal(result.trace.steps.some(step => step.type === 'DETERMINISTIC_TOOL_FALLBACK'), true);
});

test('local harness does not accept a final chart answer before render_chart succeeds', async () => {
  const toolManager = new ToolManager();
  toolManager.registerTools([new SqlTool(), new ChartTool()]);
  const responses = [
    { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: 'SELECT YEAR(d) y, MONTH(d) m, SUM(q) total FROM t GROUP BY YEAR(d), MONTH(d)' } } }] },
    { content: '![fake](https://example.com/chart-placeholder.png)' },
    { content: '', tool_calls: [{ function: { name: 'render_chart', arguments: { type: 'line', labels: ['2024-01'], datasets: [{ label: 'Total', data: [10] }] } } }] },
    { content: 'Đã tạo biểu đồ sản lượng.' }
  ];
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => responses.shift(), maxIterations: 5 });
  const result = await harness.run({
    userMessage: 'vẽ biểu đồ sản lượng trong 5 tháng gần nhất', provider: localProvider,
    messages: [{ role: 'user', content: 'vẽ biểu đồ sản lượng trong 5 tháng gần nhất' }],
    enabledToolNames: ['execute_sql_query', 'render_chart'], context: { permissions: ['*'] }
  });
  assert.equal(result.toolCalls.some(call => call.toolName === 'render_chart' && call.success), true);
  assert.equal(result.replyText, 'Đã tạo biểu đồ sản lượng.');
  assert.equal(result.trace.steps.some(step => step.type === 'INCOMPLETE_CHART_RESPONSE'), true);
});

test('local harness rejects SQL for a lower-ranked unrelated table before execution', async () => {
  const toolManager = new ToolManager();
  toolManager.registerTool(new SqlTool([{ ContractID: 1, ContractNo: 'HD001' }]));
  const responses = [
    { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: 'SELECT TOP 10 * FROM T_GarbageOutput' } } }] },
    { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: 'SELECT TOP 10 ContractID, ContractNo FROM T_Contract' } } }] },
    { content: 'Hợp đồng **HD001**.' }
  ];
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => responses.shift(), maxIterations: 3 });
  const result = await harness.run({
    userMessage: 'chi tiết các hợp đồng', provider: localProvider,
    messages: [{ role: 'user', content: 'chi tiết các hợp đồng' }],
    enabledToolNames: ['execute_sql_query'],
    context: {
      selectedTables: ['T_Contract', 'T_GarbageOutput'],
      requestPlan: { intent: 'record_lookup', table: 'T_Contract', requiredColumns: [], outputs: { data: true, chart: false, export: false } }
    }
  });
  assert.equal(result.toolCalls.length, 1);
  assert.match(result.toolCalls[0].args.sql, /T_Contract/i);
  assert.equal(result.trace.steps.some(step => step.type === 'WRONG_TABLE'), true);
  assert.match(result.replyText, /HD001/);
});

test('local harness executes printed SQL instead of returning SQL-only prose', async () => {
  const toolManager = new ToolManager();
  toolManager.registerTool(new SqlTool());
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => ({ content: '```sql\nSELECT TOP 5 * FROM M_Employee\n```' }), maxIterations: 1 });
  const result = await harness.run({
    userMessage: 'ds 5 nhân viên', provider: localProvider,
    messages: [{ role: 'user', content: 'ds 5 nhân viên' }], enabledToolNames: ['execute_sql_query']
  });
  assert.equal(result.toolCalls.some(call => call.toolName === 'execute_sql_query' && call.success), true);
  assert.match(result.replyText, /1.*dòng/);
  assert.equal(result.trace.steps.some(step => step.type === 'EXECUTED_PRINTED_SQL'), true);
});

test('local harness rejects wrong-table SQL without replacing the request with sample rows', async () => {
  let executions = 0;
  const toolManager = new ToolManager();
  const sqlTool = new SqlTool();
  const originalRun = sqlTool.run.bind(sqlTool);
  sqlTool.run = async args => { executions += 1; return originalRun(args); };
  toolManager.registerTool(sqlTool);
  const harness = new LocalModelHarness({
    toolManager,
    dispatch: async () => ({ content: '```sql\nSELECT TOP 10 * FROM T_GarbageOutput\n```' }),
    maxIterations: 1
  });
  const result = await harness.run({
    userMessage: 'bảng hợp đồng hiện tại có dữ liệu gì', provider: localProvider,
    messages: [{ role: 'user', content: 'bảng hợp đồng hiện tại có dữ liệu gì' }],
    enabledToolNames: ['execute_sql_query'],
    context: {
      selectedTables: ['T_Contract', 'T_GarbageOutput'],
      requestPlan: { intent: 'record_lookup', table: 'T_Contract', requiredColumns: [], outputs: { data: true, chart: false, export: false } }
    }
  });
  assert.equal(executions, 0);
  assert.equal(result.trace.steps.some(step => step.type === 'DETERMINISTIC_SQL_REJECTED'), true);
  assert.equal(result.trace.steps.some(step => step.type === 'PLANNED_TABLE_RECOVERY'), false);
  assert.equal(result.trace.completionStatus, 'PARTIAL');
  assert.match(result.replyText, /Chưa thể xác minh/);
});

test('empty calendar query does not trigger available-month recovery', async () => {
  let executions = 0;
  const toolManager = new ToolManager();
  const sqlTool = new SqlTool();
  sqlTool.run = async args => { executions++; return { sql: args.sql, rows: [], rowCount: 0 }; };
  toolManager.registerTool(sqlTool);
  const responses = [
    { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: "SELECT FORMAT(PaymentDate, 'yyyy-MM') Period, SUM(TotalQty) TotalQty FROM T_ElectricityOutput WHERE PaymentDate >= DATEADD(MONTH,-7,GETDATE()) GROUP BY FORMAT(PaymentDate, 'yyyy-MM')" } } }] },
    { content: 'Không có dữ liệu trong khoảng thời gian yêu cầu.' }
  ];
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => responses.shift(), maxIterations: 2 });
  const question = 'sản lượng 7 tháng tính đến hôm nay';
  const result = await harness.run({ userMessage: question, provider: localProvider, messages: [{ role: 'user', content: question }], enabledToolNames: ['execute_sql_query'] });
  assert.equal(executions, 1);
  assert.equal(result.trace.steps.some(step => step.type === 'LATEST_DATA_MONTHS_RECOVERY'), false);
});

test('local harness executes printed SQL for a detailed employee lookup', async () => {
  const toolManager = new ToolManager();
  toolManager.registerTool(new SqlTool());
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => ({ content: "SELECT EmployeeName FROM M_Employee WHERE EmployeeName LIKE '%Duy%'" }), maxIterations: 1 });
  const result = await harness.run({
    userMessage: 'thông tin chi tiết nv tên Duy', provider: localProvider,
    messages: [{ role: 'user', content: 'thông tin chi tiết nv tên Duy' }], enabledToolNames: ['execute_sql_query']
  });
  assert.equal(result.toolCalls.some(call => call.toolName === 'execute_sql_query' && call.success), true);
  assert.doesNotMatch(result.replyText, /^\s*(?:SELECT|WITH)\b/i);
});

test('local harness asks the model to synthesize SQL rows after an empty tool follow-up', async () => {
  const toolManager = new ToolManager();
  toolManager.registerTool(new SqlTool([{ EmployeeName: 'Yên Duy' }]));
  const responses = [
    { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: 'SELECT TOP 5 EmployeeName FROM M_Employee' } } }] },
    { content: '' },
    { content: 'Nhân viên tìm thấy: **Yên Duy**.' }
  ];
  const dispatchMessages = [];
  const harness = new LocalModelHarness({ toolManager, dispatch: async (_provider, messages) => { dispatchMessages.push(messages); return responses.shift(); }, maxIterations: 3 });
  const result = await harness.run({
    userMessage: 'ds 5 nv', provider: localProvider,
    messages: [
      { role: 'user', content: 'thông tin nhân viên Yên Duy' },
      { role: 'assistant', content: 'Yên Duy là nhân viên NV004.' },
      { role: 'user', content: 'ds 5 nv' }
    ], enabledToolNames: ['execute_sql_query']
  });

  assert.equal(result.replyText, 'Nhân viên tìm thấy: **Yên Duy**.');
  assert.equal(result.trace.steps.some(step => step.type === 'EMPTY_MODEL_RESPONSE'), true);
  assert.equal(dispatchMessages.length, 3);
  assert.doesNotMatch(JSON.stringify(dispatchMessages[2]), /NV004/);
});

test('automatic export preserves a valid current answer instead of re-synthesizing from old history', async () => {
  const toolManager = new ToolManager();
  toolManager.registerTools([new SqlTool(), new ExportTool()]);
  const responses = [
    { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: 'SELECT TotalQty FROM T_ElectricityOutput' } } }] },
    { content: 'Sản lượng điện hiện tại là **10**.' }
  ];
  let dispatchCount = 0;
  const harness = new LocalModelHarness({
    toolManager,
    dispatch: async () => {
      dispatchCount += 1;
      if (!responses.length) throw new Error('unexpected extra synthesis');
      return responses.shift();
    },
    maxIterations: 3
  });
  const result = await harness.run({
    userMessage: 'thống kê sản lượng điện và gửi file', provider: localProvider,
    messages: [
      { role: 'user', content: 'thông tin nhân viên Yên Duy' },
      { role: 'assistant', content: 'Yên Duy là nhân viên NV004.' },
      { role: 'user', content: 'thống kê sản lượng điện và gửi file' }
    ],
    enabledToolNames: ['execute_sql_query', 'export_data']
  });

  assert.match(result.replyText, /Sản lượng điện hiện tại/);
  assert.doesNotMatch(result.replyText, /Yên Duy|NV004/);
  assert.match(result.replyText, /\/api\/exports\//);
  assert.equal(dispatchCount, 2);
});

test('local harness formats SQL rows when the synthesis response is still empty', async () => {
  const toolManager = new ToolManager();
  toolManager.registerTool(new SqlTool());
  const responses = [
    { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: "SELECT EmployeeName, TotalQty FROM M_Employee WHERE EmployeeName LIKE '%Duy%'" } } }] },
    { content: '' },
    { content: '' }
  ];
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => responses.shift(), maxIterations: 3 });
  const result = await harness.run({
    userMessage: 'thông tin chi tiết nv Duy', provider: localProvider,
    messages: [{ role: 'user', content: 'thông tin chi tiết nv Duy' }], enabledToolNames: ['execute_sql_query']
  });

  assert.match(result.replyText, /OutputMonth/);
  assert.match(result.replyText, /TotalQty/);
  assert.equal(result.trace.steps.some(step => step.type === 'DETERMINISTIC_SQL_ROWS_FALLBACK'), true);
});

test('local harness queries a named record before dispatching to the model', async () => {
  const toolManager = new ToolManager();
  toolManager.registerTool(new SqlTool());
  const responses = [
    { content: 'M_Employee has 67 columns. Would you like me to query a specific employee?' },
    { content: 'I still only have the schema metadata.' }
  ];
  let modelCalls = 0;
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => { modelCalls++; return responses.shift(); }, maxIterations: 2 });
  const result = await harness.run({
    userMessage: 'th\u00f4ng tin chi ti\u1ebft nv t\u00ean Y\u00ean Duy', provider: localProvider,
    messages: [{ role: 'user', content: 'th\u00f4ng tin chi ti\u1ebft nv t\u00ean Y\u00ean Duy' }],
    enabledToolNames: ['execute_sql_query'], context: {
      selectedTables: ['M_Employee'],
      requestPlan: { intent: 'record_lookup', table: 'M_Employee', requiredColumns: [], outputs: { data: true, chart: false, export: false } }
    }
  });

  const sqlCall = result.toolCalls.find(call => call.toolName === 'execute_sql_query' && call.success);
  assert.ok(sqlCall);
  assert.match(sqlCall.args.sql, /FROM \[M_Employee\]/i);
  assert.match(sqlCall.args.sql, /\[EmployeeName\]\s+LIKE\s+N'%Y\u00ean Duy%'/i);
  assert.equal(modelCalls, 0);
  assert.equal(result.trace.steps.some(step => step.type === 'DETERMINISTIC_ENTITY_LOOKUP' && step.success), true);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});

test('local harness repairs an invalid SQL column from an explicit user column', async () => {
  class RepairableSqlTool extends SqlTool {
    async run(args) {
      if (/SUM\s*\(\s*ElectricityOutput\s*\)/i.test(args.sql)) throw new Error("Invalid column name 'ElectricityOutput'.");
      return { sql: args.sql, rows: [{ Period: '2024-07', TotalQty: 20 }], rowCount: 1 };
    }
  }
  const toolManager = new ToolManager();
  toolManager.registerTool(new RepairableSqlTool());
  const responses = [
    { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: "SELECT FORMAT(ElectricityOutputDate, 'yyyy-MM') Period, SUM(ElectricityOutput) TotalQty FROM T_ElectricityOutput GROUP BY FORMAT(ElectricityOutputDate, 'yyyy-MM')" } } }] },
    { content: 'Không thể truy vấn dữ liệu.' }
  ];
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => responses.shift(), maxIterations: 2 });
  const result = await harness.run({
    userMessage: 'thông tin chi tiết sản lượng theo cột TotalQty', provider: localProvider,
    messages: [{ role: 'user', content: 'thông tin chi tiết sản lượng theo cột TotalQty' }], enabledToolNames: ['execute_sql_query']
  });
  assert.equal(result.trace.steps.some(step => step.type === 'INVALID_COLUMN_RECOVERY' && step.success), true);
  assert.match(result.toolCalls.at(-1).args.sql, /SUM\s*\(\s*TotalQty\s*\)/i);
});

test('local harness recovers latest database months then creates chart and export', async () => {
  class TemporalSqlTool extends SqlTool {
    async run(args) {
      if (/WHERE\s+PaymentDate\s+IS\s+NOT\s+NULL/i.test(args.sql)) {
        return { sql: args.sql, rows: [{ Period: '2024-07', TotalQty: 20 }, { Period: '2024-06', TotalQty: 10 }], rowCount: 2 };
      }
      return { sql: args.sql, rows: [], rowCount: 0 };
    }
  }
  const toolManager = new ToolManager();
  toolManager.registerTools([new TemporalSqlTool(), new ChartTool(), new ExportTool()]);
  const responses = [
    { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: "SELECT FORMAT(PaymentDate, 'yyyy-MM') Period, SUM(TotalQty) TotalQty FROM T_ElectricityOutput WHERE PaymentDate >= DATEADD(MONTH,-7,GETDATE()) GROUP BY FORMAT(PaymentDate, 'yyyy-MM')" } } }] },
    { content: 'Không có dữ liệu.' }
  ];
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => responses.shift(), maxIterations: 2 });
  const result = await harness.run({
    userMessage: 'vẽ biểu đồ sản lượng 7 tháng gần nhất có dữ liệu và gửi file Excel', provider: localProvider,
    messages: [{ role: 'user', content: 'vẽ biểu đồ sản lượng 7 tháng gần nhất và gửi file Excel' }],
    enabledToolNames: ['execute_sql_query', 'render_chart', 'export_data']
  });
  assert.equal(result.trace.steps.some(step => step.type === 'LATEST_DATA_MONTHS_RECOVERY' && step.success), true);
  assert.equal(result.toolCalls.some(call => call.toolName === 'render_chart' && call.success), true);
  assert.equal(result.toolCalls.some(call => call.toolName === 'export_data' && call.success), true);
  assert.match(result.replyText, /\/api\/exports\//);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});

test('retrieved table fallback automatically renders and exports when the model only discusses schema', async () => {
  class RetrievedTableSqlTool extends SqlTool {
    async run(args) {
      return {
        sql: args.sql,
        rows: [{ Period: '2024-02', TotalQty: 20 }, { Period: '2024-01', TotalQty: 10 }],
        rowCount: 2
      };
    }
  }
  const toolManager = new ToolManager();
  toolManager.registerTools([new RetrievedTableSqlTool(), new ChartTool(), new ExportTool()]);
  const responses = [{ content: 'Tôi chỉ tìm thấy schema.' }, { content: 'Chưa có dữ liệu.' }];
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => responses.shift(), maxIterations: 2 });
  const question = 'vẽ biểu đồ sản lượng điện theo cột TotalQty trong 7 tháng gần nhất có dữ liệu theo ngày ElectricityOutputDate và gửi file';
  const result = await harness.run({
    userMessage: question,
    provider: localProvider,
    messages: [{ role: 'user', content: question }],
    enabledToolNames: ['execute_sql_query', 'render_chart', 'export_data'],
    context: { selectedTables: ['T_ElectricityOutput', 'T_ElectricityInput'] }
  });

  assert.equal(result.toolCalls.some(call => call.toolName === 'render_chart' && call.success), true);
  assert.equal(result.toolCalls.some(call => call.toolName === 'export_data' && call.success), true);
  assert.match(result.toolCalls.find(call => call.toolName === 'execute_sql_query' && call.success).args.sql, /SUM\(\[TotalQty\]\)/i);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});

test('invalid projected column is repaired before reaching SQL execution', async () => {
  const executed = [];
  const toolManager = new ToolManager();
  const sqlTool = new SqlTool();
  sqlTool.run = async args => { executed.push(args.sql); return { sql: args.sql, rows: [{ CustomerName: 'Test customer' }], rowCount: 1 }; };
  toolManager.registerTool(sqlTool);
  let calls = 0;
  const harness = new LocalModelHarness({ toolManager, maxIterations: 3, dispatch: async () => {
    calls++;
    if (calls <= 2) return { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: `SELECT ${calls === 1 ? 'CompanyName' : 'CustomerName'} FROM M_Customer` } } }] };
    return { content: 'Danh sách khách hàng: Test customer.' };
  } });
  const result = await harness.run({ userMessage: 'ds khách hàng', provider: localProvider,
    messages: [{ role: 'user', content: 'ds khách hàng' }], enabledToolNames: ['execute_sql_query'],
    context: { requestPlan: { table: 'M_Customer', schemaColumns: ['CustomerName'], unfilteredList: true, requiredColumns: [], outputs: { data: true } } } });
  assert.deepEqual(executed, ['SELECT CustomerName FROM M_Customer']);
  assert.ok(result.trace.steps.some(step => step.type === 'UNKNOWN_COLUMN:CompanyName'));
});

test('unfiltered customer list recovers from repeated invalid model SQL using schema columns', async () => {
  const executed = [];
  const toolManager = new ToolManager();
  const sqlTool = new SqlTool();
  sqlTool.run = async args => { executed.push(args.sql); return { sql: args.sql, rows: [{ CustomerName: 'Customer fixture' }], rowCount: 1 }; };
  toolManager.registerTool(sqlTool);
  const harness = new LocalModelHarness({ toolManager, maxIterations: 1,
    dispatch: async () => ({ content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: 'SELECT CompanyName FROM M_Customer WHERE IsActive = 1' } } }] }) });
  const result = await harness.run({ userMessage: 'ds khách hàng', provider: localProvider,
    messages: [{ role: 'user', content: 'ds khách hàng' }], enabledToolNames: ['execute_sql_query'],
    context: { requestPlan: { table: 'M_Customer', intent: 'list', schemaColumns: ['CustomerName', 'PassWord', 'ApiKey'], unfilteredList: true, requiredColumns: [], outputs: { data: true } } } });
  assert.deepEqual(executed, ['SELECT TOP 100 [CustomerName] FROM [M_Customer]']);
  assert.match(result.replyText, /Customer fixture/);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});

test('simple local list uses the reviewed enrichment plan before asking the model for SQL', async () => {
  const executed = [];
  const toolManager = new ToolManager();
  const sqlTool = new SqlTool();
  sqlTool.run = async args => {
    executed.push(args.sql);
    return { sql: args.sql, rows: [{ 'Số HĐ': 'HD-01', 'Khách hàng': 'ACME' }], rowCount: 1 };
  };
  toolManager.registerTool(sqlTool);
  let modelCalls = 0;
  const harness = new LocalModelHarness({ toolManager, dispatch: async () => {
    modelCalls++;
    throw new Error('The model should not generate SQL for a simple entity list.');
  } });
  const joinPlan = {
    outcome: 'ready', purpose: 'enrichment',
    tableRefs: [
      { tableId: 'contract', tableName: 'T_Contract', schemaName: 'dbo', alias: 't1' },
      { tableId: 'customer', tableName: 'M_Customer', schemaName: 'dbo', alias: 't2' }
    ],
    edges: [{
      relationshipId: 'contract-customer', fromTableId: 'contract', toTableId: 'customer', joinType: 'LEFT',
      columnPairs: [{ sourceColumn: 'CustomerID', targetColumn: 'CustomerID' }],
      displayColumn: 'CustomerName', businessRole: 'Khách hàng'
    }]
  };
  const result = await harness.run({
    userMessage: 'ds hợp đồng', provider: localProvider,
    messages: [{ role: 'user', content: 'ds hợp đồng' }], enabledToolNames: ['execute_sql_query'],
    context: {
      joinPlan,
      requestPlan: {
        table: 'T_Contract', intent: 'list', question: 'ds hợp đồng', schemaColumns: ['ContractID', 'ContractNo', 'CustomerID'],
        columnDisplayNames: { ContractNo: 'Số HĐ' }, unfilteredList: false, requiredColumns: [], outputs: { data: true }
      }
    }
  });
  assert.equal(modelCalls, 0);
  assert.equal(executed.length, 1);
  assert.match(executed[0], /LEFT JOIN \[dbo\]\.\[M_Customer\]/);
  assert.match(executed[0], /t2\.\[CustomerName\] AS \[Khách hàng\]/);
  assert.match(result.replyText, /HD-01/);
  assert.ok(result.trace.steps.some(step => step.type === 'DETERMINISTIC_LIST_QUERY' && step.success));
  assert.equal(result.trace.completionStatus, 'SUCCESS');
});

test('list rendering includes all four SQL rows even when model text truncates on row two', async () => {
  const toolManager = new ToolManager();
  const sqlTool = new SqlTool();
  sqlTool.run = async args => ({ sql: args.sql, rows: [105, 57, 11, 246].map(id => ({ ContractID: id, ContractNo: `Contract-${id}` })), rowCount: 4 });
  toolManager.registerTool(sqlTool);
  let calls = 0;
  const harness = new LocalModelHarness({ toolManager, maxIterations: 2, dispatch: async () => ++calls === 1
    ? { content: '', tool_calls: [{ function: { name: 'execute_sql_query', arguments: { sql: 'SELECT TOP 10 * FROM T_Contract' } } }] }
    : { content: 'Có 4 hợp đồng:\n| ContractID | ContractNo |\n| --- | --- |\n| 105 | Contract-105 |\n| 57 | Contract-' } });
  const result = await harness.run({ userMessage: 'ds hợp đồng', provider: localProvider,
    messages: [{ role: 'user', content: 'ds hợp đồng' }], enabledToolNames: ['execute_sql_query'],
    context: { requestPlan: { intent: 'list', table: 'T_Contract', requiredColumns: [], outputs: { data: true } } } });
  for (const id of [105, 57, 11, 246]) assert.ok(result.replyText.includes(`Contract-${id}`));
  assert.ok(result.trace.steps.some(step => step.type === 'GROUNDED_LIST_RENDER'));
});

test('local fallback does not dispatch to cloud when disabled', async () => {
  const previous = process.env.LOCAL_MODEL_ALLOW_CLOUD_FALLBACK;
  process.env.LOCAL_MODEL_ALLOW_CLOUD_FALLBACK = 'false';
  const attempted = [];
  const harness = new LocalModelHarness({
    toolManager: manager(), maxIterations: 1,
    dispatch: async provider => { attempted.push(provider); throw new Error('offline'); }
  });
  try {
    await assert.rejects(() => harness.run({ provider: localProvider, messages: [{ role: 'user', content: 'hi' }], enabledToolNames: [] }), /offline/);
    assert.equal(attempted.every(isLocalProvider), true);
  } finally {
    if (previous === undefined) delete process.env.LOCAL_MODEL_ALLOW_CLOUD_FALLBACK;
    else process.env.LOCAL_MODEL_ALLOW_CLOUD_FALLBACK = previous;
  }
});

test('local harness stops immediately when the caller aborts', async () => {
  const controller = new AbortController();
  controller.abort();
  let dispatchCount = 0;
  const harness = new LocalModelHarness({
    toolManager: manager(),
    dispatch: async () => { dispatchCount += 1; return { content: 'unexpected' }; }
  });
  await assert.rejects(() => harness.run({
    provider: localProvider,
    messages: [{ role: 'user', content: 'hello' }],
    enabledToolNames: [],
    context: { signal: controller.signal }
  }), error => error?.name === 'AbortError');
  assert.equal(dispatchCount, 0);
});

test('list answers must mention actual SQL row values instead of only row count', () => {
  const sqlCall = {
    result: {
      rows: [{ CompanyID: 1, CompanyCode: 'LJIP', CompanyName: 'Công ty Long Giang', isActive: true }],
      rowCount: 1
    }
  };
  assert.equal(isListRequest('ds kh'), true);
  assert.equal(isListRequest('liệt kê khách hàng'), true);
  assert.equal(listAnswerMentionsRowValue('Hệ thống chỉ hiển thị 1 khách hàng đang hoạt động.', sqlCall), false);
  assert.equal(listAnswerMentionsRowValue('Khách hàng: LJIP — Công ty Long Giang.', sqlCall), true);
});

test('SQL tool fallback renders row values instead of only a row count', () => {
  const reply = LocalModelHarness.buildToolFallbackReply([{
    toolName: 'execute_sql_query', success: true,
    result: { rows: [{ EmployeeID: 7, EmployeeName: 'Yên Duy' }], rowCount: 1 }
  }]);
  assert.match(reply, /EmployeeID/);
  assert.match(reply, /Yên Duy/);
  assert.doesNotMatch(reply, /^Đã truy vấn dữ liệu thành công/);
});

test('planning success is never used as the final data answer', () => {
  const reply = LocalModelHarness.buildToolFallbackReply([{
    toolName: 'plan_data_query', success: true, result: { intent: 'list' }
  }]);
  assert.equal(reply, '');
});

test('model intent recovery uses the current relationship value', () => {
  const joinPlan = {
    outcome: 'ready',
    tableRefs: [
      { tableId: 'employee', tableRefId: 'employee#1', tableName: 'M_Employee', schemaName: 'dbo', alias: 't1' },
      { tableId: 'constant', tableRefId: 'constant#1', tableName: 'M_Constant', schemaName: 'dbo', alias: 't2' }
    ],
    edges: [{ relationshipId: 'employee_gender', fromTableId: 'employee', toTableId: 'constant',
      fromTableRefId: 'employee#1', toTableRefId: 'constant#1', businessRole: 'Gender', displayColumn: 'ConstantName',
      columnPairs: [{ sourceColumn: 'GenderID', targetColumn: 'ConstantID' }] }]
  };
  const sql = buildModelIntentRecoverySql({ rootTable: 'M_Employee', intent: 'list', relationshipFilters: [{
    relationshipId: 'employee_gender', displayColumn: 'ConstantName', operator: 'contains', value: 'Nam'
  }] }, { table: 'M_Employee', intent: 'list', schemaColumns: ['EmployeeName', 'GenderID'] }, joinPlan);
  assert.match(sql, /t2\.\[ConstantName\] LIKE N'%Nam%'/);
  assert.doesNotMatch(sql, /N'%Nữ%'/);
});

test('contract detail requests and truncated model text trigger the SQL rows fallback', () => {
  assert.equal(isListRequest('chi tiết các hợp đồng'), true);
  assert.equal(isInsufficientSqlAnswer('D'), true);
  assert.equal(isInsufficientSqlAnswer('Tổng quan:\n- **Tháng 02/20'), true);
  assert.equal(isInsufficientSqlAnswer('Tổng quan:\n- **Tháng 02/2024:** 1.850.000 kWh.'), false);
});
