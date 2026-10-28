'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../src/backend/services/request_time');
const query = require('../src/backend/services/semantic_query');
const now = new Date('2026-10-22T18:10:00.000Z');
const tables = [{ tableName: 'Records', schemaName: 'dbo', columns: [
  { columnName: 'ID', dataType: 'INT', isPrimaryKey: true }, { columnName: 'DueDate', dataType: 'DATETIME' },
  { columnName: 'Code', dataType: 'NVARCHAR' }] }];
const sql = date => `SELECT ID, DueDate FROM dbo.Records WHERE DueDate < N'${date}'`;

test('the request date uses Vietnam calendar boundaries and is explicit in prompts', () => {
  const time = clock.create('hiện tại có gì hết hạn?', now);
  assert.equal(time.today, '2026-10-23');
  assert.equal(time.timezone, 'Asia/Ho_Chi_Minh');
  assert.equal(time.dateScoped, true);
  assert.ok(clock.instruction(time).includes('2026-10-23'));
});

test('upcoming requires an explicit or configured horizon without silently choosing 30 days', () => {
  assert.equal(clock.create('hết hạn hay sắp đến hạn', now, undefined).needsHorizon, true);
  const user = clock.create('sắp đến hạn trong 15 ngày tới', now, 30);
  assert.equal(user.horizonDays, 15);
  assert.equal(user.horizonSource, 'user');
  assert.ok(user.allowedDates.includes('2026-11-07'));
  assert.equal(clock.create('sắp đến hạn', now, 30).horizonSource, 'configuration');
  assert.equal(clock.create('sắp đến hạn', now, 'invalid').needsHorizon, true);
  assert.equal(clock.create('sắp đến hạn trong 40000 ngày tới', now, 30).needsHorizon, true, 'Invalid user windows are not silently replaced by configured defaults');
});

test('wrong anchors, ungrounded functions, missing date filters and OR bypass are blocked', () => {
  const time = clock.create('hiện tại cái nào hết hạn?', now);
  assert.equal(clock.validateSql(sql(time.today), time, tables).valid, true);
  assert.ok(clock.validateSql(sql('2023-10-27'), time, tables).violations.includes('TEMPORAL_REFERENCE_MISMATCH'));
  assert.equal(clock.validateSql('SELECT ID FROM Records', time, tables).valid, false);
  assert.equal(clock.validateSql('SELECT ID FROM Records WHERE DueDate < GETDATE()', time, tables).valid, false);
  assert.equal(clock.validateSql(sql(time.today) + ' OR ID > 0', time, tables).valid, false);
  assert.equal(clock.validateSql("SELECT ID FROM Records WHERE Code = '2026-10-23'", time, tables).valid, false, 'A date-shaped business code is not a date predicate');
  assert.equal(clock.validateSql("SELECT ID FROM Records WHERE EXISTS (SELECT 1 FROM Records x WHERE x.DueDate < '2026-10-23')", time, tables).valid, false, 'A subquery does not constrain the outer record expiry date');
});

test('symbolic offsets bind to backend time and preserve half-open calendar day boundaries', () => {
  const time = clock.create('sắp đến hạn trong 30 ngày tới', now);
  const input = { table: 'Records', operation: 'list', fields: ['DueDate'], filters: [
    { column: 'DueDate', operator: 'gte', value: { anchorDate: 'today', offsetDays: 0 } },
    { column: 'DueDate', operator: 'lt', value: { anchorDate: 'today', offsetDays: 30 } }] };
  const result = query.compile(input, tables, {}, null, time);
  assert.ok(result.sql.includes("[DueDate] >= N'2026-10-23'"));
  assert.ok(result.sql.includes("[DueDate] < N'2026-11-22'"));
  assert.equal(clock.validateSql(result.sql, time, tables).valid, true);
  const wrong = structuredClone(input); wrong.filters[0].value.anchorDate = '2023-10-27';
  assert.throws(() => query.compile(wrong, tables, {}, null, time), { code: 'TEMPORAL_REFERENCE_MISMATCH' });
  assert.throws(() => query.compile(input, tables, {}, null, clock.create('sắp đến hạn', now, '')), { code: 'TEMPORAL_HORIZON_REQUIRED' });
});

