'use strict';

// One model call for a stage: provider fallback, context compaction, the
// request clock, usage accounting and answer streaming.
const {
  providers, security, trainingService, isLocalProvider, RequestExecutionBudget, normalizeAssistantResponse, validateToolCall, getRequestPolicy, compactToolResult,
  validateCallAgainstPolicy, buildSqlRowsFallbackReply, ensureDownloadLink, resolvePlan, blockingSqlViolation, qualifiedSql,
  evaluateCompletion, stableFingerprint, validateOutputData, estimateTokens, emitProgress, toolLabel, createRequestContract,
  assessRequestContract, createMetricContract, decodeIntent, buildEnrichedListSql, contextualLookupQuestion,
  isSimpleEntityListRequest, positive, aborted, withToolProgress, createProviderBudget, recoverable, boundedCall, wireMessages
} = require('./common');
const localStage = require('../local_stage_prompt');

function createDispatch(s) {
  const { harness, userMessage, provider, enabledToolNames, resourceSnapshot, question, messages, context, onProgress, budget, candidates, plan, requestTime, resultStore, toolContext, toolDefs,
    cachedCatalog, pendingInput, policy, instruction, conversation, trace, toolCalls, providerFallbacks, seen, check } = s;
  return async (definitions, inputMessages = conversation, stage = 'agent') => {
    if (['v2_contract', 'v2_contract_repair'].includes(stage)) emitProgress(onProgress, { type: 'model_started', label: stage === 'v2_contract'
      ? 'Đang phân tích câu hỏi và lập kế hoạch truy vấn' : 'Đang điều chỉnh kế hoạch truy vấn', status: 'running', icon: 'brain' });
    let lastError;
    const queue = [s.activeProvider, ...candidates.filter(item => item.id !== s.activeProvider?.id)];
    for (let index = 0; index < queue.length; index++) {
      const candidate = queue[index];
      check();
      const toolsRequired = Boolean(plan.outputs?.data || plan.outputs?.chart || plan.outputs?.export);
      if (definitions.length && toolsRequired && !candidate.supportsToolCalling && !candidate.supportsJsonToolCalling) {
        lastError = Object.assign(new Error('Provider does not support the required tool calling capability.'), { code: 'TOOL_CAPABILITY_UNAVAILABLE' });
        trace.steps.push({ type: 'TOOL_CAPABILITY_UNAVAILABLE', providerId: candidate.id });
        continue;
      }
      const local = isLocalProvider(candidate);
      const providerTimeout = positive(local ? process.env.AI_LOCAL_TIMEOUT_MS : process.env.AI_DEFAULT_TIMEOUT_MS, 30000);
      // Local: the same window and output limit the Ollama adapter sends.
      const contextWindow = local ? positive(candidate.numCtx || candidate.contextWindow, positive(process.env.LOCAL_MODEL_NUM_CTX, 16384))
        : positive(candidate.contextWindow || candidate.numCtx, positive(process.env.AI_PROVIDER_CONTEXT_WINDOW, 16384));
      const reserve = local ? positive(candidate.outputReserve || candidate.numPredict, positive(process.env.LOCAL_MODEL_NUM_PREDICT, 2048))
        : positive(candidate.outputReserve, positive(process.env.AI_PROVIDER_OUTPUT_RESERVE, 2048));
      const structured = local && !s.structuredOutputFailed?.has(candidate.id)
        ? localStage.structuredRequest(candidate, inputMessages, definitions, stage) : null;
      const stageMessages = structured ? structured.messages : inputMessages;
      const stageDefinitions = structured ? [] : definitions;
      // Remote providers cache the unchanged beginning of a prompt, so the
      // per-request clock is a separate system message after the stage
      // rules. Local chat templates may require a single leading system
      // message, so it joins that message there.
      const clock = require('../../../services/request_time').instruction(requestTime);
      let groundedMessages = stageMessages === conversation ? stageMessages
        : stageMessages[0]?.role !== 'system' ? [{ role: 'system', content: clock }, ...stageMessages]
        : local
          ? stageMessages.map((message, index) => index ? message : { ...message, content: `${message.content}\n${clock}` })
          : [stageMessages[0], { role: 'system', content: clock }, ...stageMessages.slice(1)];
      if (local && stage === 'agent' && definitions.length) {
        s.localGuidance ||= localStage.selectGuidance(plan, question);
        trace.skill = s.localGuidance.trace;
        trace.skill.injected ||= Boolean(s.localGuidance.skill);
        groundedMessages = localStage.agentMessages(groundedMessages, definitions, policy, s.localGuidance);
      }
      const lifecycle = require('../context_lifecycle').compact(groundedMessages, {
        targetTokens: Math.max(0, (contextWindow - reserve - estimateTokens(stageDefinitions) - 256) * 0.75)
      });
      let outgoing = wireMessages(lifecycle.messages, candidate);
      if (lifecycle.changes.length) trace.steps.push({ type: 'CONTEXT_COMPACTED', stage,
        beforeTokensEstimated: lifecycle.beforeTokens, afterTokensEstimated: lifecycle.afterTokens,
        changes: lifecycle.changes });
      if (stageDefinitions.length && candidate.supportsJsonToolCalling && !candidate.supportsToolCalling) {
        outgoing = outgoing.map((item, index) => index ? item : { ...item, content: `${item.content}\nFor a tool action return only JSON {"tool":"name","arguments":{...}}. Available tools: ${JSON.stringify(stageDefinitions)}` });
      }
      if (estimateTokens(outgoing) + estimateTokens(stageDefinitions) + reserve + 256 > contextWindow) {
        lastError = Object.assign(new Error('Provider context budget exceeded.'), { code: 'CONTEXT_BUDGET_EXCEEDED' });
        trace.steps.push({ type: lastError.code, providerId: candidate.id });
        continue;
      }
      budget.consumeModelCall();
      try {
        const callStartedAt = Date.now();
        const resolution=toolContext.conversationResolution;
        const resolvedGeneral=resolution?.relation==='independent'&&resolution.operation==='conversation'&&resolution.dataUse==='none'&&resolution.sourceScope==='general';
        const previewEligible=(definitions.length===0||resolvedGeneral)&&context.mode==='general'&&!context.webSearch&&!context.knowledgeGrounding?.required
          &&!plan.outputs?.data&&!plan.outputs?.chart&&!plan.outputs?.export&&!plan.workflowReference&&!toolContext.workflowReference&&!toolCalls.length&&stage==='agent';
        const answerPreview=context.answerStream?.begin(previewEligible);
        if(context.answerStream?.metrics.enabled&&stage==='agent')trace.steps.push({type:'ANSWER_STREAM_POLICY',eligible:previewEligible,toolCount:definitions.length,
          reason:previewEligible?'general_answer':definitions.length&&!resolvedGeneral?'tools_without_general_resolution':'verified_result_required'});
        const response = await boundedCall(signal => harness.dispatch(structured ? structured.provider : candidate, outgoing, stageDefinitions, signal, { executionBudget: budget,
          onAnswer:answerPreview?.push,
          onToolCall:()=>answerPreview?.cancel(),
          onReasoning: delta => emitProgress(onProgress, { type: 'reasoning_delta', delta, iteration: trace.iterations, label: 'Reasoning', icon: 'brain' }) }), context.signal, Math.min(providerTimeout, budget.remainingMs()));
        const usage = response.usage;
        trace.steps.push({ type: 'MODEL_USAGE', stage: stage === 'agent' && context.mode === 'knowledge' ? 'knowledge_answer' : stage,
          iteration: trace.iterations, repairAttempt: s.repairs, providerId: candidate.id, model: candidate.model,
          durationMs: Date.now() - callStartedAt, calls: Math.max(1, Number(usage?.calls) || 1),
          inputTokens: usage ? Number(usage.inputTokens) || 0 : null,
          outputTokens: usage ? Number(usage.outputTokens) || 0 : null,
          cachedInputTokens: usage ? Number(usage.cachedInputTokens) || 0 : null,
          totalTokens: usage ? Number(usage.totalTokens) || (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0) : null,
          inputTokensEstimated: estimateTokens(outgoing) + estimateTokens(stageDefinitions), usageAvailable: Boolean(usage),
          messageTokensEstimated: estimateTokens(outgoing), toolDefinitionsTokensEstimated: estimateTokens(stageDefinitions),
          toolResultTokensEstimated: estimateTokens(outgoing.filter(message => message.role === 'tool')),
          ...(structured ? { structuredOutput: true } : {}) });
        trace.steps.at(-1).contextFootprint = {
          breakdown: require('../context_lifecycle').footprint(outgoing, stageDefinitions),
          systemTokensEstimated: estimateTokens(outgoing.filter(message => message.role === 'system')),
          toolMessageCount: outgoing.filter(message => message.role === 'tool').length,
          messageCount: outgoing.length,
          definitionCount: stageDefinitions.length,
          instructionChars: stage === 'agent' ? instruction.length : 0,
          cachedCatalogChars: stage === 'agent' && cachedCatalog ? JSON.stringify(cachedCatalog).length : 0
        };
        trace.tokenUsage.calls += Math.max(1, Number(usage?.calls) || 1);
        for (let i = 1; i < (Number(usage?.calls) || 1); i++) budget.consumeModelCall();
        if (usage) {
          trace.tokenUsage.available = true;
          trace.tokenUsage.inputTokens += Number(usage.inputTokens) || 0;
          trace.tokenUsage.outputTokens += Number(usage.outputTokens) || 0;
          trace.tokenUsage.totalTokens += Number(usage.totalTokens) || (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
        }
        if (candidate.id !== s.activeProvider?.id) providerFallbacks.push({ fromProviderId: s.activeProvider?.id, toProviderId: candidate.id,
          toProviderName: candidate.name, reason: lastError?.message || 'Provider unavailable' });
        s.activeProvider = candidate;
        check();
        return response;
      } catch (error) {
        if (context.signal?.aborted) throw aborted();
        lastError = error;
        if (structured && error.code !== 'OPERATION_TIMEOUT') {
          // The schema-constrained call failed: the same provider retries
          // with its native tool call for the rest of the request.
          (s.structuredOutputFailed ||= new Set()).add(candidate.id);
          trace.steps.push({ type: 'LOCAL_STRUCTURED_OUTPUT_FAILED', stage, providerId: candidate.id, error: String(error.message).slice(0, 200) });
          queue.splice(index + 1, 0, candidate);
          continue;
        }
        if (!recoverable(error)) throw error;
      }
    }
    throw lastError || new Error('Không có AI Provider khả dụng.');
  };
}

module.exports = { createDispatch };
