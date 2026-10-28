'use strict';
// Table scope of one actor in one SQL source ("gói bảng"): which tables the
// actor may query and at which level (full / lookup / bridge), and which
// columns each level exposes. Reads the raw dictionary, never the
// principal-filtered view, so dictionary_service may call it.
const rules = require('./policy');
const key = value => String(value ?? '').trim().toLowerCase();
const names = table => [key(table.tableId), key(table.tableName), key(`${table.schemaName || 'dbo'}.${table.tableName}`)];
// Lookup level without explicit columns: names and codes, never personal or payment identifiers.
const LOOKUP_NAME = /(name|code|ten|ma)$/i, NEVER_LOOKUP = /(tax|bank|passport|idno|phone|mobile|email|address|salary|password|otp|token)/i;
const cache = new Map();

function loadedRelations(dictionary) { try { return dictionary.tableRelationships || []; } catch { return []; } }
function relationsOf(sourceId, dictionary) {
  // A route that did not load relationships gets no automatic lookups or bridges (narrower, never wider).
  return loadedRelations(dictionary).filter(relation => relation.isActive !== false && relation.status === 'verified'
    && relation.columnPairs?.length && String(relation.sourceTableId || '').startsWith(`${key(sourceId)}::`));
}

function compute(source, actor, dictionary) {
  const policy = rules.normalize(source.governedPolicy), sql = policy.sql;
  const admin = !actor || actor.role === 'admin';
  const tables = (dictionary.tablesStore || []).filter(table => table.dbSourceId === source.id && table.isActive !== false);
  const byId = new Map(tables.map(table => [table.tableId, table]));
  const matcher = list => { const set = new Set(list.map(key)); return table => names(table).some(name => set.has(name)); };
  const inCeiling = sql.allowedTables.length ? matcher(sql.allowedTables) : () => true;
  const isHidden = matcher(sql.hiddenTables);
  const packageOf = new Map();
  for (const item of sql.packages) { const inPackage = matcher(item.tables); for (const table of tables) if (inPackage(table) && !packageOf.has(table.tableId)) packageOf.set(table.tableId, item); }
  const relations = relationsOf(source.id, dictionary).filter(relation => byId.has(relation.sourceTableId) && byId.has(relation.targetTableId));
  const keys = new Map(tables.map(table => [table.tableId, new Set(table.columns.filter(column => column.isPrimaryKey).map(column => key(column.columnName)))]));
  const display = new Map();
  for (const relation of relations) {
    for (const pair of relation.columnPairs) { keys.get(relation.sourceTableId).add(key(pair.sourceColumn)); keys.get(relation.targetTableId).add(key(pair.targetColumn)); }
    if (relation.displayColumn) (display.get(relation.targetTableId) || display.set(relation.targetTableId, new Set()).get(relation.targetTableId)).add(key(relation.displayColumn));
  }
  // Source-level blocked columns apply to everyone; package sensitive columns to everyone but admin.
  const blocked = new Set(sql.blockedColumns.map(key));
  const sensitive = (table, column) => {
    const names3 = [key(column), key(`${table.tableName}.${column}`), key(`${table.schemaName || 'dbo'}.${table.tableName}.${column}`)];
    if (names3.some(name => blocked.has(name))) return true;
    const item = packageOf.get(table.tableId);
    return !admin && Boolean(item) && item.sensitiveColumns.some(entry => names3.includes(key(entry)));
  };
  const usable = table => inCeiling(table) && !isHidden(table);
  const levels = new Map();
  const grant = (table, level, via) => { if (!usable(table)) return; const current = levels.get(table.tableId); if (rules.higherLevel(current?.level, level) !== current?.level) levels.set(table.tableId, { level, via }); };
  const open = !sql.packages.length;
  if (open || admin) for (const table of tables) grant(table, 'full', open ? 'source' : 'admin');
  else {
    for (const item of sql.packages) if (item.base) for (const table of tables) if (packageOf.get(table.tableId) === item) grant(table, item.baseLevel || 'full', item.id);
    const granted = actor.grants?.packages?.[source.id] || {};
    for (const [packageId, level] of Object.entries(granted)) for (const table of tables) if (packageOf.get(table.tableId)?.id === packageId) grant(table, level, packageId);
    // Q1: direct lookup targets of a granted table become readable as lookups.
    const granted1 = new Set(levels.keys());
    for (const relation of relations) {
      const cardinality = relation.cardinality || relation.relationType;
      if (granted1.has(relation.sourceTableId) && ['many-to-one', 'one-to-one'].includes(cardinality)) grant(byId.get(relation.targetTableId), 'lookup', 'auto');
      if (granted1.has(relation.targetTableId) && cardinality === 'one-to-many') grant(byId.get(relation.sourceTableId), 'lookup', 'auto');
    }
    // Q2: tables of packages that allow it may be joined through (keys only).
    for (const table of tables) if (!levels.has(table.tableId) && usable(table) && packageOf.get(table.tableId)?.allowBridge) levels.set(table.tableId, { level: 'bridge', via: 'auto' });
  }
  const entries = new Map(), lookup = new Map();
  for (const [tableId, { level, via }] of levels) {
    const table = byId.get(tableId), tableKeys = keys.get(tableId), item = packageOf.get(tableId);
    // Without packages the source keeps its old rule: every column except blocked ones.
    const visible = table.columns.filter(column => (open || column.isVisible !== false) && !sensitive(table, column.columnName)).map(column => key(column.columnName));
    const shown = level === 'full' ? visible
      : level === 'lookup' ? visible.filter(name => tableKeys.has(name) || display.get(tableId)?.has(name)
        || (item?.lookupColumns?.length ? item.lookupColumns.map(key).includes(name) : LOOKUP_NAME.test(name) && !NEVER_LOOKUP.test(name)))
        : visible.filter(name => tableKeys.has(name));
    const entry = { table, level, via, packageId: item?.id || null, packageName: item?.name || null, columns: new Set(shown), keys: tableKeys,
      known: new Set(table.columns.map(column => key(column.columnName))) };
    entries.set(tableId, entry);
    for (const name of names(table)) lookup.set(name, entry);
  }
  const packageFor = new Map();
  for (const table of tables) for (const name of names(table)) packageFor.set(name, { table, packageName: packageOf.get(table.tableId)?.name || null, hidden: isHidden(table), outside: !inCeiling(table) });
  return { sourceId: source.id, open, admin, entries, lookup, packageFor, policy,
    inCeiling: name => !sql.allowedTables.length || sql.allowedTables.map(key).some(item => item === key(name) || item === `dbo.${key(name)}`),
    hiddenName: name => sql.hiddenTables.map(key).some(item => item === key(name) || item === `dbo.${key(name)}`),
    blockedName: name => blocked.has(key(name)) };
}

