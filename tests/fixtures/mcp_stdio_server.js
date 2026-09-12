'use strict';

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListResourcesRequestSchema, ListToolsRequestSchema, ReadResourceRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const server = new Server({ name: 'knowledgehub-test-mcp', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'echo', description: 'Echo text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: `echo:${request.params.arguments?.text || ''}` }] }));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{ uri: 'test://welcome', name: 'Welcome', mimeType: 'text/plain' }] }));
server.setRequestHandler(ReadResourceRequestSchema, async request => ({ contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: 'MCP resource is available.' }] }));
server.connect(new StdioServerTransport()).catch(error => { process.stderr.write(`${error.stack || error.message}\n`); process.exitCode = 1; });
