/**
 * Database Schema & Table Relationship Module
 */

window.groupedTablesData = [];
window.dictActiveFilter = 'all';
window.selectedDictionaryTableName = null;
window.selectedDictionaryTableId = null;
window.tableRelationshipsData = [];
window.relationshipNodePositions = {};
window.relationshipDragState = null;
window.relationshipConnectState = null;
window.relationshipDiagramTables = [];
window.editingTableRelationshipId = null;
window.relationshipLineStyles = {};
window.relationshipLineDragState = null;
window.relationshipCanvasPanState = null;
window.relationshipCanvasZoom = 1;
window.businessDomainsData = {};

function loadRelationshipDiagramState() {
  try {
    const saved = JSON.parse(localStorage.getItem('knowledgehub.relationshipDiagram') || '{}');
    window.relationshipDiagramTables = Array.isArray(saved.tables) ? saved.tables : [];
    window.relationshipNodePositions = saved.positions && typeof saved.positions === 'object' ? saved.positions : {};
    window.relationshipLineStyles = saved.lineStyles && typeof saved.lineStyles === 'object' ? saved.lineStyles : {};
  } catch {
    window.relationshipDiagramTables = [];
    window.relationshipNodePositions = {};
    window.relationshipLineStyles = {};
  }
}

function saveRelationshipDiagramState() {
  try {
    localStorage.setItem('knowledgehub.relationshipDiagram', JSON.stringify({
      tables: window.relationshipDiagramTables,
      positions: window.relationshipNodePositions,
      lineStyles: window.relationshipLineStyles
    }));
  } catch {
    // Diagram persistence is optional when browser storage is unavailable.
  }
}

function escapeDictHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDictionaryTables() {
  return window.groupedTablesData || [];
}

function findDictionaryTable(tableNameOrId) {
  return getDictionaryTables().find(t => t.tableId === tableNameOrId) || getDictionaryTables().find(t => t.tableName === tableNameOrId);
}

async function fetchDataDictionary() {
  try {
    const [res, domainsRes, relationshipsRes] = await Promise.all([
      fetch('/api/dictionary'),
      fetch('/api/dictionary/domains'),
      fetch('/api/dictionary/relationships')
    ]);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (domainsRes.ok) window.businessDomainsData = await domainsRes.json();
    if (relationshipsRes.ok) window.tableRelationshipsData = await relationshipsRes.json();
    window.groupedTablesData = Array.isArray(data) ? data : (data.tables || []);
    renderDictionaryDomainOptions();
    renderDataDictionary();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
  } catch (err) {
    console.error('Lỗi nạp Lược đồ CSDL:', err);
    if (typeof showToast === 'function') showToast('Không thể nạp Lược đồ CSDL.', 'error');
  }
}

function renderDictionaryDomainOptions(selectedValue) {
  const select = document.getElementById('dict-drawer-table-domain');
  if (!select) return;
  const current = selectedValue !== undefined ? selectedValue : select.value;
  const keys = Object.keys(window.businessDomainsData || {}).sort((a, b) => a.localeCompare(b));
  if (current && !keys.includes(current)) keys.push(current);
  select.innerHTML = '<option value="">Chưa gán nhóm nghiệp vụ</option>' + keys
    .map(key => `<option value="${escapeDictHtml(key)}">${escapeDictHtml(key)}</option>`).join('');
  select.value = current || '';
}

function getFilteredDictionaryTables() {
  const keyword = document.getElementById('dict-search-input')?.value.trim().toLowerCase() || '';
  let tables = getDictionaryTables();
  if (window.dictActiveFilter === 'active') tables = tables.filter(t => t.isActive);
  if (window.dictActiveFilter === 'inactive') tables = tables.filter(t => !t.isActive);
  if (!keyword) return tables;
  return tables.filter(table =>
    String(table.tableName || '').toLowerCase().includes(keyword) ||
    String(table.tableDescription || '').toLowerCase().includes(keyword) ||
    (table.columns || []).some(col =>
      String(col.columnName || '').toLowerCase().includes(keyword) ||
      String(col.description || '').toLowerCase().includes(keyword)
    )
  );
}

function renderDictionaryOverview() {
  const activeTables = getDictionaryTables().filter(table => table.isActive);
  const domains = [...new Set(activeTables.map(table => table.domain).filter(Boolean))];
  const counts = {
    'dict-stat-active': activeTables.length,
    'dict-stat-domains': domains.length,
    'dict-stat-unassigned': activeTables.filter(table => !table.domain).length
  };
  Object.entries(counts).forEach(([id, count]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = count;
  });
  return { activeTables, domains };
}

function renderDataDictionary() {
  renderDictionaryOverview();
  const container = document.getElementById('dictionary-tables-accordion');
  if (!container) return;

  const tables = getFilteredDictionaryTables();
  const counterEl = document.getElementById('dict-tables-counter');
  if (counterEl) {
    const totalCols = tables.reduce((acc, t) => acc + (t.columns?.length || 0), 0);
    counterEl.innerHTML = `Tổng số: <strong>${tables.length} bảng</strong> (${totalCols} cột)`;
  }

  const state = window.paginationState.dictionary;
  const paginationChanged = container.dataset.currentPage !== String(state.currentPage)
    || container.dataset.itemsPerPage !== String(state.itemsPerPage);
  const maxPage = Math.max(1, Math.ceil(tables.length / state.itemsPerPage));
  if (state.currentPage > maxPage) state.currentPage = maxPage;
  container.dataset.currentPage = String(state.currentPage);
  container.dataset.itemsPerPage = String(state.itemsPerPage);
  if (paginationChanged) container.scrollTop = 0;

  if (tables.length === 0) {
    container.innerHTML = `
      <div class="dictionary-empty">
        <i class="fa-solid fa-book-atlas"></i>
        <strong>Không có bảng dữ liệu phù hợp.</strong>
      </div>
    `;
    renderPaginationControls('dict-pagination', 'dictionary', 0, renderDataDictionary);
    return;
  }

  const startIndex = (state.currentPage - 1) * state.itemsPerPage;
  const paginatedTables = tables.slice(startIndex, startIndex + state.itemsPerPage);

  container.innerHTML = paginatedTables.map(table => {
    const cols = table.columns || [];
    const isActive = !!table.isActive;
    const encodedName = encodeURIComponent(table.tableName || '');
    const encodedId = encodeURIComponent(table.tableId || table.tableName || '');
    return `
      <div class="dictionary-table-row ${isActive ? 'is-active' : 'is-inactive'}">
        <label class="quick-active-checkbox dictionary-quick-active" title="Bật/tắt nhanh cho AI" onclick="event.stopPropagation()">
          <input type="checkbox" ${isActive ? 'checked' : ''} onchange="toggleDictionaryTableActiveFromList('${encodedName}', this)">
          <span><i class="fa-solid fa-check"></i></span>
        </label>
        <div class="dictionary-row-main" onclick="openDictionaryDrawer('${encodedId}')" role="button" tabindex="0">
         
          <div>
            <strong>${escapeDictHtml(table.tableName)}</strong>
            <p>${escapeDictHtml(table.tableDescription || `Bảng dữ liệu ${table.tableName}`)}</p>
          </div>
        </div>
        <div class="dictionary-row-meta" onclick="openDictionaryDrawer('${encodedId}')" role="button">
          <span>${cols.length} cột thuộc tính</span>
          ${table.domain ? `<span class="metric-tag">${escapeDictHtml(table.domain)}</span>` : ''}
          <span class="metric-tag ${isActive ? 'green' : 'orange'}">${isActive ? 'Active cho AI' : 'Tắt'}</span>
          <i class="fa-solid fa-chevron-right"></i>
        </div>
      </div>
    `;
  }).join('');

  renderPaginationControls('dict-pagination', 'dictionary', tables.length, renderDataDictionary);
}

