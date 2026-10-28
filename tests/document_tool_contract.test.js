'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Harness = require('../src/backend/agent/harness/guarded_agent_harness');
const BaseTool = require('../src/backend/agent/tools/base_tool');
const ToolManager = require('../src/backend/agent/tools/tool_manager');
test('dynamic document tools assign source markers, repair invented citations and preserve source revision', async () => {
  const manager = new ToolManager();
  const tool = new BaseTool({ name: 'search_knowledge_base', description: 'Document test', parameters: { type: 'object' } });
  tool.run = async () => ({ documents: [{ documentId: 'guide', source: 'Guide', text: 'Verified instructions',
    chunkIndex: 2, chunkId: 'guide:rev:2', revision: 'rev' }] });
  manager.registerTool(tool);
  const responses = [{ tool_calls: [{ id: 'search', type: 'function', function: { name: tool.name, arguments: '{}' } }] },
    { content: 'Instructions [99].' }, { content: 'Instructions [1].' }];
  const result = await new Harness({ toolManager: manager, dispatch: async () => responses.shift() }).run({
    userMessage: 'Find instructions', provider: { id: 'offline', supportsToolCalling: true },
    context: { governedController: true, lockProvider: true, requestPlan: { outputs: { data: false } } } });
  assert.equal(result.trace.completionStatus, 'SUCCESS');
  assert.equal(result.trace.executionBudget.repairAttempts, 1);
  assert.ok(result.trace.steps.some(step => step.failures?.includes('INVALID_KNOWLEDGE_CITATION')));
  assert.equal(result.citationEvidence[0].payload.revision, 'rev');
  const response = require('../src/backend/assistant/core')._buildSuccessResponse('instructions', result.replyText,
    result.toolCalls, { id: 'offline' }, result.tokenUsage, [], { citationEvidence: result.citationEvidence }, result.trace);
  assert.equal(response.citations[0].documentId, 'guide');
  assert.equal(response.citations[0].revision, 'rev');
});
