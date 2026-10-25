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

// input_tokens excludes prompt-cache reads and writes; count them as input so
// quotas and budgets see the full prompt, and report the cached share apart.
function usageOf(usage) {
  if (!usage) return null;
  const cached = usage.cache_read_input_tokens || 0;
  const written = usage.cache_creation_input_tokens || 0;
  const inputTokens = (usage.input_tokens || 0) + cached + written;
  return { inputTokens, outputTokens: usage.output_tokens || 0, totalTokens: inputTokens + (usage.output_tokens || 0),
    cachedInputTokens: cached, cacheWriteTokens: written };
}

async function callAnthropic(provider, messages, tools, signal) {
  const systemMessages = messages.filter(m => m.role === 'system' && m.content);
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const body = {
    model: provider.model || 'claude-3-5-sonnet-20241022',
    max_tokens: Math.max(256, Number(provider.outputReserve || process.env.AI_PROVIDER_OUTPUT_RESERVE) || 2048),
    messages: convertMessagesToAnthropicFormat(nonSystemMessages),
    temperature: 0.3
  };

  // One block per system message. The first one (persona or stage rules) is the
  // stable part: a cache breakpoint there covers the tools and that block, and
  // later blocks (memory, request clock) may change per request.
  const promptCache = process.env.ANTHROPIC_PROMPT_CACHE !== 'false';
  if (systemMessages.length) {
    body.system = systemMessages.map((m, index) => ({ type: 'text', text: String(m.content),
      ...(promptCache && index === 0 ? { cache_control: { type: 'ephemeral' } } : {}) }));
  }

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
    throw Object.assign(new Error(`Anthropic API: ${errMsg}`), { status: res.status });
  }

  const data = await res.json();

  // Parse tool_use block
  const toolUseBlocks = data.content?.filter(b => b.type === 'tool_use') || [];
  if (toolUseBlocks.length) {
    return {
      role: 'assistant',
      content: data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || null,
      finish_reason: data.stop_reason,
      usage: usageOf(data.usage),
      tool_calls: toolUseBlocks.map((toolUseBlock, index) => ({
        id: toolUseBlock.id || `claude-tool-${Date.now()}-${index}`,
        type: 'function',
        function: {
          name: toolUseBlock.name,
          arguments: JSON.stringify(toolUseBlock.input || {})
        }
      }))
    };
  }

  return {
    role: 'assistant',
    content: data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || null,
    finish_reason: data.stop_reason,
    tool_calls: null,
    usage: usageOf(data.usage)
  };
}

module.exports = { callAnthropic };
