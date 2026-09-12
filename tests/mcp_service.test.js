'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const mcpService = require('../src/backend/services/mcp_service');
const { defaultToolManager } = require('../src/backend/agent_core');
const toolRegistry = require('../src/backend/intelligent_core/tool_registry');

test('MCP stdio server is discovered and exposed to the agent', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'mcp_stdio_server.js');
  const server = await mcpService.addServer({ name: 'Test MCP', protocol: 'stdio', endpoint: `node "${fixture}"`, scope: 'Integration test' });
  try {
    assert.equal(server.status, 'connected');
    assert.equal(server.tools.length, 1);
    assert.equal(server.resources.length, 1);
    const toolSpec = mcpService.getToolSpecs().find(spec => spec.remoteName === 'echo');
    assert.ok(toolSpec);
    assert.ok(defaultToolManager.getTool(toolSpec.name));
    const toolResult = await defaultToolManager.executeTool(toolSpec.name, { text: 'hello' });
    assert.equal(toolResult.success, true);
    assert.equal(toolResult.result.content[0].text, 'echo:hello');
    assert.ok(toolRegistry.listTools().some(definition => definition.name === toolSpec.name));
    const legacyResult = await toolRegistry.executeTool(toolSpec.name, { text: 'legacy' });
    assert.equal(legacyResult.success, true);
    assert.equal(legacyResult.result.content[0].text, 'echo:legacy');
    const resourceSpec = mcpService.getToolSpecs().find(spec => spec.kind === 'resource');
    const resourceResult = await defaultToolManager.executeTool(resourceSpec.name, { uri: 'test://welcome' });
    assert.equal(resourceResult.success, true);
    assert.equal(resourceResult.result.contents[0].text, 'MCP resource is available.');
  } finally {
    await mcpService.deleteServer(server.id);
  }
});
