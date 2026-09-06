const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const help = require('./settings_help');

function parse(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return values;
}
const defaults = parse(fs.readFileSync(path.join(root, '.env.example'), 'utf8'));
Object.assign(defaults, { AI_MAX_TOOL_ITERATIONS: '10', LOCAL_AI_MODEL: 'qwen3.5:9b' });
const choices = {
  EMBEDDING_PROVIDER: ['ollama', 'openai'],
  EMBEDDING_FALLBACK_MODE: ['error', 'deterministic']
};
const descriptions = {
  PORT: 'Cổng HTTP của ứng dụng (1–65535).',
  QDRANT_EXE: 'Đường dẫn chương trình trên máy chủ; chỉ đọc trong UI.',
  QDRANT_URL: 'Địa chỉ dịch vụ Qdrant.',
  EMBEDDING_BASE_URL: 'Địa chỉ máy chủ embedding.',
  KNOWLEDGE_REINDEX_ON_START: 'Lập chỉ mục lại khi khởi động; tắt sau khi hoàn tất.',
  QDRANT_VECTOR_SIZE: 'Phải khớp số chiều embedding của collection schema.',
  QDRANT_DOCUMENT_VECTOR_SIZE: 'Phải khớp số chiều model embedding tài liệu.',
  EMBEDDING_FALLBACK_MODE: 'error: dừng khi embedding lỗi; deterministic: vector dự phòng, không đảm bảo chất lượng tìm kiếm.',
};
const schema = Object.entries(defaults).map(([key, value]) => ({
  key, defaultValue: value, label: help[key]?.[0] || key.replace(/_/g, ' '),
  group: /^(LOCAL_MODEL|LOCAL_AI|AI_MAX_TOOL|AI_DEFAULT|AI_LOCAL)/.test(key) ? 'AI và model local'
    : /^(AI_MEMORY)/.test(key) ? 'Bộ nhớ hội thoại'
      : /^(WEB_SEARCH)/.test(key) ? 'Tìm kiếm web'
        : /^(AI_SCHEMA)/.test(key) ? 'Ngữ cảnh CSDL'
          : key === 'PORT' ? 'Máy chủ' : 'Kho tri thức và embedding',
  type: choices[key] ? 'select' : /^(true|false)$/.test(value) ? 'boolean'
    : /^\d+(\.\d+)?$/.test(value) ? 'number' : /^https?:/.test(value) ? 'url' : 'text',
  options: choices[key], readOnly: key === 'QDRANT_EXE',
  description: help[key]?.[1] || descriptions[key] || 'Áp dụng sau khi khởi động lại máy chủ.'
}));

function revision(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function fail(message, statusCode = 400) { const error = new Error(message); error.statusCode = statusCode; throw error; }
function validate(field, value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\r\n\0"']/.test(value)) fail(`Giá trị không hợp lệ: ${field.key}`);
  value = value.trim();
  if (field.type === 'boolean' && !['true', 'false'].includes(value)) fail(`Giá trị boolean không hợp lệ: ${field.key}`);
  if (field.options && !field.options.includes(value)) fail(`Lựa chọn không hợp lệ: ${field.key}`);
  if (field.type === 'number') {
    const n = Number(value);
    const fractional = ['LOCAL_MODEL_TEMPERATURE', 'AI_DOCUMENT_MIN_SCORE'].includes(field.key);
    const allowZero = fractional || field.key === 'LOCAL_MODEL_MAX_REPAIRS';
    const max = field.key === 'PORT' ? 65535 : field.key === 'AI_DOCUMENT_MIN_SCORE' ? 1 : field.key === 'LOCAL_MODEL_TEMPERATURE' ? 2 : 1000000000;
    if (!Number.isFinite(n) || n < (allowZero ? 0 : 1) || n > max || (!fractional && !Number.isInteger(n))) fail(`Số ngoài phạm vi: ${field.key}`);
  }
  if (field.type === 'url') {
    let url;
    try { url = new URL(value); } catch { fail(`URL không hợp lệ: ${field.key}`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail(`URL phải dùng HTTP(S), không chứa thông tin đăng nhập hoặc query: ${field.key}`);
  }
  return value;
}

function createSettingsService(envPath = path.join(root, '.env')) {
  const read = () => fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  return {
    get() {
      const text = read(); const values = parse(text);
      return { revision: revision(text), restartRequired: true, fields: schema.map(field => {
        const candidate = values[field.key] ?? defaults[field.key];
        // Never expose URL credentials or malformed values from a hand-edited file.
        let value = candidate;
        try { if (!field.readOnly) validate(field, candidate); } catch { value = ''; }
        return { ...field, value, source: field.key in values ? '.env' : 'Mặc định', environmentOverride: Boolean(process.env[field.key] && process.env[field.key] !== candidate) };
      }) };
    },
    save(body) {
      if (!body || !body.values || typeof body.values !== 'object' || Array.isArray(body.values)) fail('Dữ liệu cấu hình không hợp lệ.');
      const text = read();
      if (body.revision !== revision(text)) fail('Cấu hình đã thay đổi. Tải lại trước khi lưu.', 409);
      const updates = new Map();
      for (const [key, value] of Object.entries(body.values)) {
        const field = schema.find(item => item.key === key);
        if (!field || field.readOnly) fail(`Không được sửa biến: ${key}`);
        updates.set(key, validate(field, value));
      }
      if (!updates.size) return { status: 'success', changed: 0 };
      const remaining = new Map(updates);
      const newline = text.includes('\r\n') ? '\r\n' : '\n';
      const lines = text.split(/\r?\n/).map(line => {
        const key = line.trim().match(/^([A-Z][A-Z0-9_]*)\s*=/)?.[1];
        if (!updates.has(key)) return line;
        remaining.delete(key);
        return `${key}=${updates.get(key)}`;
      });
      for (const [key, value] of remaining) lines.push(`${key}=${value}`);
      const next = lines.join(newline).replace(/\s*$/, '') + newline;
      const temporary = `${envPath}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 });
        if (read() !== text) fail('Cấu hình đã thay đổi. Tải lại trước khi lưu.', 409);
        fs.renameSync(temporary, envPath);
      } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      return { status: 'success', changed: updates.size, restartRequired: true };
    }
  };
}
module.exports = { createSettingsService, validate };
