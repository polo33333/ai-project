/**
 * ToolManager — Quản lý đăng ký, phân quyền và dispatching cho Tools trong agent_core
 */

const BaseTool = require('./base_tool');
const { createToolResult } = require('./tool_result');

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
      if (!require('../../services/tool_settings_service').isEnabled(name)) continue;
      if (tool.available && !tool.available(context)) continue;
      // 1. Lọc theo whitelist tên tool nếu có yêu cầu
      if (context.allowedToolNames && !context.allowedToolNames.includes(name)) {
        continue;
      }

      // 2. Lọc theo quyền nếu tool có yêu cầu
      if (tool.requiredPermissions.length > 0) {
        if (!Array.isArray(context.permissions)) continue;
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
    if (context.signal?.aborted) throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    const wrap = (execution, tool = {}) => ({ ...execution, envelope: createToolResult(execution, context, { name: toolName, ...tool }) });
    if (!require('../../services/tool_settings_service').isEnabled(toolName)) return wrap({ success: false, tool: toolName,
      outcome: 'denied', effectState: 'none', code: 'TOOL_DISABLED', error: 'Công cụ này đã bị quản trị viên tắt.', durationMs: 0 });
    if (Array.isArray(context.allowedToolNames) && !context.allowedToolNames.includes(toolName)) {
      return wrap({ success: false, tool: toolName, outcome: 'denied', effectState: 'none', code: 'TOOL_NOT_ENABLED', error: `Tool "${toolName}" is not enabled for this request.`, durationMs: 0 });
    }
    const tool = this.getTool(toolName);
    if (!tool) {
      return wrap({
        success: false,
        tool: toolName,
        outcome: 'failed', effectState: 'none', code: 'TOOL_NOT_FOUND',
        error: `Tool "${toolName}" không tồn tại trong hệ thống.`,
        durationMs: 0
      });
    }
    if (tool.available && !tool.available(context)) return wrap({ success: false, tool: toolName,
      outcome: 'denied', effectState: 'none', code: 'TOOL_UNAVAILABLE', error: 'Tool is unavailable for this request.', durationMs: 0 });
    const execution = await tool.execute(args, context);
    return wrap(execution, { isDangerous: tool.isDangerous });
  }
}

module.exports = ToolManager;
