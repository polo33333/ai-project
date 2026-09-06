/**
 * System Logs & Audit Trails Module
 */

window.systemLogsData = [];

async function fetchLogs() {
  try {
    const res = await fetch('/api/logs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.systemLogsData = await res.json();
    renderLogsTable();
  } catch (err) {
    console.error("Lỗi nạp System Logs:", err);
  }
}

async function clearSystemLogs() {
  if (!confirm('Xóa toàn bộ nhật ký hệ thống?')) return;
  try {
    const res = await fetch('/api/logs/clear', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await fetchLogs();
    if (typeof showToast === 'function') showToast('Đã xóa nhật ký hệ thống.', 'success');
  } catch (err) {
    console.error('Lỗi xóa System Logs:', err);
    if (typeof showToast === 'function') showToast('Không thể xóa nhật ký hệ thống.', 'error');
  }
}

function escapeLogHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseLogDetails(details) {
  if (!details) return null;
  if (typeof details === 'object') return details;
  try {
    return JSON.parse(String(details));
  } catch (_) {
    return { details: String(details) };
  }
}

function buildLogJson(log, message) {
  const details = parseLogDetails(log.details);
  const payload = details || {
    message,
    module: log.module || log.component || 'System',
    level: log.level || log.type || 'INFO'
  };
  return JSON.stringify(payload, null, 2);
}

function highlightLogJson(json) {
  return escapeLogHtml(json).replace(/(&quot;(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\&])*&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (match, quoted, colon, literal, number) => {
    if (quoted) return `<span class="json-token ${colon ? 'json-key' : 'json-string'}">${quoted}</span>${colon || ''}`;
    if (literal) return `<span class="json-token json-literal">${literal}</span>`;
    return `<span class="json-token json-number">${number}</span>`;
  });
}

function getLogMeta(log) {
  const level = String(log.level || log.type || 'INFO').toUpperCase();
  if (level === 'ERROR') return { level, cls: 'red', icon: 'fa-circle-xmark' };
  if (level === 'WARN' || level === 'WARNING') return { level: 'WARN', cls: 'yellow', icon: 'fa-triangle-exclamation' };
  if (level === 'SUCCESS') return { level, cls: 'green', icon: 'fa-circle-check' };
  return { level: 'INFO', cls: 'purple', icon: 'fa-circle-info' };
}

function renderLogStats(logs) {
  const totalEl = document.getElementById('log-stat-total');
  const successEl = document.getElementById('log-stat-success');
  const warnEl = document.getElementById('log-stat-warn');
  const errorEl = document.getElementById('log-stat-error');
  const total = logs.length;
  const errors = logs.filter(log => getLogMeta(log).level === 'ERROR').length;
  const warns = logs.filter(log => getLogMeta(log).level === 'WARN').length;
  const success = total - errors - warns;

  if (totalEl) totalEl.textContent = total;
  if (successEl) successEl.textContent = success;
  if (warnEl) warnEl.textContent = warns;
  if (errorEl) errorEl.textContent = errors;
}

function renderDashboardLogs(logs = window.systemLogsData || []) {
  const totalEl = document.getElementById('dash-log-total');
  const successEl = document.getElementById('dash-log-success');
  const warnEl = document.getElementById('dash-log-warn');
  const errorEl = document.getElementById('dash-log-error');
  const total = logs.length;
  const errors = logs.filter(log => getLogMeta(log).level === 'ERROR').length;
  const warns = logs.filter(log => getLogMeta(log).level === 'WARN').length;
  const success = total - errors - warns;

  if (totalEl) totalEl.textContent = total;
  if (successEl) successEl.textContent = success;
  if (warnEl) warnEl.textContent = warns;
  if (errorEl) errorEl.textContent = errors;
}

async function fetchDashboardLogs() {
  try {
    const res = await fetch('/api/logs');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.systemLogsData = await res.json();
    renderDashboardLogs(window.systemLogsData);
  } catch (err) {
    console.error('Lỗi nạp Dashboard Logs:', err);
  }
}

function renderLogsTable() {
  const tbody = document.getElementById('system-logs-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const logs = window.systemLogsData || [];
  renderLogStats(logs);

  if (logs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="system-logs-empty">
          <i class="fa-solid fa-list-check"></i>
          <strong>Chưa có nhật ký hoạt động nào.</strong>
        </td>
      </tr>
    `;
    if (typeof renderPaginationControls === 'function') {
      renderPaginationControls('logs-pagination', 'system_logs', 0, renderLogsTable);
    }
    return;
  }

  const state = (window.paginationState && window.paginationState.system_logs) || { currentPage: 1, itemsPerPage: 10 };
  const startIndex = (state.currentPage - 1) * state.itemsPerPage;
  const paginated = logs.slice(startIndex, startIndex + state.itemsPerPage);

  paginated.forEach(log => {
    const meta = getLogMeta(log);
    const moduleName = log.module || log.component || 'System';
    const message = log.message || log.text || '';
    const detailsJson = buildLogJson(log, message);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="log-time">${escapeLogHtml(log.timestamp || '-')}</td>
      <td>
        <span class="metric-tag ${meta.cls} log-level-tag">
          <i class="fa-solid ${meta.icon}"></i>
          ${escapeLogHtml(meta.level)}
        </span>
      </td>
      <td><div class="log-module">${escapeLogHtml(moduleName)}</div></td>
      <td>
        <div class="json-code-viewer log-json-viewer">
          <pre class="json-audit-block"><code>${highlightLogJson(detailsJson)}</code></pre>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (typeof renderPaginationControls === 'function') {
    renderPaginationControls('logs-pagination', 'system_logs', logs.length, renderLogsTable);
  }
}

window.fetchLogs = fetchLogs;
window.fetchSystemLogs = fetchLogs;
window.clearSystemLogs = clearSystemLogs;
window.renderLogsTable = renderLogsTable;
window.renderDashboardLogs = renderDashboardLogs;
window.fetchDashboardLogs = fetchDashboardLogs;
