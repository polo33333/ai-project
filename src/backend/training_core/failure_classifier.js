'use strict';

function classifyCase(record = {}) {
  const failures = [];
  const calls = record.requestPayload?.toolCalls || record.toolCalls || [];
  const question = String(record.question || '');
  const reply = String(record.replyText || record.reply || '');
  const memoryDecision = record.requestPayload?.memoryDecision || record.memoryDecision || null;
  const memoryPersisted = record.requestPayload?.memoryPersisted === true || record.memoryPersisted === true;
  const has = name => calls.some(call => (call.name || call.toolName) === name && call.success !== false);
  if (!has('execute_sql_query') && /dữ liệu|chi tiết|sản lượng|doanh thu|\bnv\b/i.test(question)) failures.push('MISSING_SQL');
  if (/biểu đồ|chart/i.test(question) && !has('render_chart')) failures.push('MISSING_CHART');
  if (/gửi file|xuất file|download/i.test(question) && !has('export_data')) failures.push('MISSING_EXPORT');
  if (/^\s*```sql|^\s*(?:select|with)\b/i.test(reply)) failures.push('SQL_ONLY_ANSWER');
  if (/schema|số cột|khóa chính/i.test(reply)) failures.push('SCHEMA_ONLY_ANSWER');
  if (/Yên Duy|nhân viên/i.test(reply) && !/Yên Duy|nhân viên|\bnv\b/i.test(question)) failures.push('HISTORY_CONTAMINATION');
  if (memoryDecision?.reason === 'independent_request' && memoryDecision.mode !== 'none') failures.push('MEMORY_USED_FOR_INDEPENDENT_REQUEST');
  if (memoryDecision?.previousScope && memoryDecision?.currentScope
      && memoryDecision.previousScope !== memoryDecision.currentScope && memoryDecision.mode !== 'none'
      && memoryDecision.reason !== 'cross_domain_entity_reference') failures.push('TOPIC_CHANGE_NOT_DETECTED');
  if (record.completionStatus === 'PARTIAL' && memoryPersisted) failures.push('INVALID_RESPONSE_PERSISTED');
  if (memoryDecision?.reason === 'missing_reference') failures.push('MISSING_REFERENCE');
  if (memoryDecision?.reason === 'stale_reference_used') failures.push('STALE_REFERENCE_USED');
  return [...new Set(failures)];
}

module.exports = { classifyCase };
