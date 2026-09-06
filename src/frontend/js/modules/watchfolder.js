window.watchFoldersData = [];
window.watchFolderLogs = [];

function escapeWatchFolderHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function fetchWatchFolderData() {
  const tbody = document.getElementById('watchfolder-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="watchfolder-state-cell"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải dữ liệu...</td></tr>';
  try {
    const [foldersResponse, logsResponse] = await Promise.all([
      fetch('/api/watchfolder'),
      fetch('/api/watchfolder/logs')
    ]);
    const folders = await foldersResponse.json();
    const logs = await logsResponse.json();
    if (!foldersResponse.ok) throw new Error(folders.message || `HTTP ${foldersResponse.status}`);
    if (!logsResponse.ok) throw new Error(logs.message || `HTTP ${logsResponse.status}`);
    window.watchFoldersData = Array.isArray(folders) ? folders : [];
    window.watchFolderLogs = Array.isArray(logs) ? logs : [];
    renderWatchFolders();
    renderWatchFolderLogs();
  } catch (error) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="watchfolder-state-cell error"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeWatchFolderHtml(error.message)}</td></tr>`;
    if (typeof showToast === 'function') showToast('Không thể tải cấu hình Watch Folder.', 'error');
  }
}

function renderWatchFolders() {
  const tbody = document.getElementById('watchfolder-tbody');
  if (!tbody) return;
  if (!window.watchFoldersData.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="watchfolder-state-cell"><i class="fa-regular fa-folder-open"></i> Chưa có thư mục giám sát.</td></tr>';
  } else {
    tbody.innerHTML = window.watchFoldersData.map(folder => {
      const active = folder.status === 'Active' && folder.runtimeStatus === 'Watching';
      const filters = Array.isArray(folder.filters) ? folder.filters : [];
      return `<tr>
        <td><div class="watchfolder-path"><i class="fa-solid fa-folder-tree"></i><code title="${escapeWatchFolderHtml(folder.path)}">${escapeWatchFolderHtml(folder.path)}</code></div></td>
        <td><div class="watchfolder-filter-list">${filters.map(filter => `<span>${escapeWatchFolderHtml(filter)}</span>`).join('') || '<span>—</span>'}</div></td>
        <td><strong>${Number(folder.scannedFiles || 0).toLocaleString('vi-VN')}</strong> tệp</td>
        <td><span class="watchfolder-status ${active ? 'active' : 'paused'}" title="${escapeWatchFolderHtml(folder.error || '')}"><i class="fa-solid ${active ? 'fa-circle-play' : folder.runtimeStatus === 'Error' ? 'fa-circle-exclamation' : 'fa-circle-pause'}"></i> ${active ? 'Đang theo dõi' : folder.runtimeStatus === 'Error' ? 'Lỗi watcher' : 'Tạm dừng'}</span></td>
        <td>${escapeWatchFolderHtml(folder.lastScan || 'Chưa quét')}</td>
        <td><div class="library-row-actions"><button class="library-action-btn" title="${active ? 'Tạm dừng' : 'Tiếp tục'}" onclick="toggleWatchFolder('${escapeWatchFolderHtml(folder.id)}')"><i class="fa-solid ${active ? 'fa-pause' : 'fa-play'}"></i></button><button class="library-action-btn danger" title="Xóa" onclick="deleteWatchFolder('${escapeWatchFolderHtml(folder.id)}')"><i class="fa-solid fa-trash"></i></button></div></td>
      </tr>`;
    }).join('');
  }
  updateWatchFolderStats();
}

function renderWatchFolderLogs() {
  const tbody = document.getElementById('watchfolder-logs-tbody');
  if (!tbody) return;
  if (!window.watchFolderLogs.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="watchfolder-state-cell"><i class="fa-solid fa-clock-rotate-left"></i> Chưa có sự kiện filesystem.</td></tr>';
    if (typeof renderPaginationControls === 'function') renderPaginationControls('watchfolder-logs-pagination', 'watchfolder_logs', 0, renderWatchFolderLogs);
    return;
  }
  const state = window.paginationState?.watchfolder_logs || { currentPage: 1, itemsPerPage: 10 };
  const totalPages = Math.max(1, Math.ceil(window.watchFolderLogs.length / state.itemsPerPage));
  state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
  const start = (state.currentPage - 1) * state.itemsPerPage;
  const page = window.watchFolderLogs.slice(start, start + state.itemsPerPage);
  tbody.innerHTML = page.map(log => `<tr>
    <td><strong>${escapeWatchFolderHtml(log.fileName || '-')}</strong></td>
    <td><code>${escapeWatchFolderHtml(log.folderPath || '-')}</code></td>
    <td><span class="watchfolder-event" title="${escapeWatchFolderHtml(log.error || '')}">${escapeWatchFolderHtml(log.event || '-')}</span>${log.error ? `<small class="chat-error-text">${escapeWatchFolderHtml(log.error)}</small>` : ''}</td>
    <td>${Number(log.vectorsIndexed || 0).toLocaleString('vi-VN')} vectors</td>
    <td>${escapeWatchFolderHtml(log.timestamp || '-')}</td>
  </tr>`).join('');
  if (typeof renderPaginationControls === 'function') renderPaginationControls('watchfolder-logs-pagination', 'watchfolder_logs', window.watchFolderLogs.length, renderWatchFolderLogs);
}

function updateWatchFolderStats() {
  const folders = window.watchFoldersData;
  const active = folders.filter(folder => folder.status === 'Active' && folder.runtimeStatus === 'Watching').length;
  const scanned = folders.reduce((sum, folder) => sum + Number(folder.scannedFiles || 0), 0);
  const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  setText('wf-stat-folders', `${folders.length} Folder`);
  setText('wf-stat-active', `${active} watcher active`);
  setText('wf-stat-scanned', `${scanned.toLocaleString('vi-VN')} Tệp`);
  const status = document.getElementById('wf-stat-status');
  if (status) status.innerHTML = active ? '<i class="fa-solid fa-circle-check"></i> Đang hoạt động' : '<i class="fa-solid fa-circle-pause"></i> Chưa kích hoạt';
}

function openAddWatchFolderModal() {
  document.getElementById('watchfolder-add-form')?.reset();
  if (typeof openModal === 'function') openModal('watchfolder-add-modal');
  setTimeout(() => document.getElementById('watchfolder-path-input')?.focus(), 50);
}

function closeWatchFolderModal() {
  if (typeof closeModal === 'function') closeModal('watchfolder-add-modal');
}

function handleWatchFolderModalBackdrop(event) {
  if (event.target?.id === 'watchfolder-add-modal') closeWatchFolderModal();
}

async function submitWatchFolder(event) {
  event.preventDefault();
  const folderPath = document.getElementById('watchfolder-path-input')?.value.trim();
  const filters = Array.from(document.querySelectorAll('input[name="watchfolder-filter"]:checked')).map(input => input.value);
  if (!folderPath) return;
  if (!filters.length) {
    if (typeof showToast === 'function') showToast('Hãy chọn ít nhất một định dạng tệp.', 'warn');
    return;
  }
  const button = document.getElementById('watchfolder-submit-btn');
  if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...'; }
  try {
    const response = await fetch('/api/watchfolder/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: folderPath, filters }) });
    const data = await response.json();
    if (!response.ok || data.status === 'error') throw new Error(data.message || `HTTP ${response.status}`);
    window.watchFoldersData = data.folders || [];
    closeWatchFolderModal();
    renderWatchFolders();
    if (typeof showToast === 'function') showToast('Đã lưu cấu hình thư mục giám sát.', 'success');
  } catch (error) {
    if (typeof showToast === 'function') showToast(`Không thể thêm thư mục: ${error.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Lưu cấu hình'; }
  }
}

