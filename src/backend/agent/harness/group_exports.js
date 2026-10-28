'use strict';
const { qualifiedSql, assessSqlEvidence } = require('./completion_policy');
function groups(plan, calls) {
  if (plan.semanticGroups && (plan.semanticGroups.length > 1 || !plan.resultGroupBy?.length)) return require('./semantic_groups').results(plan.semanticGroups, calls, call => assessSqlEvidence(call, plan)?.accepted)
    .map(group => ({ label: group.label, rows: group.call?.result.rows, source: group.call, complete: group.complete }));
  const source = qualifiedSql(calls, plan).at(-1);
  if (!source || source.result.hasMore || source.result.truncated) return [];
  const displayNames = { ...plan.columnDisplayNames, ...source.result.displayNames };
  const partition = require('./result_grouping').partition(source, plan.resultGroupBy, displayNames);
  return (partition || []).map(group => ({ label: group.values.map(value => value == null ? 'Chưa xác định' : String(value)).join(' · '), rows: group.rows, source, complete: true }));
}
async function run({ plan, calls, manager, context, budget, check }) {
  const batches = groups(plan, calls);
  if (!batches.length || batches.some(group => !group.complete)) return { failures: ['EXPORT_GROUPS_UNVERIFIED'] };
  if (plan.exportRequest.expectedFiles && batches.length !== plan.exportRequest.expectedFiles) return { failures: ['EXPORT_GROUP_COUNT_MISMATCH'], count: batches.length };
  const failures = [];
  for (const [index, group] of batches.entries()) {
    if (!group.rows?.length) { failures.push('EXPORT_GROUP_EMPTY'); continue; }
    check(); budget.consumeToolCall();
    const filename = `Danh_sach_${index + 1}_${group.label.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    const args = { data: require('../../assistant/security_guard').sanitizeTabularRows(group.rows), format: 'xlsx', filename };
    const execution = await manager.executeTool('export_data', args, { ...context,
      verifiedExport: { displayNames: { ...plan.columnDisplayNames, ...group.source.result.displayNames } } });
    calls.push({ toolName: 'export_data', args, success: execution.success, result: execution.result, error: execution.error,
      durationMs: execution.durationMs, exportGroup: group.label, exportGroupIndex: index });
    if (!execution.success) failures.push('EXPORT_GROUP_FAILED');
  }
  return { failures, count: batches.length };
}
module.exports = { groups, run };
