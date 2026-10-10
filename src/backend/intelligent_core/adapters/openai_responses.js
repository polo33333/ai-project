'use strict';

const { readJsonStream, reasoningEmitter } = require('./stream_reader');

async function callOpenAIResponses(provider, messages, tools, signal, options = {}) {
  const input = messages.map(message => {
    if (message.role === 'assistant' && message.responseItems?.length) return message.responseItems;
    if (message.role === 'tool') return { type: 'function_call_output', call_id: message.tool_call_id, output: String(message.content || '') };
    if (message.role === 'assistant' && message.tool_calls?.length) return [
      ...(message.content ? [{ role: 'assistant', content: message.content }] : []),
      ...message.tool_calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments }))
    ];
    return { role: message.role, content: message.content || '' };
  }).flat();
  const body = {
    model: provider.model, input, stream: true, store: false, include: ['reasoning.encrypted_content'],
    reasoning: { summary: 'auto' },
    max_output_tokens: Math.max(256, Number(provider.outputReserve || process.env.AI_PROVIDER_OUTPUT_RESERVE) || 2048)
  };
  if (provider.supportsToolCalling && tools?.length) body.tools = tools.map(tool => ({ type: 'function', ...tool.function }));
  const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/responses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify(body), signal
  });
  if (!res.ok) throw Object.assign(new Error(`OpenAI Responses HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`), { status: res.status });
  const emit = reasoningEmitter(options.onReasoning);
  let response;
  await readJsonStream(res, event => {
    if (event.type === 'response.reasoning_summary_text.delta') emit(event.delta);
    if (event.type === 'response.completed' || event.type === 'response.incomplete') response = event.response;
    if (event.type === 'response.failed' || event.type === 'error') throw new Error(event.response?.error?.message || event.message || 'OpenAI response failed');
  }, true);
  if (!response) throw new Error('OpenAI stream ended before completion');
  const calls = (response.output || []).filter(item => item.type === 'function_call');
  return {
    role: 'assistant', responseItems: response.output,
    content: (response.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []).filter(item => item.type === 'output_text').map(item => item.text).join('\n') || null,
    tool_calls: calls.length ? calls.map(item => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } })) : null,
    finish_reason: response.status === 'incomplete' ? 'length' : calls.length ? 'tool_calls' : 'stop',
    usage: response.usage ? { inputTokens: response.usage.input_tokens || 0, outputTokens: response.usage.output_tokens || 0, totalTokens: response.usage.total_tokens || 0 } : null
  };
}

module.exports = { callOpenAIResponses };
