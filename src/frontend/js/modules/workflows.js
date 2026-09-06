/** Workflow Automation Manager — independent from Chat/LLM. */
window.workflowManagerState = { workflows: [], runs: [] };
const workflowTemplates = {
  manual: [{ id: 'prepare', name: 'Chuẩn hóa input', type: 'transform', config: { mapping: { payload: '{{input}}' }, outputKey: 'prepared' } }],
  webhook: [{ id: 'prepare', name: 'Chuẩn hóa webhook', type: 'transform', config: { mapping: { payload: '{{input}}' }, outputKey: 'prepared' } }, { id: 'send', name: 'Gọi API', type: 'http', config: { method: 'POST', url: 'https://example.com/webhook', headers: { 'Content-Type': 'application/json' }, body: '{{prepared.payload}}', outputKey: 'response', timeoutMs: 30000 }, retry: { maxAttempts: 3, delayMs: 1000 } }]
};

window.initWorkflowsView = function () { refreshWorkflowManager(); };
window.refreshWorkflowManager = async function () {
  try {
    const [workflowRes, runsRes] = await Promise.all([fetch('/api/workflows'), fetch('/api/workflows/runs')]);
    if (!workflowRes.ok || !runsRes.ok) throw new Error('Không thể tải dữ liệu workflow');
    const workflowData = await workflowRes.json(); const runData = await runsRes.json();
    workflowManagerState.workflows = workflowData.workflows || []; workflowManagerState.runs = runData.runs || [];
    renderWorkflowManager(); renderWorkflowRuns();
  } catch (error) { notifyWorkflow(error.message, 'error'); document.getElementById('workflow-cards').innerHTML = emptyWorkflowHtml('Không tải được workflow', error.message); }
};

window.renderWorkflowManager = function () {
  const query = (document.getElementById('wf-search')?.value || '').toLowerCase();
  const workflows = workflowManagerState.workflows.filter(item => `${item.name} ${item.description || ''}`.toLowerCase().includes(query));
  document.getElementById('wf-total-count').textContent = workflowManagerState.workflows.length;
  document.getElementById('wf-active-count').textContent = workflowManagerState.workflows.filter(item => item.enabled).length;
  document.getElementById('wf-run-count').textContent = workflowManagerState.runs.length;
  const filter = document.getElementById('wf-history-filter'); const selected = filter.value;
  filter.innerHTML = '<option value="">Tất cả workflow</option>' + workflowManagerState.workflows.map(item => `<option value="${h(item.id)}">${h(item.name)}</option>`).join(''); filter.value = selected;
  const container = document.getElementById('workflow-cards');
  if (!workflows.length) { container.innerHTML = emptyWorkflowHtml('Chưa có workflow phù hợp', 'Tạo workflow đầu tiên để bắt đầu automation.'); return; }
  container.innerHTML = workflows.map(workflow => {
    const trigger = workflow.trigger?.type || 'manual'; const steps = workflow.steps || [];
    return `<article class="workflow-manager-card"><div class="workflow-card-head"><span class="workflow-trigger ${trigger}"><i class="fa-solid ${trigger === 'webhook' ? 'fa-satellite-dish' : 'fa-hand-pointer'}"></i>${trigger}</span><span class="workflow-status ${workflow.enabled ? 'active' : ''}">${workflow.enabled ? 'Active' : 'Disabled'}</span></div><h3>${h(workflow.name)}</h3><p>${h(workflow.description || 'Không có mô tả')}</p><div class="workflow-step-strip">${steps.map((step, index) => `<span title="${h(step.name || step.id)}"><b>${index + 1}</b>${h(step.type)}</span>`).join('<i class="fa-solid fa-chevron-right"></i>')}</div>${trigger === 'webhook' ? `<div class="workflow-webhook"><code>/api/workflows/webhook/${h(workflow.id)}</code><button onclick="copyWorkflowWebhook('${js(workflow.id)}')"><i class="fa-regular fa-copy"></i></button></div>` : ''}<div class="workflow-card-actions"><button onclick="openRunWorkflowModal('${js(workflow.id)}')"><i class="fa-solid fa-play"></i> Chạy</button><button onclick="openWorkflowEditor('${js(workflow.id)}')"><i class="fa-solid fa-pen"></i> Sửa</button><button class="danger" onclick="deleteWorkflow('${js(workflow.id)}')"><i class="fa-solid fa-trash"></i></button></div></article>`;
  }).join('');
};

