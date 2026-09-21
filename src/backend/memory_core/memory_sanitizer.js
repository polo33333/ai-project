'use strict';

const securityGuard = require('../intelligent_core/security_guard');
const { normalizeAssistantResponse } = require('../agent_core/harness/tool_call_normalizer');

function maskSensitive(value) {
  return securityGuard.maskSensitiveData(String(value ?? ''));
}

function removeRawSql(text) {
  return String(text || '')
    .replace(/```(?:sql|tsql)[\s\S]*?```/gi, '')
    .replace(/^\s*(?:SELECT|WITH)\b[\s\S]*$/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeMessage(message, maxChars = 12000) {
  if (!message || !['user', 'assistant', 'system'].includes(message.role)) return null;
  let content = maskSensitive(message.content).trim();
  if (message.role === 'assistant') {
    if (normalizeAssistantResponse({ content }).kind === 'tool_call') return null;
    content = removeRawSql(content);
  }
  if (!content) return null;
  return { role: message.role, content: content.slice(0, maxChars) };
}

function sanitizeMessages(messages = [], maxChars = 12000) {
  const result = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.role === 'user' && messages[index + 1]?.role === 'assistant') {
      const user = sanitizeMessage(messages[index], maxChars);
      const assistant = sanitizeMessage(messages[++index], maxChars);
      if (user && assistant) result.push(user, assistant);
    } else {
      const message = sanitizeMessage(messages[index], maxChars);
      if (message) result.push(message);
    }
  }
  return result;
}

function sanitizeObject(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return maskSensitive(value).slice(0, 4000);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitizeObject(item, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|pwd|secret|token|api.?key|connection.?string/i.test(key)) {
      result[key] = '[MASKED]';
    } else {
      result[key] = sanitizeObject(item, depth + 1);
    }
  }
  return result;
}

module.exports = { maskSensitive, removeRawSql, sanitizeMessage, sanitizeMessages, sanitizeObject };
