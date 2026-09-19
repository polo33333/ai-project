'use strict';

const providers = require('../../services/ai_provider_manager');
const security = require('../../intelligent_core/security_guard');
const { trainingService } = require('../../training_core');
const { isLocalProvider } = require('./provider_classifier');
const { RequestExecutionBudget } = require('./request_execution_budget');
const { normalizeAssistantResponse } = require('./tool_call_normalizer');
const { validateToolCall } = require('./tool_argument_validator');
const { getRequestPolicy, validateCallAgainstPolicy } = require('./local_execution_policy');
const { compactToolResult } = require('./local_result_compactor');
const { buildSqlRowsFallbackReply, ensureDownloadLink } = require('./grounded_reply');
const { resolvePlan, blockingSqlViolation, qualifiedSql, evaluateCompletion, stableFingerprint, validateOutputData } = require('./completion_policy');
const { estimateTokens } = require('./context_budget');
const { emitProgress, toolLabel } = require('./progress_events');
const { buildEnrichedListSql, contextualLookupQuestion } = require('../../services/sql_enrichment_builder');

const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const aborted = () => Object.assign(new Error('Request aborted'), { name: 'AbortError' });

function createProviderBudget() {
  return new RequestExecutionBudget({
    executionClass: 'remote', timeoutMs: positive(process.env.AI_PROVIDER_REQUEST_TIMEOUT_MS, 120000),
    maxModelCalls: positive(process.env.AI_PROVIDER_MAX_MODEL_CALLS, 12),
    maxSqlAttempts: positive(process.env.AI_PROVIDER_MAX_SQL_CALLS, 3),
    maxToolCalls: positive(process.env.AI_PROVIDER_MAX_TOOL_CALLS, 20)
  });
}

function recoverable(error) {
  const status = Number(error.status || error.statusCode || String(error.message).match(/HTTP\s+(\d{3})/i)?.[1]);
  if (status) return status === 429 || status >= 500;
  return error.name === 'AbortError' || /timeout|timed out|econnrefused|fetch failed|rate limit|overloaded/i.test(error.message);
}

// Bound awaiting providers/tools even if a custom implementation ignores AbortSignal.
// The signal is also passed through so cooperative implementations cancel their work.
async function boundedCall(action, signal, timeoutMs) {
  if (signal?.aborted) throw aborted();
  const controller = new AbortController();
  let timer;
  let abortListener;
  const stopped = new Promise((_, reject) => {
    abortListener = () => { controller.abort(); reject(aborted()); };
    signal?.addEventListener('abort', abortListener, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(Object.assign(new Error('Request operation timed out'), { code: 'OPERATION_TIMEOUT' }));
    }, Math.max(1, timeoutMs));
  });
  try { return await Promise.race([Promise.resolve().then(() => action(controller.signal)), stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abortListener); }
}

function wireMessages(messages, provider) {
  if (provider.supportsToolCalling || !provider.supportsJsonToolCalling) return messages;
  return messages.map(message => message.role === 'tool'
    ? { role: 'user', content: `Tool result (${message.name}): ${message.content}` }
    : message.tool_calls?.length
      ? { role: 'assistant', content: JSON.stringify({ tool_calls: message.tool_calls }) }
      : message);
}

class GuardedAgentHarness {
  constructor({ toolManager, maxIterations = 10, dispatch, maxRepairs } = {}) {
    this.toolManager = toolManager;
    this.maxIterations = maxIterations;
    this.dispatch = dispatch;
    this.maxRepairs = Math.max(0, Number(maxRepairs ?? process.env.AI_PROVIDER_MAX_REPAIRS ?? 2) || 0);
  }

