'use strict';

// Persist decisions, not prompts, SQL literals, tool rows or provider credentials.
function buildChatDiagnostics(trace) {
  if (!trace) return null;
  const plan = trace.training?.plan || {};
  const routing = trace.workflowRouting;
  return {
    iterations: trace.iterations,
    completionStatus: trace.completionStatus,
    streaming:trace.streaming?{...trace.streaming}:null,
    contractAssessment: trace.contractAssessment ? {
      complete: trace.contractAssessment.complete,
      fields: (trace.contractAssessment.fields || []).map(field => ({ name: field.name, status: field.status })),
      failures: trace.contractAssessment.failures || []
    } : null,
    requestContract: trace.requestContract ? {
      operation: trace.requestContract.operation,
      criteriaCount: trace.requestContract.attributes?.length || 0,
      unresolvedCount: trace.requestContract.completeness?.unresolved?.length || 0,
      unresolvedReasons: [...new Set((trace.requestContract.completeness?.unresolved || []).map(item => item.reason))],
      metadataAvailable: trace.requestContract.completeness?.metadataAvailable
    } : null,
    harness: trace.harness,
    executionBudget: trace.executionBudget,
    stopReason: trace.stopReason,
    workflowRouting: routing ? {
      requestId: routing.requestId, routingMode: routing.routingMode, decisionSource: routing.decisionSource,
      routingModel: routing.routingModel, chatModel: routing.chatModel, escalated: routing.escalated,
      escalationReason: routing.escalationReason, route: routing.route, workflowId: routing.workflowId,
      inputDisposition: routing.inputDisposition, skippedReason: routing.skippedReason, errorCode: routing.errorCode,
      latencyMs: routing.latencyMs, chatFallbackReason: routing.chatFallbackReason, quickReplyKind: routing.quickReplyKind,
      retrieval: routing.retrieval || null, flow: routing.flow,
      stages: (routing.stages || []).map(stage => ({ decisionSource: stage.decisionSource, model: stage.model,
        status: stage.status, stage: stage.stage, flow: stage.flow, calls: stage.calls, httpRequests: stage.httpRequests, decisionEvaluations: stage.decisionEvaluations,
        inputTokens: stage.inputTokens, outputTokens: stage.outputTokens, totalTokens: stage.totalTokens,
        latencyMs: stage.latencyMs, errorCode: stage.errorCode, decisionScores: stage.decisionScores }))
    } : null,
    plan: { table: plan.table, intent: plan.intent, unfilteredList: plan.unfilteredList,
      requiredColumns: plan.requiredColumns, schemaColumns: plan.schemaColumns, outputs: plan.outputs,
      operation: plan.conversationState?.operation, requestedAttributes: plan.conversationState?.requestedAttributes },
    sqlEvaluations: (trace.training?.sqlEvaluations || []).slice(-20).map(item => ({ valid: item.valid, violations: item.violations })),
    responseEvaluation: trace.training?.responseEvaluation,
    skill: trace.skill ? {
      enabled: trace.skill.enabled, fewShotEnabled: trace.skill.fewShotEnabled,
      matched: trace.skill.matched, status: trace.skill.status,
      skillId: trace.skill.skillId, skillVersion: trace.skill.skillVersion,
      reason: trace.skill.reason, missingInputs: trace.skill.missingInputs,
      exampleCount: trace.skill.exampleCount, injected: trace.skill.injected
    } : null,
    steps: (trace.steps || []).slice(-50).map(step => ({ type: step.type, iteration: step.iteration, toolName: step.toolName, success: step.success,
      ...(step.type === 'PROVIDER_ERROR' ? { status: step.status, error: step.error } : {}),
      ...(step.type === 'CHART_OUTPUT_FAILED' ? { code: step.code } : {}),
      ...(['WORKFLOW_PREFERENCE_REVIEWED','WORKFLOW_PREFERENCE_UNAVAILABLE'].includes(step.type)
        ? { selectedTemplateId: step.selectedTemplateId, code: step.code } : {}),
      ...(step.type === 'CONTEXT_COMPACTED' ? { stage: step.stage, beforeTokensEstimated: step.beforeTokensEstimated,
        afterTokensEstimated: step.afterTokensEstimated, changes: step.changes } : {}),
      ...(step.type==='INVALID_ARGUMENTS'?{validationErrors:step.validationErrors}:{}),
      ...(step.type==='ANSWER_STREAM_POLICY'?{eligible:step.eligible,reason:step.reason,toolCount:step.toolCount}:{}),
      ...(step.type==='SEMANTIC_INTENT_REVIEWED'?{operation:step.operation,attributes:step.attributes}:{}),
      ...(['MEMORY_RESOLVED', 'MEMORY_RESOLUTION_REJECTED', 'MEMORY_RESOLUTION_UNAVAILABLE'].includes(step.type)
        ? { code: step.code, relation: step.relation, operation: step.operation, cardinality: step.cardinality, dataUse: step.dataUse,
          selectedIds: step.selectedIds, repairAttempt: step.repairAttempt, validationErrors: step.validationErrors } : {}),
      ...(step.failures ? { failures: step.failures } : {}),
      ...(step.type === 'MODEL_USAGE' ? { stage: step.stage, repairAttempt: step.repairAttempt, providerId: step.providerId,
        model: step.model, durationMs: step.durationMs, calls: step.calls, inputTokens: step.inputTokens,
        outputTokens: step.outputTokens, totalTokens: step.totalTokens, inputTokensEstimated: step.inputTokensEstimated,
        usageAvailable: step.usageAvailable, messageTokensEstimated: step.messageTokensEstimated,
        toolDefinitionsTokensEstimated: step.toolDefinitionsTokensEstimated, toolResultTokensEstimated: step.toolResultTokensEstimated,
        contextFootprint: step.contextFootprint } : {}) }))
  };
}

module.exports = { buildChatDiagnostics };
