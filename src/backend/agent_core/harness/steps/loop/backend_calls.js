'use strict';

// Each round first offers the model only the tools of the current stage, then
// lets the backend issue calls it has already planned (pending workflow input,
// schema recovery, catalog discovery, workflow preference, reviewed queries)
// so the model is called only when no planned call applies.
const { boundedCall } = require('../common');

const toolName = tool => tool.function?.name || tool.name;
const hasTool = (tools, name) => tools.some(tool => toolName(tool) === name);

function selectRoundTools(s) {
  const { context, toolDefs, toolCalls, cachedCatalog, toolContext, pendingInput, plan } = s;
  return context.governedController ? require('../../staged_tools').select(toolDefs, {
    completed: toolCalls.filter(call => call.success).map(call => call.toolName), catalog: Boolean(cachedCatalog),
    workflowReference: Boolean(toolContext.workflowReference || pendingInput),
    operation: plan.conversationState?.operation,
    schemaRepairNeeded: Boolean(plan.requestContract?.completeness.unresolved.length),
    workflowOperations: [...(cachedCatalog || []), ...toolCalls.filter(call=>call.toolName==='list_workflows'&&call.success).flatMap(call=>call.result?.workflows||[])]
      .flatMap(workflow=>workflow.operations||[]),
    scopedAggregate: plan.conversationState?.operation === 'aggregate'
      && Boolean(plan.schemaScope?.filters?.length) && !plan.conversationState?.requestedAttributes?.length
  }) : toolDefs;
}

// Returns a backend-generated response, or null when the model must decide.
async function planBackendResponse(s, roundTools) {
  const { harness, question, context, budget, plan, toolContext, cachedCatalog, pendingInput, trace, toolCalls, check, dispatch } = s;
  if (pendingInput && !plan.pendingInputReviewed) {
    plan.pendingInputReviewed = true;
    try {
      const answer = await require('../../../../memory_core/workflow_preference').choose(dispatch, question, [pendingInput], true);
      if (answer && Object.keys(answer.inputs).length) return { backendGenerated: true, tool_calls: [{
        id: `workflow-input-${trace.iterations}`, type: 'function', function: { name: 'resume_workflow',
          arguments: JSON.stringify({ runId: pendingInput.runId, revision: pendingInput.revision, inputs: answer.inputs }) } }] };
    } catch (error) { trace.steps.push({ type: 'WORKFLOW_PREFERENCE_UNAVAILABLE', code: error.code || error.message }); }
  }
  const workflowCatalog = cachedCatalog || [...new Map(toolCalls.filter(call => call.toolName === 'list_workflows' && call.success)
    .flatMap(call => [...(call.result?.directory || []), ...(call.result?.workflows || [])]).map(item => [item.templateId, item])).values()];
  if(plan.pendingSchemaRoot){
    const root=plan.pendingSchemaRoot;delete plan.pendingSchemaRoot;
    trace.steps.push({type:'SCHEMA_ROOT_RECOVERY',table:root});
    return {backendGenerated:true,tool_calls:[{id:`schema-recovery-${trace.iterations}`,type:'function',function:{name:'search_schema',arguments:JSON.stringify({query:root,request:plan.semanticIntent})}}]};
  }
  // Discovery is mandatory before SQL. Complete it without spending
  // several model rounds rediscovering schema or proposing premature SQL.
  if (context.governedController && (plan.outputs?.data || require('../../analysis_response').task(plan))
    && toolCalls.some(call => call.toolName === 'search_schema' && call.success)
    && !cachedCatalog && !toolCalls.some(call => call.toolName === 'list_workflows' && call.success)
    && hasTool(roundTools, 'list_workflows')) {
    trace.steps.push({ type: require('../../analysis_response').task(plan) ? 'ANALYSIS_CATALOG_DISCOVERY' : 'DATA_CATALOG_DISCOVERY' });
    return { backendGenerated: true, tool_calls: [{ id: `analysis-catalog-${trace.iterations}`, type: 'function',
      function: { name: 'list_workflows', arguments: '{}' } }] };
  }
  if (context.governedController && !plan.workflowPreferenceReviewed && !toolContext.workflowReference && hasTool(roundTools, 'run_workflow')) {
    const candidates = workflowCatalog.filter(item => !plan.rejectedWorkflows?.includes(item.templateId)).filter(item => (plan.outputs?.chart ? item.operations?.includes('chart')
      : plan.outputs?.export ? item.operations?.includes('export') : ['aggregate','compare','attribute'].includes(plan.conversationState?.operation)
        && item.operations?.includes(plan.conversationState.operation)));
    if (candidates.length) {
      plan.workflowPreferenceReviewed = true;
      try {
        // Input contracts come from tool calls (cheap), so a single model call
        // can both choose the workflow and extract its inputs.
        const detailed = [];
        for (const item of candidates) {
          if (item.inputs || detailed.length >= 3) { detailed.push(item); continue; }
          check(); budget.consumeToolCall();
          const detail = await boundedCall(signal => harness.toolManager.executeTool('list_workflows', { templateId: item.templateId }, { ...toolContext, signal }), context.signal, budget.remainingMs());
          toolCalls.push({ toolName: 'list_workflows', args: { templateId: item.templateId }, success: detail.success, result: detail.result, error: detail.error });
          detailed.push(detail.success && detail.result?.workflows?.find(found => found.templateId === item.templateId) || item);
        }
        const chosen = await require('../../../../memory_core/workflow_preference').choose(dispatch, question, detailed);
        trace.steps.push({ type: 'WORKFLOW_PREFERENCE_REVIEWED', selectedTemplateId: chosen?.templateId || null });
        if (chosen) return { backendGenerated: true, tool_calls: [{ id: `workflow-preference-${trace.iterations}`, type: 'function',
          function: { name: 'run_workflow', arguments: JSON.stringify(chosen) } }] };
      } catch (error) { trace.steps.push({ type: 'WORKFLOW_PREFERENCE_UNAVAILABLE', code: error.code || error.message }); }
    }
  }
  if (plan.semanticQueryAttempted || !hasTool(roundTools, 'execute_sql_query')) return null;
  if(plan.semanticGroups) {
    plan.semanticQueryAttempted=true;
    trace.steps.push({type:'SEMANTIC_GROUPS_DISPATCHED',count:plan.semanticGroups.length});
    return {backendGenerated:true,tool_calls:plan.semanticGroups.map((group,index)=>({id:`semantic-group-${index}`,type:'function',function:{name:'execute_sql_query',arguments:JSON.stringify(group.sql?{sql:group.sql}:{dataQuery:group.query})}}))};
  }
  if(plan.semanticSql){
    plan.semanticQueryAttempted=true;
    trace.steps.push({type:'REVIEWED_SQL_DISPATCHED'});
    return {backendGenerated:true,tool_calls:[{id:`reviewed-sql-${trace.iterations}`,type:'function',function:{name:'execute_sql_query',arguments:JSON.stringify({sql:plan.semanticSql})}}]};
  }
  if(plan.semanticQuery) {
    plan.semanticQueryAttempted=true;
    trace.steps.push({type:'SEMANTIC_PLAN_DISPATCHED',source:'semantic_intent_review'});
    return {backendGenerated:true,tool_calls:[{id:`semantic-plan-${trace.iterations}`,type:'function',function:{name:'execute_sql_query',arguments:JSON.stringify({dataQuery:plan.semanticQuery})}}]};
  }
  return null;
}

