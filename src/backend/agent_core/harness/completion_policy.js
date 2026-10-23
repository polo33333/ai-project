'use strict';

const { normalize } = require('../../training_core/request_planner');
const { evaluateSql } = require('../../training_core/sql_evaluator');
const { evaluateResponse } = require('../../training_core/response_evaluator');
const { normalizeAssistantResponse } = require('./tool_call_normalizer');

function isCodeRequest(question = '') {
  const text = normalize(question);
  if (/\b(?:chay|thuc thi|execute|run)\b/.test(text) && !/\b(?:khong|dung|do not|don't)\s+(?:chay|thuc thi|execute|run)\b/.test(text)) return false;
  return /\b(?:viet|tao|giai thich|huong dan|write|generate|explain)(?:\s+(?:giup|cho|toi|minh|mot|cau|lenh|doan|ma|truy|van|a|an|the))*\s+(?:sql|query|code|json|ma nguon)\b/.test(text)
    || /\b(?:sql|query|code|json)\b[^\n]{0,30}\b(?:mau|vi du|example)\b/.test(text)
    || /\b(?:cho|xin)\b[^\n]{0,30}\b(?:cau lenh sql|cau truy van|ma sql)\b/.test(text);
}

function resolvePlan(question, plan = {}, context = {}) {
  const codeOnly = isCodeRequest(question);
  const informational = context.webSearch || context.knowledgeGrounding?.required
    || context.mode === 'knowledge' || (context.mode === 'general' && !plan.outputs?.chart && !plan.outputs?.export);
  return {
    ...plan, codeOnly,
    outputs: plan.workflowReference && !codeOnly ? { ...plan.outputs, data: false } : codeOnly || informational
      ? { data: false, chart: false, export: false }
      : { ...plan.outputs }
  };
}

// Share the same conservative pre-execution checks with the local harness.
// More complex SQL is still validated by the SQL security/connector layer.
function blockingSqlViolation(evaluation) {
  return evaluation.violations.find(item => ['MISSING_SELECT', 'WRONG_TABLE', 'SCHEMA_QUERY', 'UNREQUESTED_FILTER'].includes(item)
    || item.startsWith('UNKNOWN_COLUMN:'));
}

function assessSqlEvidence(call, plan = {}) {
  if (!['execute_sql_query', 'query_sql_metric'].includes(call?.toolName)) return null;
  const failures = [];
  if (!call.success) failures.push('SQL_EXECUTION_FAILED');
  else if (!Array.isArray(call.result?.rows)) failures.push('SQL_ROWS_UNAVAILABLE');
  else {
    const actualSource = call.result.dbSourceId || call.result.sourceId;
    if (plan.dbSourceId && actualSource && plan.dbSourceId !== actualSource) failures.push('SQL_SOURCE_MISMATCH');
    if (call.toolName === 'query_sql_metric') {
      if (!call.result.metricId || !call.result.metricVersion) failures.push('SQL_METRIC_UNVERIFIED');
    } else {
      const sql = call.result.sql || call.args?.sql || '';
      failures.push(...require('../../memory_core/result_scope').assess(call, plan.followupScope));
      failures.push(...require('../../services/request_time').validateSql(sql, plan.requestTime, plan.temporalTables || []).violations);
      if (plan.schemaScope?.invalid) failures.push('SQL_SCOPE_UNRESOLVED');
      else if (!require('./schema_scope').matchesScope(sql, plan.schemaScope?.filters)) failures.push('SQL_SCOPE_MISMATCH');
      if (!require('./schema_scope').matchesScope(sql, plan.requestFilters)) failures.push('REQUEST_FILTER_REQUIRED');
      failures.push(...evaluateSql(sql, plan).violations.map(code => `SQL_PLAN_${code}`));
      if (plan.conversationState?.operation === 'aggregate' && !isAggregateSql(sql)) failures.push('SQL_AGGREGATION_REQUIRED');
    }
  }
  return { accepted: failures.length === 0, failures };
}

function qualifiedSql(toolCalls, plan) {
  const calls = toolCalls.filter(call => assessSqlEvidence(call, plan)?.accepted);
  if (plan.requestContract) {
    const missing = call => require('./request_contract').assessRequestContract(plan.requestContract, call).fields.filter(field => field.status === 'not_queried').length;
    calls.sort((a, b) => missing(b) - missing(a));
  }
  return calls.filter((call, index) => !dropsAggregateScope(call.result?.sql || call.args?.sql || '', calls.slice(0, index)));
}

// A supplementary aggregate must not silently replace a scoped answer with
// totals for every category. Compare parsed predicates, never business terms.
function dropsAggregateScope(sql, previousCalls = []) {
  const scope = text => {
    try {
      const parsed = new (require('node-sql-parser').Parser)().astify(text, { database: 'TransactSQL' });
      const statement = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!statement.from?.length || statement.from.some(source => !source.table) || !isAggregateSql(text)) return null;
      const sources = statement.from.map(source => ({
        alias: String(source.as || source.table).toLowerCase(),
        name: JSON.stringify([source.db || 'dbo', source.table]).toLowerCase()
      }));
      if (new Set(sources.map(source => source.name)).size !== sources.length) return null;
      const canonical = node => Array.isArray(node) ? node.map(canonical) : node && typeof node === 'object'
        ? Object.fromEntries(Object.keys(node).sort().filter(name => name !== 'parentheses')
          .map(name => [name, node.type === 'column_ref' && name === 'table'
            ? sources.find(source => source.alias === String(node[name]).toLowerCase())?.name || (sources.length === 1 ? sources[0].name : node[name])
            : node.type === 'column_ref' && name === 'column' ? String(node[name]).toLowerCase() : canonical(node[name])])) : node;
      const predicates = node => !node ? [] : node.type === 'binary_expr' && node.operator === 'AND'
        ? [...predicates(node.left), ...predicates(node.right)] : [JSON.stringify(canonical(node))];
      return { tables: sources.map(source => source.name), predicates: [statement.where, ...statement.from.map(source => source.on)].flatMap(predicates) };
    } catch { return null; }
  };
  const next = scope(sql);
  if (!next) return false;
  return previousCalls.some(call => {
    if (!call.success || call.toolName !== 'execute_sql_query') return false;
    const prior = scope(call.result?.sql || call.args?.sql || '');
    return prior?.tables.every(table => next.tables.includes(table)) && prior.predicates.some(predicate => !next.predicates.includes(predicate));
  });
}

function isAggregateSql(sql) {
  try {
    const parsed = new (require('node-sql-parser').Parser)().astify(sql, { database: 'TransactSQL' });
    const statement = Array.isArray(parsed) ? parsed[0] : parsed;
    const contains = node => Boolean(node && typeof node === 'object' && (node.type === 'aggr_func'
      || Object.values(node).some(value => Array.isArray(value) ? value.some(contains) : contains(value))));
    const aggregate = node => (node.columns || []).some(column => contains(column.expr))
      || (node.from?.length === 1 && node.from[0].expr?.ast && (node.columns || []).every(column => column.expr?.type === 'column_ref')
        && aggregate(node.from[0].expr.ast));
    return aggregate(statement);
  } catch { return false; }
}

function coversAggregateAttributes(sql, attributes = []) {
  if (!attributes.length) return true;
  try {
    const parsed = new (require('node-sql-parser').Parser)().astify(sql, { database: 'TransactSQL' });
    const statement = Array.isArray(parsed) ? parsed[0] : parsed;
    const names = new Set();
    const key = value => String(value).normalize('NFC').toLowerCase().trim();
    const collect = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'column_ref' && typeof node.column === 'string') names.add(key(node.column));
      Object.values(node).forEach(value => Array.isArray(value) ? value.forEach(collect) : collect(value));
    };
    for (const column of statement.columns || []) {
      if (column.as) names.add(key(column.as));
      collect(column.expr);
    }
    // Only exact field/alias coverage is accepted. Unknown business labels must
    // still be resolved; WHERE-only fields do not count as requested outputs.
    return attributes.every(attribute => names.has(key(attribute)));
  } catch { return false; }
}

