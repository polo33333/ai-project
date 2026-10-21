'use strict';
function select(definitions, { completed = [], catalog = false, workflowReference = false, scopedAggregate = false, operation, workflowOperations = [] } = {}) {
  const done = new Set(completed);
  const allowed = new Set(['list_workflows', 'search_schema', 'search_knowledge_base', 'get_glossary_term',
    'get_current_datetime', 'resolve_date_range', 'calculate_expression', 'calculate_stats', 'list_sql_metrics',
    'recall_memory', 'remember_preference', 'forget_memory']);
  if (catalog || done.has('list_workflows')) {
    allowed.add('run_workflow');
  }
  if(['compare','aggregate','attribute','describe','guidance'].includes(operation)&&!workflowOperations.includes(operation))allowed.delete('run_workflow');
  if (['chart','export'].includes(operation) && !workflowOperations.includes(operation)) allowed.delete('run_workflow');
  // A cached catalog describes definitions, not pending run state. Defer run
  // management schemas until discovery or a validated workflow reference.
  if (done.has('list_workflows') || workflowReference) {
    for (const name of ['get_workflow_status', 'resume_workflow', 'cancel_workflow']) allowed.add(name);
  }
  if (done.has('search_schema') && (catalog || done.has('list_workflows'))) allowed.add('execute_sql_query');
  if (completed.filter(name => name === 'search_schema').length >= 2) allowed.delete('search_schema');
  if (done.has('search_schema')) allowed.add('get_join_path');
  if (done.has('list_sql_metrics')) allowed.add('query_sql_metric');
  if (workflowReference) allowed.add('get_workflow_dataset');
  if (done.has('execute_sql_query') || done.has('query_sql_metric') || done.has('get_workflow_dataset')) {
    allowed.add('read_context_result');
    allowed.add('render_chart'); allowed.add('export_data');
  }
  if (scopedAggregate && done.has('search_schema') && !done.has('execute_sql_query')) {
    // A verified category and no extra dimensions needs SQL, not another search.
    for (const name of [...allowed]) if (!['execute_sql_query', 'get_current_datetime', 'resolve_date_range', 'list_workflows',
      ...(workflowOperations.includes(operation) ? ['run_workflow'] : [])].includes(name)) allowed.delete(name);
    if (catalog || done.has('list_workflows')) allowed.delete('list_workflows');
  }
  return definitions.filter(tool => { const name = tool.function?.name || tool.name; return allowed.has(name) || name.startsWith('mcp_'); });
}
function hasWildcardProjection(sql) {
  const ast = new (require('node-sql-parser').Parser)().astify(sql, { database: 'TransactSQL' });
  function visit(value) {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(visit);
    if (Array.isArray(value.columns) && value.columns.some(column => column.expr?.type === 'column_ref' && column.expr.column === '*')) return true;
    return Object.values(value).some(visit);
  }
  return visit(ast);
}
module.exports = { select, hasWildcardProjection };
