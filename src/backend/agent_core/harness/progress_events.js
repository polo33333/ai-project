'use strict';

const ALLOWED_STATUSES = new Set(['running', 'done', 'error', 'warning']);

function sanitizeProgressEvent(event = {}) {
  const clean = {
    type: String(event.type || 'progress').slice(0, 64),
    label: String(event.label || '').slice(0, 240),
    status: ALLOWED_STATUSES.has(event.status) ? event.status : 'running',
    icon: String(event.icon || 'circle-notch').replace(/[^a-z0-9-]/gi, '').slice(0, 40),
    timestamp: event.timestamp || new Date().toISOString()
  };
  if (event.iteration != null) clean.iteration = Number(event.iteration) || 0;
  if (event.toolName) clean.toolName = String(event.toolName).slice(0, 80);
  if (event.rowCount != null) clean.rowCount = Math.max(0, Number(event.rowCount) || 0);
  if (event.durationMs != null) clean.durationMs = Math.max(0, Number(event.durationMs) || 0);
  if (event.providerName) clean.providerName = String(event.providerName).slice(0, 100);
  return clean;
}

function emitProgress(callback, event) {
  if (typeof callback !== 'function') return;
  try { callback(sanitizeProgressEvent(event)); } catch (_) {}
}

function toolLabel(toolName, phase = 'running', rowCount = null) {
  const labels = {
    execute_sql_query: ['Đang truy vấn dữ liệu', 'Truy vấn dữ liệu hoàn tất'],
    render_chart: ['Đang tạo biểu đồ', 'Đã tạo biểu đồ'],
    search_schema: ['Đang tìm bảng và cột phù hợp', 'Đã tìm schema phù hợp'],
    search_knowledge_base: ['Đang tìm trong kho tri thức', 'Đã tìm kiếm kho tri thức'],
    get_current_datetime: ['Đang kiểm tra thời gian hệ thống', 'Đã lấy thời gian hệ thống'],
    calculate_expression: ['Đang thực hiện phép tính', 'Đã tính toán xong'],
    calculate_stats: ['Đang tính toán thống kê', 'Đã tính toán thống kê'],
    export_data: ['Đang xuất dữ liệu', 'Đã xuất dữ liệu']
  };
  const pair = labels[toolName] || [`Đang chạy ${toolName}`, `Đã chạy ${toolName}`];
  const suffix = rowCount != null ? ` · ${rowCount} dòng` : '';
  return `${phase === 'done' ? pair[1] : pair[0]}${suffix}`;
}

module.exports = { sanitizeProgressEvent, emitProgress, toolLabel };
