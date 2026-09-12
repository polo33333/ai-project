'use strict';

const StorageHelper = require('../utils/storage_helper');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { SSEClientTransport } = require('@modelcontextprotocol/sdk/client/sse.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const CONNECT_TIMEOUT_MS = Math.max(1000, Number(process.env.MCP_CONNECT_TIMEOUT_MS || 15000));
const CALL_TIMEOUT_MS = Math.max(1000, Number(process.env.MCP_CALL_TIMEOUT_MS || 30000));

function safePart(value, fallback = 'item') {
  const clean = String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return clean || fallback;
}

function splitCommandLine(commandLine) {
  const tokens = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s]+)/g;
  let match;
  while ((match = pattern.exec(String(commandLine || '').trim()))) {
    tokens.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"'])/g, '$1'));
  }
  return tokens;
}

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { type: 'object', properties: {} };
  return { ...schema, type: 'object', properties: schema.properties && typeof schema.properties === 'object' ? schema.properties : {} };
}

class McpService {
  constructor() {
    this.mcpServers = StorageHelper.loadJson('mcp_servers.json', []).map(server => ({
      ...server,
      status: server.status === 'connected' ? 'disconnected' : (server.status || 'configured'),
      tools: Array.isArray(server.tools) ? server.tools : [],
      resources: Array.isArray(server.resources) ? server.resources : []
    }));
    this.sessions = new Map();
    this.boundToolManager = null;
    this.BaseTool = null;
    this.registeredToolNames = new Set();
  }

  persist() { StorageHelper.saveJson('mcp_servers.json', this.mcpServers); }

  getServers() {
    return this.mcpServers.map(({ tools = [], resources = [], ...server }) => ({
      ...server,
      toolsCount: tools.length,
      resourcesCount: resources.length,
      tools: tools.map(tool => ({ name: tool.name, description: tool.description || '' })),
      resources: resources.map(resource => ({ uri: resource.uri, name: resource.name || resource.uri, description: resource.description || '' }))
    }));
  }

  getServer(id) { return this.mcpServers.find(server => server.id === id) || null; }

  async addServer(data = {}) {
    const protocol = String(data.protocol || 'sse').toLowerCase();
    const endpoint = String(data.endpoint || '').trim();
    if (!['sse', 'http', 'stdio'].includes(protocol)) throw new Error('Giao thức MCP phải là SSE, HTTP hoặc stdio.');
    if (!endpoint) throw new Error('Endpoint hoặc command MCP không được để trống.');
    if (protocol !== 'stdio') this.validateHttpEndpoint(endpoint);
    const newServer = {
      id: `mcp-${Date.now()}`,
      name: String(data.name || 'Custom MCP Server').trim().slice(0, 100),
      protocol,
      endpoint,
      status: 'connecting',
      scope: String(data.scope || 'General Tools & Resources').trim().slice(0, 500),
      tools: [], resources: [], lastError: null, lastConnectedAt: null
    };
    this.mcpServers.unshift(newServer);
    this.persist();
    try { await this.connectServer(newServer.id); } catch (_) { /* Error state is persisted by connectServer. */ }
    return this.getServer(newServer.id);
  }

  async deleteServer(id) {
    await this.closeSession(id);
    this.mcpServers = this.mcpServers.filter(server => server.id !== id);
    this.persist();
    this.syncAgentTools();
    return true;
  }

  validateHttpEndpoint(endpoint) {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Endpoint MCP chỉ hỗ trợ HTTP hoặc HTTPS.');
    return url;
  }

  createTransport(server, forceSse = false) {
    if (server.protocol === 'stdio') {
      const [command, ...args] = splitCommandLine(server.endpoint);
      if (!command) throw new Error('Command stdio không hợp lệ.');
      return new StdioClientTransport({ command, args, cwd: process.cwd(), stderr: 'pipe' });
    }
    const url = this.validateHttpEndpoint(server.endpoint);
    return forceSse || server.protocol === 'sse'
      ? new SSEClientTransport(url)
      : new StreamableHTTPClientTransport(url);
  }

  async openClient(server) {
    const connect = async forceSse => {
      const client = new Client({ name: 'knowledgehub-ai', version: '1.0.0' }, { capabilities: {} });
      const transport = this.createTransport(server, forceSse);
      try {
        await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
        return { client, transport };
      } catch (error) {
        await transport.close().catch(() => {});
        throw error;
      }
    };
    if (server.protocol !== 'http') return connect(false);
    try { return await connect(false); } catch (firstError) {
      try { return await connect(true); } catch (secondError) {
        throw new Error(`Không kết nối được Streamable HTTP hoặc SSE: ${secondError.message || firstError.message}`);
      }
    }
  }