  async run({ userMessage = '', messages = [], provider, enabledToolNames = null, context = {}, onProgress } = {}) {
    if (context.signal?.aborted) throw aborted();
    const budget = context.executionBudget || createProviderBudget();
    let activeProvider = provider || providers.getActiveProvider();
    const candidates = [activeProvider, ...providers.getProvidersForExecution()
      .filter(item => item.id !== activeProvider?.id && item.baseUrl && item.model && item.status !== 'unconfigured')
      .filter(item => !isLocalProvider(activeProvider) || process.env.LOCAL_MODEL_ALLOW_CLOUD_FALLBACK === 'true' || isLocalProvider(item))
      .sort((a, b) => (Number(a.priority) || 999) - (Number(b.priority) || 999))].filter(Boolean);
    const question = userMessage || [...messages].reverse().find(item => item.role === 'user')?.content || '';
    const plan = resolvePlan(question, context.requestPlan || trainingService.plan({ question, selectedTables: context.selectedTables || [] }), context);
    const toolContext = { ...context, executionBudget: budget, allowedToolNames: plan.codeOnly ? [] : enabledToolNames };
    const toolDefs = this.toolManager?.getToolDefinitions(toolContext) || [];
    // Use the actual permission-filtered definitions as the execution whitelist.
    toolContext.allowedToolNames = toolDefs.map(item => item.function?.name || item.name);
    const policy = { ...getRequestPolicy(question), dataRequired: Boolean(plan.outputs?.data), chartRequired: Boolean(plan.outputs?.chart),
      exportRequired: Boolean(plan.outputs?.export), maxSqlCalls: budget.maxSqlAttempts };
    const instruction = 'Complete the requested outputs using tools. For database data requests, execute SQL; printed SQL is not a result. '
      + 'Do not invent rows, charts or download links. Zero rows is a valid result; do not loosen filters. '
      + 'If the user requests only code or an explanation, answer directly without executing it.';
    const conversation = [{ role: 'system', content: [...messages.filter(item => item.role === 'system').map(item => item.content), instruction].join('\n\n') },
      ...messages.filter(item => item.role !== 'system')];
    if (!conversation.some(item => item.role === 'user')) conversation.push({ role: 'user', content: question });
    const trace = { harness: 'provider_guarded', startTime: Date.now(), iterations: 0, steps: [], toolCalls: [],
      training: { plan, sqlEvaluations: [] }, tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, available: false } };
    const toolCalls = [];
    const providerFallbacks = [];
    const seen = new Set();
    let reply = '';
    let finishReason;
    let repairs = 0;
    let stopReason = null;

