/**
 * Adapters Index — Provider Dispatcher
 * Chọn adapter phù hợp dựa vào provider config (apiFormat, type, baseUrl)
 */

const { callOllama }    = require('./ollama');
const { callOllamaDecision } = require('./ollama_decision');
const { callOpenAIResponses } = require('./openai_responses');
const { callOpenAI }    = require('./openai');
const { callGemini }    = require('./gemini');
const { callAnthropic } = require('./anthropic');

/**
 * Dispatch request tới đúng adapter dựa vào config của provider
 * @param {object} provider - Provider config
 * @param {Array}  messages - Messages array (OpenAI format)
 * @param {Array}  tools    - Tools array (OpenAI format)
 * @param {AbortSignal} signal
 */
function adapterKind(provider = {}) {
  const fmt = (provider.apiFormat || '').toLowerCase(), url = (provider.baseUrl || '').toLowerCase(), type = (provider.type || '').toLowerCase();
  if (fmt === 'anthropic' || type === 'anthropic' || url.includes('anthropic.com')) return 'anthropic';
  if (fmt === 'gemini' || type === 'google' || type === 'google gemini api' || url.includes('googleapis.com') || url.includes('generativelanguage')) return 'gemini';
  if (fmt === 'ollama' || type === 'local' || type === 'ollama (local)' || url.includes('11434')) return 'ollama';
  return 'openai';
}

async function dispatchUnchecked(provider, messages, tools, signal, options = {}) {
  await require('../../governance/context').refresh(provider.id, /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(provider.baseUrl || ''));
  if (typeof fetch === 'undefined') {
    throw new Error('Fetch API không khả dụng trong môi trường Node.js này (yêu cầu Node.js >= 18).');
  }

  const fmt  = (provider.apiFormat || '').toLowerCase();

  if (fmt === 'openai-responses' || (typeof options.onReasoning === 'function' && provider.supportsStreaming !== false && provider.supportsReasoning !== false && !/chat/i.test(provider.model || '') && (provider.baseUrl || '').replace(/\/$/, '') === 'https://api.openai.com/v1' && /^(?:o[134](?:-|$)|gpt-[56])/.test(provider.model || ''))) {
    return callOpenAIResponses(provider, messages, tools, signal, options);
  }

  if (fmt === 'ollama-decision') return callOllamaDecision(provider, provider.decisionTask, signal);

  const kind = adapterKind(provider);
  if (kind === 'anthropic') return callAnthropic(provider, messages, tools, signal, options);
  if (kind === 'gemini') return callGemini(provider, messages, tools, signal, options);
  if (kind === 'ollama') return callOllama(provider, messages, tools, signal, options);

  // Default: OpenAI-compat (OpenAI, DeepSeek, LM Studio, OpenRouter, ...)
  return callOpenAI(provider, messages, tools, signal, options);
}

async function dispatchToProvider(provider, messages, tools, signal, options = {}) {
  const budget = options.executionBudget || require('../../governance/context').current()?.executionBudget;
  // Admin-set locks and token limits apply to every model call, whichever feature makes it.
  const usage = require('../../services/ai_usage_service'), accountId = usage.currentAccountId();
  await usage.service.check({ accountId, provider, admitted: require('../../governance/context').current()?.aiUsageAdmitted });
  const result = await require('../../governance/admission').model.run(async () => {
    const estimated = Math.ceil(JSON.stringify([messages, tools]).length / 3) + (Number(provider.maxTokens) || 4096);
    // Provider settings and analytics store tokenCost in currency per 1K tokens.
    const unitCost = Number.isFinite(Number(provider.costPerToken)) && Number(provider.costPerToken) >= 0
      ? Number(provider.costPerToken) : Math.max(0, Number(provider.tokenCost) || 0) / 1000;
    const receipt = budget?.reserveUsage({ tokens: estimated, cost: estimated * unitCost, purpose: options.purpose || 'work' });
    let response;
    try { response = await dispatchUnchecked(provider, messages, tools, signal, options); return response; }
    finally { if (receipt !== undefined) budget.reconcileUsage(receipt, { tokens: response?.usage?.totalTokens,
      cost: response?.usage?.cost ?? (Number.isFinite(response?.usage?.totalTokens) ? response.usage.totalTokens * unitCost : undefined) }); }
  }, {
    signal, timeoutMs: Math.min(10000, budget?.remainingMs() ?? 10000)
  });
  // Providers that report no usage are still counted, by a rough size estimate, so they cannot bypass a limit.
  const reported = Number(result?.usage?.totalTokens);
  const tokens = Number.isFinite(reported) && reported > 0 ? reported
    : Math.ceil((JSON.stringify(messages || []).length + String(result?.content || '').length) / 3);
  await usage.service.record({ accountId, providerId: provider.id, tokens })
    .catch(error => console.error('[AI usage] Không ghi được mức sử dụng:', error.message));
  return result;
}

module.exports = {
  dispatchToProvider,
  adapterKind,
  callOllama,
  callOllamaDecision,
  callOpenAI,
  callGemini,
  callAnthropic
};
