'use strict';
// Bind the semantic review to visible physical columns before it can override
// a table's fallback metric. The SQL still has to project every bound measure.
function bind(measures, tables) {
  if (!Array.isArray(measures) || !measures.length || measures.length > 10) return null;
  const bound = measures.map(measure => {
    const matches = tables.filter(table => table.tableName === measure.table);
    const column = matches.length === 1 && matches[0].columns.find(column =>
      (column.name || column.columnName) === measure.column && column.isVisible !== false);
    if (!column || !['SUM','AVG','MIN','MAX','COUNT'].includes(measure.aggregation)
      || (measure.aggregation !== 'COUNT' && !/^(tinyint|smallint|int|bigint|decimal|numeric|float|real|money|smallmoney)(\(|$)/i.test(column.type || column.dataType || '')))
      throw Object.assign(new Error('REQUEST_MEASURE_UNAVAILABLE'), { code: 'REQUEST_MEASURE_UNAVAILABLE' });
    return { table: measure.table, column: measure.column, aggregation: measure.aggregation };
  });
  return bound;
}
module.exports = { bind };
