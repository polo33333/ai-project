/**
 * AI Providers & Multi-LLM Router Module
 */

window.aiProvidersData = [];
window.editingAiProviderId = null;

function escapeProviderHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeProvidersResponse(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.providers)) return data.providers;
  return [];
}

function getProviderFormat(type = '') {
  if (type.includes('Gemini')) return 'gemini';
  if (type.includes('Ollama')) return 'ollama';
  if (type.includes('DeepSeek')) return 'openai';
  if (type.includes('LM Studio')) return 'openai';
  return 'openai';
}

async function fetchAiProviders() {
  try {
    const res = await fetch('/api/ai-providers');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    window.aiProvidersData = normalizeProvidersResponse(data);
    renderAiProvidersTable();
  } catch (err) {
    console.error('Lỗi khi nạp danh sách AI Providers:', err);
    if (typeof showToast === 'function') showToast('Không thể nạp danh sách AI Providers.', 'error');
  }
}

function renderActiveProvider(activeProv) {
  const titleEl = document.getElementById('active-model-title-text');
  const urlEl = document.getElementById('active-model-url-text');
  const secEl = document.getElementById('active-model-security-text');
  const costEl = document.getElementById('active-model-cost-text');

  if (!activeProv) {
    if (titleEl) titleEl.textContent = 'Chưa có provider active';
    if (urlEl) urlEl.textContent = '-';
    if (secEl) secEl.textContent = '-';
    if (costEl) costEl.textContent = '$0 / 1k tokens';
    return;
  }

  const isLocal = String(activeProv.apiFormat || activeProv.type || '').toLowerCase().includes('ollama');
  if (titleEl) titleEl.textContent = `${activeProv.name} (${activeProv.model || 'Default'})`;
  if (urlEl) urlEl.textContent = activeProv.baseUrl || 'On-Premise Local';
  if (secEl) secEl.textContent = isLocal ? 'On-Premise, không gửi dữ liệu ra cloud' : 'Cloud API qua TLS';
  if (costEl) costEl.textContent = `$${activeProv.tokenCost || 0} / 1k tokens`;
}

