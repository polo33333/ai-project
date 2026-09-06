/**
 * Security Guardrails — Lớp Bảo mật & Phòng thủ cho AI Agent
 * Chống Prompt Injection, SQL Injection, RCE & Rò rỉ Dữ liệu Nhạy cảm.
 */

class SecurityGuard {
  constructor() {
    // Các mẫu Prompt Injection / Jailbreak phổ biến
    this.jailbreakPatterns = [
      /ignore\s+(all\s+)?(previous\s+)?instructions/i,
      /disregard\s+(all\s+)?prior\s+prompts/i,
      /bypass\s+security/i,
      /forget\s+all\s+(rules|constraints)/i,
      /act\s+as\s+(admin|root|system|developer|god\s+mode)/i,
      /you\s+are\s+now\s+unrestricted/i,
      /show\s+me\s+(the\s+)?(api\s+key|connection\s+string|env\s+variable|password)/i,
      /print\s+process\.env/i
    ];

    // Các từ khóa SQL nguy hiểm bị cấm tuyệt đối (T-SQL)
    this.sqlBlacklist = [
      'INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE',
      'CREATE', 'GRANT', 'REVOKE', 'DENY', 'EXEC', 'EXECUTE',
      'XP_CMDSHELL', 'XP_', 'SP_', 'SYS.SQL_LOGINS', 'SYS.SYSLOGINS',
      'SYS.DATABASE_PRINCIPALS', 'SYS.SERVER_PRINCIPALS', 'SYSUSERS',
      'SHUTDOWN', 'BULK', 'OPENROWSET', 'OPENDATASOURCE'
    ];
  }

  /**
   * Lớp 1: Kiểm tra & vô hiệu hóa Prompt Injection trong câu hỏi đầu vào
   * @param {string} userMessage 
   * @returns {{ safe: boolean, reason?: string }}
   */
  validateInput(userMessage) {
    if (!userMessage || typeof userMessage !== 'string') {
      return { safe: false, reason: 'Câu hỏi không hợp lệ.' };
    }

    for (const pattern of this.jailbreakPatterns) {
      if (pattern.test(userMessage)) {
        return {
          safe: false,
          reason: 'Cảnh báo An toàn: Phát hiện ý định can thiệp hoặc vô hiệu hóa quy tắc bảo mật của AI (Prompt Injection Detected).'
        };
      }
    }

    return { safe: true };
  }

