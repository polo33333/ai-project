'use strict';
const { Parser } = require('node-sql-parser');
const scopes = require('./scope');
const OPTIONS = { database: 'TransactSQL' };
const key = scopes.key;
const deny = (code, message) => Object.assign(new Error(message), { code, statusCode: 403 });
const columnName = ref => typeof ref.column === 'string' ? ref.column : ref.column?.expr?.value;

// Column references of one expression tree. Subqueries are returned apart so
// they are checked as statements with their own FROM list.
function collect(node, refs, nested) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(item => collect(item, refs, nested)); return; }
  if (node.ast) { nested.push(node.ast); return; }
  if (node.type === 'select' && node.from !== undefined) { nested.push(node); return; }
  if (node.type === 'column_ref') { refs.push(node); return; }
  for (const value of Object.values(node)) collect(value, refs, nested);
}

// Checks one SELECT statement against the actor's table scope (gói bảng):
// tables must be in scope; columns outside JOIN ... ON must be readable at the
// table's level; bridge tables and sensitive columns may only appear in ON.
function checkStatement(ast, scope, derived = new Set()) {
  for (let statement = ast; statement; statement = statement._next) {
    if (statement.type !== 'select') throw deny('SQL_READ_ONLY_DENIED', 'Chỉ cho phép câu lệnh SELECT.');
    const local = new Set(derived);
    for (const cte of statement.with || []) { checkStatement(cte.stmt?.ast || cte.stmt, scope, local); local.add(key(cte.name?.value || cte.name)); }
    const aliases = new Map(), physical = [];
    for (const item of statement.from || []) {
      if (item.expr?.ast) { checkStatement(item.expr.ast, scope, local); aliases.set(key(item.as), 'derived'); continue; }
      if (!item.table) continue;
      if (!item.db && local.has(key(item.table))) { aliases.set(key(item.as || item.table), 'derived'); continue; }
      const name = item.db ? `${item.db}.${item.table}` : item.table;
      const entry = resolve(scope, name);
      aliases.set(key(item.as || item.table), entry); aliases.set(key(item.table), entry); physical.push(entry);
    }
    const selectAliases = new Set((Array.isArray(statement.columns) ? statement.columns : []).map(column => key(column.as)).filter(Boolean));
    const join = [], other = [], nested = [];
    for (const item of statement.from || []) collect(item.on, join, nested);
    for (const part of ['columns', 'where', 'groupby', 'having', 'orderby', 'top', 'limit']) collect(statement[part], other, nested);
    nested.forEach(sub => checkStatement(sub, scope, local));
    for (const ref of join) checkColumn(ref, aliases, physical, selectAliases, true);
    for (const ref of other) checkColumn(ref, aliases, physical, selectAliases, false);
  }
}

function resolve(scope, name) {
  const entry = scope.lookup.get(key(name)) || scope.lookup.get(`dbo.${key(name)}`);
  if (entry) {
    if (!scope.open && entry.level === undefined) throw deny('SQL_TABLE_DENIED', scopes.denialMessage(scope, name));
    return entry;
  }
  // Without packages, a table unknown to the dictionary is judged by name only.
  if (scope.open && scope.inCeiling(name) && !scope.hiddenName(name) && !scope.packageFor.has(key(name)) && !scope.packageFor.has(`dbo.${key(name)}`))
    return { level: 'full', columns: null, keys: new Set(), known: null, table: { tableName: name }, blocked: scope.blockedName, hasBlocked: scope.policy.sql.blockedColumns.length > 0 };
  throw deny('SQL_TABLE_DENIED', scopes.denialMessage(scope, name));
}

