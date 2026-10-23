'use strict';

// Contract-first data pipeline (HARNESS_PIPELINE=v2):
//   schema retrieval (no model) -> ONE model call for a query contract ->
//   compile against verified metadata -> execute -> deterministic answer.
// The model never writes SQL here. Questions it cannot express (chat,
// documents, unsupported shapes) return { fallback } to the agent loop.
const Ajv = require('ajv');
const catalogApi = require('./query_catalog');
const { compile } = require('./query_compiler');
const { normalizeAssistantResponse } = require('../harness/tool_call_normalizer');

const ref = { type: 'string', minLength: 1, maxLength: 200 };
const contractSchema = { type: 'object', additionalProperties: false, required: ['kind'], properties: {
  kind: { enum: ['data', 'workflow', 'chat', 'clarify'] },
  workflow: { type: 'object', additionalProperties: false, required: ['templateId'], properties: {
    templateId: { type: 'string', maxLength: 200 },
    inputs: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
    evidence: { type: 'object', additionalProperties: { type: 'string', maxLength: 200 } } } },
  output: { type: 'object', additionalProperties: false, properties: {
    chart: { enum: ['none', 'bar', 'line', 'pie'] }, export: { enum: ['none', 'xlsx', 'csv', 'pdf'] } } },
  clarification: { type: 'string', maxLength: 300 },
  followup: { type: 'boolean' },
  root: { type: 'string', maxLength: 128 },
  operation: { enum: ['list', 'aggregate'] },
  fields: { type: 'array', maxItems: 20, items: ref },
  measures: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['ref', 'aggregation'], properties: {
    ref, aggregation: { enum: ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'] }, distinct: { type: 'boolean' }, label: { type: 'string', maxLength: 80 } } } },
  groupBy: { type: 'array', maxItems: 4, items: { type: 'object', additionalProperties: false, required: ['ref'], properties: {
    ref, grain: { enum: ['day', 'month', 'year'] } } } },
  filters: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false, required: ['ref', 'operator', 'evidence'], properties: {
    ref, operator: { enum: ['eq', 'in', 'contains', 'period', 'gte', 'gt', 'lt', 'lte', 'isNull', 'notNull'] },
    value: { type: ['string', 'number'] }, values: { type: 'array', maxItems: 50, items: { type: ['string', 'number'] } },
    evidence: { type: 'string', maxLength: 200 }, inherited: { type: 'boolean' } } } },
  sort: { type: 'object', additionalProperties: false, required: ['by'], properties: { by: { type: 'string', maxLength: 200 }, direction: { enum: ['ASC', 'DESC'] } } },
  limit: { type: 'integer', minimum: 1, maximum: 1000 },
  analysis: { enum: ['none', 'anomaly'] }
} };
const validate = new Ajv({ strict: false }).compile(contractSchema);
const definition = { type: 'function', function: { name: 'plan_query',
  description: 'Return the query contract for the current question over the supplied catalog.', parameters: contractSchema } };

const RULES = `You translate the user's business question into a query contract over CATALOG. Call plan_query only; never write SQL or answer.
- kind=data for questions answered by catalog records; kind=chat for greetings, explanations, documents or anything not in the catalog; kind=clarify only when a required value is truly ambiguous (Vietnamese question in clarification).
- root: the table whose rows are listed, counted or summed (the table holding the measure).
- Reference columns as "Table.Column". To use a lookup (code, name, status, period name, group) go through the foreign key: "Root.FKColumn->LookupColumn", e.g. "T_Feedback.StatusID->ConstantName", "T_ElectricityOutput.CustomerID->CustomerCode". Never compare a code or name with a numeric ID column.
- operation=list returns records: choose the fields the question implies (for transactions include the business date and the main amount; for people include code and name); empty fields = the table's default list. "theo X" / "by X" means groupBy X. operation=aggregate returns measures, optionally grouped (groupBy). Foreign keys in fields/groupBy are shown by their display column automatically.
- Measures use root columns only; COUNT of records uses ref "*". Rankings ("cao nhất", "top 5") use sort {by:"measure:0"} and limit.
- Every code, date, period or year written in the question must appear in a filter; never drop one.
- If the right table is only in OTHER TABLES, use it anyway (as root or in refs); its columns are supplied on the next turn.
- Prefer columns with a business label (in quotes) over unlabeled columns of similar meaning, and the table whose entity matches the question (electricity vs water).
- Every filter needs evidence: an exact quote from the question that contains the value. Dates: operator=period with value "YYYY", "YYYY-MM" or "YYYY-MM-DD" on the business date column; ranges use gte/lt with ISO dates. Relative periods are computed from TODAY. "Kỳ N" is a period name in a lookup (e.g. PeriodID->Name), not a date.
- Unusual/abnormal months: operation=aggregate grouped by the business date with grain=month, analysis=anomaly.
- kind=workflow only when one of WORKFLOWS delivers exactly the requested result (same entity, measure, time semantics and outputs); set workflow.templateId, and in workflow.inputs only values stated in the question, each with its exact quote in workflow.evidence (missing inputs are asked later). A broader report, a different entity or a filter the workflow cannot apply means kind=data.
- output.chart (bar/line/pie) when a chart is asked ("biểu đồ", "vẽ"); it needs operation=aggregate with groupBy. output.export (xlsx/csv/pdf) when a file is asked ("xuất file", "excel"). Otherwise omit output.
- Follow-up (PREVIOUS is given and the question continues it, e.g. "còn tháng 1 thì sao", "vậy tìm trong năm 2024", "thêm cột giới tính"): set followup=true, start from PREVIOUS.contract and change only what the user changed. Carried filters keep their evidence from the previous question and set inherited=true. "tất cả/toàn bộ" removes the carried filter.`;

