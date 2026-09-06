/**
 * OpenAI / DeepSeek / LM Studio / OpenRouter Adapter
 * POST /v1/chat/completions — chuẩn OpenAI-compat
 */

async function callOpenAI(provider, messages, tools, signal) {
  const body = {
    model: provider.model || 'gpt-4o-mini',
    messages,
    temperature: 0.3
  };

  if (provider.supportsToolCalling && tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${provider.apiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

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
    throw new Error(`OpenAI/compat API HTTP ${res.status}: ${errMsg}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('Không nhận được response từ API.');

  return {
    role: 'assistant',
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
