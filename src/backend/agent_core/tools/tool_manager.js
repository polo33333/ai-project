/**
 * ToolManager — Quản lý đăng ký, phân quyền và dispatching cho Tools trong agent_core
 */

const BaseTool = require('./base_tool');

class ToolManager {
  constructor() {
    this.tools = new Map();
  }

  /**
   * Đăng ký một tool mới
   * @param {BaseTool} toolInstance 
   */
  registerTool(toolInstance) {
    if (!(toolInstance instanceof BaseTool)) {
      throw new Error(`Tool đăng ký phải là instance kế thừa từ BaseTool. Nhận được: ${typeof toolInstance}`);
    }
    if (this.tools.has(toolInstance.name)) {
      console.warn(`[ToolManager] Cảnh báo: Ghi đè tool "${toolInstance.name}"`);
    }
    this.tools.set(toolInstance.name, toolInstance);
  }

  /**
   * Đăng ký danh sách nhiều tools
   * @param {Array<BaseTool>} toolList 
   */
  registerTools(toolList = []) {
    for (const tool of toolList) {
      this.registerTool(tool);
    }
  }

  unregisterTool(name) {
    return this.tools.delete(name);
  }

  /**
   * Lấy instance của một tool theo tên
   * @param {string} name 
   * @returns {BaseTool|null}
   */
  getTool(name) {
    return this.tools.get(name) || null;
  }

  /**
   * Lấy danh sách định nghĩa Tools cho LLM (có lọc theo permission/whitelist nếu cần)
   * @param {object} [context]
   * @param {Array<string>} [context.allowedToolNames]
   * @param {Array<string>} [context.permissions]
   */
  getToolDefinitions(context = {}) {
    const definitions = [];
    for (const [name, tool] of this.tools.entries()) {
      // 1. Lọc theo whitelist tên tool nếu có yêu cầu
      if (context.allowedToolNames && !context.allowedToolNames.includes(name)) {
        continue;
      }

      // 2. Lọc theo quyền nếu tool có yêu cầu
      if (tool.requiredPermissions.length > 0 && context.permissions) {
        const hasPermission = tool.requiredPermissions.every(perm => 
          context.permissions.includes(perm) || context.permissions.includes('*') || context.permissions.includes('admin')
        );
        if (!hasPermission) continue;
      }

      definitions.push(tool.toDefinition());
    }
    return definitions;
  }

  /**
   * Thực thi một tool theo tên
   * @param {string} toolName 
   * @param {object} args 
   * @param {object} context 
   */
  async executeTool(toolName, args, context = {}) {
    const tool = this.getTool(toolName);
    if (!tool) {
      return {
        success: false,
        tool: toolName,
        error: `Tool "${toolName}" không tồn tại trong hệ thống.`,
        durationMs: 0
      };
    }
    return await tool.execute(args, context);
  }
}

module.exports = ToolManager;