function renderDictionaryDrawer(table) {
  const nameEl = document.getElementById('dict-drawer-table-name');
  const metaEl = document.getElementById('dict-drawer-table-meta');
  const descEl = document.getElementById('dict-drawer-table-description');
  const domainEl = document.getElementById('dict-drawer-table-domain');
  const metricEl = document.getElementById('dict-drawer-default-metric');
  const timeEl = document.getElementById('dict-drawer-default-time');
  const aggregationEl = document.getElementById('dict-drawer-default-aggregation');
  const activeEl = document.getElementById('dict-drawer-active-toggle');
  const countEl = document.getElementById('dict-drawer-columns-count');
  const columnsEl = document.getElementById('dict-drawer-columns');
  if (!table || !columnsEl) return;

  const cols = table.columns || [];
  if (nameEl) nameEl.textContent = table.tableName || '-';
  if (metaEl) metaEl.textContent = `${table.dbName || 'SQLServer_DB'} • ${cols.length} cột thuộc tính`;
  if (descEl) descEl.value = table.tableDescription || '';
  renderDictionaryDomainOptions(table.domain || '');
  const numericType = /^(?:tinyint|smallint|int|bigint|decimal|numeric|float|real|money|smallmoney)$/i;
  if (metricEl) metricEl.innerHTML = '<option value="">Tự động nhận diện</option>' + cols.filter(col => numericType.test(col.dataType) && !/id$/i.test(col.columnName)).map(col => `<option value="${escapeDictHtml(col.columnName)}">${escapeDictHtml(col.columnName)}</option>`).join('');
  if (timeEl) timeEl.innerHTML = '<option value="">Tự động nhận diện</option>' + cols.filter(col => /date|time/i.test(col.dataType)).map(col => `<option value="${escapeDictHtml(col.columnName)}">${escapeDictHtml(col.columnName)}</option>`).join('');
  if (metricEl) metricEl.value = table.defaultMetric || '';
  if (timeEl) timeEl.value = table.defaultTimeColumn || '';
  if (aggregationEl) aggregationEl.value = table.defaultAggregation || 'SUM';
  if (activeEl) activeEl.checked = !!table.isActive;
  if (countEl) countEl.textContent = `${cols.length} cột thuộc tính`;

  columnsEl.innerHTML = cols.map(col => {
    const encodedCol = encodeURIComponent(col.columnName || '');
    const relationships = (window.tableRelationshipsData || []).filter(relation =>
      (relation.sourceTableId ? relation.sourceTableId === table.tableId : relation.sourceTable === table.tableName)
      && (relation.columnPairs || [{ sourceColumn: relation.sourceColumn }]).some(pair => pair.sourceColumn === col.columnName));
    const mappedRelationship = relationships.find(relation => relation.status !== 'rejected' && relation.businessRole && relation.displayColumn);
    return `
      <div class="dictionary-column-card">
        <div class="dictionary-column-meta">
          <div>
            <strong>${escapeDictHtml(col.columnName)}</strong>
            <div>
              <code>${escapeDictHtml(col.dataType || '-')}</code>
              ${col.isPrimaryKey ? '<span class="metric-tag green">PK</span>' : ''}
            </div>
          </div>
        </div>
        <div class="dictionary-column-fields">
          <label><span>Tên hiển thị</span>${mappedRelationship
            ? `<div class="dictionary-column-derived-name" title="Header được lấy từ vai trò của quan hệ"><i class="fa-solid fa-link"></i><strong>${escapeDictHtml(mappedRelationship.businessRole)}</strong><small>Từ quan hệ</small></div>`
            : `<input class="form-control dictionary-column-display-name" data-column="${escapeDictHtml(col.columnName)}" value="${escapeDictHtml(col.displayName || '')}" placeholder="VD: Số HĐ">`}</label>
          <label><span>Mô tả cho AI</span><textarea class="form-control dictionary-column-description" data-column="${escapeDictHtml(col.columnName)}" rows="1" placeholder="Ý nghĩa nghiệp vụ của cột...">${escapeDictHtml(col.description || col.columnDescription || '')}</textarea></label>
        </div>
        <button class="icon-action-btn" onclick="saveDictionaryColumnDescription('${encodedCol}')" title="Lưu mô tả cột">
          <i class="fa-solid fa-floppy-disk"></i>
        </button>
        <div class="dictionary-field-relations">
          <button class="dictionary-relation-toggle" type="button" onclick="toggleFieldRelationshipEditor('${encodedCol}', this)">
            <i class="fa-solid fa-link"></i> Quan hệ <span>${relationships.length}</span>
          </button>
          <div class="dictionary-field-relation-list">
            ${relationships.map(relation => `<div class="dictionary-field-relation-chip">
              <div class="dictionary-relation-chip-info">
                <span class="dictionary-relation-path">${escapeDictHtml((relation.columnPairs || [{ sourceColumn: relation.sourceColumn, targetColumn: relation.targetColumn }]).map(pair => `${pair.sourceColumn} → ${pair.targetColumn}`).join(', '))} <strong>${escapeDictHtml(relation.targetTable)}</strong></span>
                ${relation.displayColumn ? `<span class="dictionary-relation-display"><i class="fa-regular fa-eye"></i>${escapeDictHtml(relation.displayColumn)}</span>` : ''}
                <small class="relationship-status relationship-status-${escapeDictHtml(relation.status || 'suggested')}">${escapeDictHtml(formatRelationshipCardinality(relation.cardinality || relation.relationType))} · ${escapeDictHtml(relation.status || 'suggested')}</small>
              </div>
              <div class="dictionary-relation-chip-actions">
                <button type="button" class="relation-action edit" onclick="event.stopPropagation(); editFieldRelationship('${encodeURIComponent(relation.id)}', '${encodedCol}')" title="Chỉnh sửa"><i class="fa-solid fa-pen"></i></button>
                <button type="button" class="relation-action inspect" onclick="event.stopPropagation(); profileFieldRelationship('${encodeURIComponent(relation.id)}')" title="Kiểm tra dữ liệu"><i class="fa-solid fa-microscope"></i></button>
                ${relation.status !== 'verified' ? `<button type="button" class="relation-action verify" onclick="event.stopPropagation(); setFieldRelationshipStatus('${encodeURIComponent(relation.id)}', 'verified')" title="Xác minh"><i class="fa-solid fa-check"></i></button>` : ''}
                ${relation.status !== 'rejected' ? `<button type="button" class="relation-action reject" onclick="event.stopPropagation(); setFieldRelationshipStatus('${encodeURIComponent(relation.id)}', 'rejected')" title="Từ chối"><i class="fa-solid fa-ban"></i></button>` : ''}
                <button type="button" class="relation-action delete" onclick="event.stopPropagation(); deleteFieldRelationship('${encodeURIComponent(relation.id)}')" title="Xóa"><i class="fa-solid fa-trash-can"></i></button>
              </div>
            </div>`).join('')}
          </div>
          <div class="dictionary-field-relation-editor" data-column="${escapeDictHtml(col.columnName)}" hidden>
            <input type="hidden" data-role="relationship-id">
            <input type="hidden" data-role="relationship-revision">
            <div class="dictionary-relation-grid">
              <label>Bảng đích<select data-role="target-table" onchange="updateFieldRelationshipColumns(this)">${renderRelationshipTargetTableOptions(table)}</select></label>
              <label>Loại quan hệ<select data-role="cardinality" onchange="toggleManyToManyFields(this)"><option value="many-to-one">N:1</option><option value="one-to-many">1:N</option><option value="one-to-one">1:1</option><option value="many-to-many">N:N (qua bảng trung gian)</option></select></label>
              <label>Vai trò<input data-role="business-role" type="text" placeholder="VD: phòng ban của nhân viên"></label>
              <label>Cột hiển thị<select data-role="display-column"><option value="">Chọn cột trả về</option></select></label>
            </div>
            <div class="dictionary-relation-pairs" data-role="column-pairs">
              ${renderFieldRelationshipPair(table, col.columnName, '', true)}
            </div>
            <details class="dictionary-composite-key-options">
              <summary><i class="fa-solid fa-key"></i> Khóa ghép <span>Nâng cao</span></summary>
              <p>Chỉ dùng khi một quan hệ JOIN cần từ hai cặp cột trở lên.</p>
              <button type="button" class="btn-secondary-sm dictionary-add-pair" onclick="addFieldRelationshipPair('${encodedCol}')"><i class="fa-solid fa-plus"></i> Thêm cặp cột</button>
            </details>
            <div class="dictionary-many-to-many" data-role="many-to-many" hidden>
              <label>Bảng trung gian<select data-role="bridge-table" onchange="updateBridgeColumnOptions(this)">${renderRelationshipTargetTableOptions(table)}</select></label>
              <label>Cột nối về ${escapeDictHtml(table.tableName)}<select data-role="bridge-source-column"><option value="">Chọn cột</option></select></label>
              <label>Cột nối tới bảng đích<select data-role="bridge-target-column"><option value="">Chọn cột</option></select></label>
            </div>
            <p class="dictionary-relation-hint">Quan hệ tính từ <strong>${escapeDictHtml(table.tableName)}.${escapeDictHtml(col.columnName)}</strong> sang bảng đích. N:N cần cấu hình qua bảng trung gian trong sơ đồ quan hệ.</p>
            <div class="dictionary-relation-actions"><button type="button" class="btn-secondary-sm" onclick="cancelFieldRelationship('${encodedCol}')">Hủy</button><button type="button" class="btn-primary" onclick="saveFieldRelationship('${encodedCol}')"><i class="fa-solid fa-floppy-disk"></i> Lưu quan hệ</button></div>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function formatRelationshipCardinality(value) {
  return ({ 'one-to-one': '1:1', 'one-to-many': '1:N', 'many-to-one': 'N:1', 'many-to-many': 'N:N', unknown: '?' })[value] || value || '?';
}

function renderRelationshipTargetTableOptions(sourceTable) {
  const options = getDictionaryTables().filter(table => table.isActive === true
    && table.dbName === sourceTable.dbName
    && (table.dbSourceId || null) === (sourceTable.dbSourceId || null));
  return '<option value="">Chọn bảng</option>' + options.map(table =>
    `<option value="${escapeDictHtml(table.tableId)}">${escapeDictHtml(`${table.schemaName || 'dbo'}.${table.tableName}`)}</option>`).join('');
}

function renderFieldRelationshipPair(sourceTable, sourceColumn = '', targetColumn = '', locked = false) {
  const sourceOptions = (sourceTable.columns || []).map(column => `<option value="${escapeDictHtml(column.columnName)}" ${column.columnName === sourceColumn ? 'selected' : ''}>${escapeDictHtml(column.columnName)}</option>`).join('');
  return `<div class="dictionary-relation-pair">
    ${locked
      ? `<div class="dictionary-relation-fixed-source" title="Cột nguồn được cố định theo field đang thao tác"><i class="fa-solid fa-lock"></i><span>${escapeDictHtml(sourceColumn)}</span><input type="hidden" data-role="pair-source" value="${escapeDictHtml(sourceColumn)}"></div>`
      : `<select data-role="pair-source">${sourceOptions}</select>`}<i class="fa-solid fa-arrow-right"></i>
    <select data-role="pair-target" data-selected="${escapeDictHtml(targetColumn)}"><option value="">Chọn cột đích</option></select>
    ${locked ? '<span></span>' : '<button type="button" onclick="this.closest(\'.dictionary-relation-pair\').remove()" title="Xóa cặp"><i class="fa-solid fa-xmark"></i></button>'}
  </div>`;
}

function getFieldRelationshipEditor(columnName) {
  return Array.from(document.querySelectorAll('.dictionary-field-relation-editor')).find(editor => editor.dataset.column === columnName);
}

function toggleFieldRelationshipEditor(encodedColumnName, button) {
  const columnName = decodeURIComponent(encodedColumnName);
  const editor = getFieldRelationshipEditor(columnName);
  if (!editor) return;
  if (!editor.hidden) {
    editor.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
    return;
  }
  const sourceTable = findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName);
  const relationships = (window.tableRelationshipsData || []).filter(relation =>
    (relation.sourceTableId ? relation.sourceTableId === sourceTable?.tableId : relation.sourceTable === sourceTable?.tableName)
    && (relation.columnPairs || [{ sourceColumn: relation.sourceColumn }]).some(pair => pair.sourceColumn === columnName));
  if (relationships.length === 1) {
    editFieldRelationship(encodeURIComponent(relationships[0].id), encodedColumnName);
    button?.setAttribute('aria-expanded', 'true');
    return;
  }
  if (relationships.length > 1) {
    showToast?.('Field có nhiều quan hệ. Hãy chọn biểu tượng sửa trên quan hệ cần chỉnh.', 'info');
    return;
  }
  cancelFieldRelationship(encodedColumnName);
  editor.hidden = false;
  button?.setAttribute('aria-expanded', 'true');
}

function updateFieldRelationshipColumns(select, selectedColumn = '') {
  const editor = select?.closest('.dictionary-field-relation-editor');
  const table = getDictionaryTables().find(item => item.tableId === select?.value);
  if (!editor) return;
  editor.querySelectorAll('[data-role="pair-target"]').forEach((columnSelect, index) => {
    const desired = index === 0 && selectedColumn ? selectedColumn : (columnSelect.dataset.selected || columnSelect.value);
    columnSelect.innerHTML = '<option value="">Chọn cột</option>' + (table?.columns || []).map(column =>
      `<option value="${escapeDictHtml(column.columnName)}">${escapeDictHtml(column.columnName)} (${escapeDictHtml(column.dataType || '-')})</option>`).join('');
    columnSelect.value = desired;
    delete columnSelect.dataset.selected;
  });
  const displaySelect = editor.querySelector('[data-role="display-column"]');
  if (displaySelect) {
    const desired = displaySelect.dataset.selected || displaySelect.value;
    displaySelect.innerHTML = '<option value="">Chọn cột trả về</option>' + (table?.columns || []).map(column =>
      `<option value="${escapeDictHtml(column.columnName)}">${escapeDictHtml(column.columnName)} (${escapeDictHtml(column.dataType || '-')})</option>`).join('');
    displaySelect.value = desired;
    delete displaySelect.dataset.selected;
  }
}

function addFieldRelationshipPair(encodedColumnName, sourceColumn = '', targetColumn = '') {
  const sourceTable = findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName);
  const editor = getFieldRelationshipEditor(decodeURIComponent(encodedColumnName));
  const list = editor?.querySelector('[data-role="column-pairs"]');
  if (!sourceTable || !list) return;
  const usedSourceColumns = new Set(Array.from(list.querySelectorAll('[data-role="pair-source"]')).map(select => select.value));
  const nextSourceColumn = sourceColumn || sourceTable.columns?.find(column => !usedSourceColumns.has(column.columnName))?.columnName;
  if (!nextSourceColumn) {
    showToast?.('Không còn cột nguồn nào để thêm vào khóa ghép.', 'warning');
    return;
  }
  list.insertAdjacentHTML('beforeend', renderFieldRelationshipPair(sourceTable, nextSourceColumn, targetColumn));
  updateFieldRelationshipColumns(editor.querySelector('[data-role="target-table"]'));
}

function toggleManyToManyFields(select) {
  const editor = select?.closest('.dictionary-field-relation-editor');
  const panel = editor?.querySelector('[data-role="many-to-many"]');
  const compositeOptions = editor?.querySelector('.dictionary-composite-key-options');
  if (panel) panel.hidden = select.value !== 'many-to-many';
  if (compositeOptions) compositeOptions.hidden = select.value === 'many-to-many';
}

function updateBridgeColumnOptions(select) {
  const editor = select?.closest('.dictionary-field-relation-editor');
  const bridge = getDictionaryTables().find(table => table.tableId === select?.value);
  const options = '<option value="">Chọn cột</option>' + (bridge?.columns || []).map(column =>
    `<option value="${escapeDictHtml(column.columnName)}">${escapeDictHtml(column.columnName)} (${escapeDictHtml(column.dataType || '-')})</option>`).join('');
  editor?.querySelectorAll('[data-role="bridge-source-column"],[data-role="bridge-target-column"]').forEach(item => { item.innerHTML = options; });
}

function cancelFieldRelationship(encodedColumnName) {
  const columnName = decodeURIComponent(encodedColumnName);
  const editor = getFieldRelationshipEditor(columnName);
  if (!editor) return;
  editor.querySelectorAll('input:not([data-role="pair-source"])').forEach(input => { input.value = ''; });
  editor.querySelectorAll('select:not([data-role="pair-source"])').forEach(select => { select.selectedIndex = 0; });
  const fixedSource = editor.querySelector('[data-role="pair-source"]');
  if (fixedSource) fixedSource.value = columnName;
  editor.querySelectorAll('.dictionary-relation-pair:not(:first-child)').forEach(row => row.remove());
  const compositeOptions = editor.querySelector('.dictionary-composite-key-options');
  if (compositeOptions) compositeOptions.open = false;
  editor.hidden = true;
}

function editFieldRelationship(encodedId, encodedColumnName) {
  const relation = (window.tableRelationshipsData || []).find(item => item.id === decodeURIComponent(encodedId));
  const editor = getFieldRelationshipEditor(decodeURIComponent(encodedColumnName));
  if (!relation || !editor) return;
  editor.hidden = false;
  editor.querySelector('[data-role="relationship-id"]').value = relation.id;
  editor.querySelector('[data-role="relationship-revision"]').value = relation.revision || 1;
  const targetTable = editor.querySelector('[data-role="target-table"]');
  targetTable.value = relation.targetTableId || '';
  const displaySelect = editor.querySelector('[data-role="display-column"]');
  if (displaySelect) displaySelect.dataset.selected = relation.displayColumn || '';
  const pairs = relation.columnPairs?.length ? relation.columnPairs : [{ sourceColumn: relation.sourceColumn, targetColumn: relation.targetColumn }];
  const pairList = editor.querySelector('[data-role="column-pairs"]');
  pairList.innerHTML = pairs.map((pair, index) => renderFieldRelationshipPair(findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName), pair.sourceColumn, pair.targetColumn, index === 0)).join('');
  const compositeOptions = editor.querySelector('.dictionary-composite-key-options');
  if (compositeOptions) compositeOptions.open = pairs.length > 1;
  updateFieldRelationshipColumns(targetTable);
  editor.querySelector('[data-role="cardinality"]').value = relation.cardinality || relation.relationType || 'many-to-one';
  toggleManyToManyFields(editor.querySelector('[data-role="cardinality"]'));
  editor.querySelector('[data-role="business-role"]').value = relation.businessRole || '';
}

async function saveFieldRelationship(encodedColumnName) {
  const columnName = decodeURIComponent(encodedColumnName);
  const sourceTable = findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName);
  const editor = getFieldRelationshipEditor(columnName);
  if (!sourceTable || !editor) return;
  const saveButton = editor.querySelector('.dictionary-relation-actions .btn-primary');
  if (saveButton?.disabled) return;
  const id = editor.querySelector('[data-role="relationship-id"]').value;
  const targetTableId = editor.querySelector('[data-role="target-table"]').value;
  const cardinality = editor.querySelector('[data-role="cardinality"]').value;
  const columnPairs = Array.from(editor.querySelectorAll('.dictionary-relation-pair')).map(row => ({
    sourceColumn: row.querySelector('[data-role="pair-source"]').value,
    targetColumn: row.querySelector('[data-role="pair-target"]').value
  }));
  if (!targetTableId || columnPairs.some(pair => !pair.sourceColumn || !pair.targetColumn)) {
    showToast?.('Hãy chọn đủ bảng và các cặp cột.', 'warning');
    return;
  }
  if (new Set(columnPairs.map(pair => pair.sourceColumn)).size !== columnPairs.length
      || new Set(columnPairs.map(pair => pair.targetColumn)).size !== columnPairs.length) {
    showToast?.('Khóa ghép không được lặp lại cột nguồn hoặc cột đích.', 'warning');
    return;
  }
  let endpoint = id ? '/api/dictionary/relationships/update' : '/api/dictionary/relationships/add';
  let payload = { sourceTableId: sourceTable.tableId, targetTableId, columnPairs,
    cardinality, relationType: cardinality, businessRole: editor.querySelector('[data-role="business-role"]').value.trim(),
    displayColumn: editor.querySelector('[data-role="display-column"]')?.value || '' };
  if (cardinality === 'many-to-many') {
    if (id) { showToast?.('Hãy xóa cấu hình cũ rồi tạo lại quan hệ N:N.', 'warning'); return; }
    const bridgeTableId = editor.querySelector('[data-role="bridge-table"]').value;
    const bridgeSourceColumn = editor.querySelector('[data-role="bridge-source-column"]').value;
    const bridgeTargetColumn = editor.querySelector('[data-role="bridge-target-column"]').value;
    if (!bridgeTableId || !bridgeSourceColumn || !bridgeTargetColumn || columnPairs.length !== 1) {
      showToast?.('N:N cần một bảng trung gian và đủ hai cột nối.', 'warning'); return;
    }
    endpoint = '/api/dictionary/relationships/add-many-to-many';
    payload = { sourceTableId: sourceTable.tableId, targetTableId, bridgeTableId,
      sourceToBridgePairs: [{ sourceColumn: columnName, targetColumn: bridgeSourceColumn }],
      bridgeToTargetPairs: [{ sourceColumn: bridgeTargetColumn, targetColumn: columnPairs[0].targetColumn }],
      businessRole: payload.businessRole };
  }
  if (id) { payload.id = id; payload.expectedRevision = Number(editor.querySelector('[data-role="relationship-revision"]').value || 1); }
  try {
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...';
    }
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = data.relationships || [];
    renderDictionaryDrawer(sourceTable);
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    showToast?.('Đã lưu quan hệ ở trạng thái chưa xác minh.', 'success');
  } catch (err) {
    showToast?.(`Không thể lưu quan hệ: ${err.message}`, 'error');
  } finally {
    if (saveButton?.isConnected) {
      saveButton.disabled = false;
      saveButton.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Lưu quan hệ';
    }
  }
}

async function setFieldRelationshipStatus(encodedId, status) {
  const id = decodeURIComponent(encodedId);
  const relation = (window.tableRelationshipsData || []).find(item => item.id === id);
  const sourceTable = findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName);
  if (!relation || !sourceTable) return;
  try {
    const res = await fetch('/api/dictionary/relationships/status', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status, expectedRevision: relation.revision || 1 }) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = data.relationships || [];
    renderDictionaryDrawer(sourceTable);
    showToast?.(status === 'verified' ? 'Đã xác minh quan hệ để AI có thể sử dụng.' : 'Đã từ chối quan hệ.', 'success');
  } catch (err) {
    showToast?.(`Không thể cập nhật trạng thái: ${err.message}`, 'error');
  }
}

async function deleteFieldRelationship(encodedId) {
  const id = decodeURIComponent(encodedId);
  const relation = (window.tableRelationshipsData || []).find(item => item.id === id);
  if (!relation || !await showUiConfirm('Xóa quan hệ này?', { title: 'Xóa quan hệ', confirmText: 'Xóa', tone: 'danger' })) return;
  const sourceTable = findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName);
  try {
    const res = await fetch('/api/dictionary/relationships/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = data.relationships || [];
    delete window.relationshipLineStyles[id];
    saveRelationshipDiagramState();
    if (sourceTable) renderDictionaryDrawer(sourceTable);
    renderRelationshipDiagram();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    showToast?.('Đã xóa quan hệ.', 'success');
  } catch (err) {
    showToast?.(`Không thể xóa quan hệ: ${err.message}`, 'error');
  }
}

async function profileFieldRelationship(encodedId) {
  const id = decodeURIComponent(encodedId);
  const relation = (window.tableRelationshipsData || []).find(item => item.id === id);
  const sourceTable = findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName);
  if (!relation || !sourceTable) return;
  try {
    showToast?.('Đang kiểm tra dữ liệu quan hệ...', 'info');
    const res = await fetch('/api/dictionary/relationships/profile', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, expectedRevision: relation.revision || 1 }) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = data.relationships || [];
    renderDictionaryDrawer(sourceTable);
    const profile = data.relationship?.evidence?.profile || {};
    showToast?.(`Kiểm tra xong: ${profile.orphanRows || 0} orphan, ${profile.duplicateTargetKeys || 0} khóa đích trùng.`, 'success');
  } catch (err) {
    showToast?.(`Không thể kiểm tra dữ liệu: ${err.message}`, 'error');
  }
}

async function openBusinessDomainsModal() {
  try {
    const searchInput = document.getElementById('business-domains-search');
    if (searchInput) searchInput.value = '';
    const res = await fetch('/api/dictionary/domains');
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    window.businessDomainsData = data || {};
    renderBusinessDomains();
    resetBusinessDomainForm();
    if (typeof openModal === 'function') openModal('business-domains-modal');
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể tải nhóm nghiệp vụ: ${err.message}`, 'error');
  }
}

