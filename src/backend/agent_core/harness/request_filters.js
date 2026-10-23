'use strict';
const key=value=>String(value??'').normalize('NFC').toLowerCase();
function bind(filters, tables, question) {
  if(!Array.isArray(filters)||filters.length>20)throw Error('REQUEST_FILTERS_INVALID');
  return filters.map(filter=>{
    const matches=tables.filter(t=>key(t.tableName)===key(filter.table));
    const column=matches.length===1&&matches[0].columns.find(c=>key(c.name||c.columnName)===key(filter.column)&&c.isVisible!==false);
    if(!column||!['string','number','boolean'].includes(typeof filter.value)||!filter.evidence
      ||!key(question).includes(key(filter.evidence))||!key(filter.evidence).includes(key(filter.value)))throw Error('REQUEST_FILTER_UNGROUNDED');
    let value=filter.value;
    if(typeof value==='string'&&/^(int|smallint|bigint|tinyint|decimal|numeric|float|real)(\(|$)/i.test(column.type||column.dataType||'')&&value.trim()&&Number.isFinite(Number(value)))value=Number(value);
    return {table:matches[0].tableName,column:column.name||column.columnName,value};
  });
}
module.exports={bind};
