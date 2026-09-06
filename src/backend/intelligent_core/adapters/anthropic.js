/**
 * Anthropic Claude Adapter
 * POST /v1/messages — hỗ trợ tool_use blocks (Claude 3.x / 3.5 / 3.7)
 */

/**
 * Chuyển messages (OpenAI format) → Anthropic messages format
 * Anthropic không có role 'tool' — cần chuyển sang user content block kiểu tool_result
 */
function convertMessagesToAnthropicFormat(messages) {
  const result = [];

  for (const m of messages) {
    // role: 'tool' → Anthropic tool_result trong user message
    if (m.role === 'tool') {
      let contentObj;
      try { contentObj = JSON.parse(m.content); } catch (_) { contentObj = m.content; }

      // Gộp liên tiếp nhiều tool_result vào cùng 1 user message
      const lastMsg = result[result.length - 1];
      const toolBlock = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof contentObj === 'string' ? contentObj : JSON.stringify(contentObj)
      };

      if (lastMsg && lastMsg.role === 'user' && Array.isArray(lastMsg.content)) {
        lastMsg.content.push(toolBlock);
      } else {
        result.push({ role: 'user', content: [toolBlock] });
      }

    // role: 'assistant' với tool_calls → Anthropic tool_use content block
    } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const parts = [];
      if (m.content) parts.push({ type: 'text', text: m.content });
      m.tool_calls.forEach(tc => {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch (_) {}
        parts.push({
          type: 'tool_use',
          id: tc.id || `tool-${Date.now()}`,
          name: tc.function?.name,
          input
        });
      });
      result.push({ role: 'assistant', content: parts });

    // role: 'assistant' text
    } else if (m.role === 'assistant') {
      if (m.content) result.push({ role: 'assistant', content: m.content });

    // role: 'user'
    } else if (m.role === 'user') {
      result.push({ role: 'user', content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) });
    }
    // role: 'system' → handled separately via body.system
  }

  return result;
}

async function callAnthropic(provider, messages, tools, signal) {
  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const body = {
    model: provider.model || 'claude-3-5-sonnet-20241022',
    max_tokens: 4096,
    messages: convertMessagesToAnthropicFormat(nonSystemMessages),
    temperature: 0.3
  };

  if (systemMsg) body.system = systemMsg.content;

  if (provider.supportsToolCalling && tools && tools.length > 0) {
    body.tools = tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }));
  }

  const baseUrl = provider.baseUrl || 'https://api.anthropic.com';
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const errText = await res.text();
    let errMsg = `HTTP ${res.status}`;
    try { errMsg = JSON.parse(errText).error?.message || errMsg; } catch (_) {}
    throw new Error(`Anthropic API: ${errMsg}`);
  }

  const data = await res.json();

  // Parse tool_use block
  const toolUseBlock = data.content?.find(b => b.type === 'tool_use');
  if (toolUseBlock) {
    return {
      role: 'assistant',
      content: data.content?.find(b => b.type === 'text')?.text || null,
      usage: data.usage ? {
        inputTokens: data.usage.input_tokens || 0,
        outputTokens: data.usage.output_tokens || 0,
        totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
      } : null,
      tool_calls: [{
        id: toolUseBlock.id || `claude-tool-${Date.now()}`,
        type: 'function',
        function: {
          name: toolUseBlock.name,
          arguments: JSON.stringify(toolUseBlock.input || {})
        }
      }]
    };
  }

  const textBlock = data.content?.find(b => b.type === 'text');
  return {
    role: 'assistant',
    content: textBlock?.text || null,
    tool_calls: null,
    usage: data.usage ? {
      inputTokens: data.usage.input_tokens || 0,
      outputTokens: data.usage.output_tokens || 0,
      totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
    } : null
  };
}

module.exports = { callAnthropic };
