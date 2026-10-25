'use strict';

// Repairs are routed by failure phase (repair_router): each phase has its
// own budget, stage guidance is free, and a repair that resolves nothing
// and adds no new evidence stops instead of spending the request budget.
const { emitProgress } = require('../common');

// Returns repair(failures): true when the loop should run another round.
// onStop receives the stop reason when the repair budget ends the loop.
function createRepair(s, onStop) {
  const { harness, budget, trace, toolCalls, conversation, onProgress } = s;
  const phaseRepairs = {};
  let freeRepairs = 0, lastRepair = null;
  return failures => {
    const routed = require('../../repair_router').route(failures);
    trace.steps.push({ type: 'completion_rejected', iteration: trace.iterations, failures, phase: routed.phase });
    const progress = { signature: require('../../repair_router').signature(failures), evidence: toolCalls.filter(call => call.success).length };
    if (lastRepair && lastRepair.signature === progress.signature && lastRepair.evidence === progress.evidence) {
      onStop('REPAIR_NO_PROGRESS'); return false;
    }
    lastRepair = progress;
    if (routed.free && freeRepairs < 3) freeRepairs++;
    else {
      if ((phaseRepairs[routed.phase] || 0) >= harness.maxRepairs || s.repairs >= harness.maxRepairs * 2) { onStop('REPAIR_BUDGET_EXCEEDED'); return false; }
      phaseRepairs[routed.phase] = (phaseRepairs[routed.phase] || 0) + 1;
      s.repairs++; budget.recordRepair();
    }
    // Keep the last model call for the final answer rather than one more repair.
    if (budget.maxModelCalls - budget.modelCalls <= 1) { trace.steps.push({ type: 'FINALIZE_BUDGET_RESERVED', phase: routed.phase }); return false; }
    conversation.push({ role: 'user', content: `The request is incomplete: ${failures.join(', ')}. Use the enabled tools to produce the missing outputs from verified data. Do not print SQL/tool JSON as the final answer. If tools already succeeded, answer from their results. For document/web questions use the supplied sources.${routed.instruction}` });
    emitProgress(onProgress, { type: 'policy_repair', label: 'Kết quả chưa đầy đủ, đang điều chỉnh', status: 'warning', icon: 'wrench', iteration: trace.iterations });
    return true;
  };
}

module.exports = { createRepair };
