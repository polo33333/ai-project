'use strict';
const crypto = require('node:crypto');
const fail = code => Object.assign(new Error(code), { code, statusCode: 400 });
const field = { type: 'string', minLength: 1, maxLength: 128 };
const schema = { type: 'object', additionalProperties: false, required: ['version', 'entity', 'grain', 'identityFields', 'summaryFields', 'segments'], properties: {
 version: { const: 1 }, entity: { type: 'string', minLength: 1, maxLength: 200 }, grain: { type: 'string', minLength: 1, maxLength: 500 },
 kind: {enum:['entity','transaction','detail','lookup']},
 defaultCurrency: {type:'string',minLength:1,maxLength:40},
 monetaryFields: {type:'array',maxItems:32,uniqueItems:true,items:field},
 aliases: { type: 'array', maxItems: 30, uniqueItems: true, items: {type:'string',minLength:1,maxLength:100} },
 measures: {type:'array',maxItems:20,items:{type:'object',additionalProperties:false,required:['column','aggregation','unit','nullRule'],properties:{column:field,aggregation:{enum:['SUM','AVG','MIN','MAX','COUNT']},unit:{type:'string',minLength:1,maxLength:40},nullRule:{enum:['exclude','zero']},taxBasis:{enum:['before_tax','tax','after_tax','not_applicable']}}}},
 identityFields: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: field },
 summaryFields: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: field },
 segments: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['id','label','column','value'], properties: {
 id: field, label: {type:'string',minLength:1,maxLength:200}, column: field, value: {type:['string','number','boolean'],maxLength:500}
 } } }
} };
const validate = new (require('ajv'))({strict:false}).compile(schema);
function validateModel(model, table) {
 if (!validate(model)) throw fail('SEMANTIC_MODEL_INVALID');
 const quality = require('./schema_quality');
 if (![model.entity, model.grain, ...(model.aliases || [])].every(value => value.trim())) throw fail('SEMANTIC_TEXT_EMPTY');
 const columns = new Set(table.columns.filter(c=>c.isVisible!==false).map(c=>c.columnName));
 const references = [
  ['Cột định danh', model.identityFields], ['Cột hiển thị danh sách', model.summaryFields],
  ['Phân nhóm dữ liệu', model.segments.map(s=>s.column)], ['Chỉ tiêu', (model.measures||[]).map(m=>m.column)],
  ['Cột tiền', model.monetaryFields||[]]
 ];
 const unavailable = references.flatMap(([label,names])=>names.filter(name=>!columns.has(name)).map(name=>`${label}: ${name}`));
 if (unavailable.length) throw Object.assign(fail('SEMANTIC_COLUMN_UNAVAILABLE'), {
  message: `Không thể lưu vì quy tắc nghiệp vụ còn dùng cột đã tắt hoặc không tồn tại (${unavailable.join('; ')}). Hãy chọn cột đang bật hoặc bỏ quy tắc liên quan.`,
  unavailableReferences: unavailable
 });
 if (new Set(model.segments.map(s=>s.id)).size!==model.segments.length) throw fail('SEMANTIC_SEGMENT_DUPLICATE');
 const measures = model.measures || [];
 if (new Set(measures.map(m=>JSON.stringify([m.column,m.aggregation]))).size !== measures.length) throw fail('SEMANTIC_MEASURE_DUPLICATE');
 for (const measure of measures) {
  if (measure.aggregation !== 'COUNT' && !quality.numericTypes.has(quality.typeOf(table.columns.find(c=>c.columnName===measure.column)))) throw fail('SEMANTIC_MEASURE_NOT_NUMERIC');
  if (measure.aggregation === 'COUNT' && measure.nullRule === 'zero') throw fail('SEMANTIC_COUNT_NULL_RULE');
 }
 for (const name of model.monetaryFields || []) if (!quality.numericTypes.has(quality.typeOf(table.columns.find(c=>c.columnName===name)))) throw fail('SEMANTIC_MONEY_NOT_NUMERIC');
 return structuredClone(model);
}
// Hiding a column removes presentation-only references. Identity, measures and
// segments carry business meaning and must be changed explicitly by the user.
function reconcileVisibility(model, disabledColumns = []) {
 const result = structuredClone(model), disabled = new Set(disabledColumns);
 const originalSummary = result?.summaryFields;
 const adjustments = [];
 for (const field of ['summaryFields','monetaryFields']) {
  if (!Array.isArray(result?.[field])) continue;
  const removed = result[field].filter(name=>disabled.has(name));
  result[field] = result[field].filter(name=>!disabled.has(name));
  if (removed.length) adjustments.push({ field, columns: removed });
 }
 if (Array.isArray(result?.summaryFields) && !result.summaryFields.length && adjustments.some(item=>item.field==='summaryFields')) {
  const identities = (Array.isArray(result.identityFields) ? result.identityFields : []).filter(name=>!disabled.has(name));
  result.summaryFields = identities.length ? identities : originalSummary;
 }
 return { model: result, adjustments };
}
const cache = new Map();
function project(tables, intent = {}, relationships = [], scope = {}) {
 // Hash the complete authorized input, including visibility, business metadata,
 // relationship revisions and principal. No result rows or global catalog cache.
 const revision = crypto.createHash('sha256').update(JSON.stringify({tables,relationships,scope,intent})).digest('hex');
 if (cache.has(revision)) return {...structuredClone(cache.get(revision)),cacheHit:true};
 const key = x=>String(x||'').normalize('NFC').toLocaleLowerCase('vi').trim();
 const requested = intent.attributes || [], full = ['describe','guidance','detail','compare'].includes(intent.operation) && !requested.length;
 const result = tables.map((table,index)=>{
  const visible = table.columns.filter(c=>c.isVisible!==false);
  let model;
  try { if(table.semanticModel) model=validateModel(table.semanticModel,table); } catch { /* stale config cannot authorize fields */ }
  let requiredFilters;
  try { requiredFilters = require('./required_filters').validate(table.requiredFilters === undefined ? [] : table.requiredFilters, table); }
  catch { requiredFilters = undefined; }
  const keep = new Set(model?.identityFields || visible.filter(c=>c.isPrimaryKey).map(c=>c.columnName));
  if(intent.operation==='list'&&!requested.length) (model?.summaryFields||visible.map(c=>c.columnName)).forEach(c=>keep.add(c));
  requested.forEach(attr=>visible.filter(c=>[c.columnName,c.displayName].some(v=>v&&key(v)===key(attr))).forEach(c=>keep.add(c.columnName)));
  [table.defaultMetric,table.defaultTimeColumn,...(model?.segments||[]).map(s=>s.column),...(intent.operation==='aggregate'?model?.measures||[]:[]).map(m=>m.column)].filter(Boolean).forEach(c=>keep.add(c));
  (requiredFilters || []).forEach(filter=>keep.add(filter.column));
  // Mapping descriptions remain available until all legacy mappings are structured.
  visible.filter(c=>String(c.description||'').includes('=')).forEach(c=>keep.add(c.columnName));
  relationships.forEach(r=>{
   if(r.sourceTable===table.tableName) (r.columnPairs||[]).forEach(p=>keep.add(p.sourceColumn));
   if(r.targetTable===table.tableName) { (r.columnPairs||[]).forEach(p=>keep.add(p.targetColumn));if(r.displayColumn)keep.add(r.displayColumn); }
  });
  const unresolved = requested.some(attr=>!visible.some(c=>[c.columnName,c.displayName].some(v=>v&&key(v)===key(attr))));
  // Unresolved intent or labels require complete metadata; never pretend omitted
  // fields are hidden. Aggregate [] needs all possible measures/dimensions.
  const rootFull = full && (index===0 || ['describe','guidance'].includes(intent.operation));
  const selected = rootFull||unresolved||!intent.operation||(intent.operation==='aggregate'&&!requested.length) ? visible : visible.filter(c=>keep.has(c.columnName));
  return {tableName:table.tableName,schemaName:table.schemaName||'dbo',description:table.tableDescription||undefined,
   defaultMetric:table.defaultMetric||undefined,defaultTimeColumn:table.defaultTimeColumn||undefined,defaultAggregation:table.defaultAggregation||undefined,
   semanticModel:model,requiredFilters:requiredFilters?.length ? requiredFilters : undefined,
   ...(requiredFilters === undefined ? {configurationError:'Required row filters reference unavailable columns; execution must stop until configuration is repaired.'} : {}),
   excludedColumnCount:table.columns.length-visible.length,deferredColumnCount:visible.length-selected.length,
   columns:selected.map(c=>({name:c.columnName,type:c.dataType,label:c.displayName||undefined,description:c.description||undefined,isPrimaryKey:c.isPrimaryKey||undefined})),
   ...(selected.length<visible.length?{contextInstruction:'Other authorized columns are deferred, not absent or hidden. Search schema with exact requested attributes if needed.'}:{})};
 });
 const value={tables:result,contextRevision:revision,cacheHit:false};
 if(cache.size>=128)cache.delete(cache.keys().next().value);
 cache.set(revision,structuredClone(value));return value;
}
module.exports={schema,validateModel,reconcileVisibility,project};
