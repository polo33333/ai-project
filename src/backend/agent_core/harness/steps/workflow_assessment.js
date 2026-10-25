'use strict';

// The workflow suitability check run_workflow calls before starting a run.
const {
  providers, security, trainingService, isLocalProvider, RequestExecutionBudget, normalizeAssistantResponse, validateToolCall, getRequestPolicy, compactToolResult,
  validateCallAgainstPolicy, buildSqlRowsFallbackReply, ensureDownloadLink, resolvePlan, blockingSqlViolation, qualifiedSql,
  evaluateCompletion, stableFingerprint, validateOutputData, estimateTokens, emitProgress, toolLabel, createRequestContract,
  assessRequestContract, createMetricContract, decodeIntent, buildEnrichedListSql, contextualLookupQuestion,
  isSimpleEntityListRequest, positive, aborted, withToolProgress, createProviderBudget, recoverable, boundedCall, wireMessages
} = require('./common');

function installWorkflowAssessment(s) {
  const { harness, userMessage, provider, enabledToolNames, resourceSnapshot, question, messages, context, onProgress, budget, candidates, plan, requestTime, resultStore, toolContext, toolDefs,
    cachedCatalog, pendingInput, policy, instruction, conversation, trace, toolCalls, providerFallbacks, seen, check, dispatch } = s;
  // Does a quoted input value exist in a field the workflow filters on? One
  // governed read-only query; null when it cannot be checked here.
  const probeInput = async ({ table, column }, value, dbSourceId) => {
    if (!dbSourceId || dbSourceId !== toolContext.dbSourceId) return null;
    const quote = name => `[${String(name).replaceAll(']', ']]')}]`;
    const [schema, name] = String(table).includes('.') ? String(table).split('.') : ['dbo', table];
    const sql = `SELECT TOP 1 1 AS [hit] FROM ${quote(schema)}.${quote(name)} WHERE ${quote(column)} = N'${String(value).replaceAll("'", "''")}'`;
    const result = await harness.toolManager.executeTool('execute_sql_query', { sql }, { ...toolContext, joinPlan: null, compiledSemanticQuery: false });
    return result.success ? (result.result?.rows?.length || 0) > 0 : null;
  };
  if (context.governedController) toolContext.assessWorkflow = async (definition, proposedInputs = {}, { planned = false } = {}) => {
    // A separate model call; the UI shows a pending workflow card meanwhile.
    const workflow = { workflowName: definition.name, templateId: definition.id };
    emitProgress(onProgress, { type: 'workflow_pending', label: 'Đang kiểm tra quy trình có khớp câu hỏi', status: 'running', icon: 'gear', ...workflow });
    try {
      const assessment = await require('../../../memory_core/workflow_suitability').assess(dispatch, question,
      plan.conversationState ? {...toolContext.conversationResolution,operation:plan.conversationState.operation,
        attributes:plan.conversationState.requestedAttributes,
        outputs: plan.outputs, temporalMonths: plan.temporalMonths,
        proposedInputs,
        cardinality:plan.conversationState.cardinality||(['compare','list','aggregate'].includes(plan.conversationState.operation)?'collection':'single')} : {...toolContext.conversationResolution, outputs: plan.outputs, proposedInputs}, definition,
        { planned, probe: probeInput });
      if (assessment.deterministic) trace.steps.push({ type: 'WORKFLOW_ASSESSED_BY_BACKEND', templateId: definition.id, bindings: assessment.inputBindings });
      emitProgress(onProgress, { type: 'workflow_running', label: 'Đang chạy quy trình nghiệp vụ', status: 'running', icon: 'gear', ...workflow });
      return assessment;
    } catch (error) {
      // A malformed assessment is retried at once; keep the card instead of flickering.
      if (error.code !== 'WORKFLOW_ASSESSMENT_INVALID') emitProgress(onProgress, { type: 'workflow_rejected',
        label: 'Quy trình chưa phù hợp, chuyển sang truy vấn dữ liệu', status: 'warning', icon: 'gear', ...workflow });
      throw error;
    }
  };
}

module.exports = { installWorkflowAssessment };
