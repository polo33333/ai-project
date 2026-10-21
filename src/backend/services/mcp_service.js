'use strict';

const StorageHelper = require('../utils/storage_helper');
const Ajv = require('ajv');
const validateSchema = new Ajv({ allErrors: true, strict: false, validateFormats: false });
const fingerprint = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
    StorageHelper.bind(this, 'mcpServers', 'mcp_servers.json', [], servers => servers.map(server => ({
      ...server,
      status: this.sessions?.has(server.id) ? 'connected' : (server.status === 'connected' ? 'disconnected' : (server.status || 'configured')),
      tools: Array.isArray(server.tools) ? server.tools : [],
      resources: Array.isArray(server.resources) ? server.resources : []
    })));
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
      tools: tools.map(tool => ({ name: tool.name, description: tool.description || '', schemaHash: fingerprint(tool) })),
      resources: resources.map(resource => ({ uri: resource.uri, name: resource.name || resource.uri, description: resource.description || '', schemaHash: fingerprint(resource) }))
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
      readOnlyTools: Array.isArray(data.readOnlyTools) ? data.readOnlyTools.filter(value => typeof value === 'string').slice(0, 100) : [],
      readOnlyResources: Array.isArray(data.readOnlyResources) ? data.readOnlyResources.filter(value => typeof value === 'string').slice(0, 100) : [],
      tools: [], resources: [], lastError: null, lastConnectedAt: null
    };
    this.mcpServers.unshift(newServer);
    this.persist();
    try { await this.connectServer(newServer.id); } catch (_) { /* Error state is persisted by connectServer. */ }
    if (newServer.status === 'connected' && (newServer.readOnlyTools.length || newServer.readOnlyResources.length)) {
      this.reviewReadOnly(newServer.id, data, 'server-configuration');
    }
    return this.getServer(newServer.id);
  }

  reviewReadOnly(id, data, actorId) {
    const server = this.getServer(id);
    if (!server) throw new Error('Không tìm thấy MCP Server.');
    for (const key of ['readOnlyTools', 'readOnlyResources']) {
      if (!Array.isArray(data[key]) || data[key].length > 100 || data[key].some(value => typeof value !== 'string')) throw new Error('Danh sách chỉ đọc không hợp lệ.');
    }
    if (data.readOnlyTools.some(name => !server.tools.some(tool => tool.name === name)) ||
        data.readOnlyResources.some(uri => !server.resources.some(resource => resource.uri === uri))) throw new Error('Công cụ hoặc tài nguyên đã thay đổi. Hãy quét lại nguồn.');
    if (actorId !== 'server-configuration' && (data.readOnlyTools.some(name => data.expectedToolHashes?.[name] !== fingerprint(server.tools.find(tool => tool.name === name))) ||
        data.readOnlyResources.some(uri => data.expectedResourceHashes?.[uri] !== fingerprint(server.resources.find(resource => resource.uri === uri))))) throw new Error('Schema đã thay đổi sau khi mở bảng duyệt. Hãy tải lại và kiểm tra.');
    server.readOnlyTools = [...new Set(data.readOnlyTools)];
    server.readOnlyResources = [...new Set(data.readOnlyResources)];
    server.readOnlyReview = { actorId, reviewedAt: new Date().toISOString(),
      toolHashes: Object.fromEntries(server.tools.filter(tool => server.readOnlyTools.includes(tool.name)).map(tool => [tool.name, fingerprint(tool)])),
      resourceHashes: Object.fromEntries(server.resources.filter(resource => server.readOnlyResources.includes(resource.uri)).map(resource => [resource.uri, fingerprint(resource)])) };
    this.persist(); this.syncAgentTools();
    return this.getServers().find(item => item.id === id);
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
      const readOnly = require('../automation/read_only_policy').externalReadOnly();
      for (const tool of (server.tools || []).filter(tool => !readOnly || (server.readOnlyTools?.includes(tool.name) && server.readOnlyReview?.toolHashes?.[tool.name] === fingerprint(tool)))) specs.push({
        name: this.toolAlias(server, tool.name),
        description: `[MCP: ${server.name}] ${tool.description || `Gọi công cụ ${tool.name}`}`.slice(0, 1000),
        parameters: sanitizeSchema(tool.inputSchema),
        serverId: server.id, remoteName: tool.name, kind: 'tool'
      });
      const resources = (server.resources || []).filter(resource => !readOnly || (server.readOnlyResources?.includes(resource.uri) && server.readOnlyReview?.resourceHashes?.[resource.uri] === fingerprint(resource)));
      if (resources.length) specs.push({
        name: this.resourceAlias(server),
        description: `[MCP: ${server.name}] Đọc một resource đã công bố bởi server.`,
        parameters: { type: 'object', properties: { uri: { type: 'string', enum: resources.map(resource => resource.uri), description: 'URI resource cần đọc' } }, required: ['uri'] },
        serverId: server.id, kind: 'resource'
      });
    }
    return specs;
  }

  async executeSpec(spec, args = {}, context = {}) {
    const startedAt = Date.now();
    const preCancelled = context.signal?.aborted === true;
    let result;
    try { result = await this.executeValidatedSpec(spec, args, context); }
    catch (error) {
      if (error.name === 'AbortError') {
        error.toolResult = require('../agent_core/tools/tool_result').createToolResult({ success: false,
          tool: spec.name, outcome: 'cancelled', code: error.code || 'MCP_CANCELLED', error: error.message,
          effectState: preCancelled || spec.kind === 'resource' ? 'none' : 'unknown', durationMs: Date.now() - startedAt }, context);
        throw error;
      }
      result = { success: false, error: error.message || 'MCP execution failed.', code: error.code || null,
        outcome: ['ETIMEDOUT', 'TOOL_TIMEOUT'].includes(error.code) ? 'timeout' : 'failed',
        effectState: spec.kind === 'resource' ? 'none' : 'unknown', retryable: false };
    }
    const execution = { ...result, tool: spec.name, success: result.success !== false,
      result: result.success === false ? null : result, durationMs: Date.now() - startedAt,
      effectState: result.effectState || (spec.kind === 'resource' ? 'none' : 'unknown') };
    return { ...result, envelope: require('../agent_core/tools/tool_result').createToolResult(execution, context) };
  }

  async executeValidatedSpec(spec, args = {}, context = {}) {
    if (context.signal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    const permissions = Array.isArray(context.permissions) ? context.permissions : [];
    if (!permissions.some(value => ['admin', '*', `mcp:${spec.serverId}:execute`].includes(value))) {
      return { success: false, error: 'MCP access denied.', code: 'MCP_ACCESS_DENIED', outcome: 'denied', effectState: 'none' };
    }
    const current = this.getToolSpecs().filter(item => item.name === spec.name);
    if (current.length !== 1 || current[0].serverId !== spec.serverId || current[0].remoteName !== spec.remoteName || current[0].kind !== spec.kind ||
        JSON.stringify(current[0].parameters) !== JSON.stringify(spec.parameters)) {
      return { success: false, error: 'MCP tool changed or is unavailable.', code: 'MCP_SPEC_CHANGED', outcome: 'denied', effectState: 'none' };
    }
    if (!validateSchema.validate(current[0].parameters, args)) {
      return { success: false, error: 'Invalid MCP arguments.', code: 'MCP_INVALID_INPUT', outcome: 'invalid_input', effectState: 'none' };
    }
    await require('../governance/context').refresh(`mcp:${spec.serverId}`);
    const client = await this.ensureClient(spec.serverId);
    if (context.signal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    if (spec.kind === 'resource') {
      const result = await client.readResource({ uri: args.uri }, { timeout: CALL_TIMEOUT_MS, signal: context.signal });
      return { serverId: spec.serverId, uri: args.uri, contents: result.contents || [] };
    }
    const result = await client.callTool({ name: spec.remoteName, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS, signal: context.signal });
    if (result.isError) {
      const message = (result.content || []).map(item => item.text || '').filter(Boolean).join('\n') || `MCP tool ${spec.remoteName} báo lỗi.`;
      return { success: false, error: message, code: 'MCP_REMOTE_ERROR', outcome: 'failed',
        effectState: 'unknown', retryable: false };
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
        constructor() { super({ name: spec.name, description: spec.description, parameters: spec.parameters, timeoutMs: CALL_TIMEOUT_MS,
          isDangerous: spec.kind !== 'resource', requiredPermissions: [`mcp:${spec.serverId}:execute`] }); }
        async run(args, context) {
          const { envelope, ...result } = await service.executeSpec(spec, args, context);
          return result;
        }
      };
      this.boundToolManager.registerTool(new DynamicMcpTool());
      this.registeredToolNames.add(spec.name);
    }
  }
}

module.exports = new McpService();
