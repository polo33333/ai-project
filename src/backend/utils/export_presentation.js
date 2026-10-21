'use strict';
const {partition}=require('../agent_core/harness/result_grouping');
const {safeRows}=require('./export_safety');
function prepare(rows, metadata={}) {
  const columns=[...new Set(rows.flatMap(row=>Object.keys(row)))], used=new Set();
  const names=columns.map(column=>{
    const base=metadata.displayNames?.[column]||column;
    let name=base,index=2;while(used.has(name))name=`${base} (${index++})`;
    used.add(name);return name;
  });
  const rename=items=>safeRows(items.map(row=>Object.fromEntries(columns.map((column,i)=>[names[i],row[column]]))));
  if(!metadata.resultGroupBy?.length)return {data:rename(rows),groups:null};
  const groups=partition({result:{rows,displayNames:metadata.displayNames}},metadata.resultGroupBy);
  if(!groups)throw new Error('RESULT_GROUPING_UNRESOLVED');
  const sheetNames=new Set();
  const output=groups.map(group=>{
    const label=group.values.map(v=>v==null||v===''?'Chưa xác định':String(v)).join(' · ');
    const base=label.replace(/[\\/?*\[\]:\u0000-\u001f]/g,' ').replace(/^'+|'+$/g,'').trim().slice(0,31)||'Nhóm';
    let name=base,index=2;
    while(sheetNames.has(name.toLowerCase())) {const suffix=` (${index++})`;name=base.slice(0,31-suffix.length)+suffix;}
    sheetNames.add(name.toLowerCase());
    return {label,name,data:rename(group.rows)};
  });
  return {data:output.flatMap(group=>group.data),groups:output};
}
module.exports={prepare};
