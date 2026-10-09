'use strict';

// Persist decisions, not prompts, SQL literals, tool rows or provider credentials.
function buildChatDiagnostics(trace) {
  if (!trace) return null;
  const plan = trace.training?.plan || {};
  const routing = trace.workflowRouting;
  return {
    iterations: trace.iterations,
    completionStatus: trace.completionStatus,
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
      requiredColumns: plan.requiredColumns, schemaColumns: plan.schemaColumns, outputs: plan.outputs },
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
      ...(step.failures ? { failures: step.failures } : {}),
      ...(step.type === 'MODEL_USAGE' ? { stage: step.stage, repairAttempt: step.repairAttempt, providerId: step.providerId,
        model: step.model, durationMs: step.durationMs, calls: step.calls, inputTokens: step.inputTokens,
        outputTokens: step.outputTokens, totalTokens: step.totalTokens, inputTokensEstimated: step.inputTokensEstimated,
        usageAvailable: step.usageAvailable } : {}) }))
  };
}

module.exports = { buildChatDiagnostics };
