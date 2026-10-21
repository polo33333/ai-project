'use strict';

const numericTypes = new Set(['tinyint','smallint','int','bigint','decimal','numeric','float','real','money','smallmoney']);
const dateTypes = new Set(['date','datetime','datetime2','smalldatetime','datetimeoffset']);
const typeOf = column => String(column?.dataType || '').toLowerCase().split('(')[0].trim();
const issue = (code, field, message) => ({ code, field, message });
function configurationIssues(table) {
  const issues = [];
  const columns = table.columns || [];
  const available = (name, field) => {
    const column = columns.find(c => c.columnName === name);
    if (!column || column.isVisible === false) issues.push(issue('SCHEMA_COLUMN_UNAVAILABLE', field, `Cột ${name} phải tồn tại và được bật cho AI.`));
    return column;
  };
  if (table.defaultMetric) {
    const column = available(table.defaultMetric, 'defaultMetric');
    if (column && (table.defaultAggregation || 'SUM') !== 'COUNT' && !numericTypes.has(typeOf(column)))
      issues.push(issue('SCHEMA_METRIC_TYPE', 'defaultMetric', 'Chỉ tiêu mặc định phải là cột số khi dùng SUM, AVG, MIN hoặc MAX.'));
  }
  if (table.defaultTimeColumn) {
    const column = available(table.defaultTimeColumn, 'defaultTimeColumn');
    if (column && !dateTypes.has(typeOf(column))) issues.push(issue('SCHEMA_TIME_TYPE', 'defaultTimeColumn', 'Cột thời gian phải có kiểu ngày hoặc ngày giờ; time và timestamp không đại diện ngày nghiệp vụ.'));
  }
  if (table.defaultAggregation && !['SUM','AVG','MIN','MAX','COUNT'].includes(table.defaultAggregation))
    issues.push(issue('SCHEMA_AGGREGATION_INVALID', 'defaultAggregation', 'Phép tổng hợp không hợp lệ.'));
  return issues;
}
function validateConfiguration(table) {
  const issues = configurationIssues(table);
  if (issues.length) throw Object.assign(new Error(issues.map(i => i.message).join(' ')), { code: issues[0].code, statusCode: 400, issues });
  return table;
}
function audit(tables, relationships = []) {
  const active = tables.filter(t => t.isActive !== false);
  const key = value => String(value || '').normalize('NFC').trim().toLocaleLowerCase('vi');
  const aliases = new Map();
  for (const t of active) for (const name of new Set([t.semanticModel?.entity, ...(t.semanticModel?.aliases || [])].filter(Boolean).map(key))) {
    const id = JSON.stringify([t.dbSourceId, t.dbName, name]);
    aliases.set(id, [...(aliases.get(id) || []), t]);
  }
  const results = active.map(t => {
    const issues = configurationIssues(t).map(i => ({ ...i, severity: 'error' }));
    const add = (code, field, message, severity = 'warning') => issues.push({ ...issue(code, field, message), severity });
    try { require('./required_filters').validate(t.requiredFilters === undefined ? [] : t.requiredFilters, t); }
    catch (error) { add(error.code, 'requiredFilters', error.message, 'error'); }
    if (!t.semanticModel) add('SEMANTIC_MODEL_MISSING', 'semanticModel', 'Chưa khai báo đối tượng, ý nghĩa mỗi dòng và trường hiển thị.');
    else {
      try { require('./semantic_model').validateModel(t.semanticModel, t); }
      catch (error) { add(error.code || 'SEMANTIC_MODEL_INVALID', 'semanticModel', error.message, 'error'); }
      for (const name of new Set([t.semanticModel.entity, ...(t.semanticModel.aliases || [])].filter(Boolean).map(key))) {
        if (aliases.get(JSON.stringify([t.dbSourceId, t.dbName, name]))?.length > 1)
          add('SEMANTIC_ALIAS_AMBIGUOUS', 'semanticModel.aliases', `Tên “${name}” trùng nhiều bảng trong cùng nguồn; cần phân giải theo ngữ cảnh.`);
      }
    }
    if (!String(t.tableDescription || '').trim() || String(t.tableDescription).startsWith('Bảng dữ liệu '))
      add('TABLE_DESCRIPTION_MISSING', 'tableDescription', 'Cần mô tả phạm vi nghiệp vụ và trường hợp sử dụng bảng.');
    for (const c of t.columns || []) if (c.isVisible !== false && (!String(c.description || '').trim() || String(c.description).startsWith(`Cột ${c.columnName} thuộc bảng `)))
      add('COLUMN_DESCRIPTION_MISSING', `columns.${c.columnName}`, `Chưa có ý nghĩa nghiệp vụ của cột ${c.columnName}.`);
    for (const r of relationships.filter(r => r.isActive !== false && (r.sourceTableId === t.tableId || r.targetTableId === t.tableId))) {
      const source = tables.find(x => x.tableId === r.sourceTableId), target = tables.find(x => x.tableId === r.targetTableId);
      // Deliberately disabled metadata is outside the AI review scope. Missing
      // columns are different: retain those findings to expose schema drift.
      if (source?.isActive === false || target?.isActive === false
        || (r.columnPairs || []).some(p => source?.columns?.find(c => c.columnName === p.sourceColumn)?.isVisible === false
          || target?.columns?.find(c => c.columnName === p.targetColumn)?.isVisible === false)
        || (r.displayColumn && target?.columns?.find(c => c.columnName === r.displayColumn)?.isVisible === false)) continue;
      if (r.status !== 'verified') add('RELATIONSHIP_UNVERIFIED', `relationships.${r.id}`, 'Quan hệ chưa được xác minh hoặc đã lỗi thời; không dùng để JOIN.');
      if (r.status === 'verified') {
        if (!source || !target || !r.columnPairs?.length || r.columnPairs.some(p => !source.columns?.some(c => c.columnName === p.sourceColumn && c.isVisible !== false) || !target.columns?.some(c => c.columnName === p.targetColumn && c.isVisible !== false)))
          add('RELATIONSHIP_COLUMN_UNAVAILABLE', `relationships.${r.id}`, 'Quan hệ verified tham chiếu bảng/cột thiếu hoặc bị tắt.', 'error');
      }
    }
    return { tableId: t.tableId, tableName: t.tableName, issues };
  });
  return { activeTables: active.length, errors: results.reduce((n,t) => n + t.issues.filter(i => i.severity === 'error').length, 0), warnings: results.reduce((n,t) => n + t.issues.filter(i => i.severity === 'warning').length, 0), tables: results };
}
module.exports = { numericTypes, dateTypes, typeOf, configurationIssues, validateConfiguration, audit };
