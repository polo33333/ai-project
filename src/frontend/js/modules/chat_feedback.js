window.chatFeedbackData = [];

async function fetchChatFeedback() {
  try {
    const res = await fetch('/api/chat-feedback');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.chatFeedbackData = await res.json();
    renderChatFeedbackTable();
  } catch (err) {
    console.error('Lỗi nạp đánh giá AI:', err);
    if (typeof showToast === 'function') showToast(err.message, 'error', 'Không thể tải đánh giá');
  }
}

function feedbackEscape(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function feedbackTokenUsage(audit) {
  const usage = audit?.requestPayload?.tokenUsage || audit?.tokenUsage || {};
  const input = Number(usage.inputTokens ?? usage.promptTokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.completionTokens ?? 0);
  const total = Number(usage.totalTokens ?? input + output);
  return total ? `${total.toLocaleString('vi-VN')} token (${input.toLocaleString('vi-VN')} vào / ${output.toLocaleString('vi-VN')} ra)` : 'Chưa có dữ liệu token';
}

function filteredChatFeedback() {
  const keyword = String(document.getElementById('feedback-search')?.value || '').toLowerCase().trim();
  const rating = document.getElementById('feedback-rating-filter')?.value || 'all';
  const review = document.getElementById('feedback-review-filter')?.value || 'all';
  return (window.chatFeedbackData || []).filter(item => {
    const audit = item.audit || {};
    const haystack = `${audit.question || ''} ${audit.replyText || ''} ${item.model || audit.modelName || ''}`.toLowerCase();
    return (!keyword || haystack.includes(keyword)) && (rating === 'all' || item.rating === rating) && (review === 'all' || (item.reviewStatus || 'pending') === review);
  });
}

function renderFeedbackStats(items) {
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  set('feedback-stat-total', items.length);
  set('feedback-stat-like', items.filter(x => x.rating === 'like').length);
  set('feedback-stat-dislike', items.filter(x => x.rating === 'dislike').length);
  set('feedback-stat-pending', items.filter(x => !x.reviewStatus || x.reviewStatus === 'pending').length);
}

function renderChatFeedbackTable() {
  const tbody = document.getElementById('chat-feedback-tbody');
  if (!tbody) return;
  const all = window.chatFeedbackData || [];
  renderFeedbackStats(all);
  const items = filteredChatFeedback();
  const state = window.paginationState?.chat_feedback || { currentPage: 1, itemsPerPage: 10 };
  const pageItems = items.slice((state.currentPage - 1) * state.itemsPerPage, state.currentPage * state.itemsPerPage);
  tbody.innerHTML = pageItems.length ? pageItems.map(item => {
    const audit = item.audit || {};
    const review = item.reviewStatus || 'pending';
    const reviewLabel = review === 'approved' ? 'Đạt' : review === 'needs_review' ? 'Cần xem lại' : 'Chờ xem xét';
    const auditId = feedbackEscape(item.auditId);
    return `<tr><td class="chat-time">${feedbackEscape(audit.timestamp || new Date(item.updatedAt || item.createdAt).toLocaleString('vi-VN'))}</td>
      <td><span class="metric-tag ${item.rating === 'like' ? 'green' : 'red'}"><i class="fa-solid fa-thumbs-${item.rating === 'like' ? 'up' : 'down'}"></i> ${item.rating === 'like' ? 'Thích' : 'Không thích'}</span></td>
      <td><div class="chat-prompt">${feedbackEscape(audit.question || 'Không tìm thấy câu hỏi')}</div><details class="feedback-answer"><summary>Xem câu trả lời và SQL</summary><div>${feedbackEscape(audit.replyText || 'Không có câu trả lời')}</div>${audit.sqlQuery ? `<pre>${feedbackEscape(audit.sqlQuery)}</pre>` : ''}</details></td>
      <td><span class="metric-tag purple">${feedbackEscape(item.model || audit.modelName || 'Không rõ model')}</span><small class="feedback-token">${feedbackEscape(feedbackTokenUsage(audit))}</small></td>
      <td><span class="feedback-review-status ${review}">${reviewLabel}</span><textarea id="feedback-note-${auditId}" placeholder="Ghi chú kiểm duyệt">${feedbackEscape(item.reviewNote || '')}</textarea><div class="feedback-review-actions"><button data-audit-id="${auditId}" onclick="reviewChatFeedback(this.dataset.auditId,'approved')"><i class="fa-solid fa-check"></i> Đạt</button><button data-audit-id="${auditId}" onclick="reviewChatFeedback(this.dataset.auditId,'needs_review')"><i class="fa-solid fa-triangle-exclamation"></i> Xem lại</button></div></td></tr>`;
  }).join('') : '<tr><td colspan="5" class="chat-history-empty"><i class="fa-solid fa-inbox"></i><strong>Không có đánh giá phù hợp.</strong></td></tr>';
  if (typeof renderPaginationControls === 'function') renderPaginationControls('feedback-pagination', 'chat_feedback', items.length, renderChatFeedbackTable);
}

async function reviewChatFeedback(auditId, reviewStatus) {
  const reviewNote = document.getElementById(`feedback-note-${auditId}`)?.value || '';
  try {
    const res = await fetch('/api/chat-feedback/review', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auditId, reviewStatus, reviewNote }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    if (typeof showToast === 'function') showToast('Đã lưu kết quả xem xét.', 'success');
    await fetchChatFeedback();
  } catch (err) {
    if (typeof showToast === 'function') showToast(err.message, 'error', 'Không thể lưu');
  }
}

window.fetchChatFeedback = fetchChatFeedback;
window.renderChatFeedbackTable = renderChatFeedbackTable;
window.reviewChatFeedback = reviewChatFeedback;
