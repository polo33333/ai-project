'use strict';

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function jsonCandidates(content) {
  const text = String(content || '').trim();
  if (!text) return [];
  const candidates = [text];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  return [...new Set(candidates)];
}

function normalizeOne(call, index = 0, source = 'native') {
  if (!call || typeof call !== 'object') return null;
  const fn = call.function || call.functionCall || call;
  const name = fn.name || call.name || call.tool || call.tool_name;
  let args = fn.arguments ?? fn.args ?? call.arguments ?? call.args ?? call.input ?? {};
  if (!name) return null;
  if (typeof args === 'string') {
    const parsed = parseJson(args);
    if (parsed === null) {
      return { id: call.id || `local-tool-${index + 1}`, name, arguments: null, rawArguments: args, source, parseError: 'Arguments are not valid JSON.' };
    }
    args = parsed;
  }
  return {
    id: call.id || `local-tool-${index + 1}`,
    name: String(name),
    arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : null,
    rawArguments: args,
    source
  };
}

function callsFromObject(value) {
  if (!value || typeof value !== 'object') return [];
  const rawCalls = value.tool_calls || value.calls;
  if (Array.isArray(rawCalls)) return rawCalls;
  if (value.tool || value.tool_name || value.function || value.functionCall || (value.name && (value.arguments || value.args || value.input))) return [value];
  return [];
}

function normalizeAssistantResponse(response = {}) {
  if (Array.isArray(response.tool_calls) && response.tool_calls.length) {
    return {
      kind: 'tool_call',
      content: response.content || '',
      calls: response.tool_calls.map((call, index) => normalizeOne(call, index, 'native')).filter(Boolean)
    };
  }

  for (const candidate of jsonCandidates(response.content)) {
    const parsed = parseJson(candidate);
    const calls = callsFromObject(parsed).map((call, index) => normalizeOne(call, index, 'content_json')).filter(Boolean);
    if (calls.length) return { kind: 'tool_call', content: response.content || '', calls };
  }

  return { kind: 'final', content: response.content || '', calls: [] };
}

module.exports = { normalizeAssistantResponse, parseJson };
