/**
 * Adapters Index — Provider Dispatcher
 * Chọn adapter phù hợp dựa vào provider config (apiFormat, type, baseUrl)
 */

const { callOllama }    = require('./ollama');
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
async function dispatchToProvider(provider, messages, tools, signal) {
  if (typeof fetch === 'undefined') {
    throw new Error('Fetch API không khả dụng trong môi trường Node.js này (yêu cầu Node.js >= 18).');
  }

  const fmt  = (provider.apiFormat || '').toLowerCase();
  const url  = (provider.baseUrl   || '').toLowerCase();
  const type = (provider.type      || '').toLowerCase();

  if (fmt === 'anthropic' || type === 'anthropic' || url.includes('anthropic.com')) {
    return callAnthropic(provider, messages, tools, signal);
  }
  if (fmt === 'gemini' || type === 'google' || type === 'google gemini api' || url.includes('googleapis.com') || url.includes('generativelanguage')) {
    return callGemini(provider, messages, tools, signal);
  }
  if (fmt === 'ollama' || type === 'local' || type === 'ollama (local)' || url.includes('11434')) {
    return callOllama(provider, messages, tools, signal);
  }

  // Default: OpenAI-compat (OpenAI, DeepSeek, LM Studio, OpenRouter, ...)
  return callOpenAI(provider, messages, tools, signal);
}

module.exports = {
  dispatchToProvider,
  callOllama,
  callOpenAI,
  callGemini,
  callAnthropic
};
