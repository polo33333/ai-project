'use strict';
const query=require('../../services/semantic_query');
const validate=new(require('ajv'))({strict:false}).compile(query.schema);
function prepare(groups){
 if(!Array.isArray(groups)||groups.length<2||groups.length>3)throw new Error('SEMANTIC_GROUPS_INVALID');
 if(groups.some(g=>!g||typeof g.label!=='string'||!g.label.trim()||g.label.length>160||!validate(g.query)))throw new Error('SEMANTIC_GROUPS_INVALID');
 if(new Set(groups.map(g=>g.label)).size!==groups.length||new Set(groups.map(g=>g.query.table)).size!==1)throw new Error('SEMANTIC_GROUPS_INVALID');
 return structuredClone(groups);
}
function results(groups,calls){return groups.map((g,index)=>{const call=calls.find(c=>c.semanticGroup===index&&c.success&&Array.isArray(c.result?.rows));return {label:g.label,call,complete:Boolean(call&&!call.result.hasMore&&!call.result.truncated)};});}
function render(groups,calls,renderRows,displayNames){
 return results(groups,calls).map(({label,call,complete})=>`**${label}**\n\n${call?renderRows(call,displayNames)+(complete?'':'\n\nNhóm này mới có một phần dữ liệu, chưa phải toàn bộ kết quả.'):'Chưa truy vấn được nhóm này; chưa thể kết luận kết quả rỗng.'}`).join('\n\n');
}
const instruction='Preserve every explicitly requested result group. For a supported single-table request asking for multiple sets (for example records in the next N days AND already expired records), return dataQueries:[{label:"user-facing group label",query:<the supplied dataQuery schema>},...] with 2 to 3 groups instead of a single dataQuery. Each query must include its own complete predicates and requested date field in fields. Empty groups are still required queries. For calendar-day arithmetic use filter.value={anchorDate:"YYYY-MM-DD",offsetDays:N}; backend computes exact day offsets. Next N days means date >= anchor offset 0 AND date < anchor offset N; an already-expired group uses date < anchor offset 0. Do not replace days by calendar months, omit the expired group, or claim an unqueried group is empty. Do not invent group requests when the question asks for only one set.';
module.exports={prepare,results,render,instruction};