function closeBusinessDomainsModal() {
  resetBusinessDomainForm();
  if (typeof closeModal === 'function') closeModal('business-domains-modal');
}

function setBusinessDomainFormOpen(open) {
  const body = document.querySelector('.domain-manager-body');
  const form = document.getElementById('domain-manager-form');
  body?.classList.toggle('is-form-open', Boolean(open));
  form?.setAttribute('aria-hidden', String(!open));
}

function openNewBusinessDomainForm() {
  resetBusinessDomainForm();
  setBusinessDomainFormOpen(true);
  const cancel = document.getElementById('domain-cancel-button');
  if (cancel) cancel.hidden = false;
  setTimeout(() => document.getElementById('domain-key-input')?.focus(), 180);
}

function renderBusinessDomains() {
  const container = document.getElementById('business-domains-list');
  if (!container) return;
  const keyword = document.getElementById('business-domains-search')?.value.trim().toLowerCase() || '';
  const allEntries = Object.entries(window.businessDomainsData || {}).sort(([a], [b]) => a.localeCompare(b));
  const entries = allEntries.filter(([domain, aliases]) => !keyword || domain.toLowerCase().includes(keyword) || (aliases || []).some(alias => alias.toLowerCase().includes(keyword)));
  const count = document.getElementById('business-domains-count');
  if (count) count.textContent = `${allEntries.length} nhóm`;
  container.innerHTML = entries.length ? entries.map(([domain, aliases], index) => {
    const tableCount = getDictionaryTables().filter(table => table.domain === domain).length;
    const aliasChips = (aliases || []).map(alias => `<span class="domain-alias-chip">${escapeDictHtml(alias)}</span>`).join('');
    return `<div class="domain-manager-item accent-${index % 5}">
      <div class="domain-manager-item-icon"><i class="fa-solid fa-cubes-stacked"></i></div>
      <div class="domain-manager-item-info">
        <div class="domain-manager-item-title"><strong>${escapeDictHtml(domain)}</strong><span><i class="fa-solid fa-table"></i> ${tableCount} bảng</span></div>
        <div class="domain-alias-chips">${aliasChips || '<span class="domain-alias-empty">Chưa có từ khóa nhận diện</span>'}</div>
      </div>
      <div class="domain-manager-item-actions">
        <button class="icon-action-btn" onclick="editBusinessDomain('${encodeURIComponent(domain)}')" title="Chỉnh sửa"><i class="fa-solid fa-pen"></i></button>
        <button class="icon-action-btn danger-soft" onclick="deleteBusinessDomain('${encodeURIComponent(domain)}')" title="Xóa"><i class="fa-regular fa-trash-can"></i></button>
      </div>
    </div>`;
  }).join('') : '<div class="dictionary-empty"><strong>Chưa có nhóm nghiệp vụ.</strong></div>';
}

