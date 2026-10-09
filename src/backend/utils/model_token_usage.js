'use strict';

// Routing stages are a subset of request usage. Remaining usage belongs to the
// pinned chat provider (schema selection, execution and answer synthesis).
function withModelTokenUsage(usage, routing, chatModel) {
  if (!usage?.available) return usage;
  const models = new Map();
  const add = (model, inputTokens, outputTokens, calls) => {
    const entry = models.get(model) || { model, inputTokens: 0, outputTokens: 0, calls: 0 };
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    entry.calls += calls;
    models.set(model, entry);
  };
  let routedInput = 0, routedOutput = 0, routedCalls = 0;
  for (const stage of routing?.stages || []) {
    if (!(Number(stage.calls) > 0)) continue;
    const input = Number(stage.inputTokens) || 0;
    const output = Number(stage.outputTokens) || 0;
    const calls = Number(stage.calls) || 0;
    add(stage.model || 'Không xác định', input, output, calls);
    routedInput += input; routedOutput += output; routedCalls += calls;
  }
  const input = (Number(usage.inputTokens) || 0) - routedInput;
  const output = (Number(usage.outputTokens) || 0) - routedOutput;
  const calls = (Number(usage.calls) || 0) - routedCalls;
  // Never publish a misleading breakdown when an upstream subtotal is incomplete.
  if (input < 0 || output < 0 || calls < 0) return usage;
  if (input || output || calls) add(chatModel || 'Không xác định', input, output, calls);
  return { ...usage, byModel: [...models.values()].map(item => ({ ...item, totalTokens: item.inputTokens + item.outputTokens })) };
}

module.exports = { withModelTokenUsage };
