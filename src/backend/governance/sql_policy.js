'use strict';
const { Parser } = require('node-sql-parser');
function check(sql, source) {
  const validation = require('../intelligent_core/security_guard').validateSqlQuery(sql);
  if (!validation.safe) throw Object.assign(new Error(validation.error), { code: 'SQL_READ_ONLY_DENIED', statusCode: 403 });
  const policy = source.governedPolicy || {};
  if (!policy.allowedTables?.length && !policy.blockedColumns?.length) return validation.cleanedSql;
  const parser = new Parser(), neutral = validation.cleanedSql.replace(/@[a-zA-Z][a-zA-Z0-9_]*/g, 'NULL');
  const options = { database: 'TransactSQL' };
  const tables = parser.tableList(neutral, options).map(value => value.split('::').slice(1).filter(value => value !== 'null').join('.').toLowerCase());
  const allowed = (policy.allowedTables || []).map(value => value.toLowerCase());
  if (allowed.length && tables.some(value => !allowed.includes(value) && !allowed.includes(`dbo.${value}`))) throw Object.assign(new Error('Bảng SQL ngoài phạm vi được phép.'), { code: 'SQL_TABLE_DENIED', statusCode: 403 });
  const blocked = (policy.blockedColumns || []).map(value => value.toLowerCase());
  const columns = parser.columnList(neutral, options).map(value => value.split('::').at(-1).toLowerCase());
  if (blocked.length && columns.some(value => ['*', '(.*)'].includes(value) || blocked.includes(value))) throw Object.assign(new Error('Truy vấn dùng cột bị hạn chế hoặc SELECT *.'), { code: 'SQL_COLUMN_DENIED', statusCode: 403 });
  return validation.cleanedSql;
}
module.exports = { check };