function effectiveScope(source, actor) {
  const dictionary = require('../services/dictionary_service');
  const revision = rules.normalize(source.governedPolicy).revision;
  const cacheKey = `${source.id}|${revision}|${actor ? `${actor.role}|${actor.accessRevision || ''}|${JSON.stringify(actor.grants?.packages?.[source.id] || {})}` : 'system'}`;
  // Table switches, column visibility and relationship edits change objects in place,
  // so the cache also checks a signature of what compute() reads.
  const signature = catalogSignature(source.id, dictionary);
  const hit = cache.get(cacheKey);
  if (hit && hit.tables === dictionary.tablesStore && hit.relations === loadedRelations(dictionary) && hit.policy === source.governedPolicy && hit.signature === signature) return hit.scope;
  const scope = compute(source, actor, dictionary);
  if (cache.size > 500) cache.clear();
  cache.set(cacheKey, { scope, tables: dictionary.tablesStore, relations: loadedRelations(dictionary), policy: source.governedPolicy, signature });
  return scope;
}
function catalogSignature(sourceId, dictionary) {
  const parts = [];
  for (const table of dictionary.tablesStore || []) if (table.dbSourceId === sourceId)
    parts.push(`${table.tableId}:${table.isActive === false ? 0 : 1}:${(table.columns || []).map(column => column.isVisible === false ? 0 : 1).join('')}`);
  for (const relation of relationsOf(sourceId, dictionary)) parts.push(`${relation.id}:${relation.revision || 0}`);
  return parts.join('|');
}

// Who reads a table once it is active: its package, whether it is hidden, and
// the roles that get it (through function groups or as a base package).
function tableAccess(source, tableId) {
  const dictionary = require('../services/dictionary_service'), roles = require('../services/account_roles');
  const policy = rules.normalize(source.governedPolicy), table = (dictionary.tablesStore || []).find(item => item.tableId === tableId);
  if (!table) return null;
  const name = `${table.schemaName || 'dbo'}.${table.tableName}`, matches = list => list.map(key).some(item => names(table).includes(item));
  if (!policy.sql.packages.length) return { table: name, open: true, hidden: matches(policy.sql.hiddenTables), roles: [] };
  if (matches(policy.sql.hiddenTables)) return { table: name, hidden: true, roles: [] };
  const item = policy.sql.packages.find(entry => matches(entry.tables));
  if (!item) return { table: name, orphan: true, roles: [] };
  const access = roles.list().filter(role => role.id !== 'admin').map(role => {
    const effective = roles.effective({ role: role.id });
    if (!effective.permissions.includes('sql:read')) return null;
    const level = rules.higherLevel(item.base ? item.baseLevel : undefined, effective.grants?.packages?.[source.id]?.[item.id]);
    return level ? { id: role.id, name: role.name, level } : null;
  }).filter(Boolean);
  return { table: name, packageId: item.id, packageName: item.name, base: item.base, roles: access };
}

function forCurrent(source) {
  const governance = require('./context');
  return effectiveScope(source, governance.current() ? governance.principal() : null);
}

// Dictionary view for the actor: tables outside the scope are removed and
// columns the level does not expose are marked hidden.
function maskTables(tables, source, actor) {
  const scope = effectiveScope(source, actor);
  if (scope.admin && !scope.policy.sql.hiddenTables.length && !scope.policy.sql.blockedColumns.length) return tables;
  return tables.filter(table => scope.entries.has(table.tableId)).map(table => {
    const entry = scope.entries.get(table.tableId);
    if (table.columns.every(column => column.isVisible === false || entry.columns.has(key(column.columnName)))) return table;
    return { ...table, accessLevel: entry.level, columns: table.columns.map(column => entry.columns.has(key(column.columnName)) ? column : { ...column, isVisible: false }) };
  });
}

// Plain-language reason a table is out of scope (Q7).
function denialMessage(scope, tableName) {
  const info = scope.packageFor.get(key(tableName)) || scope.packageFor.get(`dbo.${key(tableName)}`);
  if (info?.hidden || scope.hiddenName(tableName)) return `Bảng “${tableName}” bị ẩn khỏi AI.`;
  if (info?.outside) return `Bảng “${tableName}” nằm ngoài phạm vi được phép của nguồn.`;
  if (info?.packageName) return `Vai trò của bạn chưa có gói “${info.packageName}” nên chưa truy vấn được bảng “${tableName}”.`;
  if (info) return `Bảng “${tableName}” chưa thuộc gói bảng nào; chỉ quản trị viên truy vấn được.`;
  return 'Bảng SQL ngoài phạm vi được phép.';
}

module.exports = { effectiveScope, forCurrent, maskTables, denialMessage, tableAccess, key };