function decode(response) {
  let value = normalizeAssistantResponse(response).calls?.find(call => call.name === 'plan_query')?.arguments;
  if (!value) { try { value = JSON.parse(String(response.content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { /* invalid below */ } }
  // A contract that omits kind but is otherwise explicit is not ambiguous.
  if (value && typeof value === 'object' && !value.kind) value.kind = value.workflow ? 'workflow' : value.root ? 'data' : value.kind;
  if (!validate(value)) throw Object.assign(new Error('V2_CONTRACT_INVALID'), { code: 'V2_CONTRACT_INVALID',
    details: (validate.errors || []).slice(0, 5).map(error => `${error.instancePath} ${error.message}`) });
  return value;
}

// Authorized tables retrieval did not select: names and entities only.
function otherTables(selection, catalog) {
  return (selection.tableDirectory || []).filter(item => !catalogApi.table(catalog, item.tableName))
    .map(item => `${item.tableName}${item.entity ? ` (${item.entity})` : ''}`).join('; ') || 'none';
}

// Independent coverage check: every explicit code, date or year in the
// question must reach a filter (or the row limit). A contract that silently
// widens "KA0021 tháng 2024-02" to all customers or all months is rejected.
function uncovered(contract, question) {
  const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi');
  const tokens = [...new Set([
    ...(question.match(/\b\d{4}-\d{1,2}(?:-\d{1,2})?\b|\b\d{1,2}\/\d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/g) || []),
    ...(question.replace(/\b\d{4}-\d{1,2}(?:-\d{1,2})?\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b\d{1,2}\/\d{4}\b/g, ' ').match(/\b(?:19|20)\d{2}\b/g) || []),
    ...(question.match(/\b[A-Za-z][A-Za-z_-]*\d[A-Za-z0-9_-]*\b/g) || [])
  ])];
  const covered = (contract.filters || []).map(filter => fold([filter.evidence, filter.value, ...(filter.values || [])].join(' ')));
  return tokens.filter(token => !covered.some(text => text.includes(fold(token))) && String(contract.limit) !== token);
}

// Safety net for follow-ups: an equality filter of the previous contract that
// the model forgot is carried unless the user widened the scope.
function carryFilters(contract, previous, question) {
  if (!contract.followup || !previous?.contract?.filters?.length) return [];
  // \b treats Vietnamese letters as non-word characters; match on spacing instead.
  if (/(^|[\s,.;:!?])(tất cả|toàn bộ|mọi|all)(?=$|[\s,.;:!?])/iu.test(question)) return [];
  const target = item => item.ref.split('->')[0].split('.')[0].toLowerCase();
  const columnOf = item => item.ref.toLowerCase();
  const added = previous.contract.filters.filter(item => ['eq', 'in'].includes(item.operator)
    && !(contract.filters || []).some(current => columnOf(current) === columnOf(item) || (target(current) === target(item) && current.ref.split('->').length > 1)))
    .map(item => ({ ...item, inherited: true }));
  contract.filters = [...(contract.filters || []), ...added];
  return added;
}

async function run({ question, plan, context, toolContext, dispatch, toolManager, trace, toolCalls, requestTime }) {
  const step = (type, data = {}) => trace.steps.push({ type, ...data });
  // 1. Schema retrieval is deterministic tool code, not a model round.
  const searchArgs = { query: question, request: { operation: 'list', attributes: [], presentation: 'unspecified' } };
  const search = await toolManager.executeTool('search_schema', searchArgs, { ...toolContext, governedController: true });
  toolCalls.push({ toolName: 'search_schema', args: searchArgs, success: search.success, result: search.result || null, error: search.error || null });
  if (!search.success || search.result?.mode !== 'data') return { fallback: 'V2_SCHEMA_UNAVAILABLE' };
  // A follow-up ("còn khách hàng DC6011 thì sao?") names no table: keep the
  // tables of the previous contract available alongside the new retrieval.
  const previous = context.resolutionContext?.previousRequest?.businessState?.v2 || null;
  const previousTables = previous?.contract ? [previous.contract.root, ...JSON.stringify(previous.contract).match(/[A-Za-z_][A-Za-z0-9_]*(?=\.[A-Za-z_])/g) || []] : [];
  let catalog = catalogApi.build(search.result, { include: previousTables });
  if (!catalog.tables.size) return { fallback: 'V2_SCHEMA_EMPTY' };

  // Authorized workflows are offered in the same contract call (tool code, no model).
  let workflows = [];
  if (['list_workflows', 'run_workflow'].every(name => toolContext.allowedToolNames?.includes(name))) {
    const listed = await toolManager.executeTool('list_workflows', { limit: 30 }, toolContext);
    if (listed.success) workflows = listed.result?.workflows || [];
  }

  // 2. One structured model call (plus at most one targeted repair).
  const recent = (context.resolutionContext?.recent || []).slice(-4).map(item => ({ role: item.role, content: String(item.content || '').slice(0, 600) }));
  const messages = [{ role: 'system', content: RULES },
    { role: 'user', content: `TODAY: ${requestTime.today}\nCATALOG:\n${catalogApi.describe(catalog)}\n`
      + `OTHER TABLES (columns supplied on request): ${otherTables(search.result, catalog)}\n`
      + (workflows.length ? `WORKFLOWS: ${describeWorkflows(workflows)}\n` : '')
      + (previous ? `PREVIOUS: ${JSON.stringify(previous)}\n` : '') + (recent.length ? `RECENT: ${JSON.stringify(recent)}\n` : '')
      + `QUESTION: ${question}` }];
  let contract, compiled, lastError, attempts = 2;
  for (let attempt = 0; attempt < attempts && !compiled; attempt++) {
    const response = await dispatch([definition], messages, attempt ? 'v2_contract_repair' : 'v2_contract');
    try {
      contract = decode(response);
      step('V2_CONTRACT', { attempt, contract: structuredClone(contract) });
      if (contract.kind === 'chat') return { fallback: 'V2_NOT_DATA', contract };
      if (contract.kind === 'clarify') return { contract, reply: contract.clarification || 'Bạn có thể nói rõ hơn phạm vi dữ liệu cần tra cứu không?', status: 'CLARIFY' };
      if (contract.kind === 'workflow') {
        if (contract.operation) plan.conversationState = { ...plan.conversationState, operation: contract.operation };
        const started = await runWorkflow(contract, workflows, question, toolManager, toolContext, step);
        if (started.handoff) { toolCalls.push(started.call); return { contract, handoff: started.handoff }; }
        // An unsuitable or failed workflow is not a dead end: ask once more for a data contract.
        workflows = workflows.filter(item => item.templateId !== contract.workflow?.templateId);
        if (attempts < 3) attempts++;
        throw Object.assign(new Error(`V2_WORKFLOW_REJECTED: ${String(started.reason).slice(0, 200)}. Answer with kind=data over CATALOG instead`), { code: 'V2_WORKFLOW_REJECTED' });
      }
      // A file needs every matching row, not the 100-row display page.
      if (exportFormat(contract, plan) && contract.operation !== 'aggregate' && !contract.limit) contract.exportLimit = true;
      const dropped = uncovered(contract, question);
      if (dropped.length) throw Object.assign(new Error(`V2_CRITERION_DROPPED: the question states ${dropped.map(item => `"${item}"`).join(', ')} but no filter uses it`), { code: 'V2_CRITERION_DROPPED' });
      const carried = carryFilters(contract, previous, question);
      if (carried.length) step('V2_FILTERS_CARRIED', { refs: carried.map(item => item.ref) });
      compiled = compile(contract.exportLimit ? { ...contract, limit: 1000 } : contract, catalog, { question, previousQuestion: previous?.question || '' });
    } catch (error) {
      lastError = error;
      // Retrieval may miss the right table ("tiền điện" -> water table). A
      // contract naming an authorized table outside the catalog loads its
      // metadata for the repair round instead of failing.
      const named = [...new Set([contract?.root, ...(JSON.stringify(contract || {}).match(/[A-Za-z_][A-Za-z0-9_]*(?=\.[A-Za-z_])/g) || [])]
        .filter(name => name && !catalogApi.table(catalog, name)))];
      if (['V2_ROOT_UNKNOWN', 'V2_TABLE_UNKNOWN'].includes(error.code) && named.length) {
        const before = new Set(catalog.tables.keys());
        catalog = catalogApi.build(search.result, { include: [...previousTables, ...catalog.tables.values()].map(item => item.tableName || item).concat(named) });
        const added = [...catalog.tables.values()].filter(item => !before.has(catalogApi.key(item.tableName)));
        if (added.length) {
          step('V2_CATALOG_EXTENDED', { tables: added.map(item => item.tableName) });
          error.message += `\nAdditional catalog:\n${catalogApi.describe({ ...catalog, tables: new Map(added.map(item => [catalogApi.key(item.tableName), item])) })}`;
        }
      }
      step('V2_CONTRACT_REJECTED', { attempt, code: error.code || 'V2_CONTRACT_INVALID', detail: String(error.message).slice(0, 300), ...(error.details ? { details: error.details } : {}) });
      messages.push({ role: 'assistant', content: JSON.stringify(contract || {}) },
        { role: 'user', content: `The contract was rejected: ${String(error.message).slice(0, 400)}${error.details ? ` ${error.details.join('; ')}` : ''}. `
          + 'Fix only that problem using exact catalog names and quotes from the question, then call plan_query again.' });
    }
  }
  if (!compiled) return { fallback: lastError?.code || 'V2_CONTRACT_INVALID', contract };
  step('V2_COMPILED', { root: compiled.root, operation: compiled.operation, joins: compiled.joinPlan.edges.length, filters: compiled.requestFilters.length });

  // 3. Execute through the governed SQL tool (permissions, security guard, completeness).
  const execute = async query => {
    const args = { sql: query.sql };
    const execution = await toolManager.executeTool('execute_sql_query', args, { ...toolContext, joinPlan: query.joinPlan,
      compiledSemanticQuery: false, requestPlan: { ...plan, rowLimit: contract.limit || null } });
    const result = { toolName: 'execute_sql_query', args, success: execution.success, result: execution.result || null,
      error: execution.error || null, code: execution.code || null, outcome: execution.outcome, effectState: execution.effectState };
    toolCalls.push(result);
    if (!execution.success) step('V2_EXECUTION_FAILED', { code: execution.code || null });
    return result;
  };
  let call = await execute(compiled);
  if (!call.success) return { fallback: call.code || 'V2_EXECUTION_FAILED', contract };

  // 4. Nothing matched a text value ("Phòng Kỹ thuật" vs stored "Kỹ thuật"):
  // look the value up in its column once. One candidate is used and shown in
  // the scope; several candidates are asked back instead of guessed.
  if (noMatch(compiled, call.result.rows) && compiled.textFilters.length) {
    const resolved = await resolveValues(compiled.textFilters, contract, toolManager, toolContext, step);
    if (resolved.clarify) return { contract, reply: resolved.clarify, status: 'CLARIFY' };
    if (resolved.changes.length) {
      step('V2_VALUE_RESOLVED', { changes: resolved.changes });
      compiled = compile(contract.exportLimit ? { ...contract, limit: 1000 } : contract, catalog, { question, previousQuestion: previous?.question || '' });
      call = await execute(compiled);
      if (!call.success) return { fallback: call.code || 'V2_EXECUTION_FAILED', contract };
    }
  }

  // 5. Deterministic answer from the verified rows, then requested outputs
  // built from the same rows (a chart or file can never drift from the data).
  let reply = render(compiled, call, question), status = 'SUCCESS';
  const rows = call.result.rows || [];
  const chartType = contract.output?.chart && contract.output.chart !== 'none' ? contract.output.chart : plan.outputs?.chart ? 'auto' : null;
  if (chartType) {
    const args = chartArgs(compiled, rows, chartType, question);
    if (!args) { reply += '\n\nChưa vẽ được biểu đồ: kết quả cần ít nhất một chiều phân nhóm và một số liệu.'; status = 'PARTIAL'; }
    else {
      const chart = await toolManager.executeTool('render_chart', args, toolContext);
      toolCalls.push({ toolName: 'render_chart', args, success: chart.success, result: chart.result || null, error: chart.error || null });
      if (!chart.success) { reply += '\n\nĐã lấy được số liệu, nhưng chưa tạo được biểu đồ.'; status = 'PARTIAL'; }
    }
  }
  const format = exportFormat(contract, plan);
  if (format && rows.length) {
    const args = { data: rows, format, filename: `Bao_cao_${new Date().toISOString().slice(0, 10)}` };
    const file = await toolManager.executeTool('export_data', args, { ...toolContext, verifiedExport: { resultGroupBy: [], displayNames: {} } });
    toolCalls.push({ toolName: 'export_data', args, success: file.success, result: file.result || null, error: file.error || null });
    if (file.success && file.result?.downloadUrl) reply = require('../harness/grounded_reply').ensureDownloadLink(reply, file.result.downloadUrl);
    else { reply += '\n\nChưa tạo được file xuất.'; status = 'PARTIAL'; }
  }
  return { contract, compiled, call, reply, status };
}

function exportFormat(contract, plan) {
  const value = contract.output?.export;
  return value && value !== 'none' ? value : plan.exportRequest?.export ? 'xlsx' : null;
}

// Labels from the dimension(s), one series per measure, values taken as-is.
function chartArgs(compiled, rows, requested, title) {
  const dimensions = compiled.outputs.filter(item => item.kind === 'dimension');
  const measures = compiled.outputs.filter(item => item.kind === 'measure');
  if (!dimensions.length || !measures.length || !rows.length) return null;
  const text = value => value instanceof Date ? value.toISOString().slice(0, value.getUTCDate() === 1 ? 7 : 10) : String(value ?? '—');
  const timeSeries = ['Tháng', 'Ngày', 'Năm'].includes(dimensions[0].alias);
  return { type: requested === 'auto' ? (timeSeries ? 'line' : 'bar') : requested, title: String(title).slice(0, 120),
    labels: rows.map(row => dimensions.map(item => text(row[item.alias])).join(' – ')),
    datasets: measures.map(item => ({ label: item.alias, data: rows.map(row => Number(row[item.alias]) || 0) })) };
}

function describeWorkflows(workflows) {
  return workflows.map(item => `${item.templateId}: ${item.name}${item.description ? ` — ${String(item.description).slice(0, 160)}` : ''}`
    + ` [operations: ${(item.operations || []).join(', ') || 'none'}; inputs: ${Object.entries(item.inputs || {})
      .map(([key, slot]) => `${key}${slot.required ? '*' : ''}(${slot.label || key}, ${slot.schema?.type || 'string'})`).join(', ') || 'none'}]`).join(' | ');
}

// Inputs are kept only when quoted from the question and valid for the slot schema.
async function runWorkflow(contract, workflows, question, toolManager, toolContext, step) {
  const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi');
  const choice = contract.workflow || {};
  const item = workflows.find(workflow => workflow.templateId === choice.templateId);
  if (!item) return { reason: `workflow ${choice.templateId} is not in WORKFLOWS` };
  const { validateValue } = require('../../automation/contract');
  const inputs = {};
  for (const [name, raw] of Object.entries(choice.inputs || {})) {
    const slot = item.inputs?.[name], quote = choice.evidence?.[name];
    if (!slot || typeof quote !== 'string' || !quote.trim() || !fold(question).includes(fold(quote))) continue;
    const type = slot.schema?.type;
    const value = ['integer', 'number'].includes(type) ? Number(raw) : type === 'boolean' ? raw === true || /^(true|1|có|co|yes)$/i.test(String(raw).trim()) : String(raw);
    if (!validateValue(value, slot.schema, name).length) inputs[name] = value;
  }
  const args = { templateId: item.templateId, inputs };
  const execution = await toolManager.executeTool('run_workflow', args, toolContext);
  const state = execution.result?.execution;
  step('V2_WORKFLOW', { templateId: item.templateId, success: execution.success, code: execution.code || null, status: state?.status || null });
  if (!execution.success) return { reason: execution.error || execution.code || 'workflow rejected' };
  if (!state || state.status === 'FAILED') return { reason: `workflow failed${state?.error?.message ? `: ${state.error.message}` : ''}` };
  return { handoff: state, call: { toolName: 'run_workflow', args, success: true, result: execution.result, error: null } };
}

// Empty rows, or one aggregate row whose measures are all NULL/0.
function noMatch(compiled, rows = []) {
  const measures = compiled.outputs.filter(item => item.kind === 'measure');
  return !rows.length || (compiled.operation === 'aggregate' && !compiled.outputs.some(item => item.kind === 'dimension')
    && rows.length === 1 && measures.every(item => [null, undefined, 0].includes(rows[0][item.alias])));
}

async function resolveValues(textFilters, contract, toolManager, toolContext, step = () => {}) {
  const quote = name => `[${String(name).replaceAll(']', ']]')}]`;
  const fold = value => String(value ?? '').normalize('NFC').toLocaleLowerCase('vi').trim();
  const changes = [];
  for (const target of textFilters) {
    const filter = contract.filters[target.index];
    const value = String(filter.value);
    const like = value.replace(/[%_[]/g, char => `[${char}]`).replaceAll("'", "''");
    const column = quote(target.column);
    // GROUP BY, not DISTINCT: the SQL guard prepends TOP to unlimited SELECTs.
    const sql = `SELECT TOP 6 ${column} AS [v] FROM ${quote(target.schemaName)}.${quote(target.table)} WHERE LEN(${column}) >= 2`
      + ` AND (${column} LIKE N'%${like}%' OR CHARINDEX(${column}, N'${value.replaceAll("'", "''")}') > 0) GROUP BY ${column}`;
    const probe = await toolManager.executeTool('execute_sql_query', { sql }, { ...toolContext, joinPlan: null, compiledSemanticQuery: false });
    if (!probe.success) { step('V2_VALUE_PROBE_FAILED', { code: probe.code || null, error: String(probe.error || '').slice(0, 200) }); continue; }
    const candidates = [...new Set((probe.result?.rows || []).map(row => row.v).filter(item => typeof item === 'string'))];
    if (!candidates.length || candidates.some(item => fold(item) === fold(value))) continue;
    if (candidates.length > 1) return { clarify: `Mình chưa tìm thấy giá trị “${value}”. Bạn muốn chọn giá trị nào: ${candidates.map(item => `“${item}”`).join(', ')}?`, changes };
    changes.push({ ref: filter.ref, from: value, to: candidates[0] });
    filter.resolvedFrom = value; filter.value = candidates[0];
  }
  return { changes };
}

function render(compiled, call, question) {
  const rows = call.result.rows || [];
  const analysis = require('../harness/analysis_response');
  const scope = compiled.scope.length ? `Phạm vi: ${compiled.scope.join('; ')}.` : '';
  // SUM over no matching rows still returns one row of NULLs: that is no data,
  // not a value. A COUNT of 0 is a real answer and is rendered.
  const measures = compiled.outputs.filter(item => item.kind === 'measure');
  const empty = !rows.length || (noMatch(compiled, rows) && measures.every(item => rows[0][item.alias] === null || rows[0][item.alias] === undefined));
  if (empty) return `Không tìm thấy dữ liệu phù hợp${scope ? ` với phạm vi đã lọc (${compiled.scope.join('; ')})` : ''}.`
    + ' Không có bản ghi không có nghĩa là giá trị bằng 0.';
  let body;
  if (compiled.analysis === 'anomaly') {
    const plan = { analysisTask: 'anomaly' };
    body = analysis.shortAnomalyReply(call, plan) || analysis.seriesAnomalyReply(call, plan, question)?.text || null;
  }
  if (!body) {
    if (rows.length === 1 && measures.length === compiled.outputs.length) {
      const format = value => typeof value === 'number' ? new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 }).format(value) : value ?? '—';
      body = measures.map(item => `**${item.alias}:** ${format(rows[0][item.alias])}`).join('\n');
    } else body = require('../harness/grounded_reply').buildSqlRowsFallbackReply(call, {}, { forceTable: rows.length > 1 });
  }
  const more = call.result.hasMore ? `\n\nĐang hiển thị ${rows.length} dòng đầu; dữ liệu có thể còn thêm.` : '';
  return `${scope ? `${scope}\n\n` : ''}${body}${more}`;
}

module.exports = { run, render, decode, carryFilters, uncovered, chartArgs, describeWorkflows, contractSchema };
