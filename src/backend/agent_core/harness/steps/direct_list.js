'use strict';

// Plain lists answered from the reviewed schema and relationship plan before
// any model call (non-governed controller).
const {
  providers, security, trainingService, isLocalProvider, RequestExecutionBudget, normalizeAssistantResponse, validateToolCall, getRequestPolicy, compactToolResult,
  validateCallAgainstPolicy, buildSqlRowsFallbackReply, ensureDownloadLink, resolvePlan, blockingSqlViolation, qualifiedSql,
  evaluateCompletion, stableFingerprint, validateOutputData, estimateTokens, emitProgress, toolLabel, createRequestContract,
  assessRequestContract, createMetricContract, decodeIntent, buildEnrichedListSql, contextualLookupQuestion,
  isSimpleEntityListRequest, positive, aborted, withToolProgress, createProviderBudget, recoverable, boundedCall, wireMessages
} = require('./common');

async function runDirectList(s) {
  const { harness, userMessage, provider, enabledToolNames, resourceSnapshot, question, messages, context, onProgress, budget, candidates, plan, requestTime, resultStore, toolContext, toolDefs,
    cachedCatalog, pendingInput, policy, instruction, conversation, trace, toolCalls, providerFallbacks, seen, check, dispatch } = s;
  let { reply, finishReason, stopReason } = s;
  try {
    // Plain lists are fully defined by the reviewed schema and relationship
    // plan. Execute that plan before calling a remote model so providers cannot
    // omit mandatory joins or rewrite configured business aliases.
    if (!context.governedController && policy.dataRequired && plan.intent === 'list' && !policy.chartRequired && !policy.exportRequired
      && (plan.unfilteredList || isSimpleEntityListRequest(question))
      && toolContext.allowedToolNames.includes('execute_sql_query')) {
      const deterministicSql = buildEnrichedListSql({ ...plan, question,
        datasetReference: context.memoryDecision?.reference }, context.joinPlan);
      if (deterministicSql) {
        try {
          check(); budget.consumeToolCall(); budget.consumeSqlAttempt();
          const execution = await boundedCall(signal => harness.toolManager.executeTool('execute_sql_query', { sql: deterministicSql },
            { ...toolContext, signal }), context.signal, budget.remainingMs());
          toolCalls.push({ toolName: 'execute_sql_query', args: { sql: deterministicSql }, success: execution.success,
            result: execution.result || null, error: execution.error || null, durationMs: execution.durationMs });
          trace.toolCalls.push({ toolName: 'execute_sql_query', success: execution.success, durationMs: execution.durationMs, source: 'DETERMINISTIC_LIST_QUERY' });
          trace.steps.push({ type: 'DETERMINISTIC_LIST_QUERY', success: execution.success, toolName: 'execute_sql_query' });
          if (execution.success) reply = buildSqlRowsFallbackReply({ toolName: 'execute_sql_query', args: { sql: deterministicSql }, success: true, result: execution.result }, plan.columnDisplayNames);
          else if (plan.directListQuery) {
            stopReason = 'DIRECT_LIST_QUERY_FAILED';
            reply = 'Không thể lấy danh sách từ cơ sở dữ liệu. Hãy kiểm tra kết nối và cấu hình bảng rồi thử lại.';
          }
        } catch (error) {
          trace.steps.push({ type: error.code || 'DETERMINISTIC_LIST_QUERY_FAILED', error: error.message });
          if (plan.directListQuery) {
            stopReason = error.code || 'DIRECT_LIST_QUERY_FAILED';
            reply = 'Không thể lấy danh sách từ cơ sở dữ liệu. Hãy kiểm tra kết nối và cấu hình bảng rồi thử lại.';
          }
        }
      }
    }
  } finally { Object.assign(s, { reply, finishReason, stopReason }); }
}

module.exports = { runDirectList };
