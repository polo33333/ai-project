/**
 * Google Gemini Adapter
 * POST /v1beta/models/{model}:generateContent + functionDeclarations
 * Hỗ trợ lưu nguyên gốc thought_signature từ Gemini 2.0 / 3.0+ cho tool calling multi-turn.
 */

const { callOpenAI } = require('./openai');

/**
 * Chuyển messages (OpenAI format) → Gemini contents format
 */
function convertMessagesToGeminiContents(messages) {
  const contents = [];

  for (const m of messages) {
    // role: 'tool' → Gemini functionResponse (gắn vào role 'user')
    if (m.role === 'tool') {
      let responseObj;
      try { responseObj = JSON.parse(m.content); } catch (_) { responseObj = { text: m.content }; }
      contents.push({
        role: 'user',
        parts: [{
          functionResponse: {
            name: m.name,
            response: responseObj
          }
        }]
      });

      // role: 'assistant' có tool_calls → Giữ nguyên parts gốc (chứa thought/thoughtSignature) nếu có
    } else if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      if (m.rawParts && Array.isArray(m.rawParts)) {
        contents.push({
          role: 'model',
          parts: m.rawParts
        });
      } else {
        contents.push({
          role: 'model',
          parts: m.tool_calls.map(tc => ({
            functionCall: {
              name: tc.function?.name,
              args: (() => {
                try { return JSON.parse(tc.function?.arguments || '{}'); } catch (_) { return {}; }
              })()
            }
          }))
        });
      }

      // role: 'assistant' text
    } else if (m.role === 'assistant') {
      if (m.content) {
        contents.push({
          role: 'model',
          parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
        });
      }

      // role: 'user'
    } else if (m.role === 'user') {
      contents.push({
        role: 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
      });
    }
  }

  return contents;
}

async function callGemini(provider, messages, tools, signal) {
  if (provider.baseUrl.includes('/openai')) {
    return callOpenAI(provider, messages, tools, signal);
  }

  const model = provider.model || 'gemini-1.5-flash';
  const systemMessages = messages.filter(m => m.role === 'system');
  const systemMsg = systemMessages.length ? { content: systemMessages.map(m => m.content).join('\n\n') } : null;
  const nonSystemMessages = messages.filter(m => m.role !== 'system');

  const contents = convertMessagesToGeminiContents(nonSystemMessages);

  const body = {
    contents,
    generationConfig: { temperature: 0.3, maxOutputTokens: Math.max(256, Number(provider.outputReserve || process.env.AI_PROVIDER_OUTPUT_RESERVE) || 2048) }
  };

  if (systemMsg) {
    body.systemInstruction = { parts: [{ text: systemMsg.content }] };
  }

  if (provider.supportsToolCalling && tools && tools.length > 0) {
    body.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description,
        parameters: t.function?.parameters || t.parameters
      }))
    }];
    body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
  }

  const url = `${provider.baseUrl}/v1beta/models/${model}:generateContent?key=${provider.apiKey}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  if (!res.ok) {
    const errText = await res.text();
    let errMsg = `HTTP ${res.status}`;
    try { errMsg = JSON.parse(errText).error?.message || errMsg; } catch (_) { }
    throw Object.assign(new Error(`Gemini API: ${errMsg}`), { status: res.status });
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  const content = candidate?.content;
  if (!content) throw new Error('Gemini không trả về candidate.');

  // Parse function call từ Gemini
  const funcParts = content.parts?.filter(p => p.functionCall) || [];
  if (funcParts.length) {
    return {
      role: 'assistant',
      content: content.parts?.filter(p => p.text && !p.thought).map(p => p.text).join('\n') || null,
      finish_reason: candidate.finishReason,
      rawParts: content.parts, // Lưu nguyên vẹn parts gốc chứa thought & thought_signature
      usage: data.usageMetadata ? {
        inputTokens: data.usageMetadata.promptTokenCount || 0,
        outputTokens: data.usageMetadata.candidatesTokenCount || 0,
        totalTokens: data.usageMetadata.totalTokenCount || 0
      } : null,
      tool_calls: funcParts.map((funcPart, index) => ({
        id: `gemini-tool-${Date.now()}-${index}`,
        type: 'function',
        function: {
          name: funcPart.functionCall.name,
          arguments: JSON.stringify(funcPart.functionCall.args || {})
        }
      }))
    };
  }

  return {
    role: 'assistant',
    content: content.parts?.filter(p => p.text && !p.thought).map(p => p.text).join('\n') || null,
    finish_reason: candidate.finishReason,
    tool_calls: null,
    usage: data.usageMetadata ? {
      inputTokens: data.usageMetadata.promptTokenCount || 0,
      outputTokens: data.usageMetadata.candidatesTokenCount || 0,
      totalTokens: data.usageMetadata.totalTokenCount || 0
    } : null
  };
}

module.exports = { callGemini };
