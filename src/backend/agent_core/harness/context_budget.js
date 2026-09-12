'use strict';

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return Math.ceil(text.length / positive(process.env.MEMORY_TOKEN_CHARS_PER_TOKEN, 3.2));
}

function measureMessages(messages = []) {
  return messages.reduce((sum, message) => sum + 4 + estimateTokens(message?.content || ''), 0);
}

function fitOptionalMessages(messages = [], options = {}) {
  const contextWindow = positive(options.contextWindow, positive(process.env.LOCAL_MODEL_NUM_CTX, 16384));
  const outputReserve = positive(options.outputReserve, positive(process.env.LOCAL_MODEL_NUM_PREDICT, 2048));
  const requiredTokens = positive(options.requiredTokens, 0);
  const margin = positive(options.margin, 256);
  const available = Math.max(0, contextWindow - outputReserve - requiredTokens - margin);
  const units = [];
  for (let index = 0; index < messages.length; index += 1) {
    const current = messages[index];
    if (current?.role === 'user' && messages[index + 1]?.role === 'assistant') {
      units.push([current, messages[index + 1]]);
      index += 1;
    } else {
      units.push([current]);
    }
  }
  const selectedUnits = [];
  let used = 0;
  for (const unit of [...units].reverse()) {
    const cost = unit.reduce((sum, message) => sum + 4 + estimateTokens(message?.content || ''), 0);
    if (used + cost > available) continue;
    selectedUnits.unshift(unit);
    used += cost;
  }
  const selected = selectedUnits.flat();
  return { messages: selected, estimate: { contextWindow, outputReserve, requiredTokens, margin, available, used, dropped: messages.length - selected.length } };
}

module.exports = { estimateTokens, fitOptionalMessages, measureMessages };