window.loadWorkflowRuns = function () { renderWorkflowRuns(); };
function renderWorkflowRuns() {
  const selected = document.getElementById('wf-history-filter')?.value || '';
  const runs = workflowManagerState.runs.filter(run => !selected || run.workflowId === selected); const container = document.getElementById('workflow-run-results-container');
  if (!runs.length) { container.innerHTML = emptyWorkflowHtml('Chưa có lượt chạy', ''); return; }
  container.innerHTML = runs.map(run => `<button class="workflow-run-row" onclick="showWorkflowRun('${js(run.runId)}')"><span class="run-dot ${run.success ? 'success' : 'failed'}"></span><span><strong>${h(workflowName(run.workflowId))}</strong><small>${new Date(run.startedAt).toLocaleString('vi-VN')} · ${h(run.triggerType || 'manual')}</small></span><b>${run.trace?.totalDurationMs || 0} ms</b><i class="fa-solid fa-chevron-right"></i></button>`).join('');
}

window.openWorkflowEditor = function (workflowId = '') {
  const workflow = workflowManagerState.workflows.find(item => item.id === workflowId);
  openWorkflowModal('workflow-editor-modal', `<div class="workflow-dialog workflow-editor-dialog"><header><div><i class="fa-solid fa-diagram-project"></i><span>${workflow ? 'Chỉnh sửa workflow' : 'Tạo workflow mới'}</span></div><button onclick="closeWorkflowModal('workflow-editor-modal')"><i class="fa-solid fa-xmark"></i></button></header><div class="workflow-editor-body"><div class="workflow-form-grid"><label>Tên workflow<input id="wfe-name" value="${h(workflow?.name || '')}" placeholder="Đồng bộ đơn hàng"></label><label>Trigger<select id="wfe-trigger"><option value="manual">Manual</option><option value="webhook">Webhook</option></select></label></div><label>Mô tả<input id="wfe-description" value="${h(workflow?.description || '')}" placeholder="Mô tả mục đích automation"></label><label class="workflow-check"><input id="wfe-enabled" type="checkbox" ${workflow?.enabled !== false ? 'checked' : ''}> Kích hoạt workflow</label><div class="workflow-json-head"><div><strong>Các bước thực thi</strong><small>http, condition, transform, delay, sql, export</small></div><button onclick="applyWorkflowTemplate()"><i class="fa-solid fa-wand-magic-sparkles"></i> Nạp mẫu</button></div><textarea id="wfe-steps" class="workflow-json-editor" spellcheck="false"></textarea><div id="wfe-error" class="workflow-form-error"></div></div><footer><button class="btn-secondary-sm" onclick="closeWorkflowModal('workflow-editor-modal')">Hủy</button><button class="btn-primary" onclick="saveWorkflowDefinition('${js(workflow?.id || '')}')"><i class="fa-solid fa-floppy-disk"></i> Lưu workflow</button></footer></div>`);
  document.getElementById('wfe-trigger').value = workflow?.trigger?.type || 'manual'; document.getElementById('wfe-steps').value = JSON.stringify(workflow?.steps || workflowTemplates.manual, null, 2);
};
window.applyWorkflowTemplate = function () { document.getElementById('wfe-steps').value = JSON.stringify(workflowTemplates[document.getElementById('wfe-trigger').value] || workflowTemplates.manual, null, 2); };
window.saveWorkflowDefinition = async function (id) {
  const errorBox = document.getElementById('wfe-error');
  try {
    const payload = { id: id || undefined, name: document.getElementById('wfe-name').value.trim(), description: document.getElementById('wfe-description').value.trim(), enabled: document.getElementById('wfe-enabled').checked, trigger: { type: document.getElementById('wfe-trigger').value }, steps: JSON.parse(document.getElementById('wfe-steps').value) };
    const response = await fetch('/api/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Không thể lưu workflow');
    closeWorkflowModal('workflow-editor-modal'); notifyWorkflow('Đã lưu workflow', 'success'); await refreshWorkflowManager(); if (data.workflow?.trigger?.type === 'webhook') showWebhookSecret(data.workflow);
  } catch (error) { errorBox.textContent = error instanceof SyntaxError ? 'JSON steps không hợp lệ.' : error.message; }
};
window.deleteWorkflow = async function (id) { if (!confirm(`Xóa workflow "${workflowName(id)}"?`)) return; const response = await fetch(`/api/workflows/${encodeURIComponent(id)}`, { method: 'DELETE' }); if (!response.ok) return notifyWorkflow('Không thể xóa workflow', 'error'); notifyWorkflow('Đã xóa workflow', 'success'); await refreshWorkflowManager(); };