  async connectServer(id) {
    const server = this.getServer(id);
    if (!server) throw new Error('Không tìm thấy MCP Server.');
    await this.closeSession(id);
    server.status = 'connecting'; server.lastError = null; this.persist();
    try {
      const session = await this.openClient(server);
      const [tools, resources] = await Promise.all([
        this.listAll(session.client, 'listTools', 'tools'),
        this.listAll(session.client, 'listResources', 'resources').catch(() => [])
      ]);
      server.tools = tools.map(tool => ({ name: tool.name, description: tool.description || '', inputSchema: sanitizeSchema(tool.inputSchema) }));
      server.resources = resources.map(resource => ({ uri: resource.uri, name: resource.name || resource.uri, description: resource.description || '', mimeType: resource.mimeType || null }));
      server.status = 'connected'; server.lastError = null; server.lastConnectedAt = new Date().toISOString();
      this.sessions.set(id, session);
      this.persist(); this.syncAgentTools();
      return server;
    } catch (error) {
      server.status = 'error'; server.lastError = String(error.message || error).slice(0, 1000);
      this.persist(); this.syncAgentTools();
      throw error;
    }
  }

  async listAll(client, method, key) {
    const items = [];
    let cursor;
    do {
      const result = await client[method](cursor ? { cursor } : {}, { timeout: CONNECT_TIMEOUT_MS });
      items.push(...(result[key] || []));
      cursor = result.nextCursor;
    } while (cursor);
    return items;
  }

  async ensureClient(serverId) {
    if (this.sessions.has(serverId)) return this.sessions.get(serverId).client;
    await this.connectServer(serverId);
    return this.sessions.get(serverId).client;
  }

  async closeSession(id) {
    const session = this.sessions.get(id);
    this.sessions.delete(id);
    if (session) await session.transport.close().catch(() => {});
  }

  toolAlias(server, toolName) {
    const prefix = `mcp_${safePart(server.id.replace(/^mcp-/, ''), 'server')}_`;
    return `${prefix}${safePart(toolName, 'tool')}`.slice(0, 64);
  }

  resourceAlias(server) { return this.toolAlias(server, 'read_resource'); }

  getToolSpecs() {
    const specs = [];
    for (const server of this.mcpServers) {
      for (const tool of server.tools || []) specs.push({
        name: this.toolAlias(server, tool.name),
        description: `[MCP: ${server.name}] ${tool.description || `Gọi công cụ ${tool.name}`}`.slice(0, 1000),
        parameters: sanitizeSchema(tool.inputSchema),
        serverId: server.id, remoteName: tool.name, kind: 'tool'
      });
      if ((server.resources || []).length) specs.push({
        name: this.resourceAlias(server),
        description: `[MCP: ${server.name}] Đọc một resource đã công bố bởi server.`,
        parameters: { type: 'object', properties: { uri: { type: 'string', enum: server.resources.map(resource => resource.uri), description: 'URI resource cần đọc' } }, required: ['uri'] },
        serverId: server.id, kind: 'resource'
      });
    }
    return specs;
  }

  async executeSpec(spec, args = {}) {
    const client = await this.ensureClient(spec.serverId);
    if (spec.kind === 'resource') {
      const result = await client.readResource({ uri: args.uri }, { timeout: CALL_TIMEOUT_MS });
      return { serverId: spec.serverId, uri: args.uri, contents: result.contents || [] };
    }
    const result = await client.callTool({ name: spec.remoteName, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS });
    if (result.isError) {
      const message = (result.content || []).map(item => item.text || '').filter(Boolean).join('\n') || `MCP tool ${spec.remoteName} báo lỗi.`;
      return { success: false, error: message };
    }
    return { serverId: spec.serverId, tool: spec.remoteName, content: result.content || [], structuredContent: result.structuredContent || null };
  }

  bindToolManager(toolManager, BaseTool) {
    this.boundToolManager = toolManager; this.BaseTool = BaseTool; this.syncAgentTools();
  }

  syncAgentTools() {
    if (!this.boundToolManager || !this.BaseTool) return;
    for (const name of this.registeredToolNames) this.boundToolManager.unregisterTool(name);
    this.registeredToolNames.clear();
    const service = this;
    for (const spec of this.getToolSpecs()) {
      const DynamicMcpTool = class extends this.BaseTool {
        constructor() { super({ name: spec.name, description: spec.description, parameters: spec.parameters, timeoutMs: CALL_TIMEOUT_MS }); }
        async run(args) { return service.executeSpec(spec, args); }
      };
      this.boundToolManager.registerTool(new DynamicMcpTool());
      this.registeredToolNames.add(spec.name);
    }
  }
}

module.exports = new McpService();
