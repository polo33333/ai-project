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
    || ['general', 'knowledge'].includes(context.mode);
  return {
    ...plan, codeOnly,
    outputs: codeOnly || informational
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

function qualifiedSql(toolCalls, plan) {
  return toolCalls.filter(call => call.toolName === 'execute_sql_query' && call.success
    && Array.isArray(call.result?.rows)
    && evaluateSql(call.result?.sql || call.args?.sql || '', plan).valid);
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
  if (!plan.codeOnly && raw) failures.push('RAW_TOOL_ANSWER');
  if (['length', 'MAX_TOKENS', 'max_tokens'].includes(finishReason)) failures.push('TRUNCATED_ANSWER');
  if (plan.outputs?.chart && !toolCalls.some(call => call.toolName === 'render_chart' && call.success && call.result?.chartSpec)) failures.push('MISSING_CHART');
  if (plan.outputs?.export && !toolCalls.some(call => call.toolName === 'export_data' && call.success && call.result?.downloadUrl)) failures.push('MISSING_EXPORT');
  if (!plan.codeOnly) {
    const downloads = toolCalls.filter(call => call.toolName === 'export_data' && call.success).map(call => call.result?.downloadUrl);
    const links = String(reply || '').match(/(?:sandbox:\/mnt\/data\/|\/api\/exports\/)[^\s)\]`]+/g) || [];
    if (links.some(link => !downloads.includes(link))) failures.push('UNVERIFIED_ARTIFACT_LINK');
  }
  const text = normalize(reply);
  if (context.knowledgeGrounding?.required && /khong co thong tin(?: cu the)?|hay cho (?:toi|minh) biet them/.test(text)) failures.push('UNGROUNDED_KNOWLEDGE_RESPONSE');
  if (context.webSearch && context.webSearchResultCount > 0
    && /khong duoc ket noi|khong co quyen truy cap|ngoai pham vi/.test(text)) failures.push('WEB_GROUNDING_REFUSAL');
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
    if (name === 'export_data') {
      // Export the complete verified dataset, not the compact preview seen by the model.
      return Array.isArray(args.data) && args.data.length === rows.length && args.data.every((row, index) =>
        Object.keys(row).length > 0 && Object.entries(row).every(([key, item]) => Object.hasOwn(rows[index], key) && value(rows[index][key]) === value(item)));
    }
    if (!args.labels?.length || !args.datasets?.length) return false;
    return args.datasets.every(dataset => Array.isArray(dataset.data) && dataset.data.length === args.labels.length)
      && args.labels.every((label, index) => rows.some(row => {
        const values = Object.values(row).map(value);
        const labelMatches = values.some(item => item === value(label) || (/^\d{4}-\d{2}$/.test(value(label)) && item.startsWith(value(label))));
        return labelMatches && args.datasets.every(dataset => Object.values(row).some(item =>
          item !== null && item !== '' && Number.isFinite(Number(item)) && Number(item) === dataset.data[index]));
      }));
  });
}

module.exports = { isCodeRequest, resolvePlan, blockingSqlViolation, qualifiedSql, isRawAnswer, evaluateCompletion, stableFingerprint, validateOutputData };
