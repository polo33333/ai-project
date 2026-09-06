/**
 * Ollama Adapter — POST /api/chat
 * Hỗ trợ tool calling từ Ollama v0.3+ (OpenAI-compat format)
 */

function convertMessagesToOllama(messages = []) {
  return messages.map(message => {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) {
      return {
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.tool_calls.map(call => {
          const fn = call.function || call;
          let args = fn.arguments ?? fn.args ?? {};
          if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (_) { args = {}; }
          }
          return { function: { name: fn.name, arguments: args } };
        })
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
        tool_name: message.tool_name || message.name
      };
    }
    return { role: message.role, content: message.content || '' };
  });
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return String(value).trim().toLowerCase() === 'true';
}

async function callOllama(provider, messages, tools, signal) {
  const body = {
    model: provider.model || 'qwen2.5-coder',
    messages: convertMessagesToOllama(messages),
    stream: false,
    options: {
      temperature: Number(provider.temperature ?? process.env.LOCAL_MODEL_TEMPERATURE ?? 0.1),
      ...(Number(provider.numCtx || process.env.LOCAL_MODEL_NUM_CTX) > 0 ? { num_ctx: Number(provider.numCtx || process.env.LOCAL_MODEL_NUM_CTX) } : {}),
      ...(Number(provider.numPredict || process.env.LOCAL_MODEL_NUM_PREDICT) > 0 ? { num_predict: Number(provider.numPredict || process.env.LOCAL_MODEL_NUM_PREDICT) } : {})
    },
    // Thinking-capable models can spend their whole generation budget in
    // message.thinking and leave message.content empty. The application needs
    // a final answer, so disable hidden reasoning unless explicitly enabled.
    think: parseBoolean(provider.think ?? process.env.LOCAL_MODEL_THINK, false),
    keep_alive: provider.keepAlive || process.env.LOCAL_MODEL_KEEP_ALIVE || '10m'
  };

  if (provider.supportsToolCalling && tools && tools.length > 0) {
    body.tools = tools.map(tool => ({
      type: 'function',
      function: tool.function || {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }
    }));
  }

  const request = async requestBody => {
    const res = await fetch(`${provider.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    return res.json();
  };

  let data = await request(body);
  let msg = data.message || {};
  if (!String(msg.content || '').trim() && !msg.tool_calls?.length && msg.thinking && body.think !== false) {
    data = await request({ ...body, think: false });
    msg = data.message || {};
  }
  if (!String(msg.content || '').trim() && !msg.tool_calls?.length) {
    const error = new Error(
      `Ollama returned an empty response (done_reason=${data.done_reason || 'unknown'}, `
      + `thinking=${String(msg.thinking || '').length}, eval_count=${Number(data.eval_count) || 0}).`
    );
    error.code = 'OLLAMA_EMPTY_RESPONSE';
    throw error;
  }
  return {
    role: 'assistant',
    content: msg.content || null,
    tool_calls: msg.tool_calls || null,
    usage: (data.prompt_eval_count != null || data.eval_count != null) ? {
      inputTokens: data.prompt_eval_count || 0,
      outputTokens: data.eval_count || 0,
      totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
    } : null,
    metadata: {
      doneReason: data.done_reason || null,
      thinkingLength: String(msg.thinking || '').length,
      contentLength: String(msg.content || '').length
    }
  };
}

module.exports = { callOllama, convertMessagesToOllama };
