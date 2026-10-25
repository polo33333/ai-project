(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const labels = { answered: 'Đã trả lời', partial: 'Kết quả một phần', clarify: 'Cần làm rõ', no_evidence: 'Chưa có bằng chứng phù hợp',
    denied: 'Không đủ quyền truy cập', pending: 'Đang chờ xử lý', cancelled: 'Đã dừng', error: 'Chưa thể hoàn tất' };
  function render(envelope, execution) {
    // The workflow panel owns live execution state; the envelope is an immutable turn snapshot.
    if (execution) return '';
    if (!envelope || envelope.schemaVersion !== '1') return '';
    const status = Object.hasOwn(labels, envelope.disposition) ? envelope.disposition : 'error';
    if (status === 'answered' || status === 'partial') return '';
    const claims = Array.isArray(envelope.claims) ? envelope.claims : [];
    const checked = claims.filter(claim => ['deterministic', 'source_supported'].includes(claim.assurance)).length;
    const limitations = Array.isArray(envelope.limitations) ? envelope.limitations.filter(value => typeof value === 'string') : [];
    if (status === 'answered' && !claims.length && !limitations.length) return '';
    const summary = status === 'answered' ? 'Nguồn và độ tin cậy' : labels[status];
    const details = `${claims.length ? `<p class="answer-assurance">${checked}/${claims.length} dữ kiện được đối chiếu nguồn. Việc đối chiếu này không xác nhận toàn bộ phần diễn giải.</p>` : ''}${limitations.length ? `<ul>${limitations.map(value => `<li>${escape(value)}</li>`).join('')}</ul>` : ''}`;
    return details ? `<details class="answer-status answer-status-${status}"><summary><span class="answer-status-dot" aria-hidden="true"></span><span class="answer-status-label">${summary}</span><span class="answer-status-chevron" aria-hidden="true">⌄</span></summary><div class="answer-status-details">${details}</div></details>`
      : `<div class="answer-status answer-status-${status}" role="status"><span class="answer-status-dot" aria-hidden="true"></span><span class="answer-status-label">${summary}</span></div>`;
  }
  root.AnswerUI = { render, label: envelope => labels[envelope?.disposition] || 'Đã nhận kết quả' };
  if (typeof module !== 'undefined') module.exports = root.AnswerUI;
})(typeof window !== 'undefined' ? window : globalThis);
