'use strict';
function inspectSkill(skill, plan = {}) {
  if (!skill?.enabled) return { status: 'no_match', missingInputs: [], reason: 'skill_disabled' };
  if (!skill.intents.includes(plan.intent)) return { status: 'no_match', missingInputs: [], reason: `unsupported_intent:${plan.intent || 'none'}` };
  const missingInputs = [];
  if (!plan.table) missingInputs.push('table');
  if (plan.outputs?.data === false) missingInputs.push('data_output');
  if (plan.intent === 'aggregate_timeseries') {
    if (!plan.metric) missingInputs.push('metric');
    if (!plan.timeColumn) missingInputs.push('timeColumn');
    const schema = Array.isArray(plan.schemaColumns) ? plan.schemaColumns : [];
    if (plan.metric && schema.length && !schema.includes(plan.metric)) missingInputs.push('metric_in_schema');
    if (plan.timeColumn && schema.length && !schema.includes(plan.timeColumn)) missingInputs.push('timeColumn_in_schema');
  }
  return missingInputs.length ? { status: 'ambiguous', missingInputs, reason: `missing_inputs:${missingInputs.join(',')}` } : { status: 'matched', missingInputs: [], reason: `intent:${plan.intent}` };
}
module.exports = { inspectSkill };
