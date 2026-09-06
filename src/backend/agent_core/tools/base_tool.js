/**
 * BaseTool — Foundation class cho toàn bộ tools trong agent_core
 * Contract chuẩn theo Mục 2.3 trong Kế hoạch V2:
 * Return shape từ execute():
 * {
 *   success: true | false,
 *   tool: "tool_name",
 *   result: object | null,
 *   error: string | null,
 *   durationMs: number
 * }
 */

class BaseTool {
  /**
   * @param {object} options
   * @param {string} options.name - Tên định danh của tool (VD: 'execute_sql_query')
   * @param {string} options.description - Mô tả chức năng để LLM hiểu khi nào nên gọi
   * @param {object} options.parameters - JSON Schema định nghĩa tham số đầu vào
   * @param {Array<string>} [options.requiredPermissions] - Quyền hạn cần thiết (VD: ['sql:read', 'export:file'])
   * @param {number} [options.timeoutMs] - Timeout tối đa cho 1 lần chạy tool (default: 30000ms)
   * @param {boolean} [options.isDangerous] - Đánh dấu tool có tác động lớn cần giám sát chặt
   */
  constructor({
    name,
    description,
    parameters = { type: 'object', properties: {}, required: [] },
    requiredPermissions = [],
    timeoutMs = 30000,
    isDangerous = false
  }) {
    if (!name) throw new Error('Tool name is required');
    if (!description) throw new Error(`Description for tool "${name}" is required`);

    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.requiredPermissions = requiredPermissions;
    this.timeoutMs = timeoutMs;
    this.isDangerous = isDangerous;
  }

  /**
   * Chuyển đổi tool sang định dạng chuẩn của OpenAI / Gemini Function Calling
   */
  toDefinition() {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters
      },
      // Giữ cả top-level properties để tương thích mọi adapter
      name: this.name,
      description: this.description,
      parameters: this.parameters
    };
  }

  /**
   * Validate tham số trước khi chạy
   * @param {object} args 
   * @returns {{ valid: boolean, errors?: Array<string> }}
   */
  validateArgs(args) {
    if (!args || typeof args !== 'object') {
      if (this.parameters?.required && this.parameters.required.length > 0) {
        return { valid: false, errors: ['Tham số đầu vào phải là một đối tượng JSON hợp lệ.'] };
      }
      return { valid: true };
    }

    if (this.parameters?.required && Array.isArray(this.parameters.required)) {
      const missing = this.parameters.required.filter(key => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) {
        return {
          valid: false,
          errors: [`Thiếu tham số bắt buộc: ${missing.join(', ')}`]
        };
      }
    }

    // Kiểm tra kiểu dữ liệu cơ bản nếu có khai báo properties
    if (this.parameters?.properties) {
      for (const [propName, propDef] of Object.entries(this.parameters.properties)) {
        const val = args[propName];
        if (val !== undefined && val !== null) {
          if (propDef.type === 'array' && !Array.isArray(val)) {
            return { valid: false, errors: [`Trường "${propName}" phải là một mảng (Array).`] };
          }
          if (propDef.type === 'number' && (typeof val !== 'number' || isNaN(val))) {
            return { valid: false, errors: [`Trường "${propName}" phải là một số (Number).`] };
          }
          if (propDef.type === 'string' && typeof val !== 'string') {
            return { valid: false, errors: [`Trường "${propName}" phải là chuỗi (String).`] };
          }
          if (propDef.enum && Array.isArray(propDef.enum) && !propDef.enum.includes(val)) {
            return { valid: false, errors: [`Trường "${propName}" nhận giá trị không hợp lệ: "${val}". Cho phép: ${propDef.enum.join(', ')}.`] };
          }
        }
      }
    }

    return { valid: true };
  }

  /**
   * Thực thi tool kèm bọc bảo vệ theo đúng Contract Mục 2.3
   * @param {object} args - Tham số do LLM truyền vào
   * @param {object} context - Ngữ cảnh phiên làm việc (user info, permissions, session id)
   */
  async execute(args, context = {}) {
    const startTime = Date.now();

    // 1. Kiểm tra quyền thực thi (Security check)
    if (this.requiredPermissions.length > 0) {
      const perms = context.permissions || [];
      const hasPermission = this.requiredPermissions.every(perm => 
        perms.includes(perm) || perms.includes('*') || perms.includes('admin')
      );
      if (!hasPermission) {
        return {
          success: false,
          tool: this.name,
          result: null,
          error: `Quyền truy cập bị từ chối: Cần quyền [${this.requiredPermissions.join(', ')}] để sử dụng tool này.`,
          durationMs: Date.now() - startTime
        };
      }
    }

    // 2. Validate tham số đầu vào
    const validation = this.validateArgs(args);
    if (!validation.valid) {
      return {
        success: false,
        tool: this.name,
        result: null,
        error: `Tham số không hợp lệ: ${validation.errors.join('; ')}`,
        durationMs: Date.now() - startTime
      };
    }

    // 3. Thực thi kèm Timeout Guard
    let timeoutHandle;
    try {
      const resultPromise = this.run(args, context);
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Tool "${this.name}" timeout sau ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      });

      const rawResult = await Promise.race([resultPromise, timeoutPromise]);
      clearTimeout(timeoutHandle);

      // Xử lý trường hợp tool cũ hoặc custom run trả về dạng { success: false, error: ... }
      if (rawResult && typeof rawResult === 'object' && rawResult.success === false) {
        return {
          success: false,
          tool: this.name,
          result: null,
          error: rawResult.error || 'Lỗi nghiệp vụ khi thực thi tool',
          details: rawResult,
          durationMs: Date.now() - startTime
        };
      }

      // Trả kết quả chuẩn (unwrapped result nếu run trả về { success: true, result: ... })
      const actualResult = (rawResult && typeof rawResult === 'object' && rawResult.success === true && rawResult.result !== undefined)
        ? rawResult.result
        : rawResult;

      return {
        success: true,
        tool: this.name,
        result: actualResult,
        error: null,
        durationMs: Date.now() - startTime
      };
    } catch (error) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      return {
        success: false,
        tool: this.name,
        result: null,
        error: error.message || 'Lỗi không xác định khi thực thi tool',
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        durationMs: Date.now() - startTime
      };
    }
  }

  /**
   * Method nghiệp vụ cụ thể — Các lớp con bắt buộc override
   * @param {object} args
   * @param {object} context
   */
  async run(args, context) {
    throw new Error(`Method run() chưa được implement trong tool "${this.name}"`);
  }
}

module.exports = BaseTool;
