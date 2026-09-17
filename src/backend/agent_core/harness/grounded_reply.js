'use strict';

function ensureDownloadLink(text, downloadUrl) {
  const reply = String(text || '').trim();
  const url = String(downloadUrl || '').trim();
  if (!url) return reply;
  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`\\[[^\\]]+\\]\\(\\s*${escapedUrl}\\s*\\)`, 'i').test(reply)) return reply;
  const link = `[Tải file tại đây](${url})`;
  const codeUrlPattern = new RegExp('`' + escapedUrl + '`', 'i');
  if (codeUrlPattern.test(reply)) return reply.replace(codeUrlPattern, link);
  const plainUrlPattern = new RegExp(escapedUrl, 'i');
  if (plainUrlPattern.test(reply)) return reply.replace(plainUrlPattern, link);
  return `${reply}\n\n${link}.`.trim();
}

function markdownCell(value) {
  if (value === null || value === undefined || value === '') return '—';
  const normalized = value instanceof Date ? value.toISOString() : String(value);
  return normalized.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}

function buildSqlRowsFallbackReply(sqlCall) {
  const rows = Array.isArray(sqlCall?.result?.rows) ? sqlCall.result.rows : [];
  if (!rows.length) return 'Không tìm thấy dữ liệu phù hợp.';

  const columns = Object.keys(rows[0] || {}).slice(0, 10);
  if (rows.length === 1) {
    const details = columns.map(column => `- **${markdownCell(column)}:** ${markdownCell(rows[0]?.[column])}`).join('\n');
    return `Tìm thấy **1** dòng kết quả:\n\n${details}`;
  }

  const visibleRows = rows.slice(0, 10);
  const header = `| ${columns.map(markdownCell).join(' | ')} |`;
  const separator = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = visibleRows.map(row => `| ${columns.map(column => markdownCell(row?.[column])).join(' | ')} |`).join('\n');
  const remainder = rows.length > visibleRows.length ? `\n\nHiển thị ${visibleRows.length}/${rows.length} kết quả.` : '';
  return `Tìm thấy **${rows.length}** kết quả:\n\n${header}\n${separator}\n${body}${remainder}`;
}

function isUngroundedKnowledgeAnswer(text = '') {
  const normalized = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  return /khong co thong tin(?: cu the)?|khong phai ung dung|neu co ung dung|app nao cu the|ung dung nao cu the|hay cho (?:toi|minh) biet them/.test(normalized);
}

module.exports = { ensureDownloadLink, buildSqlRowsFallbackReply, isUngroundedKnowledgeAnswer };