async function mutateWatchFolder(endpoint, id) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  const data = await response.json();
  if (!response.ok || data.status === 'error') throw new Error(data.message || `HTTP ${response.status}`);
  window.watchFoldersData = data.folders || [];
  renderWatchFolders();
}

async function toggleWatchFolder(id) {
  try {
    await mutateWatchFolder('/api/watchfolder/toggle', id);
    if (typeof showToast === 'function') showToast('Đã cập nhật trạng thái watcher.', 'success');
  } catch (error) {
    if (typeof showToast === 'function') showToast(`Không thể đổi trạng thái: ${error.message}`, 'error');
  }
}

async function deleteWatchFolder(id) {
  const folder = window.watchFoldersData.find(item => item.id === id);
  if (!folder || !confirm(`Xóa cấu hình giám sát "${folder.path}"?`)) return;
  try {
    await mutateWatchFolder('/api/watchfolder/delete', id);
    if (typeof showToast === 'function') showToast('Đã xóa thư mục giám sát.', 'info');
  } catch (error) {
    if (typeof showToast === 'function') showToast(`Không thể xóa thư mục: ${error.message}`, 'error');
  }
}

Object.assign(window, { fetchWatchFolderData, renderWatchFolders, renderWatchFolderLogs, openAddWatchFolderModal, closeWatchFolderModal, handleWatchFolderModalBackdrop, submitWatchFolder, toggleWatchFolder, deleteWatchFolder });

setInterval(() => {
  const view = document.getElementById('view-watchfolder');
  if (view && view.style.display !== 'none' && !document.hidden) fetchWatchFolderData();
}, 5000);
