'use strict';
process.env.GOVERNED_EXTERNAL_READ_ONLY = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const mcpService = require('../src/backend/services/mcp_service');
const { defaultToolManager } = require('../src/backend/agent_core');
const toolRegistry = require('../src/backend/intelligent_core/tool_registry');

test('MCP stdio server is discovered and exposed to the agent', async () => {
  const fixture = path.join(__dirname, 'fixtures', 'mcp_stdio_server.js');
  const server = await mcpService.addServer({ name: 'Test MCP', protocol: 'stdio', endpoint: `node "${fixture}"`, scope: 'Integration test',
    readOnlyTools: ['echo'], readOnlyResources: ['test://welcome'] });
  const context = { accountId: 'mcp-test-admin', permissions: ['admin'] };
  try {
    assert.equal(server.status, 'connected');
    assert.equal(server.tools.length, 1);
    assert.equal(server.resources.length, 1);
    const toolSpec = mcpService.getToolSpecs().find(spec => spec.remoteName === 'echo');
    assert.ok(toolSpec);
    server.readOnlyTools = [];
    assert.ok(!mcpService.getToolSpecs().some(spec => spec.name === toolSpec.name));
    assert.equal((await mcpService.executeSpec(toolSpec, { text: 'blocked' }, context)).code, 'MCP_SPEC_CHANGED');
    server.readOnlyTools = ['echo'];
    const previousDescription = server.tools[0].description;
    server.tools[0].description = 'Changed remote semantics';
    assert.ok(!mcpService.getToolSpecs().some(spec => spec.name === toolSpec.name));
    assert.equal((await mcpService.executeSpec(toolSpec, { text: 'changed' }, context)).code, 'MCP_SPEC_CHANGED');
    server.tools[0].description = previousDescription;
    assert.ok(defaultToolManager.getTool(toolSpec.name));
    assert.equal((await mcpService.executeSpec(toolSpec, { text: 'denied' })).code, 'MCP_ACCESS_DENIED');
    assert.equal((await toolRegistry.executeTool(toolSpec.name, { text: 'denied' })).code, 'MCP_ACCESS_DENIED');
    assert.equal((await mcpService.executeSpec({ ...toolSpec, remoteName: 'forged' }, {}, context)).code, 'MCP_SPEC_CHANGED');
    assert.equal((await mcpService.executeSpec({ ...toolSpec, kind: 'resource' }, { text: 'forged' }, context)).code, 'MCP_SPEC_CHANGED');
    const toolResult = await defaultToolManager.executeTool(toolSpec.name, { text: 'hello' }, context);
    assert.equal(toolResult.success, true);
    assert.equal(toolResult.result.content[0].text, 'echo:hello');
    assert.ok(!toolRegistry.listTools().some(definition => definition.name === toolSpec.name));
    assert.ok(toolRegistry.listTools(null, context).some(definition => definition.name === toolSpec.name));
    const legacyResult = await toolRegistry.executeTool(toolSpec.name, { text: 'legacy' }, context);
    assert.equal(legacyResult.success, true);
    assert.equal(legacyResult.result.content[0].text, 'echo:legacy');
    assert.equal(legacyResult.envelope.status, 'succeeded');
    assert.equal(legacyResult.envelope.effectState, 'unknown');
    assert.equal(legacyResult.result.envelope, undefined);
    const directResult = await mcpService.executeSpec(toolSpec, { text: 'direct' }, context);
    assert.equal(directResult.envelope.status, 'succeeded');
    assert.equal(directResult.content[0].text, 'echo:direct');
    const deniedResult = await mcpService.executeSpec(toolSpec, { text: 'denied' });
    assert.equal(deniedResult.envelope.status, 'denied');
    assert.equal(deniedResult.envelope.effectState, 'none');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(mcpService.executeSpec(toolSpec, { text: 'cancelled' }, { ...context, signal: controller.signal }), error => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.toolResult.status, 'cancelled');
      assert.equal(error.toolResult.effectState, 'none');
      return true;
    });
    const resourceSpec = mcpService.getToolSpecs().find(spec => spec.kind === 'resource');
    assert.equal((await mcpService.executeSpec(resourceSpec, { uri: 'test://not-allowed' }, context)).code, 'MCP_INVALID_INPUT');
    const resourceResult = await defaultToolManager.executeTool(resourceSpec.name, { uri: 'test://welcome' }, context);
    assert.equal(resourceResult.success, true);
    assert.equal(resourceResult.result.contents[0].text, 'MCP resource is available.');
    assert.equal(resourceResult.envelope.effectState, 'none');
    assert.equal(resourceResult.result.envelope, undefined);
  } finally {
    await mcpService.deleteServer(server.id);
  }
});
