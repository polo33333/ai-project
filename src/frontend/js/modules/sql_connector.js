/**
 * SQL Server Direct Live Connection Module
 */

window.dbSourcesData = [];
window.editingDbSourceId = null;

function escapeDbSourceHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchDbSources() {
  try {
    const res = await fetch('/api/sql/sources');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.dbSourcesData = await res.json();
    renderDbSourcesTable();
    updateDashboardSqlMetrics();
  } catch (err) {
    console.error("Lỗi nạp DB Sources:", err);
  }
}

function updateDashboardSqlMetrics() {
  const sources = window.dbSourcesData || [];
  const valConnectors = document.getElementById('val-connectors');
  const valTables = document.getElementById('val-tables');

  if (valConnectors) valConnectors.textContent = String(sources.length).padStart(2, '0');
  if (valTables) {
    const totalTables = sources.reduce((acc, s) => acc + Number(s.tablesCount || 0), 0);
    valTables.textContent = totalTables;
  }
}

function renderDbSourcesTable() {
  const tbody = document.getElementById('page-db-sources-tbody') || document.getElementById('db-sources-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const sources = window.dbSourcesData || [];

  if (sources.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 30px; color: var(--text-muted);">
          <i class="fa-solid fa-plug" style="font-size: 24px; color: #cbd5e1; margin-bottom: 8px; display: block;"></i>
          <strong>Chưa có Nguồn Database SQL Server nào được nạp.</strong>
        </td>
      </tr>
    `;
    return;
  }

  sources.forEach((src) => {
    const sourceId = escapeDbSourceHtml(src.id);
    const isDefault = !!src.isDefault;
    const tr = document.createElement('tr');
    if (isDefault) tr.classList.add('db-source-default');
    tr.style.borderBottom = '1px solid #f1f5f9';
    tr.innerHTML = `
      <td style="vertical-align: middle; padding: 14px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%); color: #ffffff; width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0;">
            <i class="fa-solid fa-database"></i>
          </span>
          <div>
            <strong style="color: var(--text-primary); font-size: 14px;">${escapeDbSourceHtml(src.dbName)}</strong>
            ${isDefault ? '<span class="metric-tag green" style="margin-left: 6px; font-size: 10px;"><i class="fa-solid fa-star"></i> Mặc định</span>' : ''}
            <div style="font-size: 11px; color: var(--text-muted);">User: ${escapeDbSourceHtml(src.user || '-')}</div>
          </div>
        </div>
      </td>
      <td style="vertical-align: middle; padding: 14px;">
        <span class="metric-tag purple" style="font-size: 11px;"><i class="fa-solid fa-network-wired" style="margin-right: 4px;"></i> ${escapeDbSourceHtml(src.type || 'Direct Live Connection')}</span>
      </td>
      <td style="vertical-align: middle; padding: 14px;">
        <code style="background: #eff6ff; color: #1e40af; padding: 4px 8px; border-radius: 6px; font-size: 12px; font-weight: 700; font-family: monospace;">${escapeDbSourceHtml(src.host || '-')}</code>
      </td>
      <td style="vertical-align: middle; padding: 14px;">
        <strong style="font-size: 13px; color: var(--text-primary);">${Number(src.tablesCount || 0)} Bảng Schema</strong>
        <div style="font-size: 11px; color: var(--text-muted);">${Number(src.columnsCount || 0)} Cột thuộc tính</div>
      </td>
      <td style="vertical-align: middle; padding: 14px;">
        <span class="metric-tag green" style="font-size: 11.5px;">
          <i class="fa-solid fa-circle-check"></i> ${escapeDbSourceHtml(src.status || 'Live Read-Only')}
        </span>
      </td>
      <td style="vertical-align: middle; padding: 14px; font-size: 12px; color: var(--text-muted);">
        ${escapeDbSourceHtml(src.lastSync || 'Vừa xong')}
      </td>
      <td style="vertical-align: middle; padding: 14px; text-align: right;">
        <div style="display: flex; gap: 6px; justify-content: flex-end; white-space: nowrap;">
          <button class="btn-primary" style="padding: 5px 12px; font-size: 11.5px; white-space: nowrap;" onclick="switchMainTab('dictionary')"><i class="fa-solid fa-book-atlas"></i> Dict</button>
          ${isDefault ? '' : `<button class="btn-secondary-sm" style="padding: 5px 10px; font-size: 11.5px; white-space: nowrap;" onclick="setDefaultDbSource('${sourceId}')" title="Đặt làm nguồn được AI sử dụng mặc định"><i class="fa-solid fa-star"></i> Mặc định</button>`}
          <button class="icon-action-btn" onclick="editDbSource('${sourceId}')" title="Chỉnh sửa kết nối"><i class="fa-solid fa-pen"></i></button>
          <button class="btn-secondary-sm" style="padding: 5px 10px; font-size: 11.5px; white-space: nowrap;" onclick="testDbConnection('${sourceId}')"><i class="fa-solid fa-bolt"></i> Ping</button>
          <button class="icon-action-btn danger-soft" onclick="deleteDbSource('${sourceId}')" title="Xóa nguồn CSDL">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function setDefaultDbSource(id) {
  try {
    const res = await fetch('/api/sql/set-default-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    await fetchDbSources();
    if (typeof showToast === 'function') showToast('Đã đặt nguồn CSDL mặc định.', 'success');
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể đặt nguồn mặc định: ${err.message}`, 'error');
  }
}

function editDbSource(id) {
  const source = (window.dbSourcesData || []).find(item => String(item.id) === String(id));
  if (!source) return;
  window.editingDbSourceId = source.id;
  const values = {
    'page-live-host': source.host || '',
    'page-live-dbname': source.dbName || '',
    'page-live-user': source.user || '',
    'page-live-pass': ''
  };
  Object.entries(values).forEach(([fieldId, value]) => {
    const field = document.getElementById(fieldId);
    if (field) field.value = value;
  });
  const password = document.getElementById('page-live-pass');
  if (password) password.placeholder = 'Để trống để giữ nguyên mật khẩu';
  const label = document.getElementById('page-live-submit-label');
  if (label) label.textContent = 'Cập nhật & nạp lại lược đồ';
  const cancel = document.getElementById('page-live-cancel-edit');
  if (cancel) cancel.style.display = '';
  document.querySelector('.sql-ingest-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEditDbSource() {
  window.editingDbSourceId = null;
  document.getElementById('page-live-source-form')?.reset();
  const password = document.getElementById('page-live-pass');
  if (password) password.placeholder = '••••••••';
  const label = document.getElementById('page-live-submit-label');
  if (label) label.textContent = 'Kết nối & nạp lược đồ';
  const cancel = document.getElementById('page-live-cancel-edit');
  if (cancel) cancel.style.display = 'none';
}

function testDbConnection(id) {
  const source = (window.dbSourcesData || []).find(item => item.id === id);
  showToast(`Chưa có API kiểm tra kết nối cho ${source?.dbName || 'nguồn dữ liệu này'}.`, 'warn');
}

async function deleteDbSource(id) {
  if (!confirm('Xóa nguồn CSDL này khỏi danh sách?')) return;
  try {
    const res = await fetch('/api/sql/delete-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    await fetchDbSources();
    if (typeof showToast === 'function') showToast('Đã xóa nguồn CSDL.', 'success');
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể xóa nguồn CSDL: ${err.message}`, 'error');
  }
}

async function submitPageSchemaIngestion() {
  const editingId = window.editingDbSourceId;
  const config = {
    host: document.getElementById('page-live-host')?.value.trim(),
    dbName: document.getElementById('page-live-dbname')?.value.trim(),
    user: document.getElementById('page-live-user')?.value.trim(),
    password: document.getElementById('page-live-pass')?.value || '',
    port: 1433,
    sourceId: editingId || undefined
  };
  if (!config.host || !config.dbName || !config.user || (!editingId && !config.password)) {
    if (typeof showToast === 'function') showToast('Vui lòng nhập đầy đủ Host, Database, tài khoản và mật khẩu.', 'warn', 'Thiếu thông tin kết nối');
    return;
  }
  const button = document.querySelector('.sql-ingest-submit');
  if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang kết nối...'; }
  try {
    if (typeof showToast === 'function') showToast(`Đang kết nối tới ${config.host}/${config.dbName}.`, 'info', 'Kết nối SQL Server');
    const res = await fetch('/api/sql/add-live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    cancelEditDbSource();
    await fetchDbSources();
    if (typeof fetchDataDictionary === 'function') await fetchDataDictionary();
    if (typeof showToast === 'function') showToast(`Đã nạp ${data.tablesCount || 0} bảng từ ${config.dbName}.`, 'success', 'Kết nối thành công');
  } catch (err) {
    if (typeof showToast === 'function') showToast(err.message, 'error', 'Không thể kết nối SQL Server');
  } finally {
    if (button) {
      button.disabled = false;
      button.innerHTML = `<i class="fa-solid fa-plug-circle-check"></i> <span id="page-live-submit-label">${window.editingDbSourceId ? 'Cập nhật & nạp lại lược đồ' : 'Kết nối & nạp lược đồ'}</span>`;
    }
  }
}

// Auto init when loaded
window.fetchDbSources = fetchDbSources;
window.renderDbSourcesTable = renderDbSourcesTable;
window.submitPageSchemaIngestion = submitPageSchemaIngestion;
window.testDbConnection = testDbConnection;
window.deleteDbSource = deleteDbSource;
window.setDefaultDbSource = setDefaultDbSource;
window.editDbSource = editDbSource;
window.cancelEditDbSource = cancelEditDbSource;

document.addEventListener('DOMContentLoaded', () => {
  fetchDbSources();
});
