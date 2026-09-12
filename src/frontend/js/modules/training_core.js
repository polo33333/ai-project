'use strict';

window.trainingReportData = null;
window.trainingStatusTab = 'pending';
window.trainingPageTab = 'cases';
window.skillEditorData = null;
window.selectedSkillId = null;

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

window.refreshTrainingView = function refreshTrainingView() {
  return window.trainingPageTab === 'skills' ? fetchSkillEditorData() : fetchTrainingReport();
};

window.setTrainingPageTab = function setTrainingPageTab(tab) {
  window.trainingPageTab = tab === 'skills' ? 'skills' : 'cases';
  document.getElementById('training-page-tab-cases')?.classList.toggle('active', window.trainingPageTab === 'cases');
  document.getElementById('training-page-tab-skills')?.classList.toggle('active', window.trainingPageTab === 'skills');
  const casesView = document.getElementById('training-cases-view');
  const skillsView = document.getElementById('training-skills-view');
  const summary = document.getElementById('training-summary');
  if (casesView) casesView.hidden = window.trainingPageTab !== 'cases';
  if (skillsView) skillsView.hidden = window.trainingPageTab !== 'skills';
  if (summary) summary.hidden = window.trainingPageTab !== 'cases';
  if (window.trainingPageTab === 'skills' && !window.skillEditorData) fetchSkillEditorData();
};