function editBusinessDomain(encodedDomain) {
  const domain = decodeURIComponent(encodedDomain);
  document.getElementById('domain-old-key').value = domain;
  document.getElementById('domain-key-input').value = domain;
  document.getElementById('domain-aliases-input').value = (window.businessDomainsData[domain] || []).join(', ');
  document.getElementById('domain-cancel-button').hidden = false;
  document.getElementById('domain-form-title').textContent = `Chỉnh sửa ${domain}`;
  document.getElementById('domain-form-subtitle').textContent = 'Cập nhật mã nhóm hoặc từ khóa nhận diện';
  const formIcon = document.querySelector('.domain-manager-form-icon i');
  if (formIcon) formIcon.className = 'fa-solid fa-pen';
  setBusinessDomainFormOpen(true);
  setTimeout(() => document.getElementById('domain-key-input')?.focus(), 180);
}

function resetBusinessDomainForm() {
  const oldKey = document.getElementById('domain-old-key');
  const key = document.getElementById('domain-key-input');
  const aliases = document.getElementById('domain-aliases-input');
  if (oldKey) oldKey.value = '';
  if (key) key.value = '';
  if (aliases) aliases.value = '';
  const cancel = document.getElementById('domain-cancel-button');
  if (cancel) cancel.hidden = true;
  const title = document.getElementById('domain-form-title');
  const subtitle = document.getElementById('domain-form-subtitle');
  if (title) title.textContent = 'Thêm nhóm mới';
  if (subtitle) subtitle.textContent = 'Tạo một nhóm nghiệp vụ và bộ từ khóa nhận diện';
  const formIcon = document.querySelector('.domain-manager-form-icon i');
  if (formIcon) formIcon.className = 'fa-solid fa-plus';
  setBusinessDomainFormOpen(false);
}

