/**
 * BaseTool — Foundation class cho toàn bộ tools trong agent
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

const Ajv = require('ajv');
const schemaValidator = new Ajv({ allErrors: true, strict: false, validateFormats: false });

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
    isDangerous = false,
    outputSchema = null,
    maxOutputBytes = 2 * 1024 * 1024
  }) {
    if (!name) throw new Error('Tool name is required');
    if (!description) throw new Error(`Description for tool "${name}" is required`);

    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.requiredPermissions = requiredPermissions;
    this.timeoutMs = timeoutMs;
    this.isDangerous = isDangerous;
    this.outputSchema = outputSchema;
    this.maxOutputBytes = maxOutputBytes;
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
    this._validate ||= schemaValidator.compile(this.parameters);
    const valid = this._validate(args === undefined ? {} : args);
    return valid ? { valid: true } : {
      valid: false,
      errors: this._validate.errors.map(item => (item.instancePath || '/') + ' ' + item.message)
    };
  }

  /**
   * Thực thi tool kèm bọc bảo vệ theo đúng Contract Mục 2.3
   * @param {object} args - Tham số do LLM truyền vào
   * @param {object} context - Ngữ cảnh phiên làm việc (user info, permissions, session id)
   */
  async execute(args, context = {}) {
    const startTime = Date.now();
    if (context.executionBudget?.remainingMs() <= 0) {
      return { success: false, tool: this.name, result: null, error: 'Request deadline exceeded.',
        code: 'REQUEST_DEADLINE_EXCEEDED', outcome: 'timeout', retryable: false, effectState: 'none', durationMs: 0 };
    }

    // 1. Kiểm tra quyền thực thi (Security check)
    if (this.requiredPermissions.length > 0) {
      const perms = Array.isArray(context.permissions) ? context.permissions : [];
      const hasPermission = this.requiredPermissions.every(perm => 
        perms.includes(perm) || perms.includes('*') || perms.includes('admin')
      );
      if (!hasPermission) {
        return {
          success: false,
          tool: this.name,
          result: null,
          outcome: 'denied', retryable: false, effectState: 'none',
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
        outcome: 'invalid_input', retryable: false, effectState: 'none',
        durationMs: Date.now() - startTime
      };
    }

    // 3. Thực thi kèm Timeout Guard
    let timeoutHandle;
    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason);
    if (context.signal?.aborted) abort();
    else context.signal?.addEventListener('abort', abort, { once: true });
    let stop;
    const cancelled = new Promise((_, reject) => {
      stop = () => reject(controller.signal.reason || Object.assign(new Error('Request aborted'), { name: 'AbortError' }));
      if (controller.signal.aborted) stop();
      else controller.signal.addEventListener('abort', stop, { once: true });
    });
    try {
      const resultPromise = controller.signal.aborted ? cancelled : Promise.resolve().then(() => {
        if (controller.signal.aborted) return cancelled;
        // Legacy planning tools publish request state back into context. Preserve
        // that contract while exposing a per-call signal without mutating it.
        const executionContext = new Proxy(context, {
          get(target, key, receiver) { return key === 'signal' ? controller.signal : Reflect.get(target, key, receiver); }
        });
        return this.run(args, executionContext);
      });
      const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
          const error = Object.assign(new Error(`Tool "${this.name}" timeout sau ${this.timeoutMs}ms`), { code: "TOOL_TIMEOUT" });
          controller.abort(error);
          reject(error);
        }, Math.max(1, Math.min(this.timeoutMs, context.executionBudget?.remainingMs() ?? this.timeoutMs)));
      });

      const rawResult = await Promise.race([resultPromise, timeoutPromise, cancelled]);
      clearTimeout(timeoutHandle);

      // Xử lý trường hợp tool cũ hoặc custom run trả về dạng { success: false, error: ... }
      if (rawResult && typeof rawResult === 'object' && rawResult.success === false) {
        return {
          success: false,
          tool: this.name,
          result: null,
          error: rawResult.error || 'Lỗi nghiệp vụ khi thực thi tool',
          outcome: rawResult.outcome || 'failed', retryable: rawResult.retryable === true,
          effectState: rawResult.effectState || (this.isDangerous ? 'unknown' : 'none'),
          code: rawResult.code || null,
          details: rawResult,
          durationMs: Date.now() - startTime
        };
      }

      // Trả kết quả chuẩn (unwrapped result nếu run trả về { success: true, result: ... })
      const actualResult = (rawResult && typeof rawResult === 'object' && rawResult.success === true && rawResult.result !== undefined)
        ? rawResult.result
        : rawResult;
      if (Buffer.byteLength(JSON.stringify(actualResult) || '') > this.maxOutputBytes) throw Object.assign(new Error('Tool output exceeds the permitted size.'), { code: 'TOOL_OUTPUT_TOO_LARGE' });
      if (this.outputSchema) {
        this._validateOutput ||= schemaValidator.compile(this.outputSchema);
        if (!this._validateOutput(actualResult)) throw Object.assign(new Error('Tool output does not match its contract.'), { code: 'TOOL_OUTPUT_INVALID' });
      }
      if (this.name === 'export_data') require('../../governance/artifacts').register(actualResult);

      return {
        success: true,
        tool: this.name,
        result: actualResult,
        outcome: Array.isArray(actualResult?.rows) && !actualResult.rows.length ? 'empty' : 'ok',
        retryable: false, effectState: rawResult?.effectState || (this.isDangerous ? 'unknown' : 'none'),
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
        code: error.code || (controller.signal.aborted ? 'TOOL_CANCELLED' : null),
        outcome: error.outcome || (error.code === 'TOOL_TIMEOUT' ? 'timeout' : controller.signal.aborted ? 'cancelled' : 'failed'),
        effectState: error.effectState || error.toolResult?.effectState || (this.isDangerous ? 'unknown' : 'none'),
        details: error.details || null,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined,
        durationMs: Date.now() - startTime
      };
    } finally {
      clearTimeout(timeoutHandle);
      context.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', stop);
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
