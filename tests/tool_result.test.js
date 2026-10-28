'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createToolResult } = require('../src/backend/agent/tools/tool_result');
const BaseTool = require('../src/backend/agent/tools/base_tool');
const ToolManager = require('../src/backend/agent/tools/tool_manager');

test('SQL, document and API adapters retain data without inventing completeness', async () => {
  const manager = new ToolManager();
  for (const name of ['sql_probe', 'document_probe', 'api_probe']) {
    const tool = new BaseTool({ name, description: name });
    tool.run = async () => ({ rows: [{ field: 'verified' }], dbSourceId: 'authorized-source' });
    manager.registerTool(tool);
    const result = await manager.executeTool(name, {}, { requestId: 'request', session: { id: 'session' } });
    assert.equal(result.success, true);
    assert.equal(result.envelope.status, 'succeeded');
    assert.equal(result.envelope.data, result.result);
    assert.equal(result.envelope.completeness.status, 'unknown');
    assert.equal(result.envelope.scope.conversationId, 'session');
    assert.equal(result.envelope.evidence.sourceId, 'authorized-source');
  }
});

test('workflow handoffs distinguish pending, failure and cancellation and retain revision receipts', () => {
  for (const [state, expected] of [['WAITING_INPUT', 'pending'], ['NEEDS_REVIEW', 'pending'], ['RUNNING', 'pending'],
    ['FAILED', 'failed'], ['CANCELLED', 'cancelled'], ['SUCCEEDED', 'succeeded']]) {
    const value = createToolResult({ success: true, tool: 'run_workflow', result: {
      execution: { id: 'run', status: state, revision: 3, error: state === 'FAILED' ? 'source failed' : null }
    } });
    assert.equal(value.status, expected);
    assert.equal(value.receipt.revision, 3);
    assert.equal(value.revision, 3);
    if (state === 'FAILED') assert.equal(value.error.message, 'source failed');
  }
});

test('unsafe and uncertain effects never permit automatic retry', () => {
  for (const effectState of ['unknown', 'committed']) {
    const result = createToolResult({ success: false, outcome: 'timeout', retryable: true, effectState });
    assert.equal(result.error.retryable, false);
  }
  assert.equal(createToolResult({ success: false, retryable: true, effectState: 'none' }, {}, { isDangerous: true }).error.retryable, false);
  assert.equal(createToolResult({ success: false, retryable: true, effectState: 'none' }).error.retryable, true);
});

test('direct invocation cannot bypass tool availability and never dispatches rejected calls', async () => {
  const manager = new ToolManager();
  const tool = new BaseTool({ name: 'unavailable', description: 'Unavailable' });
  let calls = 0;
  tool.available = () => false;
  tool.run = async () => { calls++; };
  manager.registerTool(tool);
  const result = await manager.executeTool('unavailable', {});
  assert.equal(result.envelope.status, 'denied');
  assert.equal(result.envelope.effectState, 'none');
  assert.equal(calls, 0);
  assert.equal((await manager.executeTool('missing', {})).envelope.error.code, 'TOOL_NOT_FOUND');
  assert.equal((await manager.executeTool('unavailable', {}, { allowedToolNames: [] })).envelope.error.code, 'TOOL_NOT_ENABLED');
});

test('timeouts preserve effect uncertainty; cancellation does not become success', async () => {
  const manager = new ToolManager();
  const tool = new BaseTool({ name: 'slow', description: 'Slow', timeoutMs: 10, isDangerous: true });
  tool.run = async () => new Promise(() => {});
  manager.registerTool(tool);
  const result = await manager.executeTool('slow', {});
  assert.equal(result.envelope.status, 'timeout');
  assert.equal(result.envelope.effectState, 'unknown');
  assert.equal(result.envelope.error.retryable, false);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(manager.executeTool('slow', {}, { signal: abort.signal }), { name: 'AbortError' });
});

test('empty and source-truncated results are distinct from complete results', () => {
  assert.equal(createToolResult({ success: true, result: { rows: [] } }).status, 'empty');
  assert.equal(createToolResult({ success: true, result: { hasMore: true, complete: true } }).completeness.status, 'partial');
  assert.equal(createToolResult({ success: true, result: { complete: true } }).completeness.status, 'complete');
});

test('model context preserves failure metadata when payload is compacted', () => {
  const { compactToolResult } = require('../src/backend/agent/harness/local_result_compactor');
  const execution = { success: false, tool: 'api', outcome: 'timeout', code: 'TOOL_TIMEOUT',
    error: 'timeout', effectState: 'unknown', details: { content: 'x'.repeat(10000) } };
  execution.envelope = createToolResult(execution);
  const compacted = compactToolResult(execution, 450);
  const value = JSON.parse(compacted);
  assert.equal(value.toolResult.status, 'timeout');
  assert.equal(value.toolResult.effectState, 'unknown');
  assert.equal(value.toolResult.retryable, false);
  assert.ok(compacted.length <= 450);
});
