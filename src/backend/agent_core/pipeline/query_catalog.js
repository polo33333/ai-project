'use strict';

// Permission-filtered metadata the query contract may reference: the tables
// schema retrieval selected, plus their direct many-to-one lookup targets, and
// the verified relationships between them. Lookups are what turn a customer
// code, a status name or "Kỳ 3" into a filter on the right foreign key.
const MAX_TABLES = 10;
const key = value => String(value ?? '').trim().toLowerCase();

function build(selection, { include = [], dictionary = require('../../services/dictionary_service'),
  relationships = require('../../services/relationship_service') } = {}) {
  const dbSourceId = selection.dbSourceId;
  const authorized = new Set([...(selection.tableDirectory || []).map(item => key(item.tableName)),
    ...(selection.intentCatalog || []).map(item => key(item.tableName))]);
  const all = dictionary.getGroupedTables().filter(table => table.isActive !== false && table.dbSourceId === dbSourceId
    && authorized.has(key(table.tableName)));
  // Blocked columns arrive hidden in the selection; keep that visibility.
  const hidden = new Set((selection.intentCatalog || []).flatMap(table => (table.columns || [])
    .filter(column => column.isVisible === false).map(column => `${key(table.tableName)}.${key(column.name)}`)));
  const verified = relationships.verifiedRelationships({ dbSourceId })
    .filter(relation => relation.columnPairs?.length && ['many-to-one', 'one-to-one'].includes(relation.cardinality || relation.relationType));
  const byName = new Map(all.map(table => [key(table.tableName), table]));
  // `include` adds tables of the previous contract; they must still be authorized.
  const selected = [...new Set([...(selection.selectedTables || []), ...include].map(key))].filter(name => byName.has(name));
  const names = new Set(selected);
  for (const name of selected) {
    for (const relation of verified) if (key(relation.sourceTable) === name && byName.has(key(relation.targetTable)) && names.size < MAX_TABLES) names.add(key(relation.targetTable));
  }
  const tables = new Map();
  for (const name of names) {
    const table = byName.get(name);
    const columns = new Map(table.columns.filter(column => column.isVisible !== false && !hidden.has(`${name}.${key(column.columnName)}`))
      .map(column => [key(column.columnName), { name: column.columnName, type: String(column.dataType || '').toLowerCase().split('(')[0],
        label: column.displayName || '', pk: Boolean(column.isPrimaryKey) }]));
    const model = table.semanticModel || {};
    const defaults = (model.summaryFields?.length ? model.summaryFields : [...columns.values()]
      .filter(column => column.pk || /(code|name|no)$/i.test(column.name)).map(column => column.name)).filter(field => columns.has(key(field))).slice(0, 8);
    tables.set(name, { tableId: table.tableId, tableName: table.tableName, schemaName: table.schemaName || 'dbo',
      label: model.entity || String(table.tableDescription || '').split(/[.\n]/)[0].slice(0, 80), columns, defaults,
      grain: model.grain || '', money: (model.monetaryFields || []).filter(field => columns.has(key(field))),
      defaultMeasure: columns.has(key(table.defaultMetric)) ? table.defaultMetric : '',
      dateColumn: columns.has(key(table.defaultTimeColumn)) ? table.defaultTimeColumn : '' });
  }
  const relations = verified.filter(relation => tables.has(key(relation.sourceTable)) && tables.has(key(relation.targetTable))
    && relation.columnPairs.every(pair => tables.get(key(relation.sourceTable)).columns.has(key(pair.sourceColumn))
      && tables.get(key(relation.targetTable)).columns.has(key(pair.targetColumn))))
    .map(relation => ({ id: relation.id, revision: relation.revision, fromTable: tables.get(key(relation.sourceTable)).tableName,
      toTable: tables.get(key(relation.targetTable)).tableName, pairs: relation.columnPairs.map(pair => ({ source: pair.sourceColumn, target: pair.targetColumn })),
      role: relation.businessRole || '', display: tables.get(key(relation.targetTable)).columns.has(key(relation.displayColumn)) ? relation.displayColumn : '' }));
  return { dbSourceId, tables, relations };
}

function table(catalog, name) { return catalog.tables.get(key(name)) || null; }
function column(catalog, tableName, columnName) { return table(catalog, tableName)?.columns.get(key(columnName)) || null; }
// The verified many-to-one relationship leaving `tableName` through `columnName`.
function foreignKey(catalog, tableName, columnName) {
  const matches = catalog.relations.filter(relation => key(relation.fromTable) === key(tableName) && key(relation.pairs[0].source) === key(columnName));
  return matches.length === 1 ? matches[0] : null;
}

// Compact text for the contract prompt: one line per column, foreign keys
// annotated with their lookup target, role and display column.
function describe(catalog) {
  const lines = [];
  for (const entry of catalog.tables.values()) {
    lines.push(`TABLE ${entry.tableName}${entry.label ? ` — ${entry.label}` : ''}${entry.defaults.length ? ` (default list: ${entry.defaults.join(', ')})` : ''}`);
    const facts = [entry.grain && `grain: ${entry.grain}`, entry.dateColumn && `business date: ${entry.dateColumn}`,
      entry.defaultMeasure && `default measure: ${entry.defaultMeasure}`, entry.money?.length && `money: ${entry.money.join(', ')}`].filter(Boolean);
    if (facts.length) lines.push(`  (${facts.join('; ')})`);
    for (const item of entry.columns.values()) {
      const fk = foreignKey(catalog, entry.tableName, item.name);
      lines.push(`  ${item.name} ${item.type}${item.pk ? ' PK' : ''}${item.label ? ` "${item.label}"` : ''}`
        + (fk ? ` -> ${fk.toTable}${fk.role ? ` [${fk.role}]` : ''}${fk.display ? ` shows ${fk.display}` : ''}` : ''));
    }
  }
  return lines.join('\n');
}

module.exports = { build, table, column, foreignKey, describe, key };
