/**
 * MCP Servers & API Keys frontend module
 */

window.mcpServersData = [];
window.apiKeysData = [];
window.embedConfigsData = [];
window.visibleApiKeyIds = new Set();

function escapeMcpApiHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function maskApiKey(key) {
  if (!key) return '-';
  if (key.length <= 18) return key;
  return `${key.slice(0, 12)}...${key.slice(-6)}`;
}

function isApiKeyVisible(id) {
  return window.visibleApiKeyIds && window.visibleApiKeyIds.has(id);
}

async function fetchMcpServers() {
  try {
    const res = await fetch('/api/mcp/servers');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.mcpServersData = await res.json();
    renderMcpServersTable();
  } catch (err) {
    console.error('Không thể tải MCP Servers:', err);
    if (typeof showToast === 'function') showToast('Không thể tải MCP Servers.', 'error');
  }
}

function renderMcpServersTable() {
  const tbody = document.getElementById('mcp-servers-tbody');
  if (!tbody) return;
  const servers = window.mcpServersData || [];

  if (servers.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="system-logs-empty"><i class="fa-solid fa-cube"></i><strong>Chưa có MCP Server nào.</strong></td></tr>`;
    return;
  }

  tbody.innerHTML = servers.map(server => {
    const status = String(server.status || 'disconnected').toUpperCase();
    const statusClass = status === 'CONNECTED' ? 'green' : status === 'ERROR' ? 'red' : 'yellow';
    return `
      <tr>
        <td><strong>${escapeMcpApiHtml(server.name)}</strong></td>
        <td><span class="metric-tag purple">${escapeMcpApiHtml(server.protocol || '-')}</span></td>
        <td><code class="table-code">${escapeMcpApiHtml(server.endpoint || '-')}</code></td>
        <td><span class="metric-tag gray">${server.toolsCount || 0} tools</span> <span class="metric-tag gray">${server.resourcesCount || 0} res</span></td>
        <td>${escapeMcpApiHtml(server.scope || '-')}</td>
        <td><span class="metric-tag ${statusClass}" title="${escapeMcpApiHtml(server.lastError || '')}"><i class="fa-solid ${status === 'CONNECTED' ? 'fa-circle-check' : status === 'ERROR' ? 'fa-circle-xmark' : 'fa-circle-pause'}"></i> ${escapeMcpApiHtml(status)}</span></td>
        <td>
          <div class="table-actions">
            <button class="icon-action-btn" onclick="connectMcpServer('${escapeMcpApiHtml(server.id)}')" title="Kết nối lại và quét Tools/Resources">
              <i class="fa-solid fa-plug-circle-bolt"></i>
            </button>
            <button class="icon-action-btn danger-soft" onclick="deleteMcpServer('${escapeMcpApiHtml(server.id)}')" title="Xóa MCP Server">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function submitNewMcpServer() {
  const name = document.getElementById('mcp-new-name')?.value.trim();
  const protocol = document.getElementById('mcp-new-protocol')?.value || 'sse';
  const endpoint = document.getElementById('mcp-new-endpoint')?.value.trim();
  const scope = document.getElementById('mcp-new-scope')?.value.trim();
  if (!name || !endpoint) {
    if (typeof showToast === 'function') showToast('Vui lòng nhập tên và endpoint MCP Server.', 'warn');
    return;
  }

  try {
    const res = await fetch('/api/mcp/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, protocol, endpoint, scope })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    ['mcp-new-name', 'mcp-new-endpoint', 'mcp-new-scope'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    await fetchMcpServers();
    if (data.server?.status !== 'connected') throw new Error(data.server?.lastError || 'MCP Server chưa kết nối được.');
    if (typeof showToast === 'function') showToast('Đã thêm MCP Server.', 'success');
  } catch (err) {
    console.error('Không thể thêm MCP Server:', err);
    if (typeof showToast === 'function') showToast(err.message || 'Không thể thêm MCP Server.', 'error');
  }
}

async function connectMcpServer(id) {
  try {
    const res = await fetch('/api/mcp/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    await fetchMcpServers();
    if (typeof showToast === 'function') showToast(`Đã kết nối: ${data.server.toolsCount} tools, ${data.server.resourcesCount} resources.`, 'success');
  } catch (err) {
    await fetchMcpServers();
    if (typeof showToast === 'function') showToast(err.message, 'error', 'Kết nối MCP thất bại');
  }
}

async function deleteMcpServer(id) {
  if (!confirm('Gỡ MCP Server này?')) return;
  try {
    const res = await fetch('/api/mcp/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchMcpServers();
    if (typeof showToast === 'function') showToast('Đã gỡ MCP Server.', 'info');
  } catch (err) {
    console.error('Không thể gỡ MCP Server:', err);
    if (typeof showToast === 'function') showToast('Không thể gỡ MCP Server.', 'error');
  }
}

async function fetchApiKeys() {
  try {
    const res = await fetch('/api/keys');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.apiKeysData = await res.json();
    renderApiKeysTable();
  } catch (err) {
    console.error('Không thể tải API Keys:', err);
    if (typeof showToast === 'function') showToast('Không thể tải API Keys.', 'error');
  }
}

function renderApiKeysTable() {
  const tbody = document.getElementById('api-keys-tbody');
  if (!tbody) return;
  const keys = window.apiKeysData || [];
  const countEl = document.getElementById('api-key-count');
  if (countEl) countEl.textContent = keys.length;
  if (keys.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="system-logs-empty"><i class="fa-solid fa-key"></i><strong>Chưa có API Key nào.</strong></td></tr>`;
    return;
  }

  tbody.innerHTML = keys.map(key => `
    <tr>
      <td><strong>${escapeMcpApiHtml(key.name)}</strong></td>
      <td>
        <div class="api-key-cell">
          <code class="table-code api-key-code" title="${escapeMcpApiHtml(key.key)}">
            ${escapeMcpApiHtml(isApiKeyVisible(key.id) ? key.key : maskApiKey(key.key))}
          </code>
        </div>
      </td>
      <td>${escapeMcpApiHtml(key.createdDate || '-')}</td>
      <td>${escapeMcpApiHtml(key.lastUsed || '-')}</td>
      <td><span class="metric-tag gray">${escapeMcpApiHtml(key.rateLimit || '-')}</span></td>
      <td>
        <div class="table-actions">
          <button class="icon-action-btn" onclick="toggleApiKeyVisibility('${escapeMcpApiHtml(key.id)}')" title="${isApiKeyVisible(key.id) ? 'Ẩn API Key' : 'Hiện API Key'}">
            <i class="fa-solid ${isApiKeyVisible(key.id) ? 'fa-eye-slash' : 'fa-eye'}"></i>
          </button>
          <button class="icon-action-btn" onclick="copyApiKey('${escapeMcpApiHtml(key.id)}')" title="Copy API Key">
            <i class="fa-solid fa-copy"></i>
          </button>
          <button class="icon-action-btn danger-soft" onclick="revokeApiKey('${escapeMcpApiHtml(key.id)}')" title="Thu hồi API Key">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function copyMcpText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    if (!document.execCommand('copy')) throw new Error('Copy command was rejected');
  } finally {
    textarea.remove();
  }
}

async function copyApiDocCode(button) {
  const code = button?.closest('.api-code-shell')?.querySelector('code')?.textContent;
  if (!code) return;
  try {
    await copyMcpText(code);
    if (typeof showToast === 'function') showToast('Đã sao chép đoạn mã.', 'success');
  } catch (err) {
    if (typeof showToast === 'function') showToast('Không thể sao chép đoạn mã.', 'error');
  }
}

async function fetchEmbedConfigs() {
  try {
    const res = await fetch('/api/embed/configs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.embedConfigsData = await res.json();
    renderEmbedConfigs();
  } catch (err) {
    if (typeof showToast === 'function') showToast('Không thể tải cấu hình Embed.', 'error');
  }
}

function renderEmbedConfigs() {
  const list = document.getElementById('embed-config-list');
  const count = document.getElementById('embed-config-count');
  const configs = window.embedConfigsData || [];
  if (count) count.textContent = configs.length;
  if (!list) return;
  if (configs.length === 0) {
    list.innerHTML = '<div class="embed-config-empty"><i class="fa-solid fa-window-restore"></i><span>Chưa có cấu hình Embed.</span></div>';
    return;
  }
  list.innerHTML = configs.map(config => `
    <article class="embed-config-item ${config.isActive ? '' : 'inactive'}">
      <div class="embed-config-main"><span class="embed-config-icon"><i class="fa-solid fa-comments"></i></span><div><strong>${escapeMcpApiHtml(config.name)}</strong><code>${escapeMcpApiHtml(config.id)}</code></div></div>
      <div class="embed-config-domains">${(config.allowedOrigins || []).filter(origin => origin && String(origin).toLowerCase() !== 'null').map(origin => `<span><i class="fa-solid fa-globe"></i>${escapeMcpApiHtml(origin)}</span>`).join('') || '<span class="empty"><i class="fa-solid fa-circle-exclamation"></i>Chưa cấu hình domain</span>'}</div>
      <div class="embed-config-meta"><span>${escapeMcpApiHtml(config.rateLimit)} req/phút</span><span>Tối đa ${escapeMcpApiHtml(config.maxRows)} dòng</span></div>
      <div class="embed-config-actions">
        <label class="embed-status-toggle" title="Bật/tắt Embed"><input type="checkbox" ${config.isActive ? 'checked' : ''} onchange="toggleEmbedConfig('${escapeMcpApiHtml(config.id)}',this.checked)"><span class="embed-toggle-track"><i></i></span><span class="embed-status-text"></span></label>
        <button class="icon-action-btn embed-preview-btn" onclick="openEmbedPreview('${escapeMcpApiHtml(config.id)}')" title="Mở Embed Chat để thử" aria-label="Mở Embed Chat để thử"><i class="fa-solid fa-up-right-from-square"></i></button>
        <button class="icon-action-btn" onclick="copyEmbedSnippet('${escapeMcpApiHtml(config.id)}')" title="Sao chép mã nhúng"><i class="fa-solid fa-code"></i></button>
        <button class="icon-action-btn" onclick="openEmbedConfigModal('${escapeMcpApiHtml(config.id)}')" title="Sửa cấu hình"><i class="fa-solid fa-pen"></i></button>
        <button class="icon-action-btn danger-soft" onclick="openEmbedDeleteModal('${escapeMcpApiHtml(config.id)}')" title="Xóa"><i class="fa-solid fa-trash-can"></i></button>
      </div>
    </article>`).join('');
}

function openEmbedPreview(id) {
  const config = (window.embedConfigsData || []).find(item => item.id === id);
  if (!config) return;

  const currentHost = document.getElementById('knowledgehub-embed-host');
  if (currentHost?.dataset.embedId === config.id) {
    if (typeof currentHost.destroyEmbed === 'function') currentHost.destroyEmbed();
    else currentHost.remove();
    document.querySelectorAll('script[data-kh-embed-preview]').forEach(script => script.remove());
    window.KnowledgeHubEmbedLoaded = false;
    return;
  }

  if (typeof currentHost?.destroyEmbed === 'function') currentHost.destroyEmbed();
  else currentHost?.remove();
  document.querySelectorAll('script[data-kh-embed-preview]').forEach(script => script.remove());

  const script = document.createElement('script');
  script.src = `/embed/knowledgehub-chat.js?v=20260912-theme-${Date.now()}`;
  script.dataset.khEmbedPreview = 'true';
  script.dataset.embedId = config.id;
  script.dataset.title = 'Trợ lý AI';
  script.dataset.color = '#4f46e5';
  script.dataset.position = 'right';
  script.dataset.preview = 'true';
  script.dataset.theme = 'auto';
  script.onload = () => {
    const toggle = document.getElementById('knowledgehub-embed-host')?.shadowRoot?.querySelector('.kh-embed-toggle');
    if (toggle) toggle.click();
  };
  document.body.appendChild(script);
}

function openEmbedConfigModal(id = '') {
  const config = (window.embedConfigsData || []).find(item => item.id === id);
  document.getElementById('embed-config-id').value = config?.id || '';
  document.getElementById('embed-config-name').value = config?.name || '';
  document.getElementById('embed-config-origins').value = (config?.allowedOrigins || []).join('\n');
  document.getElementById('embed-config-rate').value = String(config?.rateLimit || 30);
  document.getElementById('embed-config-rows').value = String(config?.maxRows || 20);
  document.getElementById('embed-config-modal-title').textContent = config ? 'Sửa Embed Chat' : 'Tạo Embed Chat';
  if (typeof openModal === 'function') openModal('embed-config-modal');
  setTimeout(() => document.getElementById('embed-config-name')?.focus(), 80);
}

function closeEmbedConfigModal() {
  if (typeof closeModal === 'function') closeModal('embed-config-modal');
}

async function saveEmbedConfig(event) {
  event.preventDefault();
  const id = document.getElementById('embed-config-id')?.value || '';
  const payload = {
    id,
    name: document.getElementById('embed-config-name')?.value.trim(),
    allowedOrigins: document.getElementById('embed-config-origins')?.value,
    rateLimit: Number(document.getElementById('embed-config-rate')?.value || 30),
    maxRows: Number(document.getElementById('embed-config-rows')?.value || 20)
  };
  try {
    const endpoint = id ? '/api/embed/configs/update' : '/api/embed/configs/create';
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    closeEmbedConfigModal();
    await fetchEmbedConfigs();
    if (typeof showToast === 'function') showToast(id ? 'Đã cập nhật cấu hình Embed.' : 'Đã tạo cấu hình Embed.', 'success');
  } catch (err) {
    if (typeof showToast === 'function') showToast(err.message, 'error', 'Không thể tạo Embed');
  }
}

async function toggleEmbedConfig(id, isActive) {
  const res = await fetch('/api/embed/configs/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, isActive }) });
  if (!res.ok) return fetchEmbedConfigs();
  await fetchEmbedConfigs();
}

function openEmbedDeleteModal(id) {
  const config = (window.embedConfigsData || []).find(item => item.id === id);
  if (!config) return;
  document.getElementById('embed-delete-id').value = id;
  document.getElementById('embed-delete-name').textContent = config.name;
  if (typeof openModal === 'function') openModal('embed-delete-modal');
}

function closeEmbedDeleteModal() {
  if (typeof closeModal === 'function') closeModal('embed-delete-modal');
}

async function confirmDeleteEmbedConfig() {
  const id = document.getElementById('embed-delete-id')?.value;
  if (!id) return;
  const res = await fetch('/api/embed/configs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  if (res.ok) {
    closeEmbedDeleteModal();
    await fetchEmbedConfigs();
    if (typeof showToast === 'function') showToast('Đã xóa cấu hình Embed.', 'success');
  }
}

async function copyEmbedSnippet(id) {
  const snippet = `<script src="${location.origin}/embed/knowledgehub-chat.js?v=20260912-theme" data-embed-id="${id}" data-title="Trợ lý AI" data-color="#4f46e5" data-position="right" data-theme="auto"><\/script>`;
  await copyMcpText(snippet);
  if (typeof showToast === 'function') showToast('Đã sao chép mã nhúng.', 'success');
}

function toggleApiKeyVisibility(id) {
  if (!window.visibleApiKeyIds) window.visibleApiKeyIds = new Set();
  if (window.visibleApiKeyIds.has(id)) {
    window.visibleApiKeyIds.delete(id);
  } else {
    window.visibleApiKeyIds.add(id);
  }
  renderApiKeysTable();
}

async function copyApiKey(id) {
  const keyItem = (window.apiKeysData || []).find(item => item.id === id);
  if (!keyItem?.key) return;
  try {
    await copyMcpText(keyItem.key);
    if (typeof showToast === 'function') showToast('Đã copy API Key.', 'success');
  } catch (err) {
    console.error('Không thể copy API Key:', err);
    if (typeof showToast === 'function') showToast('Không thể copy API Key.', 'error');
  }
}

function openApiKeyModal() {
  const input = document.getElementById('api-key-app-name');
  const rateInput = document.getElementById('api-key-rate-limit');
  if (input) {
    input.value = '';
  }
  if (rateInput) {
    rateInput.value = '500';
  }

  if (typeof openModal === 'function') {
    openModal('api-key-modal');
  } else {
    const modal = document.getElementById('api-key-modal');
    if (modal) {
      modal.style.display = 'flex';
      modal.classList.add('show');
    }
  }

  setTimeout(() => input?.focus(), 80);
}

function closeApiKeyModal() {
  if (typeof closeModal === 'function') {
    closeModal('api-key-modal');
  } else {
    const modal = document.getElementById('api-key-modal');
    if (modal) {
      modal.classList.remove('show');
      modal.style.display = '';
    }
  }
}

function generateNewApiKey() {
  openApiKeyModal();
}

async function submitNewApiKeyFromModal() {
  const input = document.getElementById('api-key-app-name');
  const rateInput = document.getElementById('api-key-rate-limit');
  const name = input?.value?.trim();
  const rateLimitValue = Math.max(1, Number(rateInput?.value || 500));
  const rateLimit = `${rateLimitValue.toLocaleString('en-US')} req/min`;
  if (!name) {
    input?.focus();
    if (typeof showToast === 'function') showToast('Vui lòng nhập tên ứng dụng.', 'warning');
    return;
  }

  try {
    const res = await fetch('/api/keys/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rateLimit })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    closeApiKeyModal();
    await fetchApiKeys();
    if (typeof showToast === 'function') showToast('Đã tạo API Key mới.', 'success');
  } catch (err) {
    console.error('Không thể tạo API Key:', err);
    if (typeof showToast === 'function') showToast('Không thể tạo API Key.', 'error');
  }
}

async function revokeApiKey(id) {
  if (!confirm('Thu hồi API Key này?')) return;
  try {
    const res = await fetch('/api/keys/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchApiKeys();
    if (typeof showToast === 'function') showToast('Đã thu hồi API Key.', 'info');
  } catch (err) {
    console.error('Không thể thu hồi API Key:', err);
    if (typeof showToast === 'function') showToast('Không thể thu hồi API Key.', 'error');
  }
}

window.fetchMcpServers = fetchMcpServers;
window.renderMcpServersTable = renderMcpServersTable;
window.submitNewMcpServer = submitNewMcpServer;
window.deleteMcpServer = deleteMcpServer;
window.connectMcpServer = connectMcpServer;
window.fetchApiKeys = fetchApiKeys;
window.renderApiKeysTable = renderApiKeysTable;
window.generateNewApiKey = generateNewApiKey;
window.openApiKeyModal = openApiKeyModal;
window.closeApiKeyModal = closeApiKeyModal;
window.submitNewApiKeyFromModal = submitNewApiKeyFromModal;
window.revokeApiKey = revokeApiKey;
window.toggleApiKeyVisibility = toggleApiKeyVisibility;
window.copyApiKey = copyApiKey;
window.copyApiDocCode = copyApiDocCode;
window.fetchEmbedConfigs = fetchEmbedConfigs;
window.renderEmbedConfigs = renderEmbedConfigs;
window.openEmbedConfigModal = openEmbedConfigModal;
window.closeEmbedConfigModal = closeEmbedConfigModal;
window.saveEmbedConfig = saveEmbedConfig;
window.toggleEmbedConfig = toggleEmbedConfig;
window.openEmbedDeleteModal = openEmbedDeleteModal;
window.closeEmbedDeleteModal = closeEmbedDeleteModal;
window.confirmDeleteEmbedConfig = confirmDeleteEmbedConfig;
window.copyEmbedSnippet = copyEmbedSnippet;
window.openEmbedPreview = openEmbedPreview;
