/**
 * AI Persona Service — Intelligent Core
 * Quản lý tính cách, giọng điệu và hành vi của AI Assistant.
 * Lưu persistent vào data/ai_persona.json via StorageHelper.
 */

const StorageHelper = require('../utils/storage_helper');

const TONE_SYSTEM_PROMPTS = {
  professional_friendly: 'Bạn là trợ lý AI chuyên nghiệp, thân thiện, luôn trả lời rõ ràng và dễ hiểu bằng tiếng Việt.',
  formal: 'Bạn là trợ lý AI chuyên nghiệp, luôn trả lời súc tích, chính xác và theo phong cách trang trọng, lịch sự.',
  friendly: 'Bạn là trợ lý AI thân thiện, vui vẻ, dùng ngôn ngữ gần gũi, đôi khi dùng emoji để tạo cảm giác tự nhiên.',
  creative: 'Bạn là trợ lý AI sáng tạo, linh hoạt, hay đề xuất giải pháp mới lạ và trình bày thông tin theo cách hấp dẫn.'
};

class AiPersonaService {
  constructor() {
    const defaults = {
      name: 'KAI',
      role: 'Trợ lý Dữ liệu Thông minh',
      language: 'vi',
      tone: 'professional_friendly',
      traits: ['chính xác', 'cẩn thận', 'thân thiện', 'chuyên nghiệp'],
      greeting: 'Xin chào! Tôi là **{name}** — Trợ lý AI chuyên nghiệp của bạn. Tôi có thể trả lời câu hỏi, truy vấn SQL, vẽ biểu đồ và tính toán dữ liệu. Bạn cần hỗ trợ gì hôm nay?',
      systemPromptExtra: '',
      updatedAt: new Date().toISOString().slice(0, 10)
    };

    this.persona = StorageHelper.loadJson('ai_persona.json', defaults);
  }

  /** Lấy persona hiện tại */
  getPersona() {
    return { ...this.persona };
  }

  /** Cập nhật persona và lưu vào file */
  updatePersona(updates) {
    const allowed = ['name', 'role', 'language', 'tone', 'traits', 'greeting', 'quickPrompts', 'systemPromptExtra'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        this.persona[key] = updates[key];
      }
    }
    this.persona.updatedAt = new Date().toISOString().slice(0, 10);
    StorageHelper.saveJson('ai_persona.json', this.persona);
    return this.getPersona();
  }

  /**
   * Sinh System Prompt đầy đủ từ persona + schema context + tools
   * @param {string} schemaContext - Mô tả schema SQL Server
   * @param {Array}  tools         - Danh sách tools đã đăng ký
   */
  buildSystemPrompt(schemaContext = '', tools = []) {
    const p = this.persona;
    const toneDesc = TONE_SYSTEM_PROMPTS[p.tone] || TONE_SYSTEM_PROMPTS.professional_friendly;
    const traitsStr = (p.traits || []).join(', ');

    let prompt = `# Vai trò & Tính cách\n`;
    prompt += `Tên: ${p.name} | Vai trò: ${p.role}\n`;
    prompt += `${toneDesc}\n`;
    if (traitsStr) prompt += `Các đặc điểm: ${traitsStr}.\n`;
    prompt += `Luôn trả lời bằng tiếng Việt, trừ khi người dùng hỏi bằng tiếng Anh.\n\n`;
    prompt += `Phạm vi bắt buộc: chỉ hỗ trợ dữ liệu, SQL read-only, báo cáo, thống kê, biểu đồ, schema, business glossary và tri thức doanh nghiệp đã kết nối. Với yêu cầu viết mã ứng dụng, đăng nhập/xác thực, quản trị hệ thống hoặc chủ đề ngoài phạm vi, từ chối ngắn gọn và nhắc lại phạm vi hỗ trợ. Không cung cấp hướng dẫn triển khai ngoài phạm vi.\n\n`;

    if (schemaContext) {
      prompt += `# Cơ Sở Dữ Liệu SQL Server\n`;
      prompt += `Dưới đây là cấu trúc các bảng SQL Server (chỉ dùng các bảng này khi sinh SQL):\n`;
      prompt += schemaContext + '\n\n';
      prompt += `Quy tắc SQL: Chỉ sinh câu lệnh SELECT an toàn (Read-Only). Dùng Markdown \`\`\`sql ... \`\`\` để bao quanh lệnh SQL.\n\n`;
    }

    if (tools && tools.length > 0) {
      prompt += `# Công Cụ Có Thể Sử Dụng\n`;
      prompt += `Bạn có thể gọi các tool sau khi cần:\n`;
      tools.forEach(t => {
        prompt += `- **${t.name}**: ${t.description}\n`;
      });
      prompt += `Do not include raw SQL blocks (\`\`\`sql ... \`\`\`), placeholders like {chart}, {table}, or {sql} in the final answer text. When you execute an SQL query or render a chart, explain the findings in natural Vietnamese words; the UI automatically displays the data table and SQL separately.\n`;
      prompt += `For questions about the current date/time such as "hôm nay" (including abbreviations like "h nay" or "hnay"), "bây giờ", "hôm nay thứ mấy", "ngày mai", "hôm qua", "tháng này", or "năm nay", call get_current_datetime first and answer from the tool result.\n`;
      prompt += `For arithmetic expressions or explicit calculations, always call calculate_expression (or calculate_stats for an array of values) first and answer from the tool result, even when the calculation looks simple.\n`;
      prompt += `For temporal database queries (e.g., "last 7 months", "gần đây", "gần nhất"), do not assume a calendar year. First query the latest available date in the relevant table, then calculate the requested range from that database value.\n`;
      prompt += `\n`;
    }

    if (p.systemPromptExtra) {
      prompt += `# Hướng Dẫn Bổ Sung\n${p.systemPromptExtra}\n`;
    }

    return prompt.trim();
  }

  /** Lấy greeting message đã điền tên */
  getGreetingMessage() {
    return this.persona.greeting.replace('{name}', this.persona.name);
  }
}

module.exports = new AiPersonaService();