async function saveBusinessDomain() {
  const oldDomain = document.getElementById('domain-old-key')?.value.trim() || '';
  const domain = document.getElementById('domain-key-input')?.value.trim() || '';
  const aliases = document.getElementById('domain-aliases-input')?.value || '';
  if (!domain) return showToast?.('Vui lòng nhập mã nghiệp vụ.', 'warning');
  try {
    const res = await fetch('/api/dictionary/domains/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ oldDomain, domain, aliases }) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.businessDomainsData = data.domains || {};
    renderBusinessDomains();
    renderDictionaryDomainOptions();
    if (typeof fetchDataDictionary === 'function') await fetchDataDictionary();
    resetBusinessDomainForm();
    showToast?.('Đã lưu nhóm nghiệp vụ và đồng bộ cho AI.', 'success');
  } catch (err) {
    showToast?.(`Không thể lưu nhóm nghiệp vụ: ${err.message}`, 'error');
  }
}

async function deleteBusinessDomain(encodedDomain) {
  const domain = decodeURIComponent(encodedDomain);
  const usedCount = getDictionaryTables().filter(table => table.domain === domain).length;
  const warning = usedCount ? `Nhóm "${domain}" đang được ${usedCount} bảng sử dụng. Chỉ xóa bộ từ khóa, domain trên bảng vẫn được giữ. Tiếp tục?` : `Xóa nhóm nghiệp vụ "${domain}"?`;
  if (!await showUiConfirm(warning, { title: 'Xóa nhóm nghiệp vụ', confirmText: 'Xóa nhóm', tone: 'danger' })) return;
  try {
    const res = await fetch('/api/dictionary/domains/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.businessDomainsData = data.domains || {};
    renderBusinessDomains();
    renderDictionaryDomainOptions();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    showToast?.('Đã xóa nhóm nghiệp vụ.', 'success');
  } catch (err) {
    showToast?.(`Không thể xóa nhóm nghiệp vụ: ${err.message}`, 'error');
  }
}

function openDictionaryDrawer(encodedTableIdentity) {
  const tableIdentity = decodeURIComponent(encodedTableIdentity);
  const table = findDictionaryTable(tableIdentity);
  if (!table) return;
  window.dictionaryModalTrigger = document.activeElement;
  window.selectedDictionaryTableName = table.tableName;
  window.selectedDictionaryTableId = table.tableId;
  renderDictionaryDrawer(table);
  const dialog = document.getElementById('dictionary-drawer');
  dialog?.classList.add('active');
  dialog?.setAttribute('aria-hidden', 'false');
  document.getElementById('dictionary-drawer-backdrop')?.classList.add('active');
  document.body.classList.add('dictionary-modal-open');
  dialog?.querySelector('.modal-close-btn')?.focus();
}

function closeDictionaryDrawer() {
  const dialog = document.getElementById('dictionary-drawer');
  dialog?.classList.remove('active');
  dialog?.setAttribute('aria-hidden', 'true');
  document.getElementById('dictionary-drawer-backdrop')?.classList.remove('active');
  document.body.classList.remove('dictionary-modal-open');
  window.dictionaryModalTrigger?.focus?.();
  window.dictionaryModalTrigger = null;
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.getElementById('dictionary-drawer')?.classList.contains('active')) {
    closeDictionaryDrawer();
  }
});

async function toggleSelectedDictionaryTableActive(isActive) {
  const tableName = window.selectedDictionaryTableName;
  if (!tableName) return;
  try {
    const res = await fetch('/api/dictionary/toggle-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableName, isActive })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    const table = findDictionaryTable(tableName);
    if (table) table.isActive = isActive;
    renderDataDictionary();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    renderDictionaryDrawer(table);
    if (typeof showToast === 'function') showToast(isActive ? 'Đã bật bảng cho AI.' : 'Đã tắt bảng khỏi ngữ cảnh AI.', 'success');
  } catch (err) {
    const activeEl = document.getElementById('dict-drawer-active-toggle');
    if (activeEl) activeEl.checked = !isActive;
    if (typeof showToast === 'function') showToast(`Không thể cập nhật trạng thái: ${err.message}`, 'error');
  }
}

async function toggleDictionaryTableActiveFromList(encodedTableName, checkbox) {
  const tableName = decodeURIComponent(encodedTableName);
  const isActive = checkbox.checked;
  checkbox.disabled = true;
  try {
    const res = await fetch('/api/dictionary/toggle-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableName, isActive })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    const table = findDictionaryTable(tableName);
    if (table) table.isActive = isActive;
    renderDataDictionary();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    if (typeof showToast === 'function') showToast(isActive ? `Đã bật bảng ${tableName} cho AI.` : `Đã tắt bảng ${tableName}.`, 'success');
  } catch (err) {
    checkbox.checked = !isActive;
    checkbox.disabled = false;
    if (typeof showToast === 'function') showToast(`Không thể cập nhật trạng thái: ${err.message}`, 'error');
  }
}

async function saveSelectedTableDescription() {
  const tableName = window.selectedDictionaryTableName;
  const description = document.getElementById('dict-drawer-table-description')?.value.trim() || '';
  const domain = document.getElementById('dict-drawer-table-domain')?.value.trim() || '';
  const defaultMetric = document.getElementById('dict-drawer-default-metric')?.value || '';
  const defaultTimeColumn = document.getElementById('dict-drawer-default-time')?.value || '';
  const defaultAggregation = document.getElementById('dict-drawer-default-aggregation')?.value || 'SUM';
  if (!tableName) return;
  try {
    const res = await fetch('/api/dictionary/update-table', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableName, description, domain, defaultMetric, defaultTimeColumn, defaultAggregation })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.groupedTablesData = Array.isArray(data.tables) ? data.tables : getDictionaryTables();
    renderDataDictionary();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    renderDictionaryDrawer(findDictionaryTable(tableName));
    if (typeof showToast === 'function') showToast('Đã lưu cấu hình nghiệp vụ của bảng.', 'success');
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể lưu mô tả bảng: ${err.message}`, 'error');
  }
}

async function saveDictionaryColumnDescription(encodedColumnName) {
  const tableName = window.selectedDictionaryTableName;
  const columnName = decodeURIComponent(encodedColumnName);
  const input = Array.from(document.querySelectorAll('.dictionary-column-description'))
    .find(el => el.dataset.column === columnName);
  const displayInput = Array.from(document.querySelectorAll('.dictionary-column-display-name'))
    .find(el => el.dataset.column === columnName);
  const description = input?.value.trim() || '';
  const currentColumn = findDictionaryTable(tableName)?.columns?.find(c => c.columnName === columnName);
  const displayName = displayInput ? displayInput.value.trim() : (currentColumn?.displayName || '');
  if (!tableName || !columnName) return;
  try {
    const res = await fetch('/api/dictionary/update-column', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableName, columnName, description, displayName })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    const table = findDictionaryTable(tableName);
    const col = table?.columns?.find(c => c.columnName === columnName);
    if (col) col.description = description;
    if (col) col.displayName = displayName;
    renderDataDictionary();
    if (typeof showToast === 'function') showToast(`Đã lưu metadata cột ${columnName}.`, 'success');
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể lưu mô tả cột: ${err.message}`, 'error');
  }
}

function filterDictionaryTables() {
  window.paginationState.dictionary.currentPage = 1;
  renderDataDictionary();
  if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
}

function filterTableStatus(status) {
  window.dictActiveFilter = status;
  window.paginationState.dictionary.currentPage = 1;
  ['all', 'active', 'inactive'].forEach(s => {
    const btn = document.getElementById(`btn-filter-${s}`);
    if (btn) btn.classList.toggle('active', s === status);
  });
  renderDataDictionary();
  if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
}

async function triggerAiGenerateDictionary() {
  if (typeof showToast === 'function') showToast('Đang đồng bộ Lược đồ CSDL vào Qdrant...', 'info');
  try {
    const res = await fetch('/api/qdrant/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    if (typeof showToast === 'function') showToast('Đã đồng bộ Lược đồ CSDL cho AI.', 'success');
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể đồng bộ Lược đồ CSDL: ${err.message}`, 'error');
  }
}

function getActiveDictionaryTables() {
  return getDictionaryTables().filter(table => table.isActive);
}

async function openRelationshipDiagram() {
  loadRelationshipDiagramState();
  if (typeof openModal === 'function') openModal('relationship-diagram-modal');
  try {
    const res = await fetch('/api/dictionary/relationships');
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = Array.isArray(data) ? data : [];
    populateRelationshipTableOptions();
    renderRelationshipDiagram();
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể tải quan hệ bảng: ${err.message}`, 'error');
  }
}

async function discoverDictionaryRelationships() {
  const button = document.getElementById('relationship-discovery-button');
  if (button?.disabled) return;
  try {
    if (button) {
      button.disabled = true;
      button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang khám phá...';
    }
    const res = await fetch('/api/dictionary/relationships/discover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = data.relationships || [];
    const selected = findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName);
    if (selected && document.getElementById('dictionary-drawer')?.classList.contains('active')) renderDictionaryDrawer(selected);
    showToast?.(`Đã tạo ${data.created?.length || 0} đề xuất quan hệ mới.`, 'success');
  } catch (err) {
    showToast?.(`Không thể khám phá quan hệ: ${err.message}`, 'error');
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> Khám phá quan hệ';
    }
  }
}

