'use strict';

// Request state for one run: plan, permitted tools, prompt, trace and budget.
const {
  providers, security, trainingService, isLocalProvider, RequestExecutionBudget, normalizeAssistantResponse, validateToolCall, getRequestPolicy, compactToolResult,
  validateCallAgainstPolicy, buildSqlRowsFallbackReply, ensureDownloadLink, resolvePlan, blockingSqlViolation, qualifiedSql,
  evaluateCompletion, stableFingerprint, validateOutputData, estimateTokens, emitProgress, toolLabel, createRequestContract,
  assessRequestContract, createMetricContract, decodeIntent, buildEnrichedListSql, contextualLookupQuestion,
  isSimpleEntityListRequest, positive, aborted, withToolProgress, createProviderBudget, recoverable, boundedCall, wireMessages
} = require('./common');

async function prepare(harness, { userMessage = '', messages = [], provider, enabledToolNames = null, context = {}, onProgress } = {}) {
  if (context.signal?.aborted) throw aborted();
  const budget = context.executionBudget || createProviderBudget();
  let activeProvider = provider || providers.getActiveProvider();
  const candidates = context.lockProvider ? [activeProvider] : [activeProvider, ...providers.getProvidersForExecution()
    .filter(item => item.id !== activeProvider?.id && item.baseUrl && item.model && item.status !== 'unconfigured')
    .filter(item => !isLocalProvider(activeProvider) || process.env.LOCAL_MODEL_ALLOW_CLOUD_FALLBACK === 'true' || isLocalProvider(item))
    .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))].filter(Boolean);
  const question = userMessage || [...messages].reverse().find(item => item.role === 'user')?.content || '';
  const plan = resolvePlan(question, context.requestPlan || trainingService.plan({ question, selectedTables: context.selectedTables || [] }), context);
  plan.exportRequest = require('../output_request').resolve(question);
  if (plan.exportRequest.export) plan.outputs = { ...plan.outputs, data: true, export: true };
  const requestTime = require('../../../services/request_time').create(question);
  plan.requestTime = requestTime;
  const resourceSnapshot = () => {
    const governance = require('../../../governance/context');
    return governance.current() ? [...governance.current().resources.values()].map(({ resource, type }) =>
      [type, resource.id, resource.governedPolicy?.revision || 0]) : [];
  };
  const resultStore = new (require('../context_result_store').ContextResultStore)(async snapshot => {
    const governance = require('../../../governance/context');
    if (governance.current()) {
      await governance.refresh();
      const latest = resourceSnapshot();
      if (snapshot.some(([type, id, revision]) => !latest.some(item => item[0] === type && item[1] === id && item[2] === revision)))
        throw new Error('CONTEXT_RESULT_SCOPE_CHANGED');
      for (const { resource, type } of governance.current().resources.values()) governance.read(resource, type);
    }
  }, resourceSnapshot);
  const toolContext = { ...context, userMessage: question, modelDestination: { id: activeProvider.id, local: isLocalProvider(activeProvider) }, executionBudget: budget, allowedToolNames: plan.codeOnly ? [] : enabledToolNames };
  toolContext.requestTime = requestTime;
  toolContext.readContextResult = args => resultStore.read(args);
  if (!plan.codeOnly && Array.isArray(toolContext.allowedToolNames)
    && toolContext.allowedToolNames.some(name => ['execute_sql_query', 'query_sql_metric', 'get_workflow_dataset'].includes(name)))
    toolContext.allowedToolNames = [...toolContext.allowedToolNames, 'read_context_result'];
  const toolDefs = (harness.toolManager?.getToolDefinitions(toolContext) || []).map(definition => {
    if(context.governedController&&definition.function?.name==='execute_sql_query') {
      const tool=structuredClone(definition);
      tool.function.description='Execute one read-only SQL SELECT using verified schema and JOIN scope. Supply sql as a SQL string. Backend checks permissions, category filters and required fields before execution.';
      tool.function.parameters={type:'object',properties:{sql:{type:'string',description:'Read-only T-SQL SELECT, including all required filters and fields.'}},required:['sql']};
      tool.description=tool.function.description;tool.parameters=tool.function.parameters;
      return tool;
    }
    if (!context.governedController || definition.function?.name !== 'search_schema') return definition;
    const tool = structuredClone(definition);
    tool.function.parameters.required = [...new Set([...(tool.function.parameters.required || []), 'request'])];
    return tool;
  });
  // Use the actual permission-filtered definitions as the execution whitelist.
  toolContext.allowedToolNames = toolDefs.map(item => item.function?.name || item.name);
  const cachedCatalog = context.governedController && toolContext.allowedToolNames.includes('list_workflows')
    ? await require('../../../governance/workflow_tools').cachedCatalog(toolContext) : null;
  const pendingInput = context.governedController && toolContext.allowedToolNames.includes('resume_workflow')
    ? await require('../../../governance/workflow_tools').pendingInput(toolContext) : null;
  const policy = { ...getRequestPolicy(plan, context), maxSqlCalls: budget.maxSqlAttempts };
  const instruction = require('../visible_answer').instruction + '\n' + require('../agent_context').instruction + '\n' + require('../analysis_response').instruction
    + (!context.resolutionContext && context.memoryDecision?.reference ? '\nThe supplied verified memory reference identifies the prior entity; missing fields do not erase that reference.' : '');
  // The request clock changes on every request, so it goes last: providers
  // cache the unchanged beginning of the prompt.
  const conversation = [{ role: 'system', content: [...messages.filter(item => item.role === 'system').map(item => item.content), instruction,
    require('../../tools/join_path').instruction, require('../../../services/request_time').instruction(requestTime)].join('\n\n') },
    ...messages.filter(item => item.role !== 'system')];
  if (!conversation.some(item => item.role === 'user')) conversation.push({ role: 'user', content: question });
  if (cachedCatalog) conversation[0].content += `\nAuthorized workflow catalog revalidated for this conversation: ${JSON.stringify(cachedCatalog)}. Discovery is complete; do not call list_workflows again unless pending-run status or additional details are needed.`;
  const trace = { harness: 'provider_guarded', startTime: Date.now(), iterations: 0, steps: [], toolCalls: [],
    training: { plan, sqlEvaluations: [] }, tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, available: false } };
  const toolCalls = [];
  if (cachedCatalog) trace.steps.push({ type: 'WORKFLOW_CATALOG_REUSED', count: cachedCatalog.length });
  const providerFallbacks = [];
  const seen = new Set();
  let reply = '';
  let finishReason;
  let repairs = 0;
  let stopReason = null;

  const check = () => { if (context.signal?.aborted) throw aborted(); budget.assertTimeRemaining(); };
  return { harness, userMessage, messages, provider, enabledToolNames, context, onProgress, budget, activeProvider, candidates, question,
    plan, requestTime, resourceSnapshot, resultStore, toolContext, toolDefs, cachedCatalog, pendingInput, policy, instruction,
    conversation, trace, toolCalls, providerFallbacks, seen, reply, finishReason, repairs, stopReason, check };
}

module.exports = { prepare };
