'use strict';
const fail=code=>Object.assign(new Error(code),{code,statusCode:400});
const field={type:'string',minLength:1,maxLength:128};
const dateOffset={type:'object',additionalProperties:false,required:['anchorDate','offsetDays'],properties:{anchorDate:{type:'string',pattern:'^(today|[0-9]{4}-[0-9]{2}-[0-9]{2})$',description:'Use today for the authoritative backend request date; use a literal only for an explicitly requested historical anchor.'},offsetDays:{type:'integer',minimum:-36600,maximum:36600}}};
const schema={type:'object',additionalProperties:false,required:['table','operation'],properties:{
 table:{...field,description:'Use the exact tableName from the authorized schema, not an invented or translated table name.'},operation:{enum:['list','detail','compare','aggregate']},fields:{type:'array',maxItems:32,uniqueItems:true,items:field},
 segment:field,limit:{type:'integer',minimum:1,maximum:100},
 ranking:{type:'object',additionalProperties:false,required:['kind','column','identityColumns'],properties:{kind:{enum:['youngest','oldest']},subject:{enum:['employee','person']},column:field,identityColumns:{type:'array',minItems:1,maxItems:3,uniqueItems:true,items:field}},description:'Explicit age superlative, using the verified birth-date column and business name/code fields. Backend returns all tied winners within the same authorized filters. Set subject=employee only when authorized metadata identifies employees.'},
 orderBy:{type:'array',minItems:1,maxItems:5,items:{type:'object',additionalProperties:false,required:['column','direction'],properties:{column:field,direction:{enum:['ASC','DESC']}}},description:'Preserve explicit ranking. Youngest uses the verified birth-date field DESC with limit=1 and isNotNull; oldest uses ASC. Never infer age from record IDs.'},
 dimensions:{type:'array',maxItems:5,uniqueItems:true,items:field},
 time:{type:'object',additionalProperties:false,required:['column','grain'],properties:{column:field,grain:{enum:['day','month','year']},latestBuckets:{type:'integer',minimum:1,maximum:100}}},
 measures:{type:'array',maxItems:10,items:{type:'object',additionalProperties:false,required:['column','aggregation'],properties:{column:field,aggregation:{enum:['SUM','AVG','MIN','MAX','COUNT']}}}},
 filters:{type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['column','operator'],properties:{column:field,operator:{enum:['eq','gte','lt','contains','in','isNotNull']},value:{anyOf:[{type:['string','number','boolean','array'],maxLength:500,maxItems:100,items:{type:['string','number','boolean'],maxLength:500}},dateOffset]},values:{type:'array',minItems:1,maxItems:100,items:{type:['string','number','boolean'],maxLength:500},description:'Use a values array with operator=in, for example multiple requested employee codes.'}}}}
}};
const valid=new(require('ajv'))({strict:false}).compile(schema);
function compile(input,tables,scope={},contract=null,requestTime=null) {
 if(!valid(input))throw fail('SEMANTIC_QUERY_INVALID');
 const key=value=>String(value||'').normalize('NFC').trim().toLocaleLowerCase('vi');
 const supplied=key(input.table);
 const namesFor=t=>[t.tableName,`${t.schemaName||'dbo'}.${t.tableName}`,
  `[${String(t.schemaName||'dbo').replaceAll(']',']]')}].[${String(t.tableName).replaceAll(']',']]')}]`,
  `[${String(t.tableName).replaceAll(']',']]')}]`];
 let matches=tables.filter(t=>t.isActive!==false&&namesFor(t).some(name=>key(name)===supplied));
 // Only configured, unique semantic names are accepted; never guess a table.
 if(!matches.length)matches=tables.filter(t=>t.isActive!==false&&[t.semanticModel?.entity,...(t.semanticModel?.aliases||[])].some(name=>name&&key(name)===supplied));
 if(matches.length!==1)throw fail('SEMANTIC_TABLE_AMBIGUOUS_OR_UNAVAILABLE');
 const table=matches[0],visible=table.columns.filter(c=>c.isVisible!==false),names=new Set(visible.map(c=>c.columnName));
 const q=name=>'['+String(name).replaceAll(']',']]')+']';
 const col=name=>{if(!names.has(name))throw fail('SEMANTIC_FIELD_UNAVAILABLE');return q(name)};
 const literal=v=>typeof v==='number'?(Number.isFinite(v)?String(v):(()=>{throw fail('SEMANTIC_VALUE_INVALID')})()):typeof v==='boolean'?(v?'1':'0'):"N'"+v.replaceAll("'","''")+"'";
 let model;if(table.semanticModel)model=require('./semantic_model').validateModel(table.semanticModel,table);
 let fields=input.fields||[],projection,group='',units={};
 const ranking=input.ranking;
 if(ranking) {
  const dateColumn=visible.find(c=>c.columnName===ranking.column);
  if(input.operation==='aggregate'||!dateColumn||!['date','datetime','datetime2','smalldatetime','datetimeoffset'].includes(String(dateColumn.dataType).toLowerCase()))throw fail('SEMANTIC_RANKING_INVALID');
  ranking.identityColumns.forEach(col);
  fields=[...new Set([...fields,ranking.column,...ranking.identityColumns])];
  const direction=ranking.kind==='youngest'?'DESC':'ASC';
  if(input.orderBy?.some(item=>item.column!==ranking.column||item.direction!==direction))throw fail('SEMANTIC_RANKING_SORT_CONFLICT');
 }
 if(input.operation==='aggregate') {
  if(!input.measures?.length)throw fail('SEMANTIC_MEASURE_REQUIRED');
  if(fields.length)throw fail('SEMANTIC_AGGREGATE_USE_DIMENSIONS');
  const dimensions=input.dimensions||[], groupExpressions=dimensions.map(col),dimensionExpressions=[...groupExpressions];
  if(input.time) {
   const c=visible.find(c=>c.columnName===input.time.column);col(input.time.column);
   if(!['date','datetime','datetime2','smalldatetime','datetimeoffset'].includes(String(c.dataType).toLowerCase()))throw fail('SEMANTIC_TIME_NOT_DATE');
   const csql=col(input.time.column),expression=input.time.grain==='day'?`CAST(${csql} AS DATE)`:input.time.grain==='year'?`YEAR(${csql})`:`DATEFROMPARTS(YEAR(${csql}), MONTH(${csql}), 1)`;
   groupExpressions.push(expression);dimensionExpressions.push(`${expression} AS [period]`);
  }
  projection=[...dimensionExpressions,...input.measures.map(m=>{
   const column=visible.find(c=>c.columnName===m.column);col(m.column);
   const numeric=['tinyint','smallint','int','bigint','decimal','numeric','float','real','money','smallmoney'];
   if(m.aggregation!=='COUNT'&&!numeric.includes(String(column.dataType||'').toLowerCase().split('(')[0]))throw fail('SEMANTIC_MEASURE_NOT_NUMERIC');
   const defined=model?.measures?.find(x=>x.column===m.column&&x.aggregation===m.aggregation);
   const unit=defined?.unit||(m.aggregation!=='COUNT'&&model?.monetaryFields?.includes(m.column)?model.defaultCurrency||'VNĐ':null);
   if(unit)units[m.aggregation+'_'+m.column]=unit;
   const value=defined?.nullRule==='zero'?`COALESCE(${col(m.column)}, 0)`:col(m.column);
   return `${m.aggregation}(${value}) AS ${q(m.aggregation+'_'+m.column)}`;
  })].join(', ');
  if(groupExpressions.length)group=' GROUP BY '+groupExpressions.join(', ')+(input.orderBy ? '' : ' ORDER BY '+(input.time?'[period]':dimensions.map(col).join(', ')));
 } else {
  if(input.measures?.length||input.dimensions?.length||input.time)throw fail('SEMANTIC_RECORD_MEASURES_DENIED');
  if(!fields.length) {
   if(input.operation!=='list'||!model)throw fail('SEMANTIC_EXPLICIT_FIELDS_REQUIRED');
   fields=model.summaryFields;
  }
  fields=[...new Set([...(model?.identityFields||visible.filter(c=>c.isPrimaryKey).map(c=>c.columnName)),...fields])];
  if(contract && ['list','detail','compare','attribute'].includes(contract.operation)) {
   if(contract.completeness?.unresolved?.length)throw fail('SEMANTIC_CONTRACT_UNRESOLVED');
   if(contract.attributes.some(attribute=>attribute.mappedSource))throw fail('SEMANTIC_JOIN_REQUIRED');
   fields=[...new Set([...fields,...contract.attributes.map(attribute=>attribute.name)])];
   if(contract.operation==='list'&&contract.completeness?.mode==='identity_fields')fields=contract.attributes.map(attribute=>attribute.name);
  }
  projection=fields.map(col).join(', ');
  for(const name of fields)if(model?.monetaryFields?.includes(name))units[name]=model.defaultCurrency||'VNĐ';
 }
 const requiredFilters = require('./required_filters');
 const mandatory = requiredFilters.validate(table.requiredFilters === undefined ? [] : table.requiredFilters, table);
 const filters=[...(input.filters||[]), ...mandatory.filter(f=>f.operator==='eq')];
 if(input.segment) {
  const segment=model?.segments.find(s=>s.id===input.segment);if(!segment)throw fail('SEMANTIC_SEGMENT_UNAVAILABLE');
  filters.push({column:segment.column,operator:'eq',value:segment.value});
 }
 if(scope.invalid)throw fail('SEMANTIC_SCOPE_INVALID');
 for(const f of scope.filters||[]) {if(f.table!==table.tableName)throw fail('SEMANTIC_JOIN_REQUIRED');filters.push({column:f.column,operator:'eq',value:f.value});}
 const uniqueFilters = [...new Map(filters.map(f=>[JSON.stringify([f.column,f.operator,f.value,f.values]),f])).values()];
 const equals = new Map();
 for(const f of uniqueFilters.filter(f=>f.operator==='eq')) {
  if(equals.has(f.column)&&equals.get(f.column)!==JSON.stringify(f.value))throw fail('SEMANTIC_FILTER_CONFLICT');
  equals.set(f.column,JSON.stringify(f.value));
 }
 const where=uniqueFilters.map(f=>{
  const c=col(f.column);
  if(f.operator==='isNotNull')return `${c} IS NOT NULL`;
  if(f.operator==='in') {
   const values=f.values||f.value;if(!Array.isArray(values)||!values.length)throw fail('SEMANTIC_FILTER_VALUES_REQUIRED');
   return `${c} IN (${values.map(literal).join(', ')})`;
  }
  if(f.value===undefined||Array.isArray(f.value))throw fail('SEMANTIC_FILTER_VALUE_REQUIRED');
  let value=f.value;
  const declared=visible.find(column=>column.columnName===f.column);
  if(['tinyint','smallint','int','bigint','decimal','numeric','float','real','money','smallmoney'].includes(String(declared?.dataType||'').toLowerCase().split('(')[0])
    &&typeof value==='string'&&(!value.trim()||!Number.isFinite(Number(value))))throw fail('SEMANTIC_FILTER_TYPE');
  if(f.operator==='contains'&&['date','datetime','datetime2','smalldatetime','datetimeoffset'].includes(String(declared?.dataType||'').toLowerCase()))throw fail('SEMANTIC_DATE_FILTER_INVALID');
  if(value&&typeof value==='object'){
   const column=visible.find(column=>column.columnName===f.column);
   if(!['date','datetime','datetime2','smalldatetime','datetimeoffset'].includes(String(column.dataType).toLowerCase())||!['eq','gte','lt'].includes(f.operator))throw fail('SEMANTIC_DATE_FILTER_INVALID');
   const anchor=value.anchorDate==='today' ? requestTime?.today || require('../agent/tools/date_range').resolve({unit:'day'}).start : value.anchorDate;
   if(requestTime?.relative && !requestTime.allowedDates.includes(anchor))throw fail('TEMPORAL_REFERENCE_MISMATCH');
   if(requestTime?.needsHorizon && value.offsetDays>0)throw fail('TEMPORAL_HORIZON_REQUIRED');
   const date=new Date(anchor+'T00:00:00.000Z');
   if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==anchor)throw fail('SEMANTIC_DATE_FILTER_INVALID');
   date.setUTCDate(date.getUTCDate()+value.offsetDays);value=date.toISOString().slice(0,10);
  }
  if(f.operator==='contains') {if(typeof f.value!=='string')throw fail('SEMANTIC_FILTER_TYPE');const v=Array.from(f.value,char=>({'%':'[%]','_':'[_]','[':'[[]'}[char]||char)).join('');return `${c} LIKE ${literal('%'+v+'%')}`;}
  return `${c} ${{eq:'=',gte:'>=',lt:'<'}[f.operator]} ${literal(value)}`;
 });
 where.push(...mandatory.filter(f=>f.operator!=='eq').map(requiredFilters.predicate));
 if(ranking) {
  const date=col(ranking.column),aggregate=ranking.kind==='youngest'?'MAX':'MIN';
  const predicate=[...where,`${date} IS NOT NULL`].join(' AND ');
  where.push(`${date} = (SELECT ${aggregate}(${date}) FROM ${q(table.schemaName||'dbo')}.${q(table.tableName)} WHERE ${predicate})`);
 }
 const sort=ranking?[{column:ranking.column,direction:ranking.kind==='youngest'?'DESC':'ASC'}]:input.orderBy;
 const orderBy=sort?.map(item=>{
  if(input.operation!=='aggregate')return col(item.column)+' '+item.direction;
  const outputs=[...(input.dimensions||[]),...(input.time?['period']:[]),...(input.measures||[]).map(m=>m.aggregation+'_'+m.column)];
  if(!outputs.includes(item.column))throw fail('SEMANTIC_SORT_FIELD_UNAVAILABLE');
  return q(item.column)+' '+item.direction;
 }).join(', ');
 let sql=`SELECT TOP ${ranking?100:input.limit||100} ${projection} FROM ${q(table.schemaName||'dbo')}.${q(table.tableName)}${where.length?' WHERE '+where.join(' AND '):''}${group}${orderBy?' ORDER BY '+orderBy:''}`;
 if(input.time?.latestBuckets) {
  if(input.orderBy)throw fail('SEMANTIC_LATEST_BUCKETS_SORT_CONFLICT');
  if(input.operation!=='aggregate'||input.time.grain!=='month'||input.dimensions?.length)throw fail('SEMANTIC_LATEST_BUCKETS_UNSUPPORTED');
  const start=`SELECT TOP ${input.time.latestBuckets} ${projection} FROM ${q(table.schemaName||'dbo')}.${q(table.tableName)}${where.length?' WHERE '+where.join(' AND '):''}${group} DESC`;
  const outputs=['[period]',...input.measures.map(m=>q(m.aggregation+'_'+m.column))];
  sql=`SELECT ${outputs.join(', ')} FROM (${start}) AS [monthly] ORDER BY [period] ASC`;
 }
 return {sql,semanticRevision:model?.version||null,units,...(ranking?{ranking:{...ranking,sql}}:{})};
}
function inferUnits(sql,tables) {
 try {
  const ast=new(require('node-sql-parser').Parser)().astify(sql,{database:'TransactSQL'});
  if(Array.isArray(ast)||ast.from?.length!==1||!ast.from[0].table)return {};
  const matches=tables.filter(table=>table.tableName.toLowerCase()===ast.from[0].table.toLowerCase()
    && (!ast.from[0].db||(table.schemaName||'dbo').toLowerCase()===ast.from[0].db.toLowerCase()));
  if(matches.length!==1)return {};
  const table=matches[0],model=table.semanticModel;if(!model)return {};
  const units={};
  for(const projection of ast.columns||[]) {
   const expr=projection.expr,aggregate=expr.type==='aggr_func'?String(expr.name).toUpperCase():null;
   if(aggregate&&!['SUM','AVG','MIN','MAX'].includes(aggregate))continue;
   const ref=aggregate?expr.args?.expr:expr;if(ref?.type!=='column_ref')continue;
   const field=table.columns.find(c=>c.isVisible!==false&&c.columnName.toLowerCase()===String(ref.column).toLowerCase());
   if(!field)continue;
   const unit=model.measures?.find(m=>m.column===field.columnName&&m.aggregation===aggregate)?.unit
    || (model.monetaryFields?.includes(field.columnName)?model.defaultCurrency||'VNĐ':null);
   const name=projection.as||(!aggregate?field.columnName:null);if(unit&&name)units[name]=unit;
  }
  return units;
 }catch{return {};}
}
function completeProjection(sql,contract,tableName,allowedColumns=[]) {
 const unchanged={sql,addedColumns:[]};
 if(!contract||!['list','detail','attribute','compare'].includes(contract.operation)||contract.completeness?.unresolved?.length
   ||contract.attributes.some(attribute=>attribute.mappedSource))return unchanged;
 try {
  const parser=new(require('node-sql-parser').Parser)(),ast=parser.astify(sql,{database:'TransactSQL'});
  if(Array.isArray(ast)||ast.type!=='select'||ast.from?.length!==1||ast.from[0].table?.toLowerCase()!==tableName?.toLowerCase()
    ||ast.distinct||ast.groupby||ast.having||ast._next||ast.columns.some(c=>c.expr?.type!=='column_ref'||c.expr.column==='*'))return unchanged;
  const key=x=>String(x).toLowerCase();
  const projected=new Set(ast.columns.map(c=>key(c.as||c.expr.column))),allowed=new Set(allowedColumns.map(key));
  const missing=contract.attributes.filter(attribute=>allowed.has(key(attribute.name))
    &&!attribute.resultKeys.some(name=>projected.has(key(name)))).map(attribute=>attribute.name);
  if(contract.operation==='list'&&contract.completeness?.mode==='identity_fields'
    && contract.attributes.every(attribute=>allowed.has(key(attribute.name)))) {
   ast.columns=contract.attributes.map(attribute=>({expr:{type:'column_ref',table:ast.from[0].as||null,column:attribute.name},as:null}));
   return {sql:parser.sqlify(ast,{database:'TransactSQL'}),addedColumns:missing};
  }
  if(!missing.length)return unchanged;
  for(const column of missing)ast.columns.push({expr:{type:'column_ref',table:ast.from[0].as||null,column},as:null});
  return {sql:parser.sqlify(ast,{database:'TransactSQL'}),addedColumns:missing};
 }catch{return unchanged;}
}
function completeAggregation(sql,input,tables){
 const unchanged={sql,completed:false};
 if(input?.operation!=='aggregate'||!input.measures?.length||input.dimensions?.length||input.time)return unchanged;
 try{
  const parser=new(require('node-sql-parser').Parser)();
  const ast=parser.astify(sql,{database:'TransactSQL'});
  if(Array.isArray(ast)||ast.type!=='select'||ast.groupby||ast.having||ast.distinct||ast._next||!ast.from?.[0]?.table
    ||!ast.columns?.every(c=>c.expr?.type==='column_ref'&&c.expr.column!=='*'))return unchanged;
  const table=tables.find(t=>t.tableName.toLowerCase()===ast.from[0].table.toLowerCase()
    &&t.tableName.toLowerCase()===String(input.table).toLowerCase()
    &&(!ast.from[0].db||String(t.schemaName||'dbo').toLowerCase()===ast.from[0].db.toLowerCase()));
  if(!table)return unchanged;
  const compiled=compile({...input,filters:[]},[table]);
  const template=parser.astify(compiled.sql,{database:'TransactSQL'});
  ast.columns=template.columns;
  for(const c of ast.columns){const ref=c.expr.args?.expr;if(ref?.type!=='column_ref')return unchanged;ref.table=ast.from[0].as||ast.from[0].table;}
  delete ast.orderby;
  return {sql:parser.sqlify(ast,{database:'TransactSQL'}),completed:true};
 }catch{return unchanged;}
}
function normalizeArguments(input) {
 const args={...input};
 if(args.query!==undefined&&args.query!==null) {
  if(args.sql!==undefined&&args.sql!==null||args.dataQuery!==undefined&&args.dataQuery!==null)throw fail('SEMANTIC_QUERY_CONFLICT');
  if(typeof args.query==='string')args.sql=args.query;
  else if(typeof args.query==='object'&&!Array.isArray(args.query)&&Object.keys(args.query).length===1&&typeof args.query.sql==='string')args.sql=args.query.sql;
  else args.dataQuery=args.query;
  delete args.query;
 }
 if(args.sql===null)delete args.sql;
 if(args.dataQuery===null)delete args.dataQuery;
 if(args.dataQuery&&typeof args.dataQuery==='object'&&!Array.isArray(args.dataQuery)) {
  const plan=structuredClone(args.dataQuery);
  for(const [legacy,current]of [['rootTable','table'],['intent','operation'],['requestedFields','fields'],['groupBy','dimensions']]) {
   if(Object.hasOwn(plan,legacy)&&!Object.hasOwn(plan,current)){plan[current]=plan[legacy];delete plan[legacy];}
  }
  if(plan.operation==='record_lookup')plan.operation='detail';
  if(plan.operation==='aggregate_timeseries')plan.operation='aggregate';
  for(const name of ['fields','dimensions','measures','filters','segment','time','limit','orderBy','ranking'])if(plan[name]===null)delete plan[name];
  if(Array.isArray(plan.filters))plan.filters=plan.filters.map(filter=>{
   const copy={...filter};if(copy.field&&!copy.column){copy.column=copy.field;delete copy.field;}return copy;
  });
  args.dataQuery=plan;
 }
 return args;
}
const rankingInstruction='For age superlatives ALWAYS supply dataQuery.ranking={kind:youngest|oldest,column:verifiedBirthDate,identityColumns:[verifiedName,verifiedBusinessCode],subject:employee|person}, using only authorized metadata. Youngest means latest birth date, oldest means earliest; never infer age from IDs. Backend excludes unknown dates, computes the extreme within authorized user filters and retains ties, so do not restrict winners using limit=1. Do not use ranking for an ordinary sorted list or a request for top N; use dataQuery.orderBy with the verified date/metric and ASC/DESC instead. Include the ranking date/metric in fields. If no verified date/metric can express the request, ask for clarification instead of an arbitrary TOP 1.';
module.exports={schema,compile,inferUnits,completeProjection,completeAggregation,normalizeArguments,rankingInstruction};