// A follow-up over a previous result must keep its scope: a single proposed
// SQL is projected onto the scoped groups. Returns { calls }, { retry: true }
// after asking the model for a repair, or { reply } when it cannot be kept.
function projectFollowupScope(s, calls, response) {
  const { plan, trace, conversation } = s;
  if (!(plan.followupScope && calls.length === 1 && calls[0].name === 'execute_sql_query' && calls[0].arguments?.sql
    && !String(calls[0].id).startsWith('semantic-group-'))) return { calls };
  try {
    plan.semanticGroups = require('../../../../memory_core/result_scope').project(calls[0].arguments.sql, plan.followupScope, plan.schemaColumns, plan.conversationState?.requestedAttributes, plan.requestContract);
    plan.semanticQueryAttempted = true;
    response.backendGenerated = true;
    trace.steps.push({ type: 'FOLLOWUP_SCOPE_PROJECTED', count: plan.semanticGroups.length });
    return { calls: plan.semanticGroups.map((group, index) => ({ id: `semantic-group-${index}`, name: 'execute_sql_query', arguments: { sql: group.sql } })) };
  } catch (error) {
    trace.steps.push({ type: 'FOLLOWUP_SCOPE_REJECTED', code: error.code || 'FOLLOWUP_SCOPE_UNSUPPORTED' });
    plan.scopeRepairAttempts = (plan.scopeRepairAttempts || 0) + 1;
    plan.semanticQueryAttempted = true;
    if (plan.scopeRepairAttempts <= 1) {
      conversation.push({ role: 'user', content: 'The proposed SQL cannot preserve the selected dataset. Repair it using the ORIGINAL root table as the first FROM source, explicit root identity/output columns and verified LEFT JOIN enrichment. Keep every group; backend restores its existing WHERE predicates. Do not substitute an independent customer/employee lookup. Scope: ' + JSON.stringify(plan.followupScope) });
      return { retry: true };
    }
    plan.memoryUnresolved = true;
    return { reply: 'Chưa thể bổ sung thông tin mà vẫn giữ nguyên phạm vi kết quả trước. Vui lòng xác nhận danh sách cần tiếp tục.' };
  }
}

module.exports = { toolName, hasTool, selectRoundTools, planBackendResponse, projectFollowupScope };
