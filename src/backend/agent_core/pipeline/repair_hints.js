'use strict';

// One targeted hint for a rejected contract, built from the catalog: the
// repair round gets the valid names and the rule it broke, not only an error
// code. Hints name catalog metadata only, never values from the database.
const catalogApi = require('./query_catalog');

const { key } = catalogApi;
const MAX_REFS = 8;
const RANKING = 'A ranking ("cao nhất", "top 5") groups by the entity, measures the amount, and sorts with sort {by:"measure:0", direction:"DESC"} plus limit.';
const RECORD = 'A question for the record with the highest or lowest value of one column ("nhân viên nào trẻ nhất", "hóa đơn nào lớn nhất") '
  + 'is operation=list with sort {by:"Root.Column"} and limit 1, without measures; youngest is the latest birth date (DESC).';
const PERIOD = /^\d{4}(?:-\d{1,2}){0,2}$/;

// The table and column a ref or error detail points at ("A.B->C.D" -> C, D).
function target(text) {
  const last = String(text || '').split('->').pop().trim();
  const dot = last.lastIndexOf('.');
  return dot > 0 ? { table: last.slice(0, dot), column: last.slice(dot + 1) } : { table: '', column: last };
}

// Refs usable from the root: its columns, then one lookup hop through each
// unambiguous foreign key, ranked by closeness to the rejected name.
function suggest(catalog, rootName, wanted) {
  const root = catalogApi.table(catalog, rootName);
  if (!root) return [];
  const candidates = [...root.columns.values()].map(column => ({ ref: `${root.tableName}.${column.name}`, table: root.tableName, column: column.name }));
  for (const relation of catalog.relations.filter(item => key(item.fromTable) === key(root.tableName))) {
    const source = relation.pairs[0].source;
    const lookup = catalogApi.table(catalog, relation.toTable);
    if (!lookup || catalogApi.foreignKey(catalog, root.tableName, source) !== relation) continue;
    for (const column of lookup.columns.values()) if (!column.pk)
      candidates.push({ ref: `${root.tableName}.${source}->${column.name}`, table: lookup.tableName, column: column.name, display: key(column.name) === key(relation.display) });
  }
  const { table, column } = target(wanted);
  const score = item => (column && key(item.column) === key(column) ? 4 : 0)
    + (column && (key(item.column).includes(key(column)) || key(column).includes(key(item.column))) ? 1 : 0)
    + (table && key(item.table) === key(table) ? 2 : 0) + (item.display ? 1 : 0);
  return candidates.map((item, index) => ({ ...item, rank: score(item), index }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index).slice(0, MAX_REFS).map(item => item.ref);
}

// followup: the question continues PREVIOUS turns.
function hint(error, contract = {}, catalog, { followup = false } = {}) {
  const detail = String(error?.message || '').split('\n')[0].replace(/^V2_[A-Z_]+:\s*/, '');
  const root = catalog && catalogApi.table(catalog, contract?.root);
  switch (error?.code) {
    case 'V2_COLUMN_UNKNOWN': case 'V2_LOOKUP_UNKNOWN': case 'V2_LOOKUP_UNREACHABLE': case 'V2_REF_INVALID': {
      const refs = root ? suggest(catalog, root.tableName, detail) : [];
      return refs.length ? `Use refs that exist, e.g. ${refs.join(', ')}. A lookup column is reached through the root's foreign key `
        + `("${root.tableName}.FKColumn->LookupColumn"), not by naming the lookup table's own key.` : '';
    }
    case 'V2_LOOKUP_AMBIGUOUS':
      return 'Several foreign keys reach that table: name the one the question means as "Root.FKColumn->LookupColumn".';
    case 'V2_TIME_NOT_DATE':
      return `grain (day/month/year) applies only to a date column, and ${detail} is not one: group by it without grain`
        + `${root?.dateColumn ? `, or by ${root.tableName}.${root.dateColumn} with grain when the question asks for periods` : ''}.`;
    case 'V2_METRIC_UNKNOWN': {
      const metrics = (catalog?.metrics || []).filter(item => !root || key(item.table) === key(root.tableName)).map(item => item.id);
      return `metric must be an approved metric id${metrics.length ? ` (${metrics.join(', ')})` : ''}; otherwise give ref and aggregation instead of metric.`;
    }
    case 'V2_MEASURE_REQUIRED':
      return `operation=aggregate needs measures. ${RANKING} ${RECORD}`;
    case 'V2_SORT_INVALID':
      return `sort.by is "measure:<index>" for a measure, or a ref that is in groupBy. ${RANKING}`;
    case 'V2_FILTER_UNGROUNDED':
      // The quote itself is missing from QUESTION ("ref \"quote\""): in a follow-up it is carried scope.
      return (followup && detail.endsWith('"') ? 'A filter carried from PREVIOUS keeps the evidence quoted from the previous question and sets inherited=true; '
        + 'drop it if the current question replaces it. ' : '')
        + 'evidence must be an exact quote from QUESTION, and the value must appear in it as whole words. A code or name is filtered on the '
        + 'column that holds it (through its lookup "Root.FKColumn->CodeColumn"), never as an invented numeric ID.';
    case 'V2_FILTER_TYPE': {
      const values = detail.includes(' = ') ? detail.slice(detail.indexOf(' = ') + 3).split(',').map(item => item.trim()) : [];
      if (values.length && values.every(item => PERIOD.test(item)))
        return `${values.join(', ')} is a date, month or year: filter it with operator=period on a date column`
          + `${root?.dateColumn ? ` (the business date is ${root.tableName}.${root.dateColumn})` : ''}, never on an ID column.`;
      return 'A code or name never matches a numeric ID column: filter the lookup column that holds it ("Root.FKColumn->CodeColumn").';
    }
    case 'V2_FILTER_VALUE_REQUIRED':
      return `The filter on ${detail} has no value. eq/ne/contains need value and in/notIn need values, quoted from QUESTION. `
        + '"theo X" / "by X" asks to group by X (groupBy), not to filter it: remove a filter the question gives no value for.';
    default:
      return '';
  }
}

module.exports = { hint, suggest };
