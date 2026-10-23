'use strict';
// Deterministic summary of verified request structure, never a model-written
// summary of business amounts or a replacement for original query results.
function fromPlan(plan = {}, updatedAt = new Date().toISOString()) {
  const state = {
    table: plan.table || null, dbSourceId: plan.dbSourceId || null,
    operation: plan.conversationState?.operation || null,
    requestedAttributes: plan.conversationState?.requestedAttributes || [],
    categoryFilters: plan.schemaScope?.invalid ? [] : plan.schemaScope?.filters || [],
    groups: plan.semanticGroups ? structuredClone(plan.semanticGroups) : null,
    query: plan.semanticQuery ? Object.fromEntries(['table', 'operation', 'filters', 'segment', 'dimensions', 'measures', 'time']
      .filter(key => plan.semanticQuery[key] !== undefined).map(key => [key, plan.semanticQuery[key]])) : null,
    metric: plan.metric || null, timeColumn: plan.timeColumn || null, updatedAt,
    instruction: 'Historical request structure only. Not evidence of current business values. Reuse only for an explicitly resolved follow-up; current instructions override it. Raw SQL predicates are not reconstructed here.'
  };
  // All-or-nothing: never silently shorten a business filter or identifying code.
  if (JSON.stringify(state).length > 8000) return { table: state.table, dbSourceId: state.dbSourceId, updatedAt,
    unavailable: 'Request structure exceeds summary budget; consult original request instead of guessing omitted filters.' };
  return structuredClone(state);
}
module.exports = { fromPlan };