test('explicit historical dates are preserved and leap/month/year boundaries use calendar arithmetic', () => {
  const historical = clock.create('hết hạn trước 2024-01-01', now);
  assert.equal(historical.relative, false);
  assert.equal(clock.validateSql(sql('2024-01-01'), historical, tables).valid, true);
  assert.equal(clock.shift('2024-02-28', 1), '2024-02-29');
  assert.equal(clock.shift('2024-02-28', 2), '2024-03-01');
  assert.equal(clock.shift('2026-12-31', 1), '2027-01-01');
  assert.throws(() => clock.shift('2023-02-29', 1), { code: 'TEMPORAL_DATE_INVALID' });
  const month = clock.create('doanh số tháng này', now);
  assert.ok(month.allowedDates.includes('2026-10-01'));
  assert.ok(month.allowedDates.includes('2026-11-01'));
});

test('SQL acceptance cannot override the request time guard at final completion', () => {
  const { assessSqlEvidence } = require('../src/backend/agent/harness/completion_policy');
  const call = { toolName: 'execute_sql_query', success: true, result: { sql: sql('2023-10-27'), rows: [] } };
  assert.ok(assessSqlEvidence(call, { requestTime: clock.create('hiện tại hết hạn', now), temporalTables: tables }).failures.includes('TEMPORAL_REFERENCE_MISMATCH'));
});

test('known expired rows remain usable while an unspecified upcoming window stays incomplete', () => {
  const { assessSqlEvidence, evaluateCompletion } = require('../src/backend/agent/harness/completion_policy');
  const time = clock.create('hiện tại hết hạn hay sắp đến hạn', now, '');
  const plan = { outputs: { data: true }, requestTime: time, temporalTables: tables };
  const call = { toolName: 'execute_sql_query', success: true, result: { sql: sql(time.today), rows: [{ ID: 1, DueDate: '2025-12-31' }] } };
  assert.equal(assessSqlEvidence(call, plan).accepted, true);
  assert.deepEqual(evaluateCompletion({ reply: 'One expired record.', plan, toolCalls: [call] }).failures, ['TEMPORAL_HORIZON_REQUIRED']);
});

test('both date tools use the same frozen request clock', async () => {
  const registry = require('../src/backend/assistant/tool_registry');
  const { GetDateTimeTool, ResolveDateRangeTool } = require('../src/backend/agent/tools/builtins');
  const context = { requestTime: clock.create('hôm nay', now) };
  const range = await new ResolveDateRangeTool().run({ unit: 'day' }, context);
  const date = await new GetDateTimeTool().run({}, context);
  assert.equal(range.start, '2026-10-23');
  assert.equal(date.isoUtc, now.toISOString());
  const registered = await registry.executeTool('resolve_date_range', { unit: 'day' }, context);
  assert.equal(registered.result.start, range.start);
});