function closeRelationshipDiagram() {
  if (typeof closeModal === 'function') closeModal('relationship-diagram-modal');
}

function populateRelationshipTableOptions() {
  const activeTables = getActiveDictionaryTables();
  const selectedNames = new Set(window.relationshipDiagramTables);
  const tables = activeTables.filter(table => selectedNames.has(table.tableName));
  const options = tables.map(table => `<option value="${escapeDictHtml(table.tableName)}">${escapeDictHtml(table.tableName)}</option>`).join('');
  const source = document.getElementById('relation-source-table');
  const target = document.getElementById('relation-target-table');
  if (source) source.innerHTML = options || '<option value="">Không có bảng Active</option>';
  if (target) {
    target.innerHTML = options || '<option value="">Không có bảng Active</option>';
    if (tables.length > 1) target.selectedIndex = 1;
  }
  updateRelationshipColumnOptions('source');
  updateRelationshipColumnOptions('target');
  const addSelect = document.getElementById('relation-add-table');
  const availableTables = activeTables.filter(table => !selectedNames.has(table.tableName));
  if (addSelect) addSelect.innerHTML = availableTables.map(table => `<option value="${escapeDictHtml(table.tableName)}">${escapeDictHtml(table.tableName)}</option>`).join('') || '<option value="">Đã thêm tất cả bảng Active</option>';
}

function addTableToRelationshipDiagram() {
  const tableName = document.getElementById('relation-add-table')?.value;
  if (!tableName || window.relationshipDiagramTables.includes(tableName)) return;
  window.relationshipDiagramTables.push(tableName);
  saveRelationshipDiagramState();
  populateRelationshipTableOptions();
  renderRelationshipDiagram();
}

function removeTableFromRelationshipDiagram(encodedTableName) {
  const tableName = decodeURIComponent(encodedTableName);
  window.relationshipDiagramTables = window.relationshipDiagramTables.filter(name => name !== tableName);
  delete window.relationshipNodePositions[tableName];
  saveRelationshipDiagramState();
  populateRelationshipTableOptions();
  renderRelationshipDiagram();
}

function updateRelationshipColumnOptions(side) {
  const tableName = document.getElementById(`relation-${side}-table`)?.value;
  const select = document.getElementById(`relation-${side}-column`);
  const table = findDictionaryTable(tableName);
  if (!select) return;
  select.innerHTML = (table?.columns || []).map(column => `<option value="${escapeDictHtml(column.columnName)}">${escapeDictHtml(column.columnName)}</option>`).join('');
}

function renderRelationshipDiagram() {
  const canvas = document.getElementById('relationship-diagram-canvas');
  const wrap = canvas?.closest('.relationship-canvas-wrap');
  const nodes = document.getElementById('relationship-table-nodes');
  const empty = document.getElementById('relationship-empty');
  if (!canvas || !nodes) return;
  const selectedNames = new Set(window.relationshipDiagramTables);
  const tables = getActiveDictionaryTables().filter(table => selectedNames.has(table.tableName));
  const columnsPerRow = Math.max(1, Math.min(3, tables.length));
  const nodeWidth = 230;
  const gapX = 70;
  const gapY = 55;
  const padding = 35;
  const rowCount = Math.ceil(tables.length / columnsPerRow);
  const nodeHeights = tables.map(table => 38 + Math.max(1, (table.columns || []).length) * 21 + 12);
  const rowHeights = Array.from({ length: rowCount }, (_, rowIndex) => {
    const heights = nodeHeights.slice(rowIndex * columnsPerRow, (rowIndex + 1) * columnsPerRow);
    return Math.max(71, ...heights);
  });
  const rowTops = rowHeights.map((_, rowIndex) => padding + rowHeights.slice(0, rowIndex).reduce((sum, height) => sum + height + gapY, 0));
  const layoutHeight = padding * 2 + rowHeights.reduce((sum, height) => sum + height, 0) + Math.max(0, rowCount - 1) * gapY;
  const savedContentHeight = tables.reduce((maxBottom, table, index) => {
    const savedTop = window.relationshipNodePositions[table.tableName]?.top;
    return savedTop == null ? maxBottom : Math.max(maxBottom, savedTop + nodeHeights[index] + padding);
  }, 0);
  canvas.dataset.contentWidth = String(Math.max(760, padding * 2 + columnsPerRow * nodeWidth + (columnsPerRow - 1) * gapX));
  canvas.dataset.contentHeight = String(Math.max(480, layoutHeight, savedContentHeight));
  applyRelationshipCanvasZoom();
  fitRelationshipCanvasToWrap();
  if (empty) empty.hidden = tables.length > 0;

  nodes.innerHTML = tables.map((table, index) => {
    const defaultLeft = padding + (index % columnsPerRow) * (nodeWidth + gapX);
    const defaultTop = rowTops[Math.floor(index / columnsPerRow)] || padding;
    const savedPosition = window.relationshipNodePositions[table.tableName];
    const left = savedPosition?.left ?? defaultLeft;
    const top = savedPosition?.top ?? defaultTop;
    window.relationshipNodePositions[table.tableName] = { left, top };
    const relationColumns = new Set(window.tableRelationshipsData.flatMap(relation => {
      const names = [];
      if (relation.sourceTable === table.tableName) names.push(relation.sourceColumn);
      if (relation.targetTable === table.tableName) names.push(relation.targetColumn);
      return names;
    }));
    return `<article class="relationship-table-node" data-table="${escapeDictHtml(table.tableName)}" style="left:${left}px;top:${top}px;width:${nodeWidth}px">
      <header class="relationship-node-drag-handle"><strong>${escapeDictHtml(table.tableName)}</strong><span>${(table.columns || []).length}</span><button class="relationship-node-remove" onpointerdown="event.stopPropagation()" onclick="removeTableFromRelationshipDiagram('${encodeURIComponent(table.tableName)}')" title="Bỏ khỏi sơ đồ"><i class="fa-solid fa-xmark"></i></button></header>
      <div class="relationship-node-columns">${(table.columns || []).map(column => `<div class="relationship-node-column ${relationColumns.has(column.columnName) ? 'linked' : ''}"><button class="relationship-port left" data-table="${escapeDictHtml(table.tableName)}" data-column="${escapeDictHtml(column.columnName)}" title="Kéo để nối cột"></button><span>${escapeDictHtml(column.columnName)}</span><code>${escapeDictHtml(column.dataType || '-')}</code>${column.isPrimaryKey ? '<b>PK</b>' : relationColumns.has(column.columnName) ? '<b>FK</b>' : ''}</div>`).join('')}</div>
    </article>`;
  }).join('');
  requestAnimationFrame(drawRelationshipLines);
  renderRelationshipList();
  ensureRelationshipDiagramInteractions();
  if (wrap && !wrap._relationshipResizeObserver && typeof ResizeObserver !== 'undefined') {
    wrap._relationshipResizeObserver = new ResizeObserver(() => {
      fitRelationshipCanvasToWrap();
      drawRelationshipLines();
    });
    wrap._relationshipResizeObserver.observe(wrap);
  }
}

function resetRelationshipDiagramLayout() {
  window.relationshipNodePositions = {};
  saveRelationshipDiagramState();
  renderRelationshipDiagram();
}

function ensureRelationshipDiagramInteractions() {
  const canvas = document.getElementById('relationship-diagram-canvas');
  const wrap = canvas?.closest('.relationship-canvas-wrap');
  if (!canvas || canvas.dataset.interactionsReady === '1') return;
  canvas.dataset.interactionsReady = '1';
  (wrap || canvas).addEventListener('pointerdown', handleRelationshipPointerDown);
  wrap?.addEventListener('wheel', handleRelationshipCanvasWheel, { passive: false });
  window.addEventListener('pointermove', handleRelationshipPointerMove);
  window.addEventListener('pointerup', handleRelationshipPointerUp);
}

function handleRelationshipPointerDown(event) {
  const canvas = document.getElementById('relationship-diagram-canvas');
  const lineHit = event.target.closest('.relationship-line-hit');
  if (lineHit && canvas) {
    event.preventDefault();
    window.relationshipLineDragState = {
      pointerId: event.pointerId,
      relationshipId: lineHit.dataset.relationshipId
    };
    lineHit.classList.add('dragging');
    return;
  }
  const port = event.target.closest('.relationship-port');
  if (port) {
    event.preventDefault();
    const point = getRelationshipPointerPosition(event, canvas);
    window.relationshipConnectState = {
      pointerId: event.pointerId,
      sourceTable: port.dataset.table,
      sourceColumn: port.dataset.column,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y
    };
    port.classList.add('connecting');
    drawRelationshipLines();
    return;
  }
  const handle = event.target.closest('.relationship-node-drag-handle');
  const node = handle?.closest('.relationship-table-node');
  if (!node || !canvas) {
    if (!event.target.closest('.relationship-table-node, .relationship-edge-action')) {
      const wrap = canvas?.closest('.relationship-canvas-wrap');
      if (!wrap) return;
      event.preventDefault();
      window.relationshipCanvasPanState = {
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startScrollLeft: wrap.scrollLeft,
        startScrollTop: wrap.scrollTop,
        wrap
      };
      wrap.classList.add('panning');
    }
    return;
  }
  event.preventDefault();
  window.relationshipDragState = {
    pointerId: event.pointerId,
    node,
    tableName: node.dataset.table,
    startClientX: event.clientX,
    startClientY: event.clientY,
    startLeft: parseFloat(node.style.left) || 0,
    startTop: parseFloat(node.style.top) || 0
  };
  node.classList.add('dragging');
}

