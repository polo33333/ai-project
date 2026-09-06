'use strict';

window.trainingReportData = null;

function escapeTrainingHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function trainingFailureLabel(code) {
  const labels = { MISSING_SQL: 'Thiếu SQL', MISSING_CHART: 'Thiếu biểu đồ', MISSING_EXPORT: 'Thiếu file', SQL_ONLY_ANSWER: 'Chỉ trả SQL', SCHEMA_ONLY_ANSWER: 'Chỉ mô tả schema', HISTORY_CONTAMINATION: 'Nhiễm lịch sử', MEMORY_USED_FOR_INDEPENDENT_REQUEST: 'Dùng memory cho câu độc lập', TOPIC_CHANGE_NOT_DETECTED: 'Không nhận diện đổi chủ đề', INVALID_RESPONSE_PERSISTED: 'Đã lưu response lỗi', MISSING_REFERENCE: 'Thiếu reference', STALE_REFERENCE_USED: 'Dùng reference cũ', REVIEW_REQUESTED: 'Cần kiểm tra thủ công' };
  return labels[code] || code;
}

window.fetchTrainingReport = async function fetchTrainingReport() {
  const root = document.getElementById('training-cases');
  if (root) root.innerHTML = '<div class="training-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang phân tích lịch sử và feedback...</div>';
  try {
    const response = await fetch('/api/training-report', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    window.trainingReportData = await response.json();
    renderTrainingReport();
  } catch (error) {
    if (root) root.innerHTML = `<div class="training-empty"><i class="fa-solid fa-triangle-exclamation"></i> Không tải được báo cáo: ${escapeTrainingHtml(error.message)}</div>`;
  }
};

window.renderTrainingReport = function renderTrainingReport() {
  const report = window.trainingReportData;
  if (!report) return;
  const summary = report.summary || {};
  const passRate = summary.total ? Math.round(summary.passed / summary.total * 100) : 0;
  document.getElementById('training-summary').innerHTML = [
    ['fa-comments', summary.total || 0, 'Case cần xem lại', 'indigo'],
    ['fa-circle-check', summary.passed || 0, 'Không phát hiện lỗi', 'green'],
    ['fa-triangle-exclamation', summary.failed || 0, 'Cần cải tiến', 'amber'],
    ['fa-thumbs-down', summary.disliked || 0, 'Dislike', 'red'],
    ['fa-gauge-high', `${passRate}%`, 'Tỷ lệ đạt rule', 'blue']
  ].map(([icon, value, label, tone]) => `<article class="training-stat ${tone}"><i class="fa-solid ${icon}"></i><div><strong>${value}</strong><span>${label}</span></div></article>`).join('');

  const counts = Object.entries(report.failureCounts || {}).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...counts.map(([, count]) => count));
  document.getElementById('training-failure-counts').innerHTML = counts.map(([failure, count]) => `<button type="button" class="training-issue-row" onclick="filterTrainingFailure('${escapeTrainingHtml(failure)}')"><span><b>${escapeTrainingHtml(trainingFailureLabel(failure))}</b><em>${count}</em></span><i style="width:${Math.max(5, count / max * 100)}%"></i></button>`).join('') || '<div class="training-empty">Chưa có lỗi.</div>';
  const select = document.getElementById('training-failure-filter');
  const current = select.value;
  select.innerHTML = '<option value="">Tất cả lỗi</option>' + counts.map(([failure]) => `<option value="${escapeTrainingHtml(failure)}">${escapeTrainingHtml(trainingFailureLabel(failure))}</option>`).join('');
  select.value = current;
  renderTrainingCases();
};

window.filterTrainingFailure = function filterTrainingFailure(failure) {
  document.getElementById('training-failure-filter').value = failure;
  renderTrainingCases();
};

window.renderTrainingCases = function renderTrainingCases() {
  const report = window.trainingReportData;
  if (!report) return;
  const query = (document.getElementById('training-search')?.value || '').toLowerCase();
  const failure = document.getElementById('training-failure-filter')?.value || '';
  const rating = document.getElementById('training-rating-filter')?.value || '';
  const cases = (report.cases || []).filter(item => {
    if (!item.failures?.length) return false;
    if (failure && !item.failures.includes(failure)) return false;
    if (rating === 'none' && item.rating) return false;
    if (rating && rating !== 'none' && item.rating !== rating) return false;
    return !query || `${item.id} ${item.question} ${item.reply}`.toLowerCase().includes(query);
  });
  document.getElementById('training-case-count').textContent = `${cases.length} case`;
  document.getElementById('training-cases').innerHTML = cases.slice(0, 100).map(item => `
    <details class="training-case">
      <summary><div class="training-case-main"><span class="training-case-id">${escapeTrainingHtml(item.id)}</span><strong>${escapeTrainingHtml(item.question)}</strong><div>${item.failures.map(code => `<span class="training-failure-chip">${escapeTrainingHtml(trainingFailureLabel(code))}</span>`).join('')}</div></div><div class="training-case-meta"><span class="training-status ${String(item.rating || 'none')}">${escapeTrainingHtml(item.rating || 'chưa đánh giá')}</span><i class="fa-solid fa-chevron-down"></i></div></summary>
      <div class="training-case-body">
        <section><h4>Câu trả lời hiện tại</h4><pre>${escapeTrainingHtml(item.reply || '—')}</pre></section>
        <section><h4>SQL</h4><pre>${escapeTrainingHtml(item.sql || 'Chưa có SQL')}</pre></section>
        <section><h4>Memory decision</h4><pre>${escapeTrainingHtml(item.memoryDecision ? JSON.stringify(item.memoryDecision, null, 2) : 'Không có trace memory')}</pre></section>
        <section class="training-suggestions"><h4>Đề xuất cải tiến</h4>${(item.suggestions || []).map(suggestion => `<article><span class="training-target">${escapeTrainingHtml(suggestion.target)}</span><div><strong>${escapeTrainingHtml(suggestion.title)}</strong><p>${escapeTrainingHtml(suggestion.message)}</p><code>${escapeTrainingHtml(suggestion.action)}</code></div></article>`).join('')}</section>
      </div>
    </details>`).join('') || '<div class="training-empty"><i class="fa-solid fa-circle-check"></i> Không có case phù hợp bộ lọc.</div>';
};
