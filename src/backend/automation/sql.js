'use strict';
const { Parser } = require('node-sql-parser');
const guard = require('../intelligent_core/security_guard');
const { error } = require('./contract');
function validateBinding(binding) {
  const check = guard.validateSqlQuery(binding.sql);
  if (!check.safe) throw error(check.error);
  // Parse a parameter-neutral copy for table auditing, never for execution.
  const neutral = binding.sql.replace(/@[a-zA-Z][a-zA-Z0-9_]*/g, 'NULL');
  let ast, tables;
  try { const parser = new Parser(); ast = parser.astify(neutral, { database: 'TransactSQL' }); tables = parser.tableList(neutral, { database: 'TransactSQL' }); } catch (_) { throw error('SQL binding không phân tích được.'); }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1 || statements[0].type !== 'select' || statements[0].into?.position) throw error('Chỉ cho phép một SELECT đọc.');
  for (const table of tables) {
    const [, database, name] = table.split('::');
    const qualified = `${database === 'null' ? 'dbo' : database}.${name}`.toLowerCase();
    if (!binding.tables.some(allowed => allowed.toLowerCase() === qualified)) throw error(`Bảng SQL ngoài binding: ${qualified}`);
  }
  const parameters = [...new Set(binding.sql.match(/@[a-zA-Z][a-zA-Z0-9_]*/g) || [])].map(name => name.slice(1));
  if (parameters.some(name => !Object.hasOwn(binding.parameters || {}, name)) || Object.keys(binding.parameters || {}).some(name => !parameters.includes(name))) throw error('Tham số SQL không khớp mapping.');
  return check.cleanedSql;
}
function tableAvailable(binding, table, connector = require('../services/sql_connector')) {
  const [schema, name] = table.split('.');
  const matches = item => item.dbSourceId === binding.dbSourceId && item.tableName === name && (item.schemaName || 'dbo') === schema;
  const persisted = require('../services/dictionary_service').tablesStore.filter(matches);
  if (persisted.length) return persisted.some(item => item.isActive !== false);
  return connector.schemas.some(matches);
}
async function executeBinding(binding, input, { signal, permissions = [], state = { input, steps: {} } } = {}) {
  if (!permissions.includes('admin') && !permissions.includes('sql:read')) throw error('Không có quyền đọc SQL.', 403);
  const sql = validateBinding(binding), connector = require('../services/sql_connector');
  const source = connector.dbSources.find(item => item.id === binding.dbSourceId);
  if (!source) throw error('Nguồn SQL đã bị gỡ.', 409);
  for (const table of binding.tables) {
    if (!tableAvailable(binding, table, connector)) throw error('Bảng binding không còn trong catalog hoặc đã tắt.', 409);
  }
  for (const mapping of binding.resultMapping || []) { const dictionary = require('../services/dictionary_service'); const table = dictionary.tablesStore.find(t=>t.tableId===mapping.tableId && t.dbSourceId===binding.dbSourceId && t.isActive!==false); if (!table || !require('./column_mapping').mappedColumns(table,dictionary).some(c=>c.column.columnName===mapping.columnName && (c.relation?.id||null)===(mapping.relationId||null))) throw error('Mapping cột hoặc quan hệ đã thay đổi. Cần cập nhật SQL của mẫu.',409); }
  const parameters = Object.entries(binding.parameters || {}).map(([name, mapping]) => {
    const value = Object.hasOwn(mapping,'value') ? require('./contract').resolve(mapping.value,state) : input[mapping.slot] ?? null;
    if (Object.hasOwn(mapping,'value')) {
      const schema = mapping.type === 'date' ? { type:'string',format:'date' } : { type:mapping.type };
      ensureParameter(value,schema);
    }
    return { name, type:mapping.type, value };
  });
  const rows = guard.sanitizeTabularRows(await connector.executeSqlQuery(sql, binding.dbSourceId, signal, parameters));
  return { rows, rowCount: rows.length, source: binding.dbSourceId, retrievedAt: new Date().toISOString(), empty: rows.length === 0 };
}
function ensureParameter(value,schema) { if (value === undefined || require('./contract').validateValue(value,schema).length) throw error('Giá trị tham số từ bước trước không đúng kiểu dữ liệu.'); }
module.exports = { validateBinding, executeBinding, tableAvailable };