test('harness blocks a stale current-date SQL before database execution and repairs using the request clock', async t => {
  const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
  const Manager = require('../src/backend/agent/tools/tool_manager');
  const Base = require('../src/backend/agent/tools/base_tool');
  const fixed = clock.create('hiện tại hết hạn', now);
  t.mock.method(clock, 'create', () => fixed);
  const manager = new Manager(), executed = [], requests = [];
  const register = (name, run) => { const tool = new Base({ name, description: name,
    parameters: { type: 'object', properties: { query: { type: 'string' }, sql: { type: 'string' } } } }); tool.run = run; manager.registerTool(tool); };
  register('list_workflows', async () => ({ workflows: [] }));
  register('search_schema', async () => ({ mode: 'data', dbSourceId: 'source', selectedTables: ['Records'],
    tables: [{ tableName: 'Records', columns: [{ name: 'ID', type: 'INT', label: 'ID' }, { name: 'DueDate', type: 'DATETIME', label: 'Due date' }] }] }));
  register('execute_sql_query', async args => { executed.push(args.sql); return { sql: args.sql, rows: [{ ID: 1, DueDate: '2025-12-31' }] }; });
  const call = (name, args) => ({ tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const responses = [call('list_workflows', {}), call('search_schema', { query: 'Records' }),
    call('execute_sql_query', { sql: sql('2023-10-27') }), call('execute_sql_query', { sql: sql(fixed.today) })];
  const result = await new Harness({ toolManager: manager, dispatch: async (_, messages) => {
    requests.push(structuredClone(messages)); return responses.shift() || { content: 'Result' };
  } }).run({ userMessage: 'hiện tại cái nào hết hạn?', provider: { id: 'fixture', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, mode: 'data', dbSourceId: 'source', requestPlan: {
      table: 'Records', intent: 'list', identityColumns: ['ID', 'DueDate'], schemaColumns: ['ID', 'DueDate'], outputs: { data: true },
      conversationState: { operation: 'list', requestedAttributes: ['ID', 'DueDate'] } } } });
  assert.deepEqual(executed, [sql(fixed.today)]);
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.ok(result.replyText.includes('23/10/2026'));
  assert.ok(result.trace.steps.some(step => step.type === 'TEMPORAL_SQL_ASSESSED' && !step.accepted));
  assert.ok(requests[3].some(message => message.content?.includes('TEMPORAL_REFERENCE_MISMATCH')));
});

test('temporal validation uses the final authorized schema after deferred date fields are exposed', async t => {
  const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
  const Manager = require('../src/backend/agent/tools/tool_manager');
  const Base = require('../src/backend/agent/tools/base_tool');
  const dictionary = require('../src/backend/services/dictionary_service');
  const fixed = clock.create('hiện tại hết hạn', now);
  t.mock.method(clock, 'create', () => fixed);
  const raw = { ...tables[0], tableId: 'record', dbSourceId: 'source', isActive: true };
  t.mock.method(dictionary, 'getGroupedTables', () => [raw]);
  t.mock.method(dictionary, 'getTableRelationships', () => []);
  const manager = new Manager(); let executions = 0;
  const register = (name, run) => { const tool = new Base({ name, description: name,
    parameters: { type: 'object', properties: { query: { type: 'string' }, sql: { type: 'string' } } } }); tool.run = run; manager.registerTool(tool); };
  register('list_workflows', async () => ({ workflows: [] }));
  register('search_schema', async () => ({ mode: 'data', dbSourceId: 'source', selectedTables: ['Records'],
    tables: [{ tableName: 'Records', semanticModel: { entity: 'Record' }, columns: [{ name: 'ID', type: 'INT' }] }],
    intentCatalog: [{ tableId: 'record', tableName: 'Records', schemaName: 'dbo', columns: [{ name: 'ID' }, { name: 'DueDate' }] }] }));
  register('execute_sql_query', async args => { executions++; assert.match(args.sql, /DueDate\]? < N'2026-10-23'/);
    return { sql: args.sql, rows: [{ ID: 1, DueDate: '2025-12-31' }] }; });
  const result = await new Harness({ toolManager: manager, dispatch: async (_, messages, definitions) => {
    if (!definitions.length) return { content: JSON.stringify({ operation: 'list', analysis: 'none', attributes: ['ID', 'DueDate'], presentation: 'table',
      dataSql: sql(fixed.today) }) };
    return { tool_calls: [{ id: 'schema', type: 'function', function: { name: 'search_schema', arguments: '{"query":"Records"}' } }] };
  } }).run({ userMessage: 'hiện tại cái nào hết hạn?', provider: { id: 'fixture', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, mode: 'data', dbSourceId: 'source', requestPlan: {
      table: 'Records', intent: 'list', identityColumns: ['ID'], schemaColumns: ['ID', 'DueDate'], outputs: { data: true },
      conversationState: { operation: 'list', requestedAttributes: [] } } } });
  assert.equal(executions, 1, JSON.stringify(result.trace.steps.filter(step => step.type !== 'MODEL_USAGE')));
  assert.equal(result.trace.completionStatus, 'SUCCESS', JSON.stringify({evaluation: result.trace.training.responseEvaluation,steps:result.trace.steps.filter(step=>step.type!=='MODEL_USAGE')}));
});

test('explicit month windows replace inherited day horizons and require both calendar bounds', () => {
  const question = 'Phát hiện tháng tiêu thụ điện bất thường của KA0021 trong 24 tháng';
  assert.equal(clock.hasExplicitScope(question), true);
  assert.equal(clock.hasExplicitScope('Tiền điện trong 2024-02'), true);
  assert.equal(clock.hasExplicitScope('thêm tên khách hàng'), false);
  const time = clock.create(question, new Date('2026-10-23T04:00:00Z'));
  assert.deepEqual(time.monthWindow, { start: '2024-11-01', end: '2026-11-01', count: 24, includesCurrentMonth: true });
  assert.equal(time.horizonDays, null);
  const metadata = [{tableName:'Records',columns:[{columnName:'Date',dataType:'DATE'}]}];
  assert.equal(clock.validateSql("SELECT SUM(Amount) FROM Records WHERE Date >= '2024-11-01' AND Date < '2026-11-01'",time,metadata).valid,true);
  assert.ok(clock.validateSql("SELECT SUM(Amount) FROM Records WHERE Date >= '2024-11-01'",time,metadata).violations.includes('TEMPORAL_MONTH_WINDOW_REQUIRED'));
});