window.fetchSkillEditorData = async function fetchSkillEditorData() {
  const list = document.getElementById('skill-editor-items');
  if (list) list.innerHTML = '<div class="training-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Đang tải skills...</div>';
  try {
    const response = await fetch('/api/training/skills', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    window.skillEditorData = data;
    if (!data.skills?.some(skill => skill.id === window.selectedSkillId)) window.selectedSkillId = data.skills?.[0]?.id || null;
    renderSkillEditor();
  } catch (error) {
    if (list) list.innerHTML = `<div class="training-empty"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeTrainingHtml(error.message)}</div>`;
  }
};

window.selectSkillForEditing = function selectSkillForEditing(skillId) {
  window.selectedSkillId = skillId;
  renderSkillEditor();
};

function selectedSkill() {
  return window.skillEditorData?.skills?.find(skill => skill.id === window.selectedSkillId) || null;
}

window.renderSkillEditor = function renderSkillEditor() {
  const data = window.skillEditorData;
  if (!data) return;
  const list = document.getElementById('skill-editor-items');
  if (list) list.innerHTML = (data.skills || []).map(skill => `<button type="button" class="skill-editor-item ${skill.id === window.selectedSkillId ? 'active' : ''}" onclick="selectSkillForEditing(decodeURIComponent('${encodeURIComponent(skill.id)}'))"><span>${escapeTrainingHtml(skill.name)}</span><small>${escapeTrainingHtml(skill.id)}</small><i class="fa-solid ${skill.enabled ? 'fa-circle-check' : 'fa-circle-pause'}"></i></button>`).join('') || '<div class="training-empty">Chưa có skill.</div>';
  const skill = selectedSkill();
  const form = document.getElementById('skill-editor-form');
  if (form) form.hidden = !skill;
  if (!skill) return;
  document.getElementById('skill-editor-name').value = skill.name || '';
  document.getElementById('skill-editor-id').value = skill.id;
  document.getElementById('skill-editor-enabled').checked = skill.enabled === true;
  document.getElementById('skill-editor-intents').value = (skill.intents || []).join(', ');
  document.getElementById('skill-editor-instructions').value = skill.instructions || '';
  const examples = (data.examples || []).filter(example => example.skillId === skill.id);
  document.getElementById('skill-editor-examples').innerHTML = examples.map(example => `<label><input type="checkbox" value="${escapeTrainingHtml(example.id)}" ${(skill.exampleIds || []).includes(example.id) ? 'checked' : ''}><span>${escapeTrainingHtml(example.name)}</span></label>`).join('') || '<small>Skill này chưa có template ví dụ.</small>';
  const enabled = data.flags?.skillCoreEnabled;
  const fewShot = data.flags?.fewShotEnabled;
  document.getElementById('skill-editor-status').innerHTML = `<i class="fa-solid ${enabled ? 'fa-circle-check' : 'fa-circle-info'}"></i><span>${enabled ? 'Skill Core đang bật.' : 'Skill Core đang tắt; cấu hình vẫn được lưu nhưng chưa áp dụng cho chat.'}${enabled && !fewShot ? ' Few-shot đang tắt.' : ''}</span>`;
  updateSkillCharacterCount();
};

window.updateSkillCharacterCount = function updateSkillCharacterCount() {
  const input = document.getElementById('skill-editor-instructions');
  const count = document.getElementById('skill-editor-char-count');
  const preview = document.getElementById('skill-editor-preview');
  if (count) count.textContent = `${input?.value.length || 0}/6000`;
  if (preview) preview.textContent = input?.value || '';
};

window.resetSelectedSkill = function resetSelectedSkill() { renderSkillEditor(); };

window.saveSelectedSkill = async function saveSelectedSkill(event) {
  event?.preventDefault();
  const skill = selectedSkill();
  if (!skill) return;
  const button = document.getElementById('skill-editor-save');
  if (button) button.disabled = true;
  const exampleIds = [...document.querySelectorAll('#skill-editor-examples input:checked')].map(input => input.value);
  try {
    const response = await fetch('/api/training/skills/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: skill.id, name: document.getElementById('skill-editor-name').value, enabled: document.getElementById('skill-editor-enabled').checked, instructions: document.getElementById('skill-editor-instructions').value, exampleIds })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    Object.assign(skill, data.skill);
    renderSkillEditor();
    if (typeof showToast === 'function') showToast('Đã lưu skill. Lượt chat mới sẽ dùng cấu hình này.', 'success');
  } catch (error) {
    if (typeof showToast === 'function') showToast(error.message, 'error');
  } finally {
    if (button) button.disabled = false;
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

window.setTrainingStatusTab = function setTrainingStatusTab(tab) {
  window.trainingStatusTab = tab === 'resolved' ? 'resolved' : 'pending';
  renderTrainingCases();
};

function formatTrainingTime(value) {
  if (!value) return 'Không có thời gian';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
}

window.setTrainingCaseResolved = async function setTrainingCaseResolved(caseId, resolved, button) {
  if (button) button.disabled = true;
  try {
    const response = await fetch('/api/training-report/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ caseId, resolved }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    const item = window.trainingReportData?.cases?.find(entry => entry.id === caseId);
    if (item) Object.assign(item, data.resolution);
    renderTrainingCases();
    if (typeof showToast === 'function') showToast(resolved ? 'Đã chuyển case sang Đã xử lý.' : 'Đã chuyển case về Cần xử lý.', 'success');
  } catch (error) {
    if (button) button.disabled = false;
    if (typeof showToast === 'function') showToast(error.message, 'error');
  }
};

window.renderTrainingCases = function renderTrainingCases() {
  const report = window.trainingReportData;
  if (!report) return;
  const query = (document.getElementById('training-search')?.value || '').toLowerCase();
  const failure = document.getElementById('training-failure-filter')?.value || '';
  const rating = document.getElementById('training-rating-filter')?.value || '';
  const resolvedTab = window.trainingStatusTab === 'resolved';
  const allCases = report.cases || [];
  const pendingCount = allCases.filter(item => !item.resolved).length;
  const resolvedCount = allCases.filter(item => item.resolved).length;
  const pendingTab = document.getElementById('training-tab-pending');
  const completedTab = document.getElementById('training-tab-resolved');
  pendingTab?.classList.toggle('active', !resolvedTab); completedTab?.classList.toggle('active', resolvedTab);
  if (pendingTab) pendingTab.querySelector('b').textContent = pendingCount;
  if (completedTab) completedTab.querySelector('b').textContent = resolvedCount;
  const cases = (report.cases || []).filter(item => {
    if (!item.failures?.length) return false;
    if (!!item.resolved !== resolvedTab) return false;
    if (failure && !item.failures.includes(failure)) return false;
    if (rating === 'none' && item.rating) return false;
    if (rating && rating !== 'none' && item.rating !== rating) return false;
    return !query || `${item.id} ${item.question} ${item.reply}`.toLowerCase().includes(query);
  });
  document.getElementById('training-case-count').textContent = `${cases.length} case`;
  const groupedCases = new Map();
  cases.slice(0, 100).forEach(item => {
    const groupCode = failure || item.failures[0] || 'REVIEW_REQUESTED';
    if (!groupedCases.has(groupCode)) groupedCases.set(groupCode, []);
    groupedCases.get(groupCode).push(item);
  });
  const caseMarkup = item => `
    <div class="training-case-shell">
      <details class="training-case">
        <summary><div class="training-case-main"><div class="training-case-identity"><time><i class="fa-regular fa-calendar"></i>${escapeTrainingHtml(formatTrainingTime(item.timestamp))}</time><span class="training-case-meta-separator" aria-hidden="true"></span><span class="training-case-id"><i class="fa-solid fa-hashtag" aria-hidden="true"></i>${escapeTrainingHtml(item.id)}</span></div><strong>${escapeTrainingHtml(item.question)}</strong><div>${item.failures.map(code => `<span class="training-failure-chip">${escapeTrainingHtml(trainingFailureLabel(code))}</span>`).join('')}</div></div><div class="training-case-meta"><span class="training-status ${String(item.rating || 'none')}">${escapeTrainingHtml(item.rating || 'chưa đánh giá')}</span><i class="fa-solid fa-chevron-down"></i></div></summary>
        <div class="training-case-body">
          <section><h4>Câu trả lời hiện tại</h4><pre>${escapeTrainingHtml(item.reply || '—')}</pre></section>
          <section><h4>SQL</h4><pre>${escapeTrainingHtml(item.sql || 'Chưa có SQL')}</pre></section>
          <section><h4>Memory decision</h4><pre>${escapeTrainingHtml(item.memoryDecision ? JSON.stringify(item.memoryDecision, null, 2) : 'Không có trace memory')}</pre></section>
          <section><h4>Skill</h4><pre>${escapeTrainingHtml(item.skill ? JSON.stringify(item.skill, null, 2) : 'Không có trace skill')}</pre></section>
          <section class="training-suggestions"><h4>Đề xuất cải tiến</h4>${(item.suggestions || []).map(suggestion => `<article><span class="training-target">${escapeTrainingHtml(suggestion.target)}</span><div><strong>${escapeTrainingHtml(suggestion.title)}</strong><p>${escapeTrainingHtml(suggestion.message)}</p><code>${escapeTrainingHtml(suggestion.action)}</code></div></article>`).join('')}</section>
        </div>
      </details>
      <button class="training-resolve-btn ${item.resolved ? 'is-resolved' : ''}" type="button" onclick="setTrainingCaseResolved(decodeURIComponent('${encodeURIComponent(item.id)}'),${!item.resolved},this)"><i class="fa-solid ${item.resolved ? 'fa-rotate-left' : 'fa-check'}"></i>${item.resolved ? 'Mở lại' : 'Đã xử lý'}</button>
    </div>`;
  document.getElementById('training-cases').innerHTML = [...groupedCases.entries()].map(([code, items]) => `
    <section class="training-case-group">
      <header><span><i class="fa-solid fa-triangle-exclamation"></i>${escapeTrainingHtml(trainingFailureLabel(code))}</span><strong>${items.length} case</strong></header>
      <div>${items.map(caseMarkup).join('')}</div>
    </section>`).join('') || '<div class="training-empty"><i class="fa-solid fa-circle-check"></i> Không có case phù hợp bộ lọc.</div>';
};
