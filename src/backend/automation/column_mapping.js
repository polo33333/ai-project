'use strict';
const quote = value => '[' + String(value).replace(/]/g, ']]') + ']';
function mappedColumns(table, dictionary) {
 return [...table.columns].filter(c=>c.isVisible!==false).sort((a,b)=>(a.ordinalPosition??9999)-(b.ordinalPosition??9999)).map(column=>{
  const candidates = dictionary.tableRelationships.filter(r=>r.sourceTableId===table.tableId && r.isActive!==false && r.status==='verified' && ['many-to-one','one-to-one'].includes(r.cardinality) && r.columnPairs?.some(p=>p.sourceColumn===column.columnName));
  const preferred = candidates.filter(r=>r.preferred);
  const relation = preferred.length===1 ? preferred[0] : candidates.length===1 ? candidates[0] : null;
  const target = relation && dictionary.tablesStore.find(t=>t.tableId===relation.targetTableId && t.dbSourceId===table.dbSourceId && t.isActive!==false);
  const display = target?.columns.find(c=>c.columnName===relation.displayColumn && c.isVisible!==false);
  const valid = display && relation.columnPairs.every(p=>table.columns.some(c=>c.columnName===p.sourceColumn && c.isVisible!==false) && target.columns.some(c=>c.columnName===p.targetColumn && c.isVisible!==false));
  return { column, relation:valid?relation:null, target:valid?target:null, label: valid ? relation.businessRole || column.displayName || display.displayName || column.columnName : column.displayName || column.columnName };
 });
}
function buildSelect(table, dictionary) {
 const columns = mappedColumns(table,dictionary), joins = [], tables = [`${table.schemaName||'dbo'}.${table.tableName}`];
 const resultMapping = [], expressions = columns.map(({column,relation,target,label},index)=>{
  let expression = `e.${quote(column.columnName)}`;
  if (relation) {
   const alias=`r${index}`; const qualified=`${target.schemaName||'dbo'}.${target.tableName}`;
   joins.push(`LEFT JOIN ${quote(target.schemaName||'dbo')}.${quote(target.tableName)} ${alias} ON ${relation.columnPairs.map(p=>`e.${quote(p.sourceColumn)} = ${alias}.${quote(p.targetColumn)}`).join(' AND ')}`);
   tables.push(qualified); expression=`${alias}.${quote(relation.displayColumn)}`;
  }
  resultMapping.push({key:column.columnName,tableId:table.tableId,columnName:column.columnName,relationId:relation?.id||null,label});
  return `${expression} AS ${quote(column.columnName)}`;
 });
 if (!expressions.length) throw new Error('Không có cột đang bật để tra cứu.');
 return { select:`SELECT TOP 50 ${expressions.join(', ')} FROM ${quote(table.schemaName||'dbo')}.${quote(table.tableName)} e ${joins.join(' ')}`, tables:[...new Set(tables)], resultMapping };
}
module.exports={buildSelect,mappedColumns};
