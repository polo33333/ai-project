'use strict';
const { estimateTokens } = require('./context_budget');
function decoded(message) { try { return JSON.parse(message.content); } catch { return null; } }
function footprint(messages, definitions = []) {
  const parts = { system: 0, history: 0, memory: 0, glossary: 0, currentQuestion: 0, schema: 0, workflow: 0, data: 0, otherTools: 0, assistantActions: 0, toolDefinitions: estimateTokens(definitions) };
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const structured = message.role === 'user' ? decoded(message) : null;
    if (typeof structured?.question === 'string' && Array.isArray(structured.candidates) && Array.isArray(structured.recent)) {
      parts.currentQuestion += estimateTokens(structured.question);
      parts.history += estimateTokens(structured.recent);
      parts.memory += estimateTokens({ candidates: structured.candidates, previousRequest: structured.previousRequest });
      parts.glossary += estimateTokens(structured.glossary || []);
      continue;
    }
    const category = message.role === 'system' ? 'system' : message.role === 'tool'
      ? message.name === 'search_schema' ? 'schema' : ['list_workflows', 'run_workflow', 'get_workflow_status', 'resume_workflow'].includes(message.name) ? 'workflow'
        : ['execute_sql_query', 'query_sql_metric', 'get_workflow_dataset'].includes(message.name) ? 'data' : 'otherTools'
      : message.tool_calls?.length ? 'assistantActions' : index === lastUser ? 'currentQuestion' : 'history';
    parts[category] += estimateTokens(message);
  }
  return { estimated: true, parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}
function compact(messages, { targetTokens = Infinity } = {}) {
  // Replace only byte-identical successful evidence. Same table/root is NOT
  // proof that a newer schema contains older columns, mappings or relations.
  const latest = new Map();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i], value = message.role === 'tool' ? decoded(message) : null;
    if (value?.success === true) latest.set(JSON.stringify([message.name, value]), i);
  }
  const changes = [];
  const result = messages.map((message, index) => {
    const value = message.role === 'tool' ? decoded(message) : null;
    const duplicate = value?.success === true ? latest.get(JSON.stringify([message.name, value])) : undefined;
    if (duplicate !== undefined && duplicate > index) {
      const content = JSON.stringify({ duplicate: true, retainedToolCallId: messages[duplicate].tool_call_id,
        instruction: 'Identical successful evidence is retained in the later tool result. No data changed.' });
      if (content.length < message.content.length) { changes.push({ index, reason: 'identical_success', retainedIndex: duplicate }); return { ...message, content }; }
    }
    return message;
  });
  const afterDedup = footprint(result).total;
  if (afterDedup > targetTokens) {
    // Only remove redundant assistant narration attached to a tool action.
    // Keep user turns, call IDs/arguments, tool evidence and failure diagnostics.
    for (let index = 0; index < result.length; index++) {
      const message = result[index];
      if (message.role === 'assistant' && message.tool_calls?.length && message.content) {
        result[index] = { ...message, content: '' };
        changes.push({ index, reason: 'action_narration' });
      }
    }
  }
  return { messages: result, changes, beforeTokens: footprint(messages).total, afterTokens: footprint(result).total };
}
module.exports = { compact, footprint };
