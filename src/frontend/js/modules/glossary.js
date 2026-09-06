/**
 * Business Glossary Management Module
 */

window.businessGlossaryData = [];
window.editingGlossaryTerm = null;

function escapeGlossaryHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeGlossaryItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.glossary)) return data.glossary;
  return [];
}

async function fetchGlossaryData() {
  try {
    const res = await fetch('/api/glossary');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    window.businessGlossaryData = normalizeGlossaryItems(data);
    renderGlossaryTable();
  } catch (err) {
    console.error('Lỗi nạp Business Glossary:', err);
    if (typeof showToast === 'function') showToast('Không thể nạp Business Glossary.', 'error');
  }
}

function getFilteredGlossaryItems() {
  const keyword = document.getElementById('glossary-search-input')?.value.trim().toLowerCase() || '';
  const items = window.businessGlossaryData || [];
  if (!keyword) return items;
  return items.filter(item =>
    String(item.term || '').toLowerCase().includes(keyword) ||
    String(item.fullMeaning || '').toLowerCase().includes(keyword) ||
    String(item.category || '').toLowerCase().includes(keyword)
  );
}

function renderGlossaryTable() {
  const tbody = document.getElementById('glossary-tbody');
  if (!tbody) return;

  const items = getFilteredGlossaryItems();
  if (window.paginationState?.glossary) {
    const state = window.paginationState.glossary;
    const maxPage = Math.max(1, Math.ceil(items.length / state.itemsPerPage));
    if (state.currentPage > maxPage) state.currentPage = maxPage;
  }

  if (items.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="4" class="system-logs-empty">
          <i class="fa-solid fa-book-bookmark"></i>
          <strong>Chưa có thuật ngữ phù hợp.</strong>
        </td>
      </tr>
    `;
    renderPaginationControls('glossary-pagination', 'glossary', 0, renderGlossaryTable);
    return;
  }

  const state = window.paginationState.glossary;
  const startIndex = (state.currentPage - 1) * state.itemsPerPage;
  const paginatedItems = items.slice(startIndex, startIndex + state.itemsPerPage);

  tbody.innerHTML = paginatedItems.map(item => {
    const term = escapeGlossaryHtml(item.term);
    const encodedTerm = encodeURIComponent(item.term || '');
    return `
      <tr>
        <td>
          <div class="glossary-term-cell">
            <strong>${term}</strong>
          </div>
        </td>
        <td>
          <div class="glossary-meaning">${escapeGlossaryHtml(item.fullMeaning || '-')}</div>
        </td>
        <td>
          <span class="metric-tag purple">${escapeGlossaryHtml(item.category || 'Nghiệp vụ')}</span>
        </td>
        <td>
          <div class="table-actions">
            <button class="icon-action-btn" onclick="openEditGlossaryModal('${encodedTerm}')" title="Sửa thuật ngữ">
              <i class="fa-solid fa-pen-to-square"></i>
            </button>
            <button class="icon-action-btn danger-soft" onclick="deleteGlossaryTermItem('${encodedTerm}')" title="Xóa thuật ngữ">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  renderPaginationControls('glossary-pagination', 'glossary', items.length, renderGlossaryTable);
}

function setGlossaryModalMode(mode, item = null) {
  ensureGlossaryModalMarkup();
  const title = document.getElementById('glossary-modal-title');
  const termInput = document.getElementById('glossary-term-input');
  const meaningInput = document.getElementById('glossary-meaning-input');
  const categorySelect = document.getElementById('glossary-category-select');
  const editIndex = document.getElementById('glossary-edit-index');

  window.editingGlossaryTerm = mode === 'edit' ? item?.term || null : null;
  if (editIndex) editIndex.value = window.editingGlossaryTerm || '-1';
  if (title) title.textContent = mode === 'edit' ? 'Sửa thuật ngữ nghiệp vụ' : 'Thêm thuật ngữ nghiệp vụ';
  if (termInput) termInput.value = item?.term || '';
  if (meaningInput) meaningInput.value = item?.fullMeaning || '';
  if (categorySelect) categorySelect.value = item?.category || 'Nghiệp vụ';
}

function ensureGlossaryModalMarkup() {
  const dialog = document.querySelector('#glossary-modal .copilot-modal-dialog');
  if (!dialog || dialog.dataset.glossaryReady === '1') return;
  dialog.dataset.glossaryReady = '1';
  dialog.style.maxWidth = '560px';
  dialog.style.height = 'auto';
  dialog.style.minHeight = 'unset';
  dialog.style.alignSelf = 'center';
  dialog.innerHTML = `
    <div class="copilot-modal-header">
      <div class="copilot-modal-title">
        <i class="fa-solid fa-book-bookmark" style="color:#6366f1;"></i>
        <span id="glossary-modal-title">Thêm thuật ngữ nghiệp vụ</span>
      </div>
      <button class="modal-close-btn" onclick="closeModal('glossary-modal')" title="Đóng cửa sổ">
        <i class="fa-solid fa-xmark"></i>
      </button>
    </div>
    <div class="glossary-modal-body">
      <input type="hidden" id="glossary-edit-index" value="-1">
      <div>
        <label class="form-label">Thuật ngữ / Từ viết tắt</label>
        <input type="text" id="glossary-term-input" class="form-control" placeholder="VD: NV, HD_VAT, KH_VIP, SP...">
      </div>
      <div>
        <label class="form-label">Ý nghĩa đầy đủ</label>
        <input type="text" id="glossary-meaning-input" class="form-control" placeholder="VD: Nhân viên chính thức, Hóa đơn GTGT...">
      </div>
      <div>
        <label class="form-label">Nhóm nghiệp vụ</label>
        <select id="glossary-category-select" class="form-control">
          <option value="Nghiệp vụ">Nghiệp vụ chung</option>
          <option value="Bán hàng">Bán hàng & Doanh thu</option>
          <option value="Nhân sự">Nhân sự & Tổ chức</option>
          <option value="Kinh doanh">Kinh doanh & Khách hàng</option>
          <option value="Tài chính">Tài chính & Thuế</option>
          <option value="Kho hàng">Kho hàng & Sản phẩm</option>
          <option value="Kỹ thuật">Kỹ thuật & Hệ thống</option>
        </select>
      </div>
      <div class="glossary-modal-actions">
        <button class="btn-secondary-sm" onclick="closeModal('glossary-modal')">Hủy bỏ</button>
        <button class="btn-primary" onclick="saveGlossaryTermFromModal()">
          <i class="fa-solid fa-floppy-disk"></i> Lưu thuật ngữ
        </button>
      </div>
    </div>
  `;
}

function openAddGlossaryModal() {
  setGlossaryModalMode('add');
  if (typeof openModal === 'function') openModal('glossary-modal');
  setTimeout(() => document.getElementById('glossary-term-input')?.focus(), 80);
}

function openEditGlossaryModal(encodedTerm) {
  const term = decodeURIComponent(encodedTerm);
  const item = (window.businessGlossaryData || []).find(g => g.term === term);
  if (!item) {
    if (typeof showToast === 'function') showToast('Không tìm thấy thuật ngữ cần sửa.', 'warn');
    return;
  }
  setGlossaryModalMode('edit', item);
  if (typeof openModal === 'function') openModal('glossary-modal');
  setTimeout(() => document.getElementById('glossary-meaning-input')?.focus(), 80);
}

async function saveGlossaryTermFromModal() {
  const term = document.getElementById('glossary-term-input')?.value.trim();
  const fullMeaning = document.getElementById('glossary-meaning-input')?.value.trim();
  const category = document.getElementById('glossary-category-select')?.value || 'Nghiệp vụ';
  const oldTerm = window.editingGlossaryTerm;

  if (!term || !fullMeaning) {
    if (typeof showToast === 'function') showToast('Vui lòng nhập đủ thuật ngữ và ý nghĩa đầy đủ.', 'warn');
    return;
  }

  const endpoint = oldTerm ? '/api/glossary/update' : '/api/glossary/add';
  const payload = oldTerm ? { oldTerm, term, fullMeaning, category } : { term, fullMeaning, category };

  try {
    let res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (oldTerm && res.status === 404) {
      await fetch('/api/glossary/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term: oldTerm })
      });
      res = await fetch('/api/glossary/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ term, fullMeaning, category })
      });
    }

    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.businessGlossaryData = normalizeGlossaryItems(data);
    renderGlossaryTable();
    if (typeof closeModal === 'function') closeModal('glossary-modal');
    if (typeof showToast === 'function') showToast(oldTerm ? 'Đã cập nhật thuật ngữ.' : 'Đã thêm thuật ngữ mới.', 'success');
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể lưu thuật ngữ: ${err.message}`, 'error');
  }
}

async function deleteGlossaryTermItem(encodedTerm) {
  const term = decodeURIComponent(encodedTerm);
  if (!confirm(`Bạn có chắc muốn xóa thuật ngữ "${term}"?`)) return;
  try {
    const res = await fetch('/api/glossary/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.businessGlossaryData = normalizeGlossaryItems(data);
    renderGlossaryTable();
    if (typeof showToast === 'function') showToast(`Đã xóa thuật ngữ "${term}".`, 'info');
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Lỗi xóa thuật ngữ: ${err.message}`, 'error');
  }
}

window.fetchGlossaryData = fetchGlossaryData;
window.renderGlossaryTable = renderGlossaryTable;
window.ensureGlossaryModalMarkup = ensureGlossaryModalMarkup;
window.openAddGlossaryModal = openAddGlossaryModal;
window.openEditGlossaryModal = openEditGlossaryModal;
window.saveGlossaryTermFromModal = saveGlossaryTermFromModal;
window.deleteGlossaryTermItem = deleteGlossaryTermItem;
