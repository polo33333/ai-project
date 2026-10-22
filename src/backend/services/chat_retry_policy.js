'use strict';

function disposition(result) {
  if (!result?.success || result.trace?.completionStatus !== 'PARTIAL'
    || typeof result.replyText !== 'string' || !result.replyText.trim()) return null;
  const limitation = result.trace.steps?.some(step => ['ANALYSIS_INSUFFICIENT_HISTORY', 'ANALYSIS_NO_MATCHING_DATA'].includes(step.type));
  const read = result.toolCalls?.some(call => call.success && ['execute_sql_query','query_sql_metric'].includes(call.toolName)
    && Array.isArray(call.result?.rows));
  return limitation && read ? 'verified_partial' : null;
}
module.exports = { disposition };