  /**
   * Giới hạn trợ lý trong phạm vi dữ liệu, SQL, báo cáo và tri thức doanh nghiệp.
   * @param {string} message
   * @returns {{ allowed: boolean, reply?: string }}
   */
  checkScope(message) {
    const text = String(message || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    const asksForImplementation = /\b(viet|code|lap trinh|tao|xay dung|implement|scaffold|sua code)\b/.test(text);
    const applicationTopic = /\b(login|dang nhap|dang ky|authentication|authorization|jwt|oauth|password|frontend|backend|api route|website|mobile app|react|vue|angular|nodejs|express)\b/.test(text);
    const dataScope = /\b(sql|database|db|du lieu|bang|cot|schema|truy van|bao cao|thong ke|bieu do|excel|csv|pdf|glossary)\b/.test(text);

    if (asksForImplementation && applicationTopic && !dataScope) {
      return {
        allowed: false,
        reply: 'Tôi chỉ hỗ trợ dữ liệu, SQL, báo cáo, biểu đồ, schema và tri thức doanh nghiệp; không hỗ trợ viết code chức năng đăng nhập hoặc ứng dụng.'
      };
    }

    return { allowed: true };
  }

  /**
   * Lớp 2: Kiểm tra nghiêm ngặt câu lệnh SQL trước khi thực thi
   * @param {string} sql 
   * @returns {{ safe: boolean, cleanedSql?: string, error?: string }}
   */
  validateSqlQuery(sql) {
    if (!sql || typeof sql !== 'string') {
      return { safe: false, error: 'Câu lệnh SQL rỗng.' };
    }

    let cleaned = sql.trim();
    const upper = cleaned.toUpperCase();

    // Chỉ cho phép SELECT hoặc WITH (CTE)
    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
      return { safe: false, error: 'Bảo mật: Hệ thống chỉ cho phép thực thi câu lệnh truy vấn Read-Only (SELECT/WITH).' };
    }

    // Chặn dấu chấm phẩy nhiều câu lệnh (Multi-statement SQL Injection: SELECT...; DROP TABLE...)
    if (cleaned.includes(';') && cleaned.split(';').filter(s => s.trim().length > 0).length > 1) {
      return { safe: false, error: 'Bảo mật: Không cho phép thực thi nhiều câu lệnh SQL cùng lúc (Multi-statement Blocked).' };
    }

    // Kiểm tra danh sách đen từ khóa nguy hại
    for (const word of this.sqlBlacklist) {
      const regex = new RegExp(`\\b${word}\\b`, 'i');
      if (regex.test(cleaned)) {
        return { safe: false, error: `Cảnh báo An toàn: Câu lệnh chứa từ khóa/thủ tục bị cấm do nguy cơ bảo mật: "${word}".` };
      }
    }

    // Tự động giới hạn TOP 100 nếu chưa có TOP để bảo vệ tài nguyên Server
    if (upper.startsWith('SELECT') && !upper.includes('SELECT TOP')) {
      cleaned = cleaned.replace(/^SELECT\s+/i, 'SELECT TOP 100 ');
    }

    return { safe: true, cleanedSql: cleaned };
  }

  /**
   * Lớp 3: Kiểm tra an toàn cho biểu thức toán học (Chống RCE / Code Injection)
   * @param {string} expression 
   * @returns {{ safe: boolean, error?: string }}
   */
  validateExpression(expression) {
    if (!expression || typeof expression !== 'string') {
      return { safe: false, error: 'Biểu thức rỗng.' };
    }

    // Chặn các từ khóa lập trình nguy hiểm
    const dangerousJs = ['process', 'global', 'require', 'import', 'window', 'document', 'fetch', 'eval', 'Function', 'constructor', '__proto__'];
    for (const kw of dangerousJs) {
      if (new RegExp(`\\b${kw}\\b`, 'i').test(expression)) {
        return { safe: false, error: `Bảo mật: Biểu thức chứa từ khóa bị cấm: "${kw}".` };
      }
    }

    // Chỉ cho phép chữ số, toán tử, khoảng trắng và hàm Math chuẩn
    const allowedPattern = /^[\d\s\+\-\*\/\%\(\)\.\,]|Math\.(sqrt|abs|round|floor|ceil|pow|min|max|PI|E)+$/;
    const cleanExpr = expression.replace(/Math\.(sqrt|abs|round|floor|ceil|pow|min|max|PI|E)/g, '');
    if (/[a-zA-Z_$]/.test(cleanExpr)) {
      return { safe: false, error: 'Biểu thức chứa ký tự/hàm không hợp lệ.' };
    }

    return { safe: true };
  }

  /**
   * Lớp 4: Che mờ (Masking) thông tin nhạy cảm trước khi trả kết quả về Client
   * @param {string} text 
   * @returns {string}
   */
  maskSensitiveData(text) {
    if (!text || typeof text !== 'string') return text;

    let masked = text;

    // Che bớt API Keys (sk-..., AQ....)
    masked = masked.replace(/(sk-[a-zA-Z0-9]{20,})/g, 'sk-••••••••••••••••');
    masked = masked.replace(/(AQ\.[a-zA-Z0-9_-]{20,})/g, 'AQ.••••••••••••••••');

    // Che bớt mật khẩu trong chuỗi Connection String nếu có
    masked = masked.replace(/(Password|Pwd|secret)=([^;]+)/gi, '$1=******');

    return masked;
  }
}

module.exports = new SecurityGuard();