function checkColumn(ref, aliases, physical, selectAliases, inJoin) {
  const name = columnName(ref);
  if (!name) return;
  const column = key(name);
  let candidates;
  if (ref.table) {
    const target = aliases.get(key(ref.table));
    if (target === 'derived') return;
    candidates = target ? [target] : [];
    if (!target) throw deny('SQL_TABLE_DENIED', 'Bảng SQL ngoài phạm vi được phép.');
  } else {
    if (!physical.length) return;
    candidates = physical.filter(entry => !entry.known || entry.known.has(column));
    if (!candidates.length) {
      if (selectAliases.has(column) || [...aliases.values()].includes('derived')) return;
      if (column !== '*') throw deny('SQL_COLUMN_DENIED', `Cột “${name}” không có trong phạm vi được phép.`);
      candidates = physical;
    }
  }
  for (const entry of candidates) {
    if (column === '*') {
      if (entry.columns === null ? !entry.hasBlocked : entry.level === 'full' && [...entry.known].every(name => entry.columns.has(name))) continue;
      throw deny('SQL_COLUMN_DENIED', 'Truy vấn dùng SELECT * trên bảng có cột hạn chế. Hãy liệt kê các cột cần lấy.');
    }
    if (entry.columns === null) { if (entry.blocked(name)) throw deny('SQL_COLUMN_DENIED', 'Truy vấn dùng cột bị hạn chế hoặc SELECT *.'); continue; }
    if (inJoin && entry.keys.has(column)) continue;
    if (entry.level === 'bridge') throw deny('SQL_COLUMN_DENIED', `Bảng “${entry.table.tableName}” chỉ dùng để nối bảng, không đọc được cột “${name}”.`);
    if (!entry.columns.has(column)) throw deny('SQL_COLUMN_DENIED', entry.level === 'lookup'
      ? `Bảng “${entry.table.tableName}” chỉ được tra cứu (mã, tên); không đọc được cột “${name}”.`
      : `Truy vấn dùng cột bị hạn chế “${name}”.`);
  }
}

// Q5: a single-table SELECT * becomes the list of columns the actor may read.
function expandStar(ast, scope, parser) {
  if (!ast || ast.type !== 'select' || ast._next || ast.with?.length || (ast.from || []).length !== 1 || !ast.from[0].table) return null;
  const columns = Array.isArray(ast.columns) ? ast.columns : [];
  if (columns.length !== 1 || columns[0].expr?.type !== 'column_ref' || columnName(columns[0].expr) !== '*') return null;
  const item = ast.from[0], entry = scope.lookup.get(key(item.db ? `${item.db}.${item.table}` : item.table)) || scope.lookup.get(`dbo.${key(item.table)}`);
  if (!entry || entry.level === 'bridge') return null;
  const names = entry.table.columns.filter(column => entry.columns.has(key(column.columnName))).map(column => column.columnName);
  if (!names.length) return null;
  ast.columns = names.map(name => ({ expr: { type: 'column_ref', table: columns[0].expr.table || null, column: name }, as: null }));
  return parser.sqlify(ast, OPTIONS);
}

function check(sql, source) {
  const guard = require('../intelligent_core/security_guard');
  const validation = guard.validateSqlQuery(sql);
  if (!validation.safe) throw Object.assign(new Error(validation.error), { code: 'SQL_READ_ONLY_DENIED', statusCode: 403 });
  const scope = scopes.forCurrent(source), sqlPolicy = scope.policy.sql;
  const restricted = sqlPolicy.allowedTables.length || sqlPolicy.blockedColumns.length || sqlPolicy.hiddenTables.length || !scope.open;
  if (!restricted) return validation.cleanedSql;
  const parser = new Parser();
  const neutral = sql => sql.replace(/@[a-zA-Z][a-zA-Z0-9_]*/g, 'NULL');
  let ast;
  try { ast = parser.astify(neutral(validation.cleanedSql), OPTIONS); }
  catch { throw deny('SQL_TABLE_DENIED', 'Không phân tích được câu SQL để kiểm tra phạm vi bảng.'); }
  if (Array.isArray(ast)) { if (ast.length !== 1) throw deny('SQL_READ_ONLY_DENIED', 'Chỉ cho phép một câu lệnh SELECT.'); [ast] = ast; }
  try {
    checkStatement(ast, scope);
  } catch (error) {
    if (error.code !== 'SQL_COLUMN_DENIED' || !/SELECT \*/.test(error.message)) throw error;
    const expanded = expandStar(structuredClone(ast), scope, parser);
    if (!expanded || /@[a-zA-Z]/.test(validation.cleanedSql)) throw error;
    const next = guard.validateSqlQuery(expanded);
    if (!next.safe) throw error;
    checkStatement(parser.astify(neutral(next.cleanedSql), OPTIONS), scope);
    return next.cleanedSql;
  }
  return validation.cleanedSql;
}
module.exports = { check, checkStatement };
