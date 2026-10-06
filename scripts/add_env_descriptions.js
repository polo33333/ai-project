'use strict';
// Add comments only. Never print or rewrite the configured assignment values.
const fs = require('node:fs');
const path = require('node:path');
const help = require('../src/backend/services/settings_help');
const extra = {
  HTTPS_CERT_FILE: ['Chứng chỉ HTTPS', 'Đường dẫn file chứng chỉ PEM; đặt cùng HTTPS_KEY_FILE để bật HTTPS. Bỏ trống/không khai báo để dùng HTTP. Đường dẫn tương đối tính từ thư mục dự án.'],
  HTTPS_KEY_FILE: ['Khóa riêng HTTPS', 'Đường dẫn private key PEM tương ứng chứng chỉ HTTPS_CERT_FILE. Không chia sẻ nội dung khóa.'],
  BOOTSTRAP_ADMIN_PASSWORD: ['Mật khẩu admin khởi tạo', 'Mật khẩu tạo tài khoản admin khi chưa có dữ liệu tài khoản. Đổi giá trị mẫu trước lần khởi động đầu tiên; không dùng để đổi mật khẩu tài khoản đã tồn tại.'],
  APP_PG_USER: ['Tài khoản PostgreSQL quản trị dữ liệu', 'Tài khoản dùng cho công cụ khởi tạo/migration. Script db:pg:init ghi thông tin riêng vào .env.postgres.'],
  APP_PG_PASSWORD: ['Mật khẩu PostgreSQL quản trị dữ liệu', 'Mật khẩu của APP_PG_USER; giữ riêng trong .env.postgres, không đưa vào mã nguồn.'],
  APP_PG_RUNTIME_USER: ['Tài khoản PostgreSQL runtime', 'Tài khoản giới hạn quyền dùng khi backend truy cập PostgreSQL trong vận hành.'],
  APP_PG_RUNTIME_PASSWORD: ['Mật khẩu PostgreSQL runtime', 'Mật khẩu của APP_PG_RUNTIME_USER; giữ riêng trong .env.postgres.'],
  APP_DATA_ENCRYPTION_KEY_FILE: ['File khóa mã hóa dữ liệu', 'Đường dẫn khóa dùng mã hóa/giải mã dữ liệu nhạy cảm lưu trong PostgreSQL. Giữ nguyên khóa để đọc được dữ liệu đã mã hóa; sao lưu khóa riêng.'],
  APP_PG_SSL_CA_FILE: ['Chứng chỉ CA PostgreSQL', 'Đường dẫn CA tin cậy để xác thực TLS khi kết nối PostgreSQL từ xa; không tắt kiểm tra chứng chỉ.'],
  WORKFLOW_API_ALLOWED_ORIGINS: ['API nguồn nội bộ được cho phép', 'Danh sách origin chính xác được workflow gọi, phân cách bằng dấu phẩy, ví dụ https://api.internal.example,http://localhost:8080. Để trống nếu không cần ngoại lệ cho API HTTP/mạng riêng.']
};
const choices = {
  CHAT_ROUTING_MODE: 'auto: TEV1 trước, chuyển model chat khi không chắc/lỗi; local_tev1: chỉ TEV1 quyết định luồng, không fallback routing; chat_model: model chat quyết định ngay. Chat thông thường vẫn cần model trả lời.',
  NODE_ENV: 'production: vận hành; development: phát triển; test: kiểm thử.',
  APP_STORAGE_BACKEND: 'postgres: PostgreSQL; json: file JSON. Đổi chế độ không tự di chuyển/đồng bộ dữ liệu; cần migration trước và restart sau.',
  EMBEDDING_PROVIDER: 'ollama: endpoint Ollama; openai: endpoint embedding tương thích OpenAI.',
  EMBEDDING_FALLBACK_MODE: 'error: báo lỗi khi embedding thất bại; deterministic: dùng vector dự phòng, chất lượng tìm kiếm không được bảo đảm.'
};
function annotate(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/).filter(line => !line.startsWith('# @env '));
  let count = 0;
  const result = lines.flatMap(line => {
    const match = line.match(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (!match) return [line];
    const [, key, value] = match;
    const entry = help[key] || extra[key];
    if (!entry) throw new Error(`Missing description: ${key}`);
    let detail = choices[key] || '';
    if (/^(true|false)$/.test(value.trim())) detail += ' Lựa chọn: true = bật; false = tắt.';
    if (/_MS$/.test(key)) detail += ' Đơn vị: mili giây (1000 ms = 1 giây).';
    if (/_CHARS(?:_PER_TOKEN)?$/.test(key)) detail += ' Đơn vị: ký tự (hoặc ký tự/token với hệ số ước lượng).';
    count++;
    return [`# @env ${key}: ${entry[0]}. ${entry[1]}${detail ? ' ' + detail.trim() : ''}`, line];
  });
  return { text: result.join(newline), count };
}
function main() {
  const root = path.resolve(__dirname, '..');
  for (const file of ['.env', '.env.example']) {
    const target = path.join(root, file);
    const original = fs.readFileSync(target, 'utf8');
    const updated = annotate(original);
    const assignments = text => text.split(/\r?\n/).filter(line => /^\s*(?:#\s*)?[A-Z][A-Z0-9_]*\s*=/.test(line));
    if (JSON.stringify(assignments(original)) !== JSON.stringify(assignments(updated.text))) throw new Error('Configuration values changed.');
    fs.writeFileSync(target, updated.text, 'utf8');
    console.log(`${file}: documented ${updated.count} options; values unchanged.`);
  }
}
if (require.main === module) main();
module.exports = { annotate };
