'use strict';

async function callOllamaDecision(provider, task, signal) {
  const res = await fetch(`${provider.baseUrl}/v1/systemone`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ model: provider.model, state: task.state, questions: task.questions, keep_alive: provider.keepAlive || '10m' })
  });
  if (!res.ok) {
    // Do not expose upstream response bodies or state in a user-facing error.
    throw Object.assign(new Error(`Ollama decision HTTP ${res.status}`), { code: 'ROUTING_PROVIDER_ERROR', status: res.status });
  }
  const data = await res.json();
  return { role: 'assistant', content: JSON.stringify(data), tool_calls: null,
    usage: { inputTokens: Number(data.usage?.input_tokens) || 0, outputTokens: Number(data.usage?.output_tokens) || 0,
      totalTokens: (Number(data.usage?.input_tokens) || 0) + (Number(data.usage?.output_tokens) || 0),
      calls: Object.keys(task.questions).length },
    metadata: { endpoint: '/v1/systemone', decisionEvaluations: Object.keys(task.questions).length } };
}
module.exports = { callOllamaDecision };