function renderAiProvidersTable() {
  const tbody = document.getElementById('page-ai-providers-tbody') || document.getElementById('ai-providers-tbody');
  if (!tbody) return;

  const providers = window.aiProvidersData || [];
  const activeProv = providers.find(p => p.isActive) || null;
  renderActiveProvider(activeProv);

  if (providers.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="system-logs-empty">
          <i class="fa-solid fa-network-wired"></i>
          <strong>Chưa có AI Provider nào được cấu hình.</strong>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = providers.map(prov => {
    const isActive = !!prov.isActive;
    const priority = Number(prov.priority) || 999;
    const rawStatus = String(prov.status || 'standby').toLowerCase();
    const isConnected = rawStatus === 'connected' || rawStatus === 'online';
    const isUnconfigured = rawStatus === 'unconfigured';
    const healthClass = isConnected ? 'green' : isUnconfigured ? 'gray' : 'red';
    const healthIcon = isConnected ? 'fa-link' : isUnconfigured ? 'fa-gear' : 'fa-link-slash';
    const healthText = isConnected ? 'Đã kết nối' : isUnconfigured ? 'Chưa cấu hình' : 'Mất kết nối';
    const id = escapeProviderHtml(prov.id);
    return `
      <tr class="${isActive ? 'provider-row-active' : ''}">
        <td>
          <div class="provider-name-cell">
            <span class="provider-icon"><i class="fa-solid fa-robot"></i></span>
            <div>
              <strong>${escapeProviderHtml(prov.name)}</strong>
              <span>${escapeProviderHtml(prov.apiFormat || 'openai')}</span>
            </div>
          </div>
        </td>
        <td><span class="metric-tag purple">${escapeProviderHtml(prov.type || '-')}</span></td>
        <td>
          <div class="provider-model">${escapeProviderHtml(prov.model || '-')}</div>
          <div class="provider-url">${escapeProviderHtml(prov.baseUrl || '-')}</div>
        </td>
        <td><strong>$${escapeProviderHtml(prov.tokenCost || 0)} / 1k</strong></td>
        <td>
          <div class="provider-status-stack">
            <span class="metric-tag ${isActive ? 'green' : 'purple'} provider-routing-status">
              <i class="fa-solid ${isActive ? 'fa-circle-check' : 'fa-shuffle'}"></i>
              ${isActive ? `Đang sử dụng · Priority ${priority}` : `Dự phòng · Priority ${priority}`}
            </span>
            <span class="metric-tag ${healthClass} provider-health-status">
              <i class="fa-solid ${healthIcon}"></i> ${healthText}
            </span>
          </div>
        </td>
        <td>
          <div class="table-actions">
            <button class="icon-action-btn" onclick="editAiProvider('${id}')" title="Chỉnh sửa provider">
              <i class="fa-solid fa-pen"></i>
            </button>
            <button class="icon-action-btn" onclick="testAiProviderConnection('${id}')" title="Test kết nối">
              <i class="fa-solid fa-plug-circle-check"></i>
            </button>
            <button class="icon-action-btn ${isActive ? 'is-active' : ''}" onclick="activateAiProvider('${id}')" title="${isActive ? 'Provider đang được sử dụng' : `Đặt làm provider chính (priority ${priority})`}" ${isActive ? 'disabled' : ''}>
              <i class="fa-solid fa-power-off"></i>
            </button>
            <button class="icon-action-btn danger-soft" onclick="deleteAiProvider('${id}')" title="Xóa provider">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function setProviderFormModel(model) {
  const modelSelect = document.getElementById('page-new-prov-model');
  if (!modelSelect) return;
  const value = String(model || '');
  const exists = Array.from(modelSelect.options).some(option => option.value === value);
  if (value && !exists) modelSelect.add(new Option(value, value));
  modelSelect.value = value;
}

function editAiProvider(id) {
  const provider = (window.aiProvidersData || []).find(item => String(item.id) === String(id));
  if (!provider) {
    if (typeof showToast === 'function') showToast('Không tìm thấy provider cần chỉnh sửa.', 'error');
    return;
  }

  window.editingAiProviderId = provider.id;
  const values = {
    'page-new-prov-name': provider.name || '',
    'page-new-prov-type': provider.type || 'OpenAI Compatible',
    'page-new-prov-url': provider.baseUrl || '',
    'page-new-prov-key': '',
    'page-new-prov-priority': String(provider.priority || 1),
    'page-new-prov-cost': String(provider.tokenCost || 0)
  };
  Object.entries(values).forEach(([fieldId, value]) => {
    const field = document.getElementById(fieldId);
    if (field) field.value = value;
  });
  setProviderFormModel(provider.model);

  const keyInput = document.getElementById('page-new-prov-key');
  if (keyInput) keyInput.placeholder = 'Để trống để giữ nguyên API Key';
  const label = document.getElementById('page-provider-save-label');
  if (label) label.textContent = 'Cập nhật provider';
  const cancelButton = document.getElementById('page-provider-cancel-btn');
  if (cancelButton) cancelButton.style.display = '';
  document.getElementById('page-add-provider-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditAiProvider() {
  window.editingAiProviderId = null;
  const form = document.getElementById('page-provider-form');
  if (form) form.reset();
  onProvTypeChange();
  const keyInput = document.getElementById('page-new-prov-key');
  if (keyInput) keyInput.placeholder = 'AIzaSy... / sk-...';
  const label = document.getElementById('page-provider-save-label');
  if (label) label.textContent = 'Lưu provider';
  const cancelButton = document.getElementById('page-provider-cancel-btn');
  if (cancelButton) cancelButton.style.display = 'none';
}

async function testAiProviderConnection(id) {
  if (typeof showToast === 'function') showToast('Đang kiểm tra Provider...', 'info');
  try {
    const res = await fetch('/api/ai-providers/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    const ok = data.success !== false;
    if (typeof showToast === 'function') {
      showToast(`${ok ? 'Kết nối thành công' : 'Kết nối fallback'} (${data.latencyMs || 0}ms)`, ok ? 'success' : 'warn');
    }
    await fetchAiProviders();
  } catch (err) {
    console.error('Test Provider lỗi:', err);
    if (typeof showToast === 'function') showToast(`Test Provider lỗi: ${err.message}`, 'error');
  }
}

async function activateAiProvider(id) {
  try {
    const res = await fetch('/api/ai-providers/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    await fetchAiProviders();
    if (typeof showToast === 'function') showToast('Đã kích hoạt AI Provider.', 'success');
  } catch (err) {
    console.error('Không thể kích hoạt Provider:', err);
    if (typeof showToast === 'function') showToast(`Không thể kích hoạt Provider: ${err.message}`, 'error');
  }
}

async function deleteAiProvider(id) {
  if (!confirm('Xóa Provider này khỏi Router?')) return;
  try {
    const res = await fetch('/api/ai-providers/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerId: id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    await fetchAiProviders();
    if (typeof showToast === 'function') showToast('Đã xóa AI Provider.', 'info');
  } catch (err) {
    console.error('Không thể xóa Provider:', err);
    if (typeof showToast === 'function') showToast(`Không thể xóa Provider: ${err.message}`, 'error');
  }
}

function onProvTypeChange() {
  const typeSelect = document.getElementById('page-new-prov-type');
  const urlInput = document.getElementById('page-new-prov-url');
  const modelSelect = document.getElementById('page-new-prov-model');
  if (!typeSelect) return;

  const val = typeSelect.value;
  if (val.includes('Gemini')) {
    if (urlInput) urlInput.value = 'https://generativelanguage.googleapis.com';
    if (modelSelect) modelSelect.innerHTML = '<option value="gemini-2.5-flash">gemini-2.5-flash</option><option value="gemini-1.5-pro">gemini-1.5-pro</option>';
  } else if (val.includes('Ollama')) {
    if (urlInput) urlInput.value = 'http://127.0.0.1:11434';
    if (modelSelect) modelSelect.innerHTML = '<option value="qwen2.5-coder">qwen2.5-coder</option><option value="llama3.1">llama3.1</option>';
  } else if (val.includes('OpenAI')) {
    if (urlInput) urlInput.value = 'https://api.openai.com/v1';
    if (modelSelect) modelSelect.innerHTML = '<option value="gpt-4o-mini">gpt-4o-mini</option><option value="gpt-4o">gpt-4o</option>';
  } else if (val.includes('DeepSeek')) {
    if (urlInput) urlInput.value = 'https://api.deepseek.com';
    if (modelSelect) modelSelect.innerHTML = '<option value="deepseek-chat">deepseek-chat</option>';
  } else if (val.includes('LM Studio')) {
    if (urlInput) urlInput.value = 'http://127.0.0.1:1234/v1';
    if (modelSelect) modelSelect.innerHTML = '<option value="meta-llama-3-8b-instruct">meta-llama-3-8b-instruct</option>';
  }
}

async function savePageNewAiProvider() {
  const name = document.getElementById('page-new-prov-name')?.value.trim();
  const type = document.getElementById('page-new-prov-type')?.value || 'OpenAI Compatible';
  const baseUrl = document.getElementById('page-new-prov-url')?.value.trim();
  const model = document.getElementById('page-new-prov-model')?.value.trim();
  const apiKey = document.getElementById('page-new-prov-key')?.value.trim();
  const priority = parseInt(document.getElementById('page-new-prov-priority')?.value || '1', 10);
  const tokenCost = parseFloat(document.getElementById('page-new-prov-cost')?.value || '0');
  const editingId = window.editingAiProviderId;

  if (!name || !model) {
    if (typeof showToast === 'function') showToast('Vui lòng nhập tên Provider và Model AI.', 'warn');
    return;
  }

  const apiFormat = getProviderFormat(type);
  try {
    const payload = { name, type, apiFormat, baseUrl, model, supportsToolCalling: apiFormat !== 'ollama', priority, tokenCost };
    if (apiKey) payload.apiKey = apiKey;
    if (editingId) payload.providerId = editingId;
    const res = await fetch(editingId ? '/api/ai-providers/update' : '/api/ai-providers/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    const actionText = editingId ? 'cập nhật' : 'thêm';
    cancelEditAiProvider();
    await fetchAiProviders();
    if (typeof showToast === 'function') showToast(`Đã ${actionText} AI Provider "${name}".`, 'success');
  } catch (err) {
    const actionText = editingId ? 'cập nhật' : 'thêm';
    console.error(`Không thể ${actionText} Provider:`, err);
    if (typeof showToast === 'function') showToast(`Không thể ${actionText} Provider: ${err.message}`, 'error');
  }
}

async function autoFetchProviderModels() {
  const type = document.getElementById('page-new-prov-type')?.value || 'Google Gemini API';
  const baseUrl = document.getElementById('page-new-prov-url')?.value.trim();
  const apiKey = document.getElementById('page-new-prov-key')?.value.trim();
  const modelSelect = document.getElementById('page-new-prov-model');
  if (!modelSelect) return;

  if (typeof showToast === 'function') showToast('Đang quét danh sách model...', 'info');
  try {
    const res = await fetch('/api/ai-providers/fetch-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, baseUrl, apiKey })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    const models = data.models || [];
    modelSelect.innerHTML = models.length
      ? models.map(model => `<option value="${escapeProviderHtml(model)}">${escapeProviderHtml(model)}</option>`).join('')
      : '<option value="">Không tìm thấy model</option>';
    if (typeof showToast === 'function') showToast(`Đã tìm thấy ${models.length} model.`, models.length ? 'success' : 'warn');
  } catch (err) {
    console.error('Không thể quét models:', err);
    if (typeof showToast === 'function') showToast(`Không thể quét models: ${err.message}`, 'error');
  }
}

window.fetchAiProviders = fetchAiProviders;
window.renderAiProvidersTable = renderAiProvidersTable;
window.onProvTypeChange = onProvTypeChange;
window.savePageNewAiProvider = savePageNewAiProvider;
window.autoFetchProviderModels = autoFetchProviderModels;
window.editAiProvider = editAiProvider;
window.cancelEditAiProvider = cancelEditAiProvider;
window.testAiProviderConnection = testAiProviderConnection;
window.activateAiProvider = activateAiProvider;
window.toggleAiProviderActive = activateAiProvider;
window.deleteAiProvider = deleteAiProvider;
