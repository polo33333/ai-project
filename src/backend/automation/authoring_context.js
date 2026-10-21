'use strict';

// Only catalog metadata leaves this boundary: never connection strings or sample rows.
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value[key] !== undefined).map(key => [key, value[key]]));
function authoringContext(connector, dictionary) {
  const sources = connector.dbSources.filter(source => source.mode === 'live' || source.type === 'Direct Live Connection')
    .map(source => pick(source, ['id', 'name', 'dbName', 'type', 'mode']));
  const tables = dictionary.getGroupedTables().filter(table => table.isActive !== false && sources.some(source => source.id === table.dbSourceId))
    .map(table => ({ ...pick(table, ['tableId', 'dbSourceId', 'dbName', 'schemaName', 'tableName', 'description', 'domain', 'defaultMetric', 'defaultTimeColumn', 'defaultAggregation']),
      columns: (table.columns || []).filter(column => column.isVisible !== false).map(column => pick(column, ['columnName', 'dataType', 'description', 'displayName', 'isPrimaryKey', 'isNullable'])) }));
  const relationships = dictionary.getTableRelationships().filter(relation => relation.isActive !== false
    && ['sourceTableId', 'targetTableId'].every(key => tables.some(table => table.tableId === relation[key])))
    .map(relation => pick(relation, ['id', 'sourceTableId', 'targetTableId', 'columnPairs', 'cardinality', 'status', 'description', 'defaultJoinType']));
  return { sources, tables, relationships };
}
module.exports = { authoringContext };
