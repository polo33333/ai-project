'use strict';

// Checks a model answer that proposes no tool calls. Returns { reply } when it
// is accepted, { groundedFallback: true } when verified rows can be rendered
// instead, or { failures } to repair.
const { qualifiedSql, evaluateCompletion } = require('../common');

function checkAnswer(s, response, finishReason) {
  const { context, plan, trace, toolCalls } = s;
  const candidate = require('../../visible_answer').visibleAnswer(response.content);
  let evaluation = evaluateCompletion({ reply: candidate, plan, toolCalls, context, finishReason });
  if (context.governedController && evaluation.failures.length === 1 && evaluation.failures[0] === 'MISSING_SQL'
    && toolCalls.some(call => call.toolName === 'search_schema' && call.success && call.result?.tables?.length)
    && /(?:không có|chưa có|không lưu|chưa lưu|không tìm thấy).{0,100}(?:cột|trường)|(?:cột|trường).{0,100}(?:không có|chưa có|không tồn tại)/iu.test(candidate)) {
    evaluation = { valid: true, score: 1, failures: [] };
    trace.steps.push({ type: 'SCHEMA_LIMITATION_ANSWER' });
  }
  if (context.knowledgeGrounding?.required && !/\[\d+\](?!\s*\()/.test(candidate)) {
    evaluation = { valid: false, score: 0, failures: [...new Set([...evaluation.failures, 'MISSING_KNOWLEDGE_CITATION'])] };
  }
  if (evaluation.valid) return { reply: candidate };
  // Once verified rows exist, a deterministic renderer can replace raw/empty text.
  const contentFailures = ['EMPTY_ANSWER', 'RAW_TOOL_ANSWER', 'SQL_ONLY_ANSWER', 'TRUNCATED_ANSWER', 'INSUFFICIENT_DATA_ANSWER'];
  if (qualifiedSql(toolCalls, plan).length && evaluation.failures.every(item => contentFailures.includes(item))) {
    trace.steps.push({ type: 'GROUNDED_RESULT_FALLBACK' });
    return { groundedFallback: true };
  }
  return { failures: evaluation.failures };
}

module.exports = { checkAnswer };
