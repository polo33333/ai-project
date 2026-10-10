/**
 * OpenAI / DeepSeek / LM Studio / OpenRouter Adapter
 * POST /v1/chat/completions — chuẩn OpenAI-compat
 */

const { readJsonStream, reasoningEmitter } = require('./stream_reader');

async function callOpenAI(provider, messages, tools, signal, options = {}) {
  const emit = reasoningEmitter(options.onReasoning);
  const body = {
    model: provider.model || 'gpt-4o-mini',
    messages,
    temperature: 0.3,
    max_tokens: Math.max(256, Number(provider.outputReserve || process.env.AI_PROVIDER_OUTPUT_RESERVE) || 2048)
  };

  if (provider.supportsToolCalling && tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  if (typeof options.onReasoning === 'function' && provider.supportsStreaming !== false) body.stream = true;

  const request = () => fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  let res = await request();
  if (!res.ok && body.stream && [400, 422, 501].includes(res.status)) {
    const detail = await res.clone().text();
    if (/stream(?:ing)?[\s\S]{0,100}(?:unsupported|not supported|not support)|(?:unsupported|not supported|not support)[\s\S]{0,100}stream/i.test(detail)) {
      delete body.stream; res = await request();
    }
  }

  if (!res.ok) {
    const errText = await res.text();
    let errMsg = `HTTP ${res.status}`;
    try {
      const payload = JSON.parse(errText);
      const apiError = payload?.error || payload;
      const parts = [
        apiError?.message,
        apiError?.code != null ? `code=${apiError.code}` : null,
        apiError?.metadata?.raw,
        apiError?.metadata?.provider_name
          ? `upstream=${apiError.metadata.provider_name}`
          : null
      ].filter(Boolean);
      if (parts.length > 0) errMsg = parts.join(' | ');
    } catch (_) {
      const compactBody = errText.replace(/\s+/g, ' ').trim().slice(0, 500);
      if (compactBody) errMsg = compactBody;
    }
    throw Object.assign(new Error(`OpenAI/compat API HTTP ${res.status}: ${errMsg}`), { status: res.status });
  }

  let data;
  if (body.stream && res.body && (res.headers?.get('content-type') || '').includes('text/event-stream')) {
    const message = { content: '', reasoning_content: '', tool_calls: [] };
    let finish_reason = null;
    let usage;
    await readJsonStream(res, chunk => {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.find(item => item.index === 0 || item.index == null);
      if (!choice) return;
      if (choice.finish_reason) finish_reason = choice.finish_reason;
      const delta = choice.delta || {};
      message.content += delta.content || '';
      const reasoning = delta.reasoning_content || delta.reasoning || '';
      message.reasoning_content += reasoning;
      emit(reasoning);
      for (const part of delta.tool_calls || []) {
        const index = part.index || 0;
        const call = message.tool_calls[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (part.id) call.id = part.id;
        call.function.name += part.function?.name || '';
        call.function.arguments += part.function?.arguments || '';
      }
    }, true);
    if (!finish_reason) throw new Error('Provider stream ended before completion');
    message.tool_calls = message.tool_calls.filter(Boolean);
    data = { choices: [{ message, finish_reason }], usage };
  } else {
    data = await res.json();
    emit(data.choices?.[0]?.message?.reasoning_content || data.choices?.[0]?.message?.reasoning);
  }
  const choice = data.choices?.[0];
  if (!choice) throw new Error('Không nhận được response từ API.');

  return {
    role: 'assistant',
    reasoning_content: choice.message?.reasoning_content || undefined,
    content: choice.message?.content || null,
    tool_calls: choice.message?.tool_calls || null,
    finish_reason: choice.finish_reason,
    usage: data.usage ? {
      inputTokens: data.usage.prompt_tokens || 0,
      outputTokens: data.usage.completion_tokens || 0,
      totalTokens: data.usage.total_tokens || 0
    } : null
  };
}

module.exports = { callOpenAI };
