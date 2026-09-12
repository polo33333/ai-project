'use strict';

// Persist decisions, not prompts, SQL literals, tool rows or provider credentials.
function buildChatDiagnostics(trace) {
  if (!trace) return null;
  const plan = trace.training?.plan || {};
  return {
    iterations: trace.iterations,
    completionStatus: trace.completionStatus,
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
    steps: (trace.steps || []).slice(-50).map(step => ({ type: step.type, iteration: step.iteration, toolName: step.toolName, success: step.success }))
  };
}

module.exports = { buildChatDiagnostics };