window.openRunWorkflowModal = function (workflowId = 'data_export_pipeline') {
  openWorkflowModal('run-workflow-modal-v2', `<div class="workflow-dialog"><header><div><i class="fa-solid fa-play"></i><span>Chạy ${h(workflowName(workflowId))}</span></div><button onclick="closeWorkflowModal('run-workflow-modal-v2')"><i class="fa-solid fa-xmark"></i></button></header><div class="workflow-editor-body"><label>Input JSON<textarea id="wf-run-input" class="workflow-json-editor short" spellcheck="false">${h(JSON.stringify(defaultRunInput(workflowId), null, 2))}</textarea></label><div id="wf-run-error" class="workflow-form-error"></div></div><footer><button class="btn-secondary-sm" onclick="closeWorkflowModal('run-workflow-modal-v2')">Hủy</button><button id="wf-submit-btn" class="btn-primary" onclick="executeSelectedWorkflow('${js(workflowId)}')"><i class="fa-solid fa-bolt"></i> Thực thi</button></footer></div>`);
};
window.closeRunWorkflowModal = function () { closeWorkflowModal('run-workflow-modal-v2'); };
window.executeSelectedWorkflow = async function (workflowId) {
  const button = document.getElementById('wf-submit-btn');
  try { const input = JSON.parse(document.getElementById('wf-run-input').value || '{}'); button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang chạy'; const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) }); const result = await response.json(); if (!response.ok || !result.success) throw new Error(result.message || result.trace?.error || 'Workflow thất bại'); closeWorkflowModal('run-workflow-modal-v2'); notifyWorkflow('Workflow chạy thành công', 'success'); await refreshWorkflowManager(); showRunPayload(result); } catch (error) { document.getElementById('wf-run-error').textContent = error instanceof SyntaxError ? 'Input JSON không hợp lệ.' : error.message; } finally { if (button) { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-bolt"></i> Thực thi'; } }
};
window.showWorkflowRun = function (runId) { const run = workflowManagerState.runs.find(item => item.runId === runId); if (run) showRunPayload(run); };
function showRunPayload(run) { openWorkflowModal('workflow-run-detail-modal', `<div class="workflow-dialog workflow-detail-dialog"><header><div><i class="fa-solid fa-code-branch"></i><span>Chi tiết lượt chạy</span></div><button onclick="closeWorkflowModal('workflow-run-detail-modal')"><i class="fa-solid fa-xmark"></i></button></header><div class="workflow-run-summary ${run.success ? 'success' : 'failed'}"><strong>${run.success ? 'Thành công' : 'Thất bại'}</strong><span>${run.trace?.totalDurationMs || 0} ms · ${(run.trace?.executedSteps || []).length} steps</span></div><div class="workflow-editor-body"><pre class="workflow-run-json">${h(JSON.stringify(run, null, 2))}</pre></div></div>`); }
function showWebhookSecret(workflow) { openWorkflowModal('workflow-secret-modal', `<div class="workflow-dialog"><header><div><i class="fa-solid fa-key"></i><span>Webhook đã sẵn sàng</span></div><button onclick="closeWorkflowModal('workflow-secret-modal')"><i class="fa-solid fa-xmark"></i></button></header><div class="workflow-editor-body"><p>Gửi secret trong header <code>X-Workflow-Secret</code>.</p><label>Endpoint<input readonly value="${location.origin}/api/workflows/webhook/${h(workflow.id)}"></label><label>Secret<input readonly value="${h(workflow.webhookSecret)}"></label></div></div>`); }
window.copyWorkflowWebhook = async function (id) { await navigator.clipboard.writeText(`${location.origin}/api/workflows/webhook/${id}`); notifyWorkflow('Đã sao chép webhook URL', 'success'); };
window.closeWorkflowModal = function (id) { document.getElementById(id)?.remove(); };
function openWorkflowModal(id, html) { document.getElementById(id)?.remove(); const modal = document.createElement('div'); modal.id = id; modal.className = 'modal-backdrop workflow-modal show'; modal.innerHTML = html; modal.onclick = event => { if (event.target === modal) modal.remove(); }; document.body.appendChild(modal); }
function workflowName(id) { return workflowManagerState.workflows.find(item => item.id === id)?.name || id; }
function defaultRunInput(id) { return id === 'data_export_pipeline' ? { sql: 'SELECT TOP 5 * FROM M_Employee', exportFormat: 'xlsx', exportFilename: 'Bao_Cao' } : {}; }
function emptyWorkflowHtml(title, detail) { return `<div class="system-tools-empty"><i class="fa-solid fa-diagram-project"></i><strong>${h(title)}</strong><span>${h(detail)}</span></div>`; }
function notifyWorkflow(message, type) { if (typeof showToast === 'function') showToast(message, type); }
function h(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
function js(value) { return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
