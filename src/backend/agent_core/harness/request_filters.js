'use strict';
const key=value=>String(value??'').normalize('NFC').toLowerCase();
function bindOne(filter, tables, question) {
  const matches=tables.filter(t=>key(t.tableName)===key(filter?.table));
  const column=matches.length===1&&matches[0].columns.find(c=>key(c.name||c.columnName)===key(filter.column)&&c.isVisible!==false);
  if(!column||!['string','number','boolean'].includes(typeof filter.value)||!filter.evidence
    ||!key(question).includes(key(filter.evidence))||!key(filter.evidence).includes(key(filter.value)))throw Error('REQUEST_FILTER_UNGROUNDED');
  let value=filter.value;
  const type=String(column.type||column.dataType||'').trim();
  const identity={table:matches[0].tableName,column:column.name||column.columnName,...(matches[0].schemaName?{schemaName:matches[0].schemaName}:{})};
  // A month/year/day on a date column is a period, never an equality: bind it
  // as the half-open range [from, to) that SQL must cover exactly.
  if(/^(date|datetime|datetime2|smalldatetime|datetimeoffset)\b/i.test(type)){
    const range=dateRange(value);
    if(!range)throw Error('REQUEST_FILTER_UNGROUNDED');
    return {...identity,value,...range,dateOnly:/^date$/i.test(type)};
  }
  if(typeof value==='string'&&/^(int|smallint|bigint|tinyint|decimal|numeric|float|real)(\(|$)/i.test(type)&&value.trim()&&Number.isFinite(Number(value)))value=Number(value);
  return {...identity,value};
}
const iso=(y,m,d)=>{const date=new Date(Date.UTC(y,m-1,d));return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d?date.toISOString().slice(0,10):null;};
// Year "2024", month "2024-02" / "02/2024", day "2024-02-15" / "15/02/2024".
function dateRange(value){
  const text=String(value??'').trim();
  let m=text.match(/^(\d{4})$/);
  if(m){const from=iso(+m[1],1,1),to=iso(+m[1]+1,1,1);return from&&to?{from,to}:null;}
  m=text.match(/^(\d{4})[-/.](\d{1,2})$/);
  const month=m?[+m[1],+m[2]]:(m=text.match(/^(\d{1,2})[-/.](\d{4})$/))?[+m[2],+m[1]]:null;
  if(month){const from=iso(month[0],month[1],1),to=month[1]===12?iso(month[0]+1,1,1):iso(month[0],month[1]+1,1);return from&&to?{from,to}:null;}
  m=text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const day=m?[+m[1],+m[2],+m[3]]:(m=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/))?[+m[3],+m[2],+m[1]]:null;
  if(day){const from=iso(...day);return from?{from,to:new Date(Date.parse(from)+86400000).toISOString().slice(0,10)}:null;}
  return null;
}
function bind(filters, tables, question) {
  if(!Array.isArray(filters)||filters.length>20)throw Error('REQUEST_FILTERS_INVALID');
  return filters.map(filter=>bindOne(filter,tables,question));
}
// One ungrounded entry must not discard the qualifiers that did bind. An entry
// quoting the question but naming no authorized column is still a requested
// qualifier: keep it as unresolved so the answer discloses the wider scope.
function bindEach(filters, tables, question) {
  if(!Array.isArray(filters)||filters.length>20)throw Error('REQUEST_FILTERS_INVALID');
  const bound=[],unresolved=[];
  for(const filter of filters) {
    try { bound.push(bindOne(filter,tables,question)); }
    catch {
      if(filter?.evidence&&key(question).includes(key(filter.evidence)))unresolved.push({evidence:String(filter.evidence).slice(0,120),reason:'REQUEST_FILTER_UNGROUNDED'});
    }
  }
  return {filters:bound,unresolved};
}
module.exports={bind,bindEach,dateRange};
