'use strict';

function disposition(result) {
  if (!result?.success || result.trace?.completionStatus !== 'PARTIAL'
    || typeof result.replyText !== 'string' || !result.replyText.trim()) return null;
  const limitation = result.trace.steps?.some(step => ['ANALYSIS_INSUFFICIENT_HISTORY', 'ANALYSIS_NO_MATCHING_DATA'].includes(step.type));
  const read = result.toolCalls?.some(call => call.success && ['execute_sql_query','query_sql_metric'].includes(call.toolName)
    && Array.isArray(call.result?.rows));
  const failures = result.trace.training?.responseEvaluation?.failures || [];
  const temporalClarification = result.trace.training?.plan?.requestTime?.needsHorizon
    && failures.length > 0 && failures.every(code => code === 'TEMPORAL_HORIZON_REQUIRED')
    && result.trace.sqlEvidence?.some(item => item.assessment?.accepted
      && result.toolCalls?.[item.index]?.success && Array.isArray(result.toolCalls[item.index].result?.rows));
  return (limitation || temporalClarification) && read ? 'verified_partial' : null;
}
module.exports = { disposition };