function handleRelationshipPointerMove(event) {
  const canvas = document.getElementById('relationship-diagram-canvas');
  const pan = window.relationshipCanvasPanState;
  if (pan && pan.pointerId === event.pointerId) {
    pan.wrap.scrollLeft = pan.startScrollLeft - (event.clientX - pan.startClientX);
    pan.wrap.scrollTop = pan.startScrollTop - (event.clientY - pan.startClientY);
    return;
  }
  const lineDrag = window.relationshipLineDragState;
  if (lineDrag && lineDrag.pointerId === event.pointerId && canvas) {
    const point = getRelationshipPointerPosition(event, canvas);
    window.relationshipLineStyles[lineDrag.relationshipId] = { controlX: point.x, controlY: point.y };
    drawRelationshipLines();
    return;
  }
  const drag = window.relationshipDragState;
  if (drag && drag.pointerId === event.pointerId && canvas) {
    const maxLeft = Math.max(0, canvas.offsetWidth - drag.node.offsetWidth);
    const maxTop = Math.max(0, canvas.offsetHeight - drag.node.offsetHeight);
    const scale = getRelationshipCanvasZoom();
    const left = Math.min(maxLeft, Math.max(0, drag.startLeft + (event.clientX - drag.startClientX) / scale));
    const top = Math.min(maxTop, Math.max(0, drag.startTop + (event.clientY - drag.startClientY) / scale));
    drag.node.style.left = `${left}px`;
    drag.node.style.top = `${top}px`;
    window.relationshipNodePositions[drag.tableName] = { left, top };
    drawRelationshipLines();
  }
  const connect = window.relationshipConnectState;
  if (connect && connect.pointerId === event.pointerId && canvas) {
    const point = getRelationshipPointerPosition(event, canvas);
    connect.currentX = point.x;
    connect.currentY = point.y;
    drawRelationshipLines();
    document.querySelectorAll('.relationship-port.drop-target').forEach(item => item.classList.remove('drop-target'));
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.relationship-port');
    if (target && target.dataset.table !== connect.sourceTable) target.classList.add('drop-target');
  }
}

async function handleRelationshipPointerUp(event) {
  const pan = window.relationshipCanvasPanState;
  if (pan && pan.pointerId === event.pointerId) {
    pan.wrap.classList.remove('panning');
    window.relationshipCanvasPanState = null;
  }
  const lineDrag = window.relationshipLineDragState;
  if (lineDrag && lineDrag.pointerId === event.pointerId) {
    window.relationshipLineDragState = null;
    saveRelationshipDiagramState();
    drawRelationshipLines();
  }
  const drag = window.relationshipDragState;
  if (drag && drag.pointerId === event.pointerId) {
    drag.node.classList.remove('dragging');
    window.relationshipDragState = null;
    saveRelationshipDiagramState();
  }
  const connect = window.relationshipConnectState;
  if (connect && connect.pointerId === event.pointerId) {
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.relationship-port');
    document.querySelectorAll('.relationship-port.connecting,.relationship-port.drop-target').forEach(item => item.classList.remove('connecting', 'drop-target'));
    window.relationshipConnectState = null;
    drawRelationshipLines();
    if (target && target.dataset.table !== connect.sourceTable) {
      await createRelationshipFromPorts(connect, target.dataset);
    }
  }
}

function getRelationshipPointerPosition(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  const scale = getRelationshipCanvasZoom();
  return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
}

function getRelationshipCanvasZoom() {
  return Math.min(1.8, Math.max(0.45, Number(window.relationshipCanvasZoom) || 1));
}

function applyRelationshipCanvasZoom() {
  const canvas = document.getElementById('relationship-diagram-canvas');
  if (canvas) canvas.style.zoom = getRelationshipCanvasZoom();
}

function fitRelationshipCanvasToWrap() {
  const canvas = document.getElementById('relationship-diagram-canvas');
  const wrap = canvas?.closest('.relationship-canvas-wrap');
  if (!canvas || !wrap) return;
  const scale = getRelationshipCanvasZoom();
  const contentWidth = Number(canvas.dataset.contentWidth) || 760;
  const contentHeight = Number(canvas.dataset.contentHeight) || 480;
  canvas.style.width = `${Math.max(contentWidth, wrap.clientWidth / scale)}px`;
  canvas.style.height = `${Math.max(contentHeight, wrap.clientHeight / scale)}px`;
}

function handleRelationshipCanvasWheel(event) {
  const wrap = event.currentTarget;
  const canvas = document.getElementById('relationship-diagram-canvas');
  if (!canvas || !wrap.contains(event.target)) return;
  event.preventDefault();
  const oldScale = getRelationshipCanvasZoom();
  const nextScale = Math.min(1.8, Math.max(0.45, oldScale * (event.deltaY < 0 ? 1.1 : 0.9)));
  if (Math.abs(nextScale - oldScale) < 0.001) return;
  const rect = wrap.getBoundingClientRect();
  const cursorX = event.clientX - rect.left;
  const cursorY = event.clientY - rect.top;
  const logicalX = (wrap.scrollLeft + cursorX) / oldScale;
  const logicalY = (wrap.scrollTop + cursorY) / oldScale;
  window.relationshipCanvasZoom = nextScale;
  applyRelationshipCanvasZoom();
  fitRelationshipCanvasToWrap();
  wrap.scrollLeft = logicalX * nextScale - cursorX;
  wrap.scrollTop = logicalY * nextScale - cursorY;
  drawRelationshipLines();
}

function drawRelationshipLines() {
  const canvas = document.getElementById('relationship-diagram-canvas');
  const svg = document.getElementById('relationship-lines');
  if (!canvas || !svg) return;
  const canvasRect = canvas.getBoundingClientRect();
  const scale = getRelationshipCanvasZoom();
  svg.setAttribute('width', canvas.offsetWidth);
  svg.setAttribute('height', canvas.offsetHeight);
  const lines = window.tableRelationshipsData.map((relation, index) => {
    const source = Array.from(canvas.querySelectorAll('.relationship-table-node')).find(node => node.dataset.table === relation.sourceTable);
    const target = Array.from(canvas.querySelectorAll('.relationship-table-node')).find(node => node.dataset.table === relation.targetTable);
    if (!source || !target) return '';
    const a = source.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    const sourcePort = Array.from(source.querySelectorAll('.relationship-port.left')).find(port => port.dataset.column === relation.sourceColumn);
    const targetPort = Array.from(target.querySelectorAll('.relationship-port.left')).find(port => port.dataset.column === relation.targetColumn);
    const sourceRect = sourcePort?.getBoundingClientRect();
    const targetRect = targetPort?.getBoundingClientRect();
    const x1 = sourceRect ? (sourceRect.left - canvasRect.left + sourceRect.width / 2) / scale : (a.left - canvasRect.left + a.width / 2) / scale;
    const y1 = sourceRect ? (sourceRect.top - canvasRect.top + sourceRect.height / 2) / scale : (a.top - canvasRect.top + a.height / 2) / scale;
    const x2 = targetRect ? (targetRect.left - canvasRect.left + targetRect.width / 2) / scale : (b.left - canvasRect.left + b.width / 2) / scale;
    const y2 = targetRect ? (targetRect.top - canvasRect.top + targetRect.height / 2) / scale : (b.top - canvasRect.top + b.height / 2) / scale;
    const midX = (x1 + x2) / 2;
    const defaultControlY = (y1 + y2) / 2;
    const storedStyle = window.relationshipLineStyles[relation.id] || {};
    const controlX = Number.isFinite(Number(storedStyle.controlX)) ? Number(storedStyle.controlX) : midX;
    const controlY = Number.isFinite(Number(storedStyle.controlY)) ? Number(storedStyle.controlY) : defaultControlY;
    const curveMidX = (x1 + 2 * controlX + x2) / 4;
    const curveMidY = (y1 + 2 * controlY + y2) / 4;
    const pathData = `M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}`;
    return `<path d="${pathData}" class="relationship-line-hit" data-relationship-id="${escapeDictHtml(relation.id)}"/><path d="${pathData}" class="relationship-line relationship-line-${index % 4}" marker-end="url(#relation-arrow)"/><text x="${curveMidX}" y="${curveMidY - 10}" class="relationship-line-label">${escapeDictHtml(relation.relationType || '')}</text><g class="relationship-edge-action relationship-edge-edit" onclick="editTableRelationship('${encodeURIComponent(relation.id)}')"><circle cx="${curveMidX - 12}" cy="${curveMidY + 7}" r="9"></circle><text x="${curveMidX - 12}" y="${curveMidY + 10}">✎</text><title>Chỉnh sửa quan hệ</title></g><g class="relationship-edge-action relationship-edge-delete" onclick="deleteTableRelationship('${encodeURIComponent(relation.id)}')"><circle cx="${curveMidX + 12}" cy="${curveMidY + 7}" r="9"></circle><text x="${curveMidX + 12}" y="${curveMidY + 11}">×</text><title>Xóa quan hệ</title></g>`;
  }).join('');
  const connect = window.relationshipConnectState;
  const preview = connect ? `<path d="M ${connect.startX} ${connect.startY} C ${connect.startX + 55} ${connect.startY}, ${connect.currentX - 55} ${connect.currentY}, ${connect.currentX} ${connect.currentY}" class="relationship-line-preview"/>` : '';
  svg.innerHTML = `<defs><marker id="relation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"></path></marker></defs>${lines}${preview}`;
}

