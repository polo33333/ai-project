'use strict';
function periodColumns(sql) {
  try {
    const parsed = new (require('node-sql-parser').Parser)().astify(sql, { database: 'TransactSQL' });
    let ast = Array.isArray(parsed) ? parsed[0] : parsed;
    while (ast.from?.length === 1 && ast.from[0].expr?.ast) ast = ast.from[0].expr.ast;
    const parts = {};
    for (const column of ast.columns || []) {
      const expr = column.expr, name = expr?.name?.name?.[0]?.value?.toUpperCase();
      if (expr?.type === 'function' && ['YEAR', 'MONTH'].includes(name) && column.as && expr.args?.value?.[0]?.type === 'column_ref')
        parts[name] = { alias: column.as, source: JSON.stringify(expr.args.value[0]) };
    }
    return parts.YEAR && parts.MONTH && parts.YEAR.source === parts.MONTH.source ? parts : null;
  } catch { return null; }
}
function periodLabel(row, parts) {
  if (!parts) return null;
  const year = Number(row[parts.YEAR.alias]), month = Number(row[parts.MONTH.alias]);
  return Number.isInteger(year) && year >= 1000 && year <= 9999 && Number.isInteger(month) && month >= 1 && month <= 12
    ? `${year}-${String(month).padStart(2, '0')}` : null;
}
function bindMonthly(args, source) {
  try {
    const sql = source.result.sql || source.args?.sql || '', parts = periodColumns(sql);
    let ast = new (require('node-sql-parser').Parser)().astify(sql, { database: 'TransactSQL' });
    if (Array.isArray(ast)) return null;
    while (ast.from?.length === 1 && ast.from[0].expr?.ast) ast = ast.from[0].expr.ast;
    const measures = (ast.columns || []).filter(column => column.expr?.type === 'aggr_func' && column.as).map(column => column.as);
    if (!measures.length || !source.result.rows.length) return null;
    const month = value => {
      const text = value instanceof Date ? value.toISOString() : String(value ?? '');
      const year = Number(text.slice(0, 4)), number = Number(text.slice(5, 7));
      return text[4] === '-' && Number.isInteger(year) && year >= 1000 && year <= 9999 && Number.isInteger(number) && number >= 1 && number <= 12
        ? text.slice(0, 7) : null;
    };
    const dateAliases = (ast.columns || []).filter(column => column.as && column.expr?.type === 'function'
      && ['DATEFROMPARTS', 'FORMAT', 'DATETRUNC', 'EOMONTH'].includes(column.expr.name?.name?.[0]?.value?.toUpperCase())).map(column => column.as);
    const dateAlias = dateAliases.find(alias => source.result.rows.every(row => month(row[alias])));
    const entries = source.result.rows.map(row => ({ row, label: parts ? periodLabel(row, parts) : dateAlias ? month(row[dateAlias]) : null }));
    if (entries.some(item => !item.label) || new Set(entries.map(item => item.label)).size !== entries.length
      || entries.some(({ row }) => measures.some(column => typeof row[column] !== 'number' || !Number.isFinite(row[column])))) return null;
    entries.sort((a, b) => a.label.localeCompare(b.label));
    return { type: args.type, title: args.title, labels: entries.map(item => item.label), datasets: measures.map((column, index) => ({
      label: args.datasets?.length === measures.length ? args.datasets[index]?.label || column : column,
      data: entries.map(item => item.row[column]) })) };
  } catch { return null; }
}
module.exports = { periodColumns, periodLabel, bindMonthly };
