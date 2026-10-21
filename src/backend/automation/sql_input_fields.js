'use strict';
// Derive parameter semantics from executable predicates, not workflow names.
const key=x=>String(x||'').toLowerCase();
function inputFields(workflow) {
 const result={};
 for(const binding of Object.values(workflow.bindings||{})){
  if(typeof binding.sql!=='string')continue;
  let ast;try{ast=new(require('node-sql-parser').Parser)().astify(binding.sql,{database:'TransactSQL'});}catch{continue;}
  if(Array.isArray(ast))continue;
  const refs=ast.from||[];
  const walk=(node,visit)=>{if(!node||typeof node!=='object')return;visit(node);for(const value of Object.values(node))if(value&&typeof value==='object')Array.isArray(value)?value.forEach(v=>walk(v,visit)):walk(value,visit);};
  walk(ast.where,node=>{
   if(node.type!=='binary_expr'||['AND','OR'].includes(String(node.operator).toUpperCase()))return;
   const parameters=[],columns=[];
   walk(node,child=>{if(child.type!=='column_ref')return;if(String(child.column).startsWith('@'))parameters.push(String(child.column).slice(1));else columns.push(child);});
   for(const param of parameters){
    const slot=binding.parameters?.[param]?.slot;if(!slot)continue;
    for(const col of columns){const source=refs.filter(r=>col.table?key(r.as||r.table)===key(col.table):refs.length===1);
     if(source.length!==1||!source[0].table)continue;
     const field={table:source[0].table,column:col.column};result[slot]||=[];
     if(!result[slot].some(f=>key(f.table)===key(field.table)&&key(f.column)===key(field.column)))result[slot].push(field);
    }
   }
  });
 }
 return result;
}
module.exports={inputFields};
