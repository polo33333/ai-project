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

function compactToolResult(execution, maxChars = Number(process.env.LOCAL_MODEL_TOOL_RESULT_CHARS || 6000), options = {}) {
  const envelope = execution.envelope;
  const toolResult = envelope ? { schemaVersion: envelope.schemaVersion, status: envelope.status,
    completeness: envelope.completeness?.status || 'unknown', revision: envelope.revision,
    effectState: envelope.effectState, errorCode: envelope.error?.code || null,
    retryable: envelope.error?.retryable === true } : null;
  const compacted = execution.success
    ? { success: true, result: compactValue(execution.result, { maxDepth: 7, maxArrayItems: options.maxArrayItems || 20, maxObjectKeys: 100, maxStringChars: 1500 }) }
    : { success: false, error: execution.error, code: execution.code || undefined,
      details: compactValue(execution.details, { maxDepth: 3, maxArrayItems: 10, maxObjectKeys: 20, maxStringChars: 500 }) };
  if (toolResult) compacted.toolResult = toolResult;
  const serialized = JSON.stringify(compacted);
  if (serialized.length <= maxChars) return serialized;
  const truncated = {
    success: execution.success,
    truncated: true,
    ...(toolResult ? { toolResult } : {}),
    instruction: 'Use this partial result and do not repeat the same tool call.'
  };
  // Keep machine-readable status when data must be compacted further.
  const reserve = JSON.stringify({ ...truncated, summary: '' }).length;
  truncated.summary = serialized.slice(0, Math.max(0, Math.floor((maxChars - reserve) / 2)));
  return JSON.stringify(truncated);
}

function compactSupersededSchemas(messages) {
  const schema = message => { try { const value = JSON.parse(message.content); return value.success === true ? value.result : null; } catch { return null; } };
  const latest = messages.findLastIndex(message => message.role === 'tool' && message.name === 'search_schema'
    && schema(message));
  const current = latest >= 0 ? schema(messages[latest]) : null;
  const root = result => result?.selectedTables?.[0] || result?.tables?.[0]?.tableName;
  return messages.map((message, index) => index < latest && message.role === 'tool' && message.name === 'search_schema'
    && root(current) && root(schema(message)) === root(current) && schema(message)?.dbSourceId === current.dbSourceId
    ? { ...message, content: JSON.stringify({ superseded: true, instruction: 'Use the latest verified search_schema result in this conversation.' }) } : message);
}
module.exports = { compactToolResult, compactValue, compactSupersededSchemas };
