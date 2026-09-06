/**
 * Model Context Protocol (MCP) Server & Data Source Manager
 * Connects Stdio/SSE MCP Servers (Postgres, SQL Server, Filesystem, Custom Tools)
 * Persistent storage enabled via StorageHelper to ./data/mcp_servers.json
 */

const StorageHelper = require('../utils/storage_helper');

class McpService {
  constructor() {
    this.mcpServers = StorageHelper.loadJson('mcp_servers.json', []);
  }

  persist() {
    StorageHelper.saveJson('mcp_servers.json', this.mcpServers);
  }

  getServers() {
    return this.mcpServers;
  }

  addServer(data) {
    const newServer = {
      id: `mcp-${Date.now()}`,
      name: data.name || "Custom MCP Server",
      protocol: data.protocol || "sse",
      endpoint: data.endpoint || "",
      toolsCount: Number.isFinite(Number(data.toolsCount)) ? Number(data.toolsCount) : 0,
      resourcesCount: Number.isFinite(Number(data.resourcesCount)) ? Number(data.resourcesCount) : 0,
      status: "configured",
      scope: data.scope || "General Tools & Resources"
    };

    this.mcpServers.unshift(newServer);
    this.persist();
    return newServer;
  }

  deleteServer(id) {
    this.mcpServers = this.mcpServers.filter(s => s.id !== id);
    this.persist();
    return true;
  }
}

module.exports = new McpService();