function canFinalizeVerifiedRead(plan, call, context = {}) {
  if (require('./analysis_response').task(plan)) return false;
  if (!plan.outputs?.data || plan.outputs.chart || plan.outputs.export || plan.codeOnly || context.webSearch || context.knowledgeGrounding?.required) return false;
  if (!call?.success || !Array.isArray(call.result?.rows) || call.result.hasMore || call.result.truncated) return false;
  if (plan.requestContract) return require('./request_contract').assessRequestContract(plan.requestContract, call).complete;
  return plan.conversationState?.operation === 'aggregate' && Array.isArray(plan.schemaScope?.filters) && !plan.schemaScope.invalid
    && coversAggregateAttributes(call.result.sql || call.args?.sql || '', plan.conversationState.requestedAttributes)
    && isAggregateSql(call.result.sql || call.args?.sql || '')
    && require('./schema_scope').matchesScope(call.result.sql || call.args?.sql || '', plan.schemaScope.filters);
}

function isRawAnswer(text = '') {
  const value = String(text).trim();
  return /```(?:sql|tsql)\b/i.test(value)
    || /^(?:```\s*)?(?:select|with)\b/i.test(value)
    || normalizeAssistantResponse({ content: value }).kind === 'tool_call';
}

function evaluateCompletion({ reply, plan, toolCalls = [], context = {}, finishReason } = {}) {
  const raw = isRawAnswer(reply);
  const evaluatedCalls = toolCalls.filter(call => call.toolName !== 'execute_sql_query' || qualifiedSql([call], plan).length);
  const base = evaluateResponse({ reply, plan, toolCalls: evaluatedCalls });
  const failures = base.failures.filter(item => !(plan.codeOnly && item === 'SQL_ONLY_ANSWER'));
  if (failures.includes('MISSING_SQL')) {
    const attempted = toolCalls.map(call => assessSqlEvidence(call, plan)).filter(Boolean);
    // Successful execution and usable evidence are separate states. Give the
    // repair loop the actual failed invariant instead of asking it to rerun
    // metadata discovery after SQL has already returned rows.
    const reasons = attempted.at(-1)?.failures;
    if (reasons?.length) failures.splice(failures.indexOf('MISSING_SQL'), 1, ...reasons);
    else if (attempted.length) failures.splice(failures.indexOf('MISSING_SQL'), 1, 'SQL_SCOPE_CHANGED');
  }
  if (!plan.codeOnly && raw) failures.push('RAW_TOOL_ANSWER');
  if (plan.calculationUnverified) failures.push('CALCULATION_NOT_VERIFIED');
  if (plan.memoryUnresolved) failures.push('MEMORY_REFERENCE_UNRESOLVED');
  if (plan.requestTime?.needsHorizon) failures.push('TEMPORAL_HORIZON_REQUIRED');
  if (plan.intent === 'schema_description' && !toolCalls.some(call => call.toolName === 'search_schema' && call.success
    && call.result?.tables?.some(table => table.columns?.length))) failures.push('MISSING_SCHEMA_EVIDENCE');
  if (['length', 'MAX_TOKENS', 'max_tokens'].includes(finishReason)) failures.push('TRUNCATED_ANSWER');
  if (plan.outputs?.chart && !toolCalls.some(call => call.toolName === 'render_chart' && call.success && call.result?.chartSpec)) failures.push('MISSING_CHART');
  if (plan.outputs?.export && !toolCalls.some(call => call.toolName === 'export_data' && call.success && call.result?.downloadUrl)) failures.push('MISSING_EXPORT');
  if (!plan.codeOnly) {
    const downloads = toolCalls.filter(call => call.toolName === 'export_data' && call.success).map(call => call.result?.downloadUrl);
    const links = String(reply || '').match(/(?:sandbox:\/mnt\/data\/|\/api\/exports\/)[^\s)\]`]+/g) || [];
    if (links.some(link => !downloads.includes(link))) failures.push('UNVERIFIED_ARTIFACT_LINK');
  }
  const text = normalize(reply);
  if (require('./analysis_response').task(plan) && /^da tra cuu duoc/.test(text)
    && !/tieu chi|phuong phap|nguong|baseline|criterion|method/.test(text)) failures.push('ANALYSIS_NOT_PERFORMED');
  if (context.knowledgeGrounding?.required && /khong co thong tin(?: cu the)?|hay cho (?:toi|minh) biet them/.test(text)) failures.push('UNGROUNDED_KNOWLEDGE_RESPONSE');
  if (context.webSearch && context.webSearchResultCount > 0
    && /khong duoc ket noi|khong co quyen truy cap|ngoai pham vi/.test(text)) failures.push('WEB_GROUNDING_REFUSAL');
  if (plan.requestContract) {
    const assessment = require('./request_contract').assessRequestContract(plan.requestContract, qualifiedSql(toolCalls, plan).at(-1));
    failures.push(...assessment.failures);
  }
  const documentEvidence = [...(context.citationEvidence || []), ...toolCalls
    .filter(call => call.success && call.toolName === 'search_knowledge_base')
    .flatMap(call => call.result?.documents || [])];
  if (documentEvidence.length) {
    const markers = require('../../knowledge_core/services/citation_service').findMarkers(reply || '');
    const known = new Set(documentEvidence.map(item => item.citationIndex).filter(Number.isInteger));
    // Incidental document discovery must not invalidate a structured answer
    // rendered solely from executed SQL. Explicit document grounding still requires citations.
    if (!markers.length && (context.knowledgeGrounding?.required || (plan.intent !== 'schema_description' && !qualifiedSql(toolCalls, plan).length))) failures.push('MISSING_KNOWLEDGE_CITATION');
    if (markers.some(marker => !known.has(marker))) failures.push('INVALID_KNOWLEDGE_CITATION');
  }
  const unique = [...new Set(failures)];
  return { valid: unique.length === 0, score: Math.max(0, 1 - unique.length * 0.2), failures: unique };
}

function stableFingerprint(name, args) {
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  return `${name}:${JSON.stringify(canonical(args))}`;
}

function validateOutputData(name, args, sqlCalls) {
  if (!['render_chart', 'export_data'].includes(name)) return true;
  const value = item => item instanceof Date ? item.toISOString() : String(item ?? '');
  return sqlCalls.some(call => {
    const rows = call.result.rows;
    const calendarParts = require('./chart_evidence').periodColumns(call.result.sql || call.args?.sql || '');
    if (name === 'export_data') {
      // Export the complete verified dataset, not the compact preview seen by the model.
      return Array.isArray(args.data) && args.data.length === rows.length && args.data.every((row, index) =>
        Object.keys(row).length > 0 && Object.entries(row).every(([key, item]) => Object.hasOwn(rows[index], key) && value(rows[index][key]) === value(item)));
    }
    if (!args.labels?.length || !args.datasets?.length) return false;
    return args.datasets.every(dataset => Array.isArray(dataset.data) && dataset.data.length === args.labels.length)
      && args.labels.every((label, index) => rows.some(row => {
        const values = Object.values(row).map(value);
        const labelMatches = values.some(item => item === value(label) || (/^\d{4}-\d{2}$/.test(value(label)) && item.startsWith(value(label))))
          || require('./chart_evidence').periodLabel(row, calendarParts) === value(label);
        return labelMatches && args.datasets.every(dataset => Object.values(row).some(item =>
          item !== null && item !== '' && Number.isFinite(Number(item)) && Number(item) === dataset.data[index]));
      }));
  });
}

module.exports = { isCodeRequest, resolvePlan, blockingSqlViolation, assessSqlEvidence, qualifiedSql, dropsAggregateScope, canFinalizeVerifiedRead, isRawAnswer, evaluateCompletion, stableFingerprint, validateOutputData };
