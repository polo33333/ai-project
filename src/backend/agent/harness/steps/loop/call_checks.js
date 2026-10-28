'use strict';

// Checks one proposed call without executing it: argument validation, stage
// permit, semantic query compilation, calculation scope, discovery order,
// repeated calls, SQL scope/filters/policy and verified output data.
// Returns the rejection (if any) with the prepared arguments, or
// { halt: true, reply } when the call already answers the request.
const { security, trainingService, validateToolCall, validateCallAgainstPolicy, blockingSqlViolation, qualifiedSql, stableFingerprint,
  validateOutputData } = require('../common');
const { hasTool, toolName } = require('./backend_calls');

async function prepareCall(s, call, { response, roundTools }) {
  const { harness, question, context, plan, requestTime, toolContext, cachedCatalog, trace, toolCalls, seen, dispatch } = s;
  const validation = validateToolCall(harness.toolManager, call, toolContext.allowedToolNames);
  let rejection = validation.valid ? null : validation.category;
  let detail = validation.errors?.join('; ');
  // Stage selection is an execution permit, not only a prompt hint. A
  // model call outside this round's definitions is rejected before
  // execution (after the more specific guards below explain why);
  // backend-generated calls carry their own preconditions.
  const stageDenied = context.governedController && !response.backendGenerated && !hasTool(roundTools, call.name);
  const args = validation.args || call.arguments || {};
  let compiledRanking;
  if(args.dataQuery){args.query=args.dataQuery;delete args.dataQuery;}
  if (!rejection && call.name === 'execute_sql_query' && args.query) {
    try {
      if (args.query.time?.grain === 'month' && plan.temporalMonths && plan.allowLatestAvailableMonths)
        args.query = { ...args.query, time: { ...args.query.time, latestBuckets: plan.temporalMonths } };
      if (args.sql) throw Object.assign(new Error('Supply exactly one query or sql.'), { code: 'SEMANTIC_QUERY_CONFLICT' });
      const tables = require('../../../../services/dictionary_service').getGroupedTables()
        .filter(table => table.isActive && table.dbSourceId === toolContext.dbSourceId
          && (toolContext.selectedTables?.includes(table.tableName) || toolContext.joinPlan?.tableRefs?.some(ref => ref.tableName === table.tableName && (ref.schemaName || 'dbo') === (table.schemaName || 'dbo'))));
      const compiled = require('../../../../services/semantic_lookup_query').compile(args.query, tables, plan.schemaScope, plan.requestContract, requestTime, toolContext.joinPlan);
      args.sql = compiled.sql;
      compiledRanking = compiled.ranking;
      toolContext.semanticQueryUnits = compiled.units;
      toolContext.compiledSemanticQuery = true;
      trace.steps.push({ type: 'SEMANTIC_QUERY_COMPILED', operation: args.query.operation, table: args.query.table });
    } catch (error) { rejection = error.code || 'SEMANTIC_QUERY_INVALID'; detail = error.message; }
  } else if (call.name === 'execute_sql_query') {
    toolContext.compiledSemanticQuery = false;
    if (!rejection && context.governedController && args.sql) {
      if(plan.semanticQuery?.operation==='aggregate'){
        const tables=require('../../../../services/dictionary_service').getGroupedTables().filter(t=>t.isActive&&t.dbSourceId===toolContext.dbSourceId);
        const aggregate=require('../../../../services/semantic_query').completeAggregation(args.sql,plan.semanticQuery,tables);
        args.sql=aggregate.sql;
        if(aggregate.completed)trace.steps.push({type:'SEMANTIC_AGGREGATION_COMPLETED'});
      }
      const completed=require('../../../../services/semantic_query').completeProjection(args.sql,plan.requestContract,plan.table,plan.schemaColumns);
      args.sql=completed.sql;
      if(completed.addedColumns.length)trace.steps.push({type:'SEMANTIC_PROJECTION_COMPLETED',addedColumns:completed.addedColumns});
    }
  }
  // Schema discovery has already established a safe category scope.
  // Repeating retrieval cannot improve this single-table aggregate.
  if (!rejection && context.governedController && call.name === 'search_schema'
    && plan.conversationState?.operation === 'aggregate' && plan.schemaScope?.filters?.length
    && toolCalls.some(item => item.toolName === 'search_schema' && item.success)) {
    rejection = 'SCHEMA_ALREADY_VERIFIED';
    detail = 'Use the verified schema and schemaScope predicates already returned. Proceed to aggregate SQL; do not rediscover the same category. Workflow discovery is only required if no catalog is available.';
  }
  if (!rejection && !stageDenied && context.governedController && call.name === 'calculate_expression') {
    if (plan.outputs?.data) plan.calculationUnverified = true;
    try {
      const evidence = qualifiedSql(toolCalls, plan).map(call => ({ sql: call.result.sql || call.args?.sql,
        dbSourceId: call.result.dbSourceId || call.result.sourceId,
        rows: call.result.rows.slice(0, 20), previewOnly: call.result.rows.length > 20 || Boolean(call.result.hasMore || call.result.truncated) }));
      const assessment = await require('../../calculation_scope').assessCalculation(dispatch, question, args, evidence);
      if (!assessment.allowed) {
        trace.steps.push({ type: 'CALCULATION_SCOPE_CONFLICT', iteration: trace.iterations, expression: args.expression });
        if (plan.outputs?.data) {
          rejection = 'CALCULATION_SCOPE_CONFLICT';
          detail = `The proposed calculation was not verified: ${assessment.answer}. Preserve the original data request and its contract. Reconcile with the supplied SQL evidence or explain the remaining limitation; do not mark the requested calculation complete.`;
        } else {
          plan.outputs = { data: false, chart: false, export: false };
          plan.requestContract = null;
          return { halt: true, reply: require('../../visible_answer').visibleAnswer(assessment.answer) };
        }
      }
    } catch (error) {
      rejection = error.code || 'CALCULATION_ASSESSMENT_FAILED';
      detail = 'The arithmetic has not been verified against the business scope. Do not present its numeric result as the correct business amount. Clarify whether the values are separate obligations or alternative sources for the same obligation.';
    }
  }
  // Ground independent list discovery in the current user request rather
  // than a model rewrite influenced by a previous conversation topic.
  const priorSchemas = toolCalls.filter(item => item.toolName === 'search_schema' && item.success && item.result?.mode === 'data');
  const cachedSchema = priorSchemas.find(item => item.result.dbSourceId === toolContext.dbSourceId
    && stableFingerprint('search_schema', item.args) === stableFingerprint('search_schema', args));
  const reuseSchema = !rejection && context.governedController && call.name === 'search_schema' && cachedSchema
    && !priorSchemas.some(item => item.result.schemaReused
      && stableFingerprint('search_schema', item.args) === stableFingerprint('search_schema', args))
    && !(response.backendGenerated && call.id?.startsWith('schema-recovery-'));
  if (!rejection && call.name === 'run_workflow' && plan.rejectedWorkflows?.includes(args.templateId)) {
    rejection = 'WORKFLOW_ALREADY_REJECTED';
    detail = 'This workflow was already assessed as unsuitable or failed for this request. Do not retry it; use verified SQL or a different matching workflow.';
  }
  if (!rejection && context.governedController && ['execute_sql_query', 'query_sql_metric', 'run_workflow'].includes(call.name)
    && toolContext.allowedToolNames.includes('list_workflows')
    && !cachedCatalog &&!toolCalls.some(item => item.toolName === 'list_workflows' && item.success)) {
    rejection = 'WORKFLOW_DISCOVERY_REQUIRED';
    detail = 'Call list_workflows first. Compare operation and output granularity. Select an exact matching workflow or use narrow SQL/metric tools when a workflow would return broader or different results.';
  }
  const fp = stableFingerprint(call.name, args);
  if (!rejection && context.governedController && call.name === 'execute_sql_query'
    && !toolCalls.some(item => item.toolName === 'search_schema' && item.success && item.result?.mode === 'data')) {
    rejection = 'SCHEMA_DISCOVERY_REQUIRED'; detail = 'Call search_schema before direct SQL to obtain the selected source schema and verified joins.';
  }
  if (!rejection && seen.has(fp) && !reuseSchema) { rejection = 'NO_PROGRESS'; detail = 'This identical call was already attempted. Use the previous result or correct the arguments.'; }
  if (!rejection && call.name === 'execute_sql_query') ({ rejection, detail } = checkSql(s, call, args));
  if (!rejection && plan.outputs?.data && ['render_chart', 'export_data'].includes(call.name) && !qualifiedSql(toolCalls, plan).length) {
    rejection = 'PREMATURE_OUTPUT_TOOL'; detail = 'Execute a valid business SQL query before producing this output.';
  }
  let verifiedExport;
  if (!rejection && plan.outputs?.data && call.name === 'export_data') {
    const source = qualifiedSql(toolCalls, plan).at(-1);
    if (source) {
      args.data = security.sanitizeTabularRows(source.result.rows);
      verifiedExport={resultGroupBy:plan.resultGroupBy||[],displayNames:{...plan.columnDisplayNames,...source.result.displayNames}};
      if(plan.resultGroupBy?.length&&!require('../../result_grouping').partition(source,plan.resultGroupBy,verifiedExport.displayNames)) {
        rejection='RESULT_GROUPING_UNRESOLVED';detail='Resolve the requested grouping to the verified output column before exporting. Do not export an ungrouped substitute.';
      }
    }
  }
  if (!rejection && plan.outputs?.data && !validateOutputData(call.name, args, qualifiedSql(toolCalls, plan))) {
    rejection = 'UNVERIFIED_OUTPUT_DATA';
    detail = 'Output values must match verified SQL rows. Export all rows, not a compact preview. For charts, query the exact labels and numeric series first.';
  }
  if (!rejection && stageDenied) {
    rejection = 'TOOL_NOT_IN_STAGE';
    detail = `${call.name} is not available at this stage. Use one of: ${roundTools.map(toolName).join(', ')}.`;
  }
  return { validation, rejection, detail, args, compiledRanking, reuseSchema, cachedSchema, fp, verifiedExport };
}

