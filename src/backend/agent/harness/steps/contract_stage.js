'use strict';

// The contract-first pipeline (HARNESS_PIPELINE=v2). Returns the run result
// when it answered; otherwise records the attempt and the agent loop continues.
const {
  providers, security, trainingService, isLocalProvider, RequestExecutionBudget, normalizeAssistantResponse, validateToolCall, getRequestPolicy, compactToolResult,
  validateCallAgainstPolicy, buildSqlRowsFallbackReply, ensureDownloadLink, resolvePlan, blockingSqlViolation, qualifiedSql,
  evaluateCompletion, stableFingerprint, validateOutputData, estimateTokens, emitProgress, toolLabel, createRequestContract,
  assessRequestContract, createMetricContract, decodeIntent, buildEnrichedListSql, contextualLookupQuestion,
  isSimpleEntityListRequest, positive, aborted, withToolProgress, createProviderBudget, recoverable, boundedCall, wireMessages
} = require('./common');

async function runContractStage(s) {
  const { harness, userMessage, provider, enabledToolNames, resourceSnapshot, question, messages, context, onProgress, budget, candidates, plan, requestTime, resultStore, toolContext, toolDefs,
    cachedCatalog, pendingInput, policy, instruction, conversation, trace, toolCalls, providerFallbacks, seen, check, dispatch } = s;
  let { reply, finishReason, stopReason } = s;
  try {
    // HARNESS_PIPELINE=v2: contract-first data path (pipeline/contract_pipeline).
    // It answers what it can compile; everything else continues in the agent
    // loop below, which starts clean.
    // Pending workflow inputs, workflow-result follow-ups and one-file-per-group
    // exports stay on the agent loop.
    if (process.env.HARNESS_PIPELINE === 'v2' && context.governedController && !plan.codeOnly && !context.webSearch && !toolContext.workflowReference) {
      try {
        // Documents already retrieved: grounded answer. No data tools: conversation.
        // Otherwise the contract pipeline (data, workflows, pending inputs, chat).
        const dataTools = ['search_schema', 'execute_sql_query'].every(name => toolContext.allowedToolNames.includes(name));
        const v2 = context.knowledgeGrounding?.required
          ? await require('../../pipeline/conversation_answer').documents({ conversation, dispatch, plan, context })
          : !dataTools ? (toolContext.allowedToolNames.some(name => name.startsWith('mcp_')) ? { fallback: 'V2_EXTERNAL_TOOLS' }
            : await require('../../pipeline/contract_pipeline').answerWithoutCatalog({ question, conversation, dispatch, plan, context, toolContext,
              toolManager: withToolProgress(harness.toolManager, onProgress), toolCalls, trace, gate: 'no_catalog' }))
          : await require('../../pipeline/contract_pipeline').run({ question, plan, context, toolContext, dispatch,
            toolManager: withToolProgress(harness.toolManager, onProgress), trace, toolCalls, requestTime, conversation, pendingInput });
        if (v2.handoff) {
          const state = v2.handoff;
          trace.pipeline = 'v2';
          trace.completionStatus = state.status === 'SUCCEEDED' ? 'SUCCESS' : state.status === 'CANCELLED' ? 'CANCELLED' : 'PARTIAL';
          trace.training.responseEvaluation = { valid: state.status === 'SUCCEEDED', failures: state.status === 'SUCCEEDED' ? [] : ['WORKFLOW_HANDOFF'], score: state.status === 'SUCCEEDED' ? 1 : 0 };
          trace.steps.push({ type: 'WORKFLOW_TOOL_HANDOFF', toolName: 'run_workflow', runId: state.id, status: state.status });
          trace.executionBudget = budget.snapshot(); trace.durationMs = Date.now() - trace.startTime;
          const text = require('../workflow_reply').reply(state);
          emitProgress(onProgress, { type: 'request_completed', label: text, status: 'done', icon: 'check' });
          return { replyText: text, toolCalls, usedProvider: s.activeProvider, providerFallbacks, tokenUsage: trace.tokenUsage, trace, conversation };
        }
        if (v2.reply) {
          plan.v2 = { contract: v2.contract, question, dbSourceId: v2.dbSourceId || toolContext.dbSourceId || null };
          if (v2.compiled) {
            plan.requestFilters = v2.compiled.requestFilters;
            plan.table = v2.compiled.root;
            plan.conversationState = { ...plan.conversationState, operation: v2.compiled.operation };
          }
          const succeeded = v2.status === 'SUCCESS';
          trace.pipeline = 'v2';
          trace.completionStatus = succeeded ? 'SUCCESS' : 'PARTIAL';
          trace.training.responseEvaluation = { valid: succeeded, score: succeeded ? 1 : 0, failures: succeeded ? [] : [`V2_${v2.status}`] };
          trace.executionBudget = budget.snapshot(); trace.durationMs = Date.now() - trace.startTime;
          emitProgress(onProgress, { type: 'request_completed', label: 'Đã hoàn thành câu trả lời', status: 'done', icon: 'check', durationMs: trace.durationMs });
          return { replyText: security.maskSensitiveData(v2.reply), toolCalls, citationEvidence: v2.citationEvidence || [], usedProvider: s.activeProvider,
            providerFallbacks, tokenUsage: trace.tokenUsage, trace, conversation };
        }
        trace.steps.push({ type: 'V2_FALLBACK', code: v2.fallback || 'V2_NO_ANSWER' });
      } catch (error) {
        if (context.signal?.aborted) throw aborted();
        trace.steps.push({ type: 'V2_FALLBACK', code: error.code || 'V2_ERROR', detail: String(error.message).slice(0, 200) });
      }
      // The agent loop starts clean, but the v2 attempt stays as evidence: its
      // contract, decisions and tool calls are kept in the trace and audit.
      const fallback = [...trace.steps].reverse().find(step => step.type === 'V2_FALLBACK');
      trace.v2Attempt = { fallbackCode: fallback?.code || null,
        contract: [...trace.steps].reverse().find(step => step.type === 'V2_CONTRACT')?.contract || null,
        steps: trace.steps.filter(step => /^V2_/.test(step.type)).map(({ contract, ...step }) => step),
        toolCalls: toolCalls.splice(0).map(call => ({ toolName: call.toolName, success: call.success, code: call.code || null,
          error: call.error ? String(call.error).slice(0, 300) : null, sql: call.args?.sql || null, rowCount: call.result?.rows?.length ?? null })) };
    }
  } finally { Object.assign(s, { reply, finishReason, stopReason }); }
}

module.exports = { runContractStage };