    const check = () => { if (context.signal?.aborted) throw aborted(); budget.assertTimeRemaining(); };
    const dispatch = async definitions => {
      let lastError;
      for (const candidate of [activeProvider, ...candidates.filter(item => item.id !== activeProvider?.id)]) {
        check();
        const toolsRequired = Boolean(plan.outputs?.data || plan.outputs?.chart || plan.outputs?.export);
        if (definitions.length && toolsRequired && !candidate.supportsToolCalling && !candidate.supportsJsonToolCalling) {
          lastError = Object.assign(new Error('Provider does not support the required tool calling capability.'), { code: 'TOOL_CAPABILITY_UNAVAILABLE' });
          trace.steps.push({ type: 'TOOL_CAPABILITY_UNAVAILABLE', providerId: candidate.id });
          continue;
        }
        const providerTimeout = positive(isLocalProvider(candidate) ? process.env.AI_LOCAL_TIMEOUT_MS : process.env.AI_DEFAULT_TIMEOUT_MS, 30000);
        let outgoing = wireMessages(conversation, candidate);
        if (definitions.length && candidate.supportsJsonToolCalling && !candidate.supportsToolCalling) {
          outgoing = outgoing.map((item, index) => index ? item : { ...item, content: `${item.content}\nFor a tool action return only JSON {"tool":"name","arguments":{...}}. Available tools: ${JSON.stringify(definitions)}` });
        }
        const contextWindow = positive(candidate.contextWindow || candidate.numCtx, positive(process.env.AI_PROVIDER_CONTEXT_WINDOW, 16384));
        const reserve = positive(candidate.outputReserve, positive(process.env.AI_PROVIDER_OUTPUT_RESERVE, 2048));
        if (estimateTokens(outgoing) + estimateTokens(definitions) + reserve + 256 > contextWindow) {
          lastError = Object.assign(new Error('Provider context budget exceeded.'), { code: 'CONTEXT_BUDGET_EXCEEDED' });
          trace.steps.push({ type: lastError.code, providerId: candidate.id });
          continue;
        }
        budget.consumeModelCall();
        try {
          const response = await boundedCall(signal => this.dispatch(candidate, outgoing, definitions, signal), context.signal, Math.min(providerTimeout, budget.remainingMs()));
          const usage = response.usage;
          trace.tokenUsage.calls += Math.max(1, Number(usage?.calls) || 1);
          for (let i = 1; i < (Number(usage?.calls) || 1); i++) budget.consumeModelCall();
          if (usage) {
            trace.tokenUsage.available = true;
            trace.tokenUsage.inputTokens += Number(usage.inputTokens) || 0;
            trace.tokenUsage.outputTokens += Number(usage.outputTokens) || 0;
            trace.tokenUsage.totalTokens += Number(usage.totalTokens) || (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
          }
          if (candidate.id !== activeProvider?.id) providerFallbacks.push({ fromProviderId: activeProvider?.id, toProviderId: candidate.id,
            toProviderName: candidate.name, reason: lastError?.message || 'Provider unavailable' });
          activeProvider = candidate;
          check();
          return response;
        } catch (error) {
          if (context.signal?.aborted) throw aborted();
          lastError = error;
          if (!recoverable(error)) throw error;
        }
      }
      throw lastError || new Error('Không có AI Provider khả dụng.');
    };
    const repair = failures => {
      trace.steps.push({ type: 'completion_rejected', iteration: trace.iterations, failures });
      if (repairs >= this.maxRepairs) { stopReason = 'REPAIR_BUDGET_EXCEEDED'; return false; }
      repairs++; budget.recordRepair();
      const citationInstruction = failures.includes('MISSING_KNOWLEDGE_CITATION')
        ? ` Rewrite the answer from the supplied document context. After every document claim, insert the actual numbered marker such as [1] or [2], matching Tài liệu 1 or Tài liệu 2. Never output the literal text [N] and do not invent marker numbers. Available evidence:\n\n${String(context.knowledgeGrounding?.documentContext || '')}`
        : '';
      conversation.push({ role: 'user', content: `The request is incomplete: ${failures.join(', ')}. Use the enabled tools to produce the missing outputs from verified data. Do not print SQL/tool JSON as the final answer. If tools already succeeded, answer from their results. For document/web questions use the supplied sources.${citationInstruction}` });
      emitProgress(onProgress, { type: 'policy_repair', label: 'Kết quả chưa đầy đủ, đang điều chỉnh', status: 'warning', icon: 'wrench', iteration: trace.iterations });
      return true;
    };

    try {
      while (trace.iterations < this.maxIterations) {
        check(); trace.iterations++;
        emitProgress(onProgress, { type: 'model_started', label: `Đang xử lý · vòng ${trace.iterations}`, status: 'running', icon: 'brain', iteration: trace.iterations });
        const response = await dispatch(toolDefs);
        finishReason = response.finish_reason;
        const normalized = normalizeAssistantResponse(response);
        const native = Array.isArray(response.tool_calls) && response.tool_calls.length > 0;
        const acceptCalls = !plan.codeOnly && (native || activeProvider.supportsJsonToolCalling === true);
        const calls = acceptCalls ? normalized.calls : [];
        const canonicalCalls = calls.map((call, index) => ({ id: call.id || `call-${trace.iterations}-${index}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
        conversation.push({ role: 'assistant', content: response.content || '',
          ...(calls.length ? { tool_calls: canonicalCalls, rawParts: native ? response.rawParts : undefined } : {}) });
        emitProgress(onProgress, { type: 'model_completed', label: 'Đã nhận phản hồi từ model', status: 'done', icon: 'robot', iteration: trace.iterations });
        if (!calls.length) {
          const candidate = response.content || '';
          let evaluation = evaluateCompletion({ reply: candidate, plan, toolCalls, context, finishReason });
          if (context.knowledgeGrounding?.required && !/\[\d+\](?!\s*\()/.test(candidate)) {
            evaluation = { valid: false, score: 0, failures: [...new Set([...evaluation.failures, 'MISSING_KNOWLEDGE_CITATION'])] };
          }
          if (evaluation.valid) { reply = candidate; break; }
          // Once verified rows exist, a deterministic renderer can replace raw/empty text.
          const contentFailures = ['EMPTY_ANSWER', 'RAW_TOOL_ANSWER', 'SQL_ONLY_ANSWER', 'TRUNCATED_ANSWER', 'INSUFFICIENT_DATA_ANSWER'];
          if (qualifiedSql(toolCalls, plan).length && evaluation.failures.every(item => contentFailures.includes(item))) {
            trace.steps.push({ type: 'GROUNDED_RESULT_FALLBACK' }); break;
          }
          if (!repair(evaluation.failures)) break;
          continue;
        }
        const roundFailures = [];
        for (let index = 0; index < calls.length; index++) {
          check();
          const call = calls[index];
          const validation = validateToolCall(this.toolManager, call, toolContext.allowedToolNames);
          let rejection = validation.valid ? null : validation.category;
          let detail = validation.errors?.join('; ');
          const args = validation.args || call.arguments || {};
          const fp = stableFingerprint(call.name, args);
          if (!rejection && seen.has(fp)) { rejection = 'NO_PROGRESS'; detail = 'This identical call was already attempted. Use the previous result or correct the arguments.'; }
          if (!rejection && call.name === 'execute_sql_query') {
            const sqlEvaluation = trainingService.evaluateSql(args.sql, plan);
            trace.training.sqlEvaluations.push(sqlEvaluation);
            rejection = blockingSqlViolation(sqlEvaluation) || sqlEvaluation.violations[0];
            detail = rejection ? `${rejection}. Expected table: ${plan.table || 'selected business table'}. Available columns: ${(plan.schemaColumns || []).join(', ')}` : null;
            const policyEvaluation = validateCallAgainstPolicy(call, args, policy, toolCalls);
            if (!rejection && !policyEvaluation.valid) { rejection = policyEvaluation.category; detail = policyEvaluation.error; }
          }
          if (!rejection && plan.outputs?.data && ['render_chart', 'export_data'].includes(call.name) && !qualifiedSql(toolCalls, plan).length) {
            rejection = 'PREMATURE_OUTPUT_TOOL'; detail = 'Execute a valid business SQL query before producing this output.';
          }
          if (!rejection && plan.outputs?.data && call.name === 'export_data') {
            const source = qualifiedSql(toolCalls, plan).at(-1);
            if (source) args.data = security.sanitizeTabularRows(source.result.rows);
          }
          if (!rejection && plan.outputs?.data && !validateOutputData(call.name, args, qualifiedSql(toolCalls, plan))) {
            rejection = 'UNVERIFIED_OUTPUT_DATA';
            detail = 'Output values must match verified SQL rows. Export all rows, not a compact preview. For charts, query the exact labels and numeric series first.';
          }
          let execution;
          if (rejection) {
            execution = { success: false, error: detail || rejection };
            trace.steps.push({ type: rejection, iteration: trace.iterations, toolName: call.name });
          } else {
            seen.add(fp); budget.consumeToolCall();
            if (call.name === 'execute_sql_query') budget.consumeSqlAttempt();
            emitProgress(onProgress, { type: 'tool_started', label: toolLabel(call.name), status: 'running', toolName: call.name, icon: 'gear' });
            execution = await boundedCall(signal => this.toolManager.executeTool(call.name, args, { ...toolContext, signal }), context.signal, budget.remainingMs());
            check();
            toolCalls.push({ toolName: call.name, args, success: execution.success, result: execution.result || null, error: execution.error || null, durationMs: execution.durationMs });
            trace.toolCalls.push({ toolName: call.name, success: execution.success, durationMs: execution.durationMs });
            emitProgress(onProgress, { type: 'tool_completed', label: toolLabel(call.name, 'done', execution.result?.rowCount), status: execution.success ? 'done' : 'error', toolName: call.name, icon: 'gear' });
          }
          if (!execution.success) roundFailures.push(rejection || 'TOOL_EXECUTION_FAILED');
          conversation.push({ role: 'tool', tool_call_id: canonicalCalls[index].id, name: call.name,
            content: compactToolResult(execution, positive(process.env.AI_PROVIDER_TOOL_RESULT_CHARS, 12000)) });
        }
        if (roundFailures.length && !repair([...new Set(roundFailures)])) break;
      }
    } catch (error) {
      if (context.signal?.aborted) throw aborted();
      stopReason = error.code || 'PROVIDER_ERROR';
      trace.steps.push({ type: stopReason, iteration: trace.iterations });
    }

    if (!qualifiedSql(toolCalls, plan).length) {
      const recoveryQuestion = contextualLookupQuestion(question, messages);
      const recoverySql = buildEnrichedListSql({ ...plan, question: recoveryQuestion,
        datasetReference: context.memoryDecision?.reference }, context.joinPlan);
      if (recoverySql && toolContext.allowedToolNames.includes('execute_sql_query')) {
        try {
          check(); budget.consumeToolCall(); budget.consumeSqlAttempt();
          const execution = await boundedCall(signal => this.toolManager.executeTool('execute_sql_query', { sql: recoverySql },
            { ...toolContext, signal }), context.signal, budget.remainingMs());
          toolCalls.push({ toolName: 'execute_sql_query', args: { sql: recoverySql }, success: execution.success,
            result: execution.result || null, error: execution.error || null, durationMs: execution.durationMs });
          trace.toolCalls.push({ toolName: 'execute_sql_query', success: execution.success, durationMs: execution.durationMs, source: 'ENRICHED_LIST_RECOVERY' });
          trace.steps.push({ type: 'ENRICHED_LIST_RECOVERY', success: execution.success, toolName: 'execute_sql_query' });
          if (execution.success) stopReason = null;
        } catch (error) {
          trace.steps.push({ type: error.code || 'ENRICHED_LIST_RECOVERY_FAILED', error: error.message });
        }
      }
    }

    if (context.signal?.aborted) throw aborted();
    if (!reply && !stopReason && toolCalls.some(call => call.success)) {
      try {
        conversation.push({ role: 'user', content: 'Summarize only the verified tool results. Do not claim missing outputs were completed.' });
        const synthesis = await dispatch([]);
        const evaluation = evaluateCompletion({ reply: synthesis.content, plan, toolCalls, context, finishReason: synthesis.finish_reason });
        if (evaluation.valid) { reply = synthesis.content; finishReason = synthesis.finish_reason; }
      } catch (error) {
        if (context.signal?.aborted) throw aborted();
        stopReason = error.code || 'SYNTHESIS_FAILED';
        trace.steps.push({ type: stopReason });
      }
    }
    const sql = qualifiedSql(toolCalls, plan).at(-1);
    // Render lists from executed rows so a fluent but truncated model answer cannot omit records.
    if (sql && (!reply || plan.intent === 'list' || sql.result.rows.length === 0)) {
      reply = buildSqlRowsFallbackReply({ ...sql, result: { ...sql.result, rows: security.sanitizeTabularRows(sql.result.rows) } });
      finishReason = undefined;
      trace.steps.push({ type: 'GROUNDED_RESULT_RENDER' });
    }
    const exported = toolCalls.find(call => call.toolName === 'export_data' && call.success && call.result?.downloadUrl);
    const chart = toolCalls.find(call => call.toolName === 'render_chart' && call.success && call.result?.chartSpec);
    if (!reply && chart) reply = 'Đã tạo biểu đồ từ dữ liệu đã xác minh.';
    if (exported) { reply = ensureDownloadLink(reply || 'Đã xuất file.', exported.result.downloadUrl); finishReason = undefined; }
    if (!reply) reply = stopReason === 'TOOL_CAPABILITY_UNAVAILABLE'
      ? 'Model hiện tại chưa hỗ trợ công cụ cần thiết để hoàn thành yêu cầu này. Vui lòng chọn model hỗ trợ công cụ.'
      : 'Chưa thể hoàn tất yêu cầu với kết quả đã xác minh. Vui lòng thử lại.';
    let evaluation = evaluateCompletion({ reply, plan, toolCalls, context, finishReason });
    if (stopReason && !sql && !chart && !exported) {
      evaluation = { valid: false, score: 0, failures: [...new Set([...evaluation.failures, stopReason])] };
    }
    // A generic fallback must never turn a failed general/knowledge request into SUCCESS.
    if (reply.startsWith('Chưa thể hoàn tất') && evaluation.valid) evaluation = { valid: false, score: 0, failures: ['INCOMPLETE_ANSWER'] };
    if (!evaluation.valid && (sql || chart || exported)) reply += '\n\nMột phần yêu cầu chưa hoàn tất; phần hiển thị trên là kết quả đã xác minh.';
    trace.training.responseEvaluation = evaluation;
    trace.completionStatus = evaluation.valid ? 'SUCCESS' : 'PARTIAL';
    trace.executionBudget = budget.snapshot();
    trace.durationMs = Date.now() - trace.startTime;
    trace.stopReason = stopReason;
    emitProgress(onProgress, { type: 'request_completed', label: evaluation.valid ? 'Đã hoàn thành câu trả lời' : 'Yêu cầu chưa hoàn tất', status: evaluation.valid ? 'done' : 'warning', icon: 'check', durationMs: trace.durationMs });
    return { replyText: security.maskSensitiveData(reply), toolCalls, usedProvider: activeProvider, providerFallbacks,
      tokenUsage: trace.tokenUsage, trace, conversation };
  }
}

module.exports = GuardedAgentHarness;
module.exports.createProviderBudget = createProviderBudget;
module.exports.boundedCall = boundedCall;