// SQL checks for a call that passed the generic ones. Records the training
// evaluation of the SQL whether or not it is accepted.
function checkSql(s, call, args) {
  const { context, plan, requestTime, toolContext, policy, trace, toolCalls } = s;
  let rejection = null, detail = null;
  if (context.governedController) {
    try {
      if (require('../../staged_tools').hasWildcardProjection(args.sql)) {
        rejection = 'SQL_PROJECTION_REQUIRED'; detail = 'Select explicit columns needed for this question, plus identity fields. SELECT * and table.* are not allowed; COUNT(*) is allowed.';
      }
    } catch { rejection = 'INVALID_SQL'; detail = 'SQL could not be parsed. Use a valid SELECT with explicit requested columns.'; }
  }
  const sqlEvaluation = trainingService.evaluateSql(args.sql, plan);
  if (!rejection && !require('../../schema_scope').matchesScope(args.sql, plan.requestFilters)) {
    rejection = 'REQUEST_FILTER_REQUIRED';
    // Spell each predicate as SQL: a period is a half-open range, not `= '2024-02'`.
    const required = plan.requestFilters.map(filter => filter.from
      ? `${filter.table}.${filter.column} >= '${filter.from}' AND ${filter.table}.${filter.column} < '${filter.to}'`
      : `${filter.table}.${filter.column} = ${JSON.stringify(filter.value)}`).join('; ');
    detail = `SQL must retain every explicitly requested predicate, including related-table filters (JOIN the verified relationship when the column is on another table): ${required}. Correct the WHERE clause, do not return a broader preview.`;
  }
  const scopeFailures = require('../../../../memory/result_scope').assess({ args, result: { sql: args.sql } },
    plan.followupScope ? { ...plan.followupScope, datasets: plan.followupScope.datasets.map(dataset => ({ ...dataset, identityComplete: false })) } : null);
  if (scopeFailures.length) { rejection = scopeFailures[0]; detail = 'Keep the selected previous result predicates, root table and groups. Do not execute an unscoped replacement.'; }
  if (!rejection && plan.followupScope && toolContext.joinPlan?.outcome === 'ready') {
    const projection = require('../../../../services/sql_join_validator').validateSqlAgainstJoinPlan(args.sql, toolContext.joinPlan);
    if (!projection.valid && projection.code === 'JOIN_PROJECTION_INVALID') { rejection = projection.code; detail = projection.error; }
  }
  if (!rejection && requestTime.relative) {
    const temporal = require('../../../../services/request_time').validateSql(args.sql, requestTime, plan.temporalTables || []);
    trace.steps.push({ type: 'TEMPORAL_SQL_ASSESSED', accepted: temporal.valid, failures: temporal.violations });
    if (!temporal.valid) {
      rejection = temporal.violations[0];
      detail = `${temporal.violations.join(', ')}. ${require('../../../../services/request_time').instruction(requestTime)}`;
    }
  }
  if (!rejection && (plan.schemaScope?.invalid || !require('../../schema_scope').matchesScope(args.sql, plan.schemaScope?.filters))) {
    rejection = 'SCHEMA_CATEGORY_FILTER_REQUIRED'; detail = `Retain these category predicates grounded in the configured column descriptions: ${JSON.stringify(plan.schemaScope)}. Do not aggregate unrelated categories.`;
  }
  if (!rejection && require('../../completion_policy').dropsAggregateScope(args.sql, toolCalls)) {
    rejection = 'AGGREGATE_SCOPE_CHANGED'; detail = 'A successful aggregate already answers a filtered scope. Retain its WHERE predicates; do not replace the requested category with all categories. Use the verified scoped result, or explain any unmapped category that needs clarification.';
  }
  trace.training.sqlEvaluations.push(sqlEvaluation);
  if (!rejection) {
    rejection = blockingSqlViolation(sqlEvaluation) || sqlEvaluation.violations[0];
    detail = rejection ? `${rejection}. Expected table: ${plan.table || 'selected business table'}. Available columns: ${(plan.schemaColumns || []).join(', ')}` : null;
  }
  const policyEvaluation = validateCallAgainstPolicy(call, args, policy, toolCalls);
  if (!rejection && !policyEvaluation.valid) { rejection = policyEvaluation.category; detail = policyEvaluation.error; }
  return { rejection, detail };
}

module.exports = { prepareCall };
