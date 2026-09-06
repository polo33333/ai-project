'use strict';

function compactValue(value, limits, depth = 0) {
  if (depth > limits.maxDepth) return '[truncated]';
  if (value instanceof Date) return value.toISOString();
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value.toString('base64');
  if (value && typeof value === 'object' && typeof value.toJSON === 'function') {
    return compactValue(value.toJSON(), limits, depth);
  }
  if (Array.isArray(value)) {
    const sliced = value.slice(0, limits.maxArrayItems).map(item => compactValue(item, limits, depth + 1));
    if (value.length > sliced.length) sliced.push({ _truncatedItems: value.length - sliced.length });
    return sliced;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, limits.maxObjectKeys).map(([key, item]) => [key, compactValue(item, limits, depth + 1)]));
  }
  if (typeof value === 'string' && value.length > limits.maxStringChars) return `${value.slice(0, limits.maxStringChars)}…`;
  return value;
}

function compactToolResult(execution, maxChars = Number(process.env.LOCAL_MODEL_TOOL_RESULT_CHARS || 6000)) {
  const compacted = execution.success
    ? { success: true, result: compactValue(execution.result, { maxDepth: 5, maxArrayItems: 20, maxObjectKeys: 40, maxStringChars: 1500 }) }
    : { success: false, error: execution.error };
  const serialized = JSON.stringify(compacted);
  if (serialized.length <= maxChars) return serialized;
  return JSON.stringify({
    success: execution.success,
    summary: serialized.slice(0, Math.max(0, maxChars - 120)),
    truncated: true,
    instruction: 'Use this partial result and do not repeat the same tool call.'
  });
}

module.exports = { compactToolResult, compactValue };