async function createRelationshipFromPorts(source, target) {
  const selectedRelationType = document.getElementById('relation-type')?.value || 'many-to-one';
  const payload = {
    sourceTable: source.sourceTable,
    sourceColumn: source.sourceColumn,
    targetTable: target.table,
    targetColumn: target.column,
    relationType: selectedRelationType,
    description: ''
  };
  try {
    const res = await fetch('/api/dictionary/relationships/add', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = data.relationships || [];
    renderRelationshipDiagram();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    if (typeof showToast === 'function') showToast(`${payload.sourceTable}.${payload.sourceColumn} → ${payload.targetTable}.${payload.targetColumn}`, 'success', 'Đã tạo quan hệ');
  } catch (err) {
    if (typeof showToast === 'function') showToast(err.message, 'error', 'Không thể tạo quan hệ');
  }
}

function renderRelationshipList() {
  const list = document.getElementById('relationship-list');
  const count = document.getElementById('relationship-count');
  if (count) count.textContent = window.tableRelationshipsData.length;
  if (!list) return;
  list.innerHTML = window.tableRelationshipsData.length ? window.tableRelationshipsData.map(relation => `<div class="relationship-list-item"><div><strong>${escapeDictHtml(relation.sourceTable)}.${escapeDictHtml(relation.sourceColumn)}</strong><span>${escapeDictHtml(relation.relationType)} → ${escapeDictHtml(relation.targetTable)}.${escapeDictHtml(relation.targetColumn)}</span></div><button class="icon-action-btn danger-soft" onclick="deleteTableRelationship('${encodeURIComponent(relation.id)}')" title="Xóa quan hệ"><i class="fa-solid fa-trash"></i></button></div>`).join('') : '<div class="relationship-list-empty">Chưa có quan hệ nào.</div>';
}

async function createTableRelationship() {
  const payload = {
    sourceTable: document.getElementById('relation-source-table')?.value,
    sourceColumn: document.getElementById('relation-source-column')?.value,
    targetTable: document.getElementById('relation-target-table')?.value,
    targetColumn: document.getElementById('relation-target-column')?.value,
    relationType: document.getElementById('relation-type')?.value,
    description: document.getElementById('relation-description')?.value.trim()
  };
  if (!payload.sourceTable || !payload.targetTable || !payload.sourceColumn || !payload.targetColumn) {
    if (typeof showToast === 'function') showToast('Hãy chọn đầy đủ bảng và cột.', 'warn');
    return;
  }
  try {
    const isEditing = !!window.editingTableRelationshipId;
    const endpoint = isEditing ? '/api/dictionary/relationships/update' : '/api/dictionary/relationships/add';
    const requestPayload = isEditing ? { id: window.editingTableRelationshipId, ...payload } : payload;
    const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestPayload) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = data.relationships || [];
    document.getElementById('relation-description').value = '';
    cancelEditTableRelationship();
    renderRelationshipDiagram();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    if (typeof showToast === 'function') showToast(isEditing ? 'Đã cập nhật quan hệ bảng.' : 'Đã tạo quan hệ giữa hai bảng.', 'success');
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể tạo quan hệ: ${err.message}`, 'error');
  }
}

function editTableRelationship(encodedId) {
  const id = decodeURIComponent(encodedId);
  const relation = window.tableRelationshipsData.find(item => item.id === id);
  if (!relation) return;
  [relation.sourceTable, relation.targetTable].forEach(tableName => {
    if (!window.relationshipDiagramTables.includes(tableName)) window.relationshipDiagramTables.push(tableName);
  });
  saveRelationshipDiagramState();
  populateRelationshipTableOptions();
  const sourceTable = document.getElementById('relation-source-table');
  const targetTable = document.getElementById('relation-target-table');
  if (sourceTable) sourceTable.value = relation.sourceTable;
  if (targetTable) targetTable.value = relation.targetTable;
  updateRelationshipColumnOptions('source');
  updateRelationshipColumnOptions('target');
  document.getElementById('relation-source-column').value = relation.sourceColumn;
  document.getElementById('relation-target-column').value = relation.targetColumn;
  document.getElementById('relation-type').value = relation.relationType || 'many-to-one';
  document.getElementById('relation-description').value = relation.description || '';
  window.editingTableRelationshipId = id;
  const saveButton = document.getElementById('relationship-save-button');
  const cancelButton = document.getElementById('relationship-cancel-edit');
  if (saveButton) saveButton.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Lưu chỉnh sửa';
  if (cancelButton) cancelButton.style.display = '';
  renderRelationshipDiagram();
}

function cancelEditTableRelationship() {
  window.editingTableRelationshipId = null;
  const saveButton = document.getElementById('relationship-save-button');
  const cancelButton = document.getElementById('relationship-cancel-edit');
  if (saveButton) saveButton.innerHTML = '<i class="fa-solid fa-plus"></i> Tạo quan hệ';
  if (cancelButton) cancelButton.style.display = 'none';
}

async function deleteTableRelationship(encodedId) {
  if (!await showUiConfirm('Xóa quan hệ bảng này?', { title: 'Xóa quan hệ bảng', confirmText: 'Xóa quan hệ', tone: 'danger' })) return;
  const relationshipId = decodeURIComponent(encodedId);
  try {
    const res = await fetch('/api/dictionary/relationships/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: relationshipId }) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = data.relationships || [];
    delete window.relationshipLineStyles[relationshipId];
    saveRelationshipDiagramState();
    renderRelationshipDiagram();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể xóa quan hệ: ${err.message}`, 'error');
  }
}

async function previewRelationshipPlan() {
  const question = document.getElementById('relationship-preview-question')?.value.trim() || '';
  const resultEl = document.getElementById('relationship-preview-result');
  const selectedTable = getDictionaryTables().find(table => window.relationshipDiagramTables.includes(table.tableName));
  if (!question) { showToast?.('Hãy nhập câu hỏi cần preview.', 'warning'); return; }
  try {
    const res = await fetch('/api/dictionary/relationships/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, dbSourceId: selectedTable?.dbSourceId || null }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.innerHTML = data.outcome === 'ready'
        ? `<strong>Ready</strong><span>${(data.tableRefs || []).map(ref => `${escapeDictHtml(ref.schemaName)}.${escapeDictHtml(ref.tableName)} <code>${escapeDictHtml(ref.alias)}</code>`).join(' → ')}</span>`
        : `<strong>${escapeDictHtml(data.outcome || 'no_path')}</strong><span>${escapeDictHtml(data.reason || 'Không xác định được đường JOIN.')}</span>`;
    }
  } catch (err) {
    if (resultEl) { resultEl.hidden = false; resultEl.textContent = err.message; }
  }
}

window.fetchDataDictionary = fetchDataDictionary;
window.renderDataDictionary = renderDataDictionary;
window.filterDictionaryTables = filterDictionaryTables;
window.filterTableStatus = filterTableStatus;
window.openDictionaryDrawer = openDictionaryDrawer;
window.closeDictionaryDrawer = closeDictionaryDrawer;
window.toggleSelectedDictionaryTableActive = toggleSelectedDictionaryTableActive;
window.toggleDictionaryTableActiveFromList = toggleDictionaryTableActiveFromList;
window.saveSelectedTableDescription = saveSelectedTableDescription;
window.saveDictionaryColumnDescription = saveDictionaryColumnDescription;
window.triggerAiGenerateDictionary = triggerAiGenerateDictionary;
window.openRelationshipDiagram = openRelationshipDiagram;
window.discoverDictionaryRelationships = discoverDictionaryRelationships;
window.closeRelationshipDiagram = closeRelationshipDiagram;
window.populateRelationshipTableOptions = populateRelationshipTableOptions;
window.updateRelationshipColumnOptions = updateRelationshipColumnOptions;
window.renderRelationshipDiagram = renderRelationshipDiagram;
window.resetRelationshipDiagramLayout = resetRelationshipDiagramLayout;
window.addTableToRelationshipDiagram = addTableToRelationshipDiagram;
window.removeTableFromRelationshipDiagram = removeTableFromRelationshipDiagram;
window.editTableRelationship = editTableRelationship;
window.cancelEditTableRelationship = cancelEditTableRelationship;
window.createTableRelationship = createTableRelationship;
window.deleteTableRelationship = deleteTableRelationship;
window.toggleFieldRelationshipEditor = toggleFieldRelationshipEditor;
window.updateFieldRelationshipColumns = updateFieldRelationshipColumns;
window.addFieldRelationshipPair = addFieldRelationshipPair;
window.toggleManyToManyFields = toggleManyToManyFields;
window.updateBridgeColumnOptions = updateBridgeColumnOptions;
window.cancelFieldRelationship = cancelFieldRelationship;
window.editFieldRelationship = editFieldRelationship;
window.saveFieldRelationship = saveFieldRelationship;
window.setFieldRelationshipStatus = setFieldRelationshipStatus;
window.profileFieldRelationship = profileFieldRelationship;
window.previewRelationshipPlan = previewRelationshipPlan;
