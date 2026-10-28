'use strict';

// The tool-calling loop. Each round: stage tools and backend-planned calls
// (loop/backend_calls), model answer checks (loop/answer_check), call checks
// (loop/call_checks), execution and recording (loop/call_results), then the
// round's completion (loop/round_end) or a phase repair (loop/repair).
// Returns the run result only when a workflow takes over the answer.
const { normalizeAssistantResponse, emitProgress, aborted } = require('./common');
const { selectRoundTools, planBackendResponse, projectFollowupScope } = require('./loop/backend_calls');
const { checkAnswer } = require('./loop/answer_check');
const { prepareCall } = require('./loop/call_checks');
const { startCall, recordCall } = require('./loop/call_results');
const { completeRound } = require('./loop/round_end');
const { createRepair } = require('./loop/repair');

async function runAgentLoop(s) {
  const { harness, context, onProgress, plan, conversation, trace, check, dispatch } = s;
  let { reply, finishReason, stopReason } = s;
  const repair = createRepair(s, reason => { stopReason = reason; });
  try {
    try {
      while (!reply && trace.iterations < (context.governedController ? Math.min(harness.maxIterations, 6) : harness.maxIterations)) {
        check(); trace.iterations++;
        emitProgress(onProgress, { type: 'model_started', label: `Đang xử lý · vòng ${trace.iterations}`, status: 'running', icon: 'brain', iteration: trace.iterations });
        const roundTools = selectRoundTools(s);
        const response = await planBackendResponse(s, roundTools) || await dispatch(roundTools);
        finishReason = response.finish_reason;
        const normalized = normalizeAssistantResponse(response);
        const native = Array.isArray(response.tool_calls) && response.tool_calls.length > 0;
        const acceptCalls = !plan.codeOnly && (native || s.activeProvider.supportsJsonToolCalling === true);
        const scoped = projectFollowupScope(s, acceptCalls ? normalized.calls : [], response);
        if (scoped.retry) continue;
        if (scoped.reply) { reply = scoped.reply; break; }
        const { calls } = scoped;
        if(calls.length)context.answerStream?.reset();
        const canonicalCalls = calls.map((call, index) => ({ id: call.id || `call-${trace.iterations}-${index}`, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
        conversation.push({ role: 'assistant', content: response.content || '', responseItems: response.responseItems, reasoning_content: response.reasoning_content,
          ...(response.backendGenerated ? { backendGenerated: true } : {}),
          ...(calls.length ? { tool_calls: canonicalCalls, rawParts: native ? response.rawParts : undefined } : {}) });
        emitProgress(onProgress, { type: 'model_completed', label: 'Đã nhận phản hồi từ model', status: 'done', icon: 'robot', iteration: trace.iterations });
        if (!calls.length) {
          const answer = checkAnswer(s, response, finishReason);
          if (answer.reply) { reply = answer.reply; break; }
          if (answer.groundedFallback || !repair(answer.failures)) break;
          continue;
        }
        const round = { response, roundTools, failures: [] };
        // Result groups ("tách 2 nhóm") are independent read-only queries:
        // check and start them all, then record the results in order. Each
        // group is checked against the evidence from before this round.
        const prepared = [];
        if (response.backendGenerated && calls.length > 1
          && calls.every(call => call.name === 'execute_sql_query' && String(call.id).startsWith('semantic-group-'))) {
          for (const call of calls) {
            check();
            const item = await prepareCall(s, call, round);
            prepared.push(item.halt || item.rejection ? item : { ...item, pending: startCall(s, call, item) });
          }
          trace.steps.push({ type: 'RESULT_GROUPS_PARALLEL', count: prepared.filter(item => item.pending).length });
        }
        for (let index = 0; index < calls.length; index++) {
          check();
          const current = prepared[index] || await prepareCall(s, calls[index], round);
          if (current.halt) { reply = current.reply; break; }
          const handedOff = await recordCall(s, calls[index], current, { ...round, canonicalCall: canonicalCalls[index] });
          if (handedOff) return handedOff;
        }
        const completed = await completeRound(s, round.failures);
        if (completed) {
          if (completed.reply) { reply = completed.reply; finishReason = undefined; }
          break;
        }
        if (round.failures.length && !repair([...new Set(round.failures)])) break;
      }
    } catch (error) {
      if (context.signal?.aborted) throw aborted();
      stopReason = error.code || 'PROVIDER_ERROR';
      trace.steps.push({ type: stopReason, iteration: trace.iterations,
        status: error.status || error.statusCode || null,
        error: String(error.message || stopReason).replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]').slice(0, 2000) });
    }
  } finally { Object.assign(s, { reply, finishReason, stopReason }); }
}

module.exports = { runAgentLoop };
