/**
 * Database Schema & Table Relationship Module
 */

window.groupedTablesData = [];
window.dictActiveFilter = 'active';
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

function scopeDictionaryMutationTables(tables) {
  const sourceId = window.dictionaryWorkspaceSource?.id;
  if (!sourceId) return tables;
  const existingIds = new Set(getDictionaryTables().map(table => table.tableId));
  return tables.filter(table => table.dbSourceId === sourceId || (!table.dbSourceId && existingIds.has(table.tableId)));
}

function scopeDictionaryMutationRelationships(relations) {
  if (!window.dictionaryWorkspaceSource?.id) return relations;
  const tables = getDictionaryTables();
  return relations.filter(relation => (!relation.dbSourceId || relation.dbSourceId === window.dictionaryWorkspaceSource.id) && ['source', 'target'].every(side =>
    tables.some(table => relation[side + 'TableId'] ? table.tableId === relation[side + 'TableId'] : table.tableName === relation[side + 'Table'])));
}

function findDictionaryTable(tableNameOrId) {
  return getDictionaryTables().find(t => t.tableId === tableNameOrId) || getDictionaryTables().find(t => t.tableName === tableNameOrId);
}

let dictionaryWorkspaceRequest = null;
let dictionaryWorkspaceGeneration = 0;
function fetchDataDictionary({ force = false } = {}) {
  if (dictionaryWorkspaceRequest && !force) return dictionaryWorkspaceRequest;
  const request = loadDictionaryWorkspace(++dictionaryWorkspaceGeneration).finally(() => { if (dictionaryWorkspaceRequest === request) dictionaryWorkspaceRequest = null; });
  dictionaryWorkspaceRequest = request;
  return dictionaryWorkspaceRequest;
}
async function loadDictionaryWorkspace(generation) {
  try {
    const res = await fetch('/api/dictionary/workspace', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (generation !== dictionaryWorkspaceGeneration) return false;
    if (!Array.isArray(data.tables) || !Array.isArray(data.relationships) || !data.domains || typeof data.domains !== 'object' || Array.isArray(data.domains))
      throw new Error('INVALID_DICTIONARY_WORKSPACE');
    if (window.dictionaryWorkspaceSource?.id !== data.source?.id) {
      window.selectedDictionaryTableName = null;
      window.selectedDictionaryTableId = null;
      window.dictionaryGraphSelection = null;
      window.dictionaryGraphHover = null;
      window.pendingDictionaryRelationships = [];
      window.pendingDictionaryRelationshipPreviews = [];
      if (window.paginationState?.dictionary) window.paginationState.dictionary.currentPage = 1;
      if (typeof document !== 'undefined') {
        const viewport = document.getElementById('dictionary-graph-viewport');
        if (viewport) delete viewport.dataset.graphCentered;
        document.getElementById('dictionary-graph-tooltip')?.remove();
        document.getElementById('dictionary-graph-mappings')?.remove();
        if (typeof closeDictionaryDrawer === 'function') closeDictionaryDrawer();
      }
    }
    window.dictionaryWorkspaceSource = data.source || null;
    if (typeof document !== 'undefined') {
      const label = document.getElementById('dictionary-current-source');
      if (label) label.textContent = data.source ? `Nguồn đang xem: ${data.source.dbName}` : 'Chưa có nguồn CSDL mặc định';
    }
    window.businessDomainsData = data.domains;
    window.tableRelationshipsData = data.relationships;
    window.groupedTablesData = data.tables;
    renderDictionaryQuality(data.quality);
    renderDictionaryDomainOptions();
    renderDataDictionary();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
  } catch (err) {
    if (generation !== dictionaryWorkspaceGeneration) return false;
    console.error('Lỗi nạp Lược đồ CSDL:', err);
    if (typeof showToast === 'function') showToast('Không thể nạp Lược đồ CSDL.', 'error');
    return false;
  }
}

const dictionaryQualityState = { rows: [], page: 1, pageSize: 6 };

function buildDictionaryQualityRows(quality, tables, relationships) {
  const byId = new Map(tables.map(table => [table.tableId, table]));
  const relations = new Map(relationships.map(relation => [relation.id, relation]));
  const rows = new Map();
  for (const table of quality?.tables || []) for (const issue of table.issues || []) {
    const isRelation = String(issue.field || '').startsWith('relationships.');
    const relationId = isRelation ? issue.field.slice('relationships.'.length) : null;
    const relation = relations.get(relationId);
    const sourceTable = byId.get(relation?.sourceTableId), targetTable = byId.get(relation?.targetTableId);
    if (relation && (relation.isActive === false || sourceTable?.isActive === false || targetTable?.isActive === false
      || (relation.columnPairs || []).some(pair => sourceTable?.columns?.find(column => column.columnName === pair.sourceColumn)?.isVisible === false
        || targetTable?.columns?.find(column => column.columnName === pair.targetColumn)?.isVisible === false)
      || (relation.displayColumn && targetTable?.columns?.find(column => column.columnName === relation.displayColumn)?.isVisible === false))) continue;
    const key = isRelation ? `relation:${relationId}` : JSON.stringify([table.tableId, issue.code, issue.field]);
    if (rows.has(key)) {
      const row = rows.get(key);
      if (!row.issues.some(item => item.code === issue.code)) row.issues.push(issue);
      if (issue.severity === 'error') row.severity = 'error';
      continue;
    }
    const source = byId.get(relation?.sourceTableId) || (!relation ? byId.get(table.tableId) : null);
    rows.set(key, { relationId, relation, source, target: byId.get(relation?.targetTableId), table, issues: [issue],
      kind: isRelation ? 'relationship' : 'configuration', severity: issue.severity });
  }
  return [...rows.values()].sort((a,b) => (a.severity === 'error' ? 0 : 1) - (b.severity === 'error' ? 0 : 1)
    || String(a.source?.tableName || a.table.tableName).localeCompare(String(b.source?.tableName || b.table.tableName), 'vi')
    || String(a.target?.tableName || '').localeCompare(String(b.target?.tableName || ''), 'vi'));
}

function renderDictionaryQuality(quality) {
  const summary = document.getElementById('dictionary-quality-summary');
  if (!summary) return;
  dictionaryQualityState.rows = buildDictionaryQualityRows(quality, getDictionaryTables(), window.tableRelationshipsData || []);
  const rows = dictionaryQualityState.rows;
  summary.textContent = quality
    ? `${rows.filter(row => row.kind === 'relationship').length} quan hệ cần kiểm tra · ${rows.filter(row => row.kind !== 'relationship').length} vấn đề bảng / cột · ${quality.activeTables} bảng đang bật`
    : 'Chưa có kết quả kiểm tra — hãy tải lại dữ liệu';
  const select = document.getElementById('dictionary-quality-table');
  if (select) {
    const previous = select.value;
    const involved = new Map();
    for (const row of rows) for (const table of [row.source, row.target]) if (table?.tableId) involved.set(table.tableId, table);
    select.innerHTML = '<option value="">Tất cả bảng</option>' + [...involved.values()].sort((a,b)=>a.tableName.localeCompare(b.tableName)).map(table =>
      `<option value="${escapeDictHtml(table.tableId)}">${escapeDictHtml(`${table.schemaName || 'dbo'}.${table.tableName}`)}${table.dbName ? ' · ' + escapeDictHtml(table.dbName) : ''}</option>`).join('');
    select.value = involved.has(previous) ? previous : '';
  }
  filterDictionaryQuality();
}

function filterDictionaryQuality() {
  dictionaryQualityState.page = 1;
  renderDictionaryQualityPage();
}
function pageDictionaryQuality(direction) {
  dictionaryQualityState.page += direction;
  renderDictionaryQualityPage();
  const results = document.getElementById('dictionary-quality-results');
  if (results) results.scrollTop = 0;
}
function renderDictionaryQualityPage() {
  const container = document.getElementById('dictionary-quality-results');
  if (!container) return;
  const normalize = value => String(value || '').normalize('NFD').split('').filter(char => char.charCodeAt(0) < 0x300 || char.charCodeAt(0) > 0x36f).join('').toLowerCase().replaceAll('đ','d');
  const search = normalize(document.getElementById('dictionary-quality-search')?.value).trim();
  const kind = document.getElementById('dictionary-quality-kind')?.value || 'all';
  const tableId = document.getElementById('dictionary-quality-table')?.value || '';
  const rows = dictionaryQualityState.rows.map((row,index)=>({...row,index})).filter(row =>
    (kind === 'all' || row.kind === kind || kind === 'error' && row.severity === 'error')
    && (!tableId || row.source?.tableId === tableId || row.target?.tableId === tableId)
    && (!search || normalize([row.source?.tableName,row.source?.semanticModel?.entity,row.target?.tableName,row.target?.semanticModel?.entity,
      row.relation?.businessRole,...(row.relation?.columnPairs || []).flatMap(pair=>[pair.sourceColumn,pair.targetColumn]),...row.issues.map(issue=>issue.message)].join(' ')).includes(search)));
  const pages = Math.max(1, Math.ceil(rows.length / dictionaryQualityState.pageSize));
  dictionaryQualityState.page = Math.max(1, Math.min(pages, dictionaryQualityState.page));
  const start = (dictionaryQualityState.page - 1) * dictionaryQualityState.pageSize;
  const statusLabels = { suggested: 'Chờ xác minh', stale: 'Cần xác minh lại', rejected: 'Đã từ chối', verified: 'Cấu hình liên kết có lỗi' };
  const cardinality = { 'many-to-one':'Nhiều → Một', 'one-to-many':'Một → Nhiều', 'one-to-one':'Một → Một', 'many-to-many':'Nhiều → Nhiều' };
  const tableLabel = (table, fallback) => `<span class="dictionary-quality-table-name"><strong>${escapeDictHtml(table?.tableName || fallback || 'Bảng không còn trong danh mục')}</strong><small>${escapeDictHtml(table?.semanticModel?.entity || (table ? `${table.schemaName || 'dbo'} · ${table.dbName || ''}` : 'Không thể xác định bảng'))}</small></span>`;
  container.innerHTML = rows.slice(start,start + dictionaryQualityState.pageSize).map(row => {
    const relation = row.relation;
    const title = row.kind === 'relationship'
      ? `<div class="dictionary-quality-path">${tableLabel(row.source,relation?.sourceTable)}<i class="fa-solid fa-arrow-right" aria-hidden="true"></i>${tableLabel(row.target,relation?.targetTable)}</div>`
      : `<div class="dictionary-quality-path">${tableLabel(row.source,row.table.tableName)}</div>`;
    const pairs = (relation?.columnPairs || []).map(pair=>`<span><code>${escapeDictHtml(pair.sourceColumn)}</code><span aria-label="liên kết với"> → </span><code>${escapeDictHtml(pair.targetColumn)}</code></span>`).join('');
    const field = {semanticModel:'Quy tắc nghiệp vụ',tableDescription:'Mô tả bảng',defaultMetric:'Chỉ tiêu mặc định',defaultTimeColumn:'Cột thời gian',defaultAggregation:'Phép tổng hợp',requiredFilters:'Bộ lọc bắt buộc'};
    const reason = row.kind === 'relationship'
      ? row.issues.filter(issue=>issue.code !== 'RELATIONSHIP_UNVERIFIED').map(issue=>issue.message).join(' ') || (relation?.status === 'stale' ? 'Cấu trúc đã thay đổi. Cần kiểm tra lại cặp khóa trước khi dùng cho AI.' : 'AI chưa dùng liên kết này. Cần kiểm tra cặp khóa và ý nghĩa nghiệp vụ.')
      : row.issues.map(issue=>`${field[issue.field] || (issue.field.startsWith('columns.') ? 'Cột ' + issue.field.slice(8) : 'Cấu hình nghiệp vụ')}: ${issue.message}`).join(' ');
    return `<article class="dictionary-quality-row ${row.severity === 'error' ? 'has-error' : ''}">
      <div class="dictionary-quality-row-main">${title}
        ${pairs ? `<div class="dictionary-quality-pairs">${pairs}</div>` : ''}
        ${relation?.businessRole ? `<div class="dictionary-quality-role">Vai trò: ${escapeDictHtml(relation.businessRole)}</div>` : ''}
        <p class="dictionary-quality-reason">${escapeDictHtml(reason)}</p>
      </div>
      <div class="dictionary-quality-row-status"><span class="dictionary-quality-badge ${row.severity === 'error' ? 'is-error' : ''}"><i class="fa-solid ${row.severity === 'error' ? 'fa-circle-exclamation' : 'fa-clock'}" aria-hidden="true"></i>${escapeDictHtml(row.kind === 'relationship' ? statusLabels[relation?.status] || 'Cần kiểm tra' : row.severity === 'error' ? 'Lỗi cấu hình' : 'Cần bổ sung')}</span>${relation ? `<small>${escapeDictHtml(cardinality[relation.cardinality || relation.relationType] || 'Chưa rõ số lượng liên kết')}</small>` : ''}</div>
      <button type="button" class="dictionary-quality-open" data-quality-index="${row.index}" ${!row.source ? 'disabled' : ''}>${row.kind === 'relationship' && relation ? 'Xem quan hệ' : 'Xem bảng'} <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></button>
    </article>`;
  }).join('') || '<div class="dictionary-quality-empty"><i class="fa-solid fa-circle-check" aria-hidden="true"></i><strong>Không có mục phù hợp</strong><span>Thử đổi bộ lọc hoặc tìm theo tên bảng, cột liên kết.</span></div>';
  container.onclick = event => {
    const button = event.target.closest('[data-quality-index]');
    if (button && container.contains(button)) openDictionaryQualityItem(Number(button.dataset.qualityIndex));
  };
  const count = document.getElementById('dictionary-quality-count');
  if (count) count.textContent = rows.length ? `${start + 1}–${Math.min(start + dictionaryQualityState.pageSize,rows.length)} / ${rows.length} mục · đã gộp quan hệ trùng` : '0 mục';
  const page = document.getElementById('dictionary-quality-page');
  if (page) page.textContent = `${dictionaryQualityState.page} / ${pages}`;
  const prev = document.getElementById('dictionary-quality-prev'), next = document.getElementById('dictionary-quality-next');
  if (prev) prev.disabled = dictionaryQualityState.page <= 1;
  if (next) next.disabled = dictionaryQualityState.page >= pages;
}

function openDictionaryQualityItem(index) {
  const row = dictionaryQualityState.rows[index];
  if (!row?.source) return;
  openDictionaryDrawer(encodeURIComponent(row.source.tableId || row.source.tableName));
  if (row.relation) {
    const column = row.relation.columnPairs?.[0]?.sourceColumn;
    if (column && row.source.columns?.some(item=>item.columnName === column)) {
      const content = getFieldRelationshipEditor(column)?.closest('.dictionary-field-relation-content');
      if (content?.hidden) toggleFieldRelationshipEditor(encodeURIComponent(column), content.parentElement?.querySelector('.dictionary-relation-toggle'));
      editFieldRelationship(encodeURIComponent(row.relation.id),encodeURIComponent(column));
      const editor = getFieldRelationshipEditor(column);
      editor?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      editor?.querySelector('[data-role="target-table"]')?.focus({ preventScroll: true });
    } else if (typeof showToast === 'function') showToast('Cột liên kết không còn tồn tại. Đã mở bảng nguồn để bạn kiểm tra cấu hình.', 'warn');
  }
}

function renderDictionaryDomainOptions(selectedValue) {
  const select = document.getElementById('dict-drawer-table-domain');
  if (!select) return;
  const current = selectedValue !== undefined ? selectedValue : select.value;
  const keys = Object.keys(window.businessDomainsData || {}).sort((a, b) => a.localeCompare(b));
  if (current && !keys.includes(current)) keys.push(current);
  select.innerHTML = '<option value="">Chưa gán lĩnh vực nghiệp vụ</option>' + keys
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

  container.innerHTML = `<table class="dictionary-catalog" aria-label="Danh sách bảng dữ liệu">
    <thead><tr><th scope="col" class="dictionary-catalog-toggle">Active</th><th scope="col">Bảng dữ liệu</th><th scope="col">Lĩnh vực nghiệp vụ</th><th scope="col" class="dictionary-catalog-count">Số cột</th><th scope="col">Trạng thái</th><th scope="col"><span class="dictionary-catalog-action-heading">Cấu trúc</span></th></tr></thead>
    <tbody>${paginatedTables.map(table => {
    const cols = table.columns || [];
    const isActive = !!table.isActive;
    const encodedId = encodeURIComponent(table.tableId || table.tableName || '');
    return `<tr class="${isActive ? 'is-active' : 'is-inactive'}">
      <td class="dictionary-catalog-toggle">
        <label class="quick-active-checkbox dictionary-quick-active" title="Bật/tắt bảng cho AI">
          <input type="checkbox" aria-label="Cho phép AI sử dụng bảng ${escapeDictHtml(table.tableName)}" ${isActive ? 'checked' : ''} onchange="toggleDictionaryTableActiveFromList('${encodedId}', this)">
          <span><i class="fa-solid fa-check"></i></span>
        </label>
      </td>
      <td class="dictionary-catalog-name"><button type="button" class="dictionary-catalog-open" onclick="openDictionaryDrawer('${encodedId}')">
        <span class="dictionary-catalog-copy"><strong>${escapeDictHtml(table.tableName)}</strong><span title="${escapeDictHtml(table.tableDescription || '')}">${escapeDictHtml(table.tableDescription || 'Chưa có mô tả nội dung')}</span></span>
      </button></td>
      <td data-label="Lĩnh vực nghiệp vụ">${table.domain ? `<span class="dictionary-catalog-domain">${escapeDictHtml(table.domain)}</span>` : '<span class="dictionary-catalog-unassigned">Chưa gán lĩnh vực</span>'}</td>
      <td class="dictionary-catalog-count" data-label="Số cột">${cols.length}</td>
      <td data-label="Trạng thái"><span class="dictionary-catalog-status ${isActive ? 'enabled' : 'disabled'}"><i class="fa-solid fa-circle"></i>${isActive ? 'Đang bật' : 'Đã tắt'}</span></td>
      <td class="dictionary-catalog-action"><button type="button" class="btn-secondary-sm" onclick="openDictionaryDrawer('${encodedId}')" aria-label="Xem cấu trúc bảng ${escapeDictHtml(table.tableName)}">Chi tiết <i class="fa-solid fa-chevron-right"></i></button></td>
    </tr>`;
  }).join('')}</tbody></table>`;

  renderPaginationControls('dict-pagination', 'dictionary', tables.length, renderDataDictionary);
}

function renderDictionaryDrawer(table) {
  const columnSearch = document.getElementById('dict-column-search');
  if (columnSearch) columnSearch.value = '';
  const columnEmpty = document.getElementById('dict-column-search-empty');
  if (columnEmpty) columnEmpty.hidden = true;
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
  const semantic = table.semanticModel || {};
  const requiredFiltersInput = document.getElementById('dict-required-filters');
  if (requiredFiltersInput) requiredFiltersInput.value = JSON.stringify(table.requiredFilters || [], null, 2);
  const currencyInput=document.getElementById('dict-semantic-currency');if(currencyInput)currencyInput.value=semantic.defaultCurrency||'VNĐ';
  const moneyInput=document.getElementById('dict-semantic-money-fields');if(moneyInput)moneyInput.value=(semantic.monetaryFields||[]).join(', ');
  const kindInput=document.getElementById('dict-semantic-kind');if(kindInput)kindInput.value=semantic.kind||'entity';
  const measuresInput=document.getElementById('dict-semantic-measures');if(measuresInput)measuresInput.value=JSON.stringify(semantic.measures||[],null,2);
  for (const [id,value] of Object.entries({entity:semantic.entity||'',grain:semantic.grain||'',identities:(semantic.identityFields||[]).join(', '),summary:(semantic.summaryFields||[]).join(', '),aliases:(semantic.aliases||[]).join(', '),segments:JSON.stringify(semantic.segments||[],null,2)})) {
    const input=document.getElementById('dict-semantic-'+id);if(input)input.value=value;
  }
  renderDictionaryDomainOptions(table.domain || '');
  const numericType = /^(?:tinyint|smallint|int|bigint|decimal|numeric|float|real|money|smallmoney)$/i;
  if (metricEl) metricEl.innerHTML = '<option value="">Tự động nhận diện</option>' + cols.filter(col => col.isVisible !== false && numericType.test(col.dataType) && !/id$/i.test(col.columnName)).map(col => `<option value="${escapeDictHtml(col.columnName)}">${escapeDictHtml(col.columnName)}</option>`).join('');
  if (timeEl) timeEl.innerHTML = '<option value="">Tự động nhận diện</option>' + cols.filter(col => col.isVisible !== false && /date|time/i.test(col.dataType)).map(col => `<option value="${escapeDictHtml(col.columnName)}">${escapeDictHtml(col.columnName)}</option>`).join('');
  if (metricEl) metricEl.value = table.defaultMetric || '';
  if (timeEl) timeEl.value = table.defaultTimeColumn || '';
  if (aggregationEl) aggregationEl.value = table.defaultAggregation || 'SUM';
  if (activeEl) activeEl.checked = !!table.isActive;
  if (countEl) countEl.textContent = `${cols.length} cột thuộc tính`;

  columnsEl.innerHTML = cols.map(col => {
    const encodedCol = encodeURIComponent(col.columnName || '');
    const relationships = getDictionaryRelationshipPreviews().filter(relation =>
      (relation.sourceTableId ? relation.sourceTableId === table.tableId : relation.sourceTable === table.tableName)
      && (relation.columnPairs || [{ sourceColumn: relation.sourceColumn }]).some(pair => pair.sourceColumn === col.columnName));
    const mappedRelationship = relationships.find(relation => relation.status !== 'rejected' && relation.businessRole && relation.displayColumn);
    return `
      <div class="dictionary-column-row ${col.isVisible === false ? 'is-excluded' : ''}">
        <div class="dictionary-column-visible" title="Đưa cột vào schema AI, truy vấn và vector Qdrant">
          <input type="checkbox" data-role="column-visible" data-column="${escapeDictHtml(col.columnName)}" aria-label="Cho phép AI sử dụng cột ${escapeDictHtml(col.columnName)}" ${col.isVisible !== false ? 'checked' : ''} onclick="event.stopPropagation()" onchange="toggleDictionaryColumnVisibility(this)">
        </div>
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
            ? `<div class="form-control dictionary-column-display-name dictionary-column-derived-name" title="Tên hiển thị lấy từ vai trò của quan hệ"><i class="fa-solid fa-link"></i><span>${escapeDictHtml(mappedRelationship.businessRole)}</span><small>Quan hệ</small></div>`
            : `<input class="form-control dictionary-column-display-name" data-column="${escapeDictHtml(col.columnName)}" value="${escapeDictHtml(col.displayName || '')}" placeholder="VD: Số HĐ">`}</label>
          <label><span>Mô tả cho AI</span><textarea class="form-control dictionary-column-description" data-column="${escapeDictHtml(col.columnName)}" rows="1" placeholder="Ý nghĩa nghiệp vụ của cột...">${escapeDictHtml(col.description || col.columnDescription || '')}</textarea></label>
        </div>
        <div class="dictionary-field-relations">
          <button class="dictionary-relation-toggle" type="button" aria-expanded="false" onclick="toggleFieldRelationshipEditor('${encodedCol}', this)">
            <i class="fa-solid fa-link"></i> Quan hệ <span>${relationships.length}</span><i class="fa-solid fa-chevron-down dictionary-relation-chevron"></i>
          </button>
          <div class="dictionary-field-relation-content" hidden>
          <div class="dictionary-field-relation-list">
            ${relationships.map(relation => `<div class="dictionary-field-relation-chip" data-relationship-id="${escapeDictHtml(relation.id)}" role="button" tabindex="0" onclick="editFieldRelationship('${encodeURIComponent(relation.id)}', '${encodedCol}')" onkeydown="if(event.key === 'Enter' || event.key === ' '){ event.preventDefault(); editFieldRelationship('${encodeURIComponent(relation.id)}', '${encodedCol}'); }">
              <div class="dictionary-relation-chip-info">
                <span class="dictionary-relation-path">${escapeDictHtml((relation.columnPairs || [{ sourceColumn: relation.sourceColumn, targetColumn: relation.targetColumn }]).map(pair => `${pair.sourceColumn} → ${pair.targetColumn}`).join(', '))} <strong>${escapeDictHtml(relation.targetTable)}</strong></span>
                ${relation.displayColumn ? `<span class="dictionary-relation-display"><i class="fa-regular fa-eye"></i>${escapeDictHtml(relation.displayColumn)}</span>` : ''}
                <small class="relationship-status relationship-status-${escapeDictHtml(relation.status || 'suggested')}">${escapeDictHtml(formatRelationshipCardinality(relation.cardinality || relation.relationType))} · ${escapeDictHtml(relation.status || 'suggested')}</small>
              </div>
              <div class="dictionary-relation-chip-actions">
                ${relation._pending ? `<button type="button" class="relation-action delete" onclick="event.stopPropagation(); discardPendingFieldRelationship('${encodeURIComponent(relation.id)}')" title="Bỏ thay đổi"><i class="fa-solid fa-trash-can"></i></button>` : `
                ${relation.status !== 'verified' ? `<button type="button" class="relation-action verify" onclick="event.stopPropagation(); setFieldRelationshipStatus('${encodeURIComponent(relation.id)}', 'verified', this)" title="Xác minh" aria-label="Xác minh quan hệ"><i class="fa-solid fa-check"></i></button>` : ''}
                ${relation.status !== 'rejected' ? `<button type="button" class="relation-action reject" onclick="event.stopPropagation(); setFieldRelationshipStatus('${encodeURIComponent(relation.id)}', 'rejected', this)" title="Từ chối" aria-label="Từ chối quan hệ"><i class="fa-solid fa-ban"></i></button>` : ''}
                <button type="button" class="relation-action delete" onclick="event.stopPropagation(); deleteFieldRelationship('${encodeURIComponent(relation.id)}')" title="Xóa"><i class="fa-solid fa-trash-can"></i></button>`}
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
              <label class="dictionary-preferred-option"><input data-role="preferred" type="checkbox"><span>Ưu tiên quan hệ này khi có nhiều đường JOIN tương đương</span></label>
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
            <p class="dictionary-relation-hint">Quan hệ tính từ <strong>${escapeDictHtml(table.tableName)}.${escapeDictHtml(col.columnName)}</strong> sang bảng đích. N:1 yêu cầu khóa đích duy nhất; 1:N yêu cầu khóa nguồn duy nhất; 1:1 yêu cầu cả hai phía duy nhất. Hệ thống sẽ kiểm tra bằng metadata hoặc kết quả profiling trước khi xác minh. N:N cần cấu hình qua bảng trung gian.</p>
            <div class="dictionary-relation-actions"><button type="button" class="btn-secondary-sm" onclick="cancelFieldRelationship('${encodedCol}')">Hủy</button><button type="button" class="btn-primary" onclick="saveFieldRelationship('${encodedCol}')"><i class="fa-solid fa-plus"></i> Thêm vào thay đổi</button></div>
          </div>
          </div>
        </div>
      </div>
      </div>
    `;
  }).join('');
}

function filterDictionaryColumns() {
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase();
  const query = normalize(document.getElementById('dict-column-search')?.value.trim());
  let visible = 0;
  document.querySelectorAll('#dict-drawer-columns > .dictionary-column-row').forEach(row => {
    const label = row.querySelector('.dictionary-column-display-name');
    const text = [row.querySelector('.dictionary-column-meta strong')?.textContent, label?.value || label?.textContent].join(' ');
    row.hidden = Boolean(query && !normalize(text).includes(query));
    if (!row.hidden) visible++;
  });
  const empty = document.getElementById('dict-column-search-empty');
  if (empty) empty.hidden = visible > 0 || !query;
}

function formatRelationshipCardinality(value) {
  return ({ 'one-to-one': '1:1', 'one-to-many': '1:N', 'many-to-one': 'N:1', 'many-to-many': 'N:N', unknown: '?' })[value] || value || '?';
}

function getDictionaryRelationshipPreviews() {
  const stored = window.tableRelationshipsData || [];
  const previews = window.pendingDictionaryRelationshipPreviews || [];
  const replacedIds = new Set(previews.map(item => item._storedId).filter(Boolean));
  return stored.filter(item => !replacedIds.has(item.id)).concat(previews);
}

function toggleDictionaryColumnVisibility(checkbox) {
  const row = checkbox?.closest('.dictionary-column-row');
  if (!row) return;
  row.classList.toggle('is-excluded', !checkbox.checked);
}

function renderRelationshipTargetTableOptions(sourceTable) {
  const options = getDictionaryTables().filter(table => table.isActive === true
    && table.dbName === sourceTable.dbName
    && (table.dbSourceId || null) === (sourceTable.dbSourceId || null));
  return '<option value="">Chọn bảng</option>' + options.map(table =>
    `<option value="${escapeDictHtml(table.tableId)}">${escapeDictHtml(`${table.schemaName || 'dbo'}.${table.tableName}`)}</option>`).join('');
}

function renderFieldRelationshipPair(sourceTable, sourceColumn = '', targetColumn = '', locked = false) {
  const sourceOptions = (sourceTable.columns || []).filter(column => column.isVisible !== false || column.columnName === sourceColumn)
    .map(column => `<option value="${escapeDictHtml(column.columnName)}" ${column.columnName === sourceColumn ? 'selected' : ''}>${escapeDictHtml(column.columnName)}</option>`).join('');
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
  const content = editor?.closest('.dictionary-field-relation-content');
  if (!editor || !content) return;
  const opening = content.hidden;
  content.hidden = !opening;
  button?.setAttribute('aria-expanded', String(opening));
  button?.classList.toggle('is-open', opening);
  if (!opening) editor.hidden = true;
  else {
    const relationships = getDictionaryRelationshipPreviews().filter(relation =>
    (relation.sourceTableId ? relation.sourceTableId === window.selectedDictionaryTableId : relation.sourceTable === window.selectedDictionaryTableName)
      && (relation.columnPairs || [{ sourceColumn: relation.sourceColumn }]).some(pair => pair.sourceColumn === columnName));
    if (relationships.length === 1) editFieldRelationship(encodeURIComponent(relationships[0].id), encodedColumnName);
    else if (relationships.length === 0) {
      cancelFieldRelationship(encodedColumnName);
      editor.hidden = false;
    }
  }
}

function updateFieldRelationshipColumns(select, selectedColumn = '') {
  const editor = select?.closest('.dictionary-field-relation-editor');
  const table = getDictionaryTables().find(item => item.tableId === select?.value);
  if (!editor) return;
  editor.querySelectorAll('[data-role="pair-target"]').forEach((columnSelect, index) => {
    const desired = index === 0 && selectedColumn ? selectedColumn : (columnSelect.dataset.selected || columnSelect.value);
    columnSelect.innerHTML = '<option value="">Chọn cột</option>' + (table?.columns || []).filter(column => column.isVisible !== false).map(column =>
      `<option value="${escapeDictHtml(column.columnName)}">${escapeDictHtml(column.columnName)} (${escapeDictHtml(column.dataType || '-')})</option>`).join('');
    columnSelect.value = desired;
    delete columnSelect.dataset.selected;
  });
  const displaySelect = editor.querySelector('[data-role="display-column"]');
  if (displaySelect) {
    const desired = Object.hasOwn(displaySelect.dataset, 'selected') ? displaySelect.dataset.selected : displaySelect.value;
    displaySelect.innerHTML = '<option value="">Chọn cột trả về</option>' + (table?.columns || []).filter(column => column.isVisible !== false).map(column =>
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
  const nextSourceColumn = sourceColumn || sourceTable.columns?.find(column => column.isVisible !== false && !usedSourceColumns.has(column.columnName))?.columnName;
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
  const options = '<option value="">Chọn cột</option>' + (bridge?.columns || []).filter(column => column.isVisible !== false).map(column =>
    `<option value="${escapeDictHtml(column.columnName)}">${escapeDictHtml(column.columnName)} (${escapeDictHtml(column.dataType || '-')})</option>`).join('');
  editor?.querySelectorAll('[data-role="bridge-source-column"],[data-role="bridge-target-column"]').forEach(item => { item.innerHTML = options; });
}

function cancelFieldRelationship(encodedColumnName) {
  const columnName = decodeURIComponent(encodedColumnName);
  const editor = getFieldRelationshipEditor(columnName);
  if (!editor) return;
  editor.querySelectorAll('input:not([data-role="pair-source"])').forEach(input => { input.value = ''; });
  const preferred = editor.querySelector('[data-role="preferred"]');
  if (preferred) preferred.checked = false;
  editor.querySelectorAll('select:not([data-role="pair-source"])').forEach(select => { select.selectedIndex = 0; });
  const fixedSource = editor.querySelector('[data-role="pair-source"]');
  if (fixedSource) fixedSource.value = columnName;
  editor.querySelectorAll('.dictionary-relation-pair:not(:first-child)').forEach(row => row.remove());
  const compositeOptions = editor.querySelector('.dictionary-composite-key-options');
  if (compositeOptions) compositeOptions.open = false;
  editor.hidden = true;
  editor.dataset.initialState = readFieldRelationshipState(editor);
}

function readFieldRelationshipState(editor) {
  return JSON.stringify(Array.from(editor.querySelectorAll('input[data-role], select[data-role]')).map(input =>
    [input.dataset.role, input.type === 'checkbox' ? input.checked : input.value]));
}

function stageDirtyFieldRelationships(columns = []) {
  const disabled = new Set(columns.filter(column=>column.isVisible === false).map(column=>column.columnName));
  for (const editor of document.querySelectorAll('#dictionary-drawer .dictionary-field-relation-editor')) {
    if (disabled.has(editor.dataset.column) || (!editor.dataset.initialState && editor.hidden)) continue;
    if (editor.dataset.initialState === readFieldRelationshipState(editor)) continue;
    if (!saveFieldRelationship(encodeURIComponent(editor.dataset.column), { silent: true })) return false;
  }
  return true;
}

function editFieldRelationship(encodedId, encodedColumnName) {
  const relation = getDictionaryRelationshipPreviews().find(item => item.id === decodeURIComponent(encodedId));
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
  editor.querySelector('[data-role="preferred"]').checked = relation.preferred === true;
  editor.dataset.initialState = readFieldRelationshipState(editor);
}

function saveFieldRelationship(encodedColumnName, options = {}) {
  const columnName = decodeURIComponent(encodedColumnName);
  const sourceTable = findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName);
  const editor = getFieldRelationshipEditor(columnName);
  if (!sourceTable || !editor) return;
  const saveButton = editor.querySelector('.dictionary-relation-actions .btn-primary');
  if (saveButton?.disabled) return;
  const editorRelationshipId = editor.querySelector('[data-role="relationship-id"]').value;
  const draftRelation = (window.pendingDictionaryRelationshipPreviews || []).find(item => item.id === editorRelationshipId);
  const id = draftRelation?._storedId || (draftRelation ? '' : editorRelationshipId);
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
    displayColumn: editor.querySelector('[data-role="display-column"]')?.value || '',
    preferred: editor.querySelector('[data-role="preferred"]')?.checked === true };
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
  const expectedRevision = id ? Number(editor.querySelector('[data-role="relationship-revision"]').value || 1) : undefined;
  if (id) { delete payload.id; delete payload.expectedRevision; }
  window.pendingDictionaryRelationships ||= [];
  const change = { id: id || null, expectedRevision, operation: endpoint.endsWith('add-many-to-many') ? 'many-to-many' : (id ? 'update' : 'add'), payload };
  const localId = draftRelation?.id || id || `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  change.localId = localId;
  const existingIndex = window.pendingDictionaryRelationships.findIndex(item => item.localId === localId || (id && item.id === id));
  if (existingIndex >= 0) window.pendingDictionaryRelationships[existingIndex] = change;
  else window.pendingDictionaryRelationships.push(change);
  const targetTable = findDictionaryTable(targetTableId);
  const previous = draftRelation || (window.tableRelationshipsData || []).find(item => item.id === id) || {};
  const preview = {
    ...previous,
    id: localId,
    _pending: true,
    _storedId: id || null,
    sourceTableId: sourceTable.tableId,
    sourceTable: sourceTable.tableName,
    targetTableId,
    targetTable: targetTable?.tableName || previous.targetTable || '',
    targetSchema: targetTable?.schemaName || previous.targetSchema || 'dbo',
    columnPairs,
    sourceColumn: columnPairs[0]?.sourceColumn || columnName,
    targetColumn: columnPairs[0]?.targetColumn || '',
    cardinality,
    relationType: cardinality,
    businessRole: payload.businessRole || '',
    displayColumn: payload.displayColumn || '',
    preferred: payload.preferred === true,
    status: previous.status || 'suggested'
  };
  window.pendingDictionaryRelationshipPreviews ||= [];
  const previewIndex = window.pendingDictionaryRelationshipPreviews.findIndex(item => item.id === localId);
  if (previewIndex >= 0) window.pendingDictionaryRelationshipPreviews[previewIndex] = preview;
  else window.pendingDictionaryRelationshipPreviews.push(preview);
  editor.querySelector('[data-role="relationship-id"]').value = localId;
  editor.dataset.initialState = readFieldRelationshipState(editor);
  if (!options.silent) {
    const list = editor.closest('.dictionary-field-relation-content')?.querySelector('.dictionary-field-relation-list');
    if (list) {
      const chip = Array.from(list.querySelectorAll('[data-relationship-id]')).find(item=>item.dataset.relationshipId === localId || item.dataset.relationshipId === editorRelationshipId);
      const markup = `<div class="dictionary-field-relation-chip" data-relationship-id="${escapeDictHtml(localId)}" role="button" tabindex="0" onclick="editFieldRelationship('${encodeURIComponent(localId)}', '${encodedColumnName}')" onkeydown="if(event.key === 'Enter' || event.key === ' '){event.preventDefault();editFieldRelationship('${encodeURIComponent(localId)}', '${encodedColumnName}');}"><div class="dictionary-relation-chip-info"><span class="dictionary-relation-path">${escapeDictHtml(columnPairs.map(pair=>`${pair.sourceColumn} → ${pair.targetColumn}`).join(', '))} <strong>${escapeDictHtml(preview.targetTable)}</strong></span>${preview.displayColumn ? `<span class="dictionary-relation-display"><i class="fa-regular fa-eye"></i>${escapeDictHtml(preview.displayColumn)}</span>` : ''}<small>Chờ lưu thay đổi</small></div></div>`;
      if (chip) chip.outerHTML = markup; else list.insertAdjacentHTML('beforeend', markup);
    }
    editor.hidden = true;
  }
  const saveAllButton = document.getElementById('dictionary-save-all-button');
  if (saveAllButton) saveAllButton.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Lưu tất cả thay đổi (${window.pendingDictionaryRelationships.length} quan hệ)`;
  if (!options.silent) showToast?.('Đã thêm quan hệ vào danh sách thay đổi. Nhấn “Lưu tất cả thay đổi” để áp dụng.', 'info');
  return true;
}

function discardPendingFieldRelationship(encodedId) {
  const id = decodeURIComponent(encodedId);
  window.pendingDictionaryRelationships = (window.pendingDictionaryRelationships || []).filter(item => item.localId !== id);
  window.pendingDictionaryRelationshipPreviews = (window.pendingDictionaryRelationshipPreviews || []).filter(item => item.id !== id);
  const sourceTable = findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName);
  if (sourceTable) renderDictionaryDrawer(sourceTable);
  const saveAllButton = document.getElementById('dictionary-save-all-button');
  if (saveAllButton) {
    const count = window.pendingDictionaryRelationships.length;
    saveAllButton.innerHTML = `<i class="fa-solid fa-floppy-disk"></i> Lưu tất cả thay đổi${count ? ` (${count} quan hệ)` : ''}`;
  }
}

const pendingRelationshipStatuses = new Set();
async function setFieldRelationshipStatus(encodedId, status, button = null) {
  const id = decodeURIComponent(encodedId);
  if (pendingRelationshipStatuses.has(id)) return;
  const relation = (window.tableRelationshipsData || []).find(item => item.id === id);
  const sourceTable = findDictionaryTable(window.selectedDictionaryTableId || window.selectedDictionaryTableName);
  if (!relation || !sourceTable) return;
  pendingRelationshipStatuses.add(id);
  const buttons = Array.from(document.querySelectorAll('.dictionary-field-relation-chip[data-relationship-id]'))
    .filter(chip=>chip.dataset.relationshipId === id).flatMap(chip=>Array.from(chip.querySelectorAll('.relation-action')));
  if (button && !buttons.includes(button)) buttons.push(button);
  const previous = buttons.map(node=>({node,disabled:node.disabled}));
  const buttonState = button ? {html:button.innerHTML,title:button.title,label:button.getAttribute('aria-label')} : null;
  previous.forEach(({node})=>{node.disabled=true;});
  if (button) {
    const label = status === 'verified' ? 'Đang xác minh…' : 'Đang xử lý…';
    button.innerHTML = `<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i><span>${label}</span>`;
    button.classList.add('is-processing');
    button.setAttribute('aria-busy','true');
    button.setAttribute('aria-label',label);
    button.title=label;
  }
  try {
    const res = await fetch('/api/dictionary/relationships/status', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status, expectedRevision: relation.revision || 1 }) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = scopeDictionaryMutationRelationships(data.relationships || []);
    renderDictionaryDrawer(sourceTable);
    showToast?.(status === 'verified' ? 'Đã xác minh quan hệ để AI có thể sử dụng.' : 'Đã từ chối quan hệ.', 'success');
    await fetchDataDictionary();
  } catch (err) {
    showToast?.(`Không thể cập nhật trạng thái: ${err.message}`, 'error');
  } finally {
    pendingRelationshipStatuses.delete(id);
    previous.forEach(({node,disabled})=>{node.disabled=disabled;});
    if (button) {
      button.innerHTML=buttonState.html;
      button.title=buttonState.title;
      button.classList.remove('is-processing');
      button.removeAttribute('aria-busy');
      if (buttonState.label === null) button.removeAttribute('aria-label'); else button.setAttribute('aria-label',buttonState.label);
    }
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
    window.tableRelationshipsData = scopeDictionaryMutationRelationships(data.relationships || []);
    delete window.relationshipLineStyles[id];
    saveRelationshipDiagramState();
    if (sourceTable) renderDictionaryDrawer(sourceTable);
    renderRelationshipDiagram();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    showToast?.('Đã xóa quan hệ.', 'success');
    await fetchDataDictionary();
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
    window.tableRelationshipsData = scopeDictionaryMutationRelationships(data.relationships || []);
    renderDictionaryDrawer(sourceTable);
    const profile = data.relationship?.evidence?.profile || {};
    showToast?.(`Kiểm tra xong: ${profile.orphanRows || 0} orphan, ${profile.duplicateTargetKeys || 0} khóa đích trùng.`, 'success');
    await fetchDataDictionary();
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
    if (typeof showToast === 'function') showToast(`Không thể tải lĩnh vực nghiệp vụ: ${err.message}`, 'error');
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
        <div class="domain-alias-chips">${aliasChips || '<span class="domain-alias-empty">Chưa có từ khóa tìm kiếm</span>'}</div>
      </div>
      <div class="domain-manager-item-actions">
        <button class="icon-action-btn" onclick="editBusinessDomain('${encodeURIComponent(domain)}')" title="Chỉnh sửa"><i class="fa-solid fa-pen"></i></button>
        <button class="icon-action-btn danger-soft" onclick="deleteBusinessDomain('${encodeURIComponent(domain)}')" title="Xóa"><i class="fa-regular fa-trash-can"></i></button>
      </div>
    </div>`;
  }).join('') : '<div class="dictionary-empty"><strong>Chưa có lĩnh vực nghiệp vụ.</strong></div>';
}

function editBusinessDomain(encodedDomain) {
  const domain = decodeURIComponent(encodedDomain);
  document.getElementById('domain-old-key').value = domain;
  document.getElementById('domain-key-input').value = domain;
  document.getElementById('domain-aliases-input').value = (window.businessDomainsData[domain] || []).join(', ');
  document.getElementById('domain-cancel-button').hidden = false;
  document.getElementById('domain-form-title').textContent = `Chỉnh sửa ${domain}`;
  document.getElementById('domain-form-subtitle').textContent = 'Cập nhật mã lĩnh vực hoặc từ khóa tìm kiếm dùng chung';
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
  if (title) title.textContent = 'Thêm lĩnh vực mới';
  if (subtitle) subtitle.textContent = 'Tạo một lĩnh vực nghiệp vụ và bộ từ khóa tìm kiếm dùng chung';
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
    showToast?.('Đã lưu lĩnh vực nghiệp vụ và đồng bộ cho AI.', 'success');
  } catch (err) {
    showToast?.(`Không thể lưu lĩnh vực nghiệp vụ: ${err.message}`, 'error');
  }
}

async function deleteBusinessDomain(encodedDomain) {
  const domain = decodeURIComponent(encodedDomain);
  const usedCount = getDictionaryTables().filter(table => table.domain === domain).length;
  const warning = usedCount ? `Nhóm "${domain}" đang được ${usedCount} bảng sử dụng. Chỉ xóa bộ từ khóa, domain trên bảng vẫn được giữ. Tiếp tục?` : `Xóa lĩnh vực nghiệp vụ "${domain}"?`;
  if (!await showUiConfirm(warning, { title: 'Xóa lĩnh vực nghiệp vụ', confirmText: 'Xóa lĩnh vực', tone: 'danger' })) return;
  try {
    const res = await fetch('/api/dictionary/domains/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ domain }) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.businessDomainsData = data.domains || {};
    renderBusinessDomains();
    renderDictionaryDomainOptions();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    showToast?.('Đã xóa lĩnh vực nghiệp vụ.', 'success');
  } catch (err) {
    showToast?.(`Không thể xóa lĩnh vực nghiệp vụ: ${err.message}`, 'error');
  }
}

function openDictionaryDrawer(encodedTableIdentity) {
  const tableIdentity = decodeURIComponent(encodedTableIdentity);
  const table = findDictionaryTable(tableIdentity);
  if (!table) return;
  window.dictionaryModalTrigger = document.activeElement;
  window.selectedDictionaryTableName = table.tableName;
  window.selectedDictionaryTableId = table.tableId;
  window.pendingDictionaryRelationships = [];
  window.pendingDictionaryRelationshipPreviews = [];
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
  const tableId = window.selectedDictionaryTableId;
  if (!tableName) return;
  try {
    const res = await fetch('/api/dictionary/toggle-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableId, tableName, isActive })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    const table = findDictionaryTable(tableId || tableName);
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
  const table = findDictionaryTable(decodeURIComponent(encodedTableName));
  if (!table) return;
  const { tableId, tableName } = table;
  const isActive = checkbox.checked;
  checkbox.disabled = true;
  try {
    const res = await fetch('/api/dictionary/toggle-active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableId, tableName, isActive })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
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

function reconcileDictionaryPresentation(model, columns) {
  if (!model) return [];
  const originalSummary = model.summaryFields;
  const disabled = new Set(columns.filter(column=>column.isVisible === false).map(column=>column.columnName));
  const removed = [];
  for (const field of ['summaryFields','monetaryFields']) {
    if (!Array.isArray(model[field])) continue;
    removed.push(...model[field].filter(name=>disabled.has(name)));
    model[field] = model[field].filter(name=>!disabled.has(name));
  }
  if (!model.summaryFields?.length && removed.length) {
    const identities = (model.identityFields || []).filter(name=>!disabled.has(name));
    model.summaryFields = identities.length ? identities : originalSummary;
  }
  return [...new Set(removed)];
}

async function saveSelectedTableDescription() {
  if (window.dictionarySavePending) return;
  const tableName = window.selectedDictionaryTableName;
  const tableId = window.selectedDictionaryTableId;
  if (!tableName) return;
  const table = {
    description: document.getElementById('dict-drawer-table-description')?.value.trim() || '',
    domain: document.getElementById('dict-drawer-table-domain')?.value.trim() || '',
    defaultMetric: document.getElementById('dict-drawer-default-metric')?.value || '',
    defaultTimeColumn: document.getElementById('dict-drawer-default-time')?.value || '',
    defaultAggregation: document.getElementById('dict-drawer-default-aggregation')?.value || 'SUM',
    isActive: document.getElementById('dict-drawer-active-toggle')?.checked !== false
  };
  const current = findDictionaryTable(tableId || tableName);
  try { table.requiredFilters = JSON.parse(document.getElementById('dict-required-filters')?.value || '[]'); }
  catch { showToast('Bộ lọc bắt buộc chưa đúng định dạng JSON.', 'error'); return; }
  const semanticEntity = document.getElementById('dict-semantic-entity')?.value.trim();
  if (semanticEntity) {
    const values = id => (document.getElementById('dict-semantic-'+id)?.value||'').split(',').map(v=>v.trim()).filter(Boolean);
    try {
      table.semanticModel = {version:1,entity:semanticEntity,kind:document.getElementById('dict-semantic-kind')?.value||'entity',grain:document.getElementById('dict-semantic-grain')?.value.trim()||'',
        defaultCurrency:document.getElementById('dict-semantic-currency')?.value.trim()||'VNĐ',monetaryFields:values('money-fields'),
        identityFields:values('identities'),summaryFields:values('summary'),aliases:values('aliases'),
        segments:JSON.parse(document.getElementById('dict-semantic-segments')?.value||'[]'),measures:JSON.parse(document.getElementById('dict-semantic-measures')?.value||'[]')};
    } catch { showToast('Cấu hình nhóm hoặc chỉ tiêu chưa đúng định dạng JSON.', 'error'); return; }
  } else if (current?.semanticModel) table.semanticModel = null;
  const columns = (current?.columns || []).map(column => {
    const description = Array.from(document.querySelectorAll('.dictionary-column-description')).find(el => el.dataset.column === column.columnName);
    const displayName = Array.from(document.querySelectorAll('.dictionary-column-display-name')).find(el => el.dataset.column === column.columnName);
    const visible = Array.from(document.querySelectorAll('[data-role="column-visible"]')).find(el => el.dataset.column === column.columnName);
    return { columnName: column.columnName, description: description?.value.trim() || '',
      displayName: typeof displayName?.value === 'string' ? displayName.value.trim() : (column.displayName || ''), isVisible: visible?.checked !== false };
  });
  const presentationAdjustments = reconcileDictionaryPresentation(table.semanticModel, columns);
  if (!stageDirtyFieldRelationships(columns)) return;
  const button = document.getElementById('dictionary-save-all-button');
  const controls = [...document.querySelectorAll('#dictionary-drawer .dictionary-drawer-body input, #dictionary-drawer .dictionary-drawer-body select, #dictionary-drawer .dictionary-drawer-body textarea, #dictionary-drawer .dictionary-drawer-body button')].map(node => ({ node, disabled: node.disabled }));
  try {
    window.dictionarySavePending = true;
    controls.forEach(({ node }) => { node.disabled = true; });
    if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...'; }
    const res = await fetch('/api/dictionary/save-table-configuration', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableId, tableName, table, columns, relationships: window.pendingDictionaryRelationships || [] }) });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    window.groupedTablesData = Array.isArray(data.tables) ? scopeDictionaryMutationTables(data.tables) : getDictionaryTables();
    window.tableRelationshipsData = Array.isArray(data.relationships) ? scopeDictionaryMutationRelationships(data.relationships) : window.tableRelationshipsData;
    renderDictionaryQuality(data.quality);
    window.invalidateRelatedTabData?.('schema');
    window.refreshDictionarySyncStatus?.();
    const stillSelected = (window.selectedDictionaryTableId || window.selectedDictionaryTableName) === (tableId || tableName);
    if (stillSelected) {
      window.pendingDictionaryRelationships = [];
      window.pendingDictionaryRelationshipPreviews = [];
    }
    renderDataDictionary();
    if (window.dictionaryView === 'graph' && typeof renderDictionaryGraph === 'function') renderDictionaryGraph();
    if (stillSelected) renderDictionaryDrawer(findDictionaryTable(tableId || tableName));
    const vectorMessage = data.vectorSync?.scheduled ? 'Đã lưu cấu hình. Đồng bộ vector đã được xếp hàng.' : data.vectorSync?.success === false ? 'Đã lưu cấu hình; đồng bộ vector chưa thành công.' : 'Đã lưu cấu hình bảng, cột và quan hệ.';
    const adjustedColumns = [...new Set([...presentationAdjustments,...(data.configurationAdjustments || []).flatMap(item=>item.columns || [])])];
    showToast?.(vectorMessage + (adjustedColumns.length ? ` Đã bỏ ${adjustedColumns.join(', ')} khỏi cấu hình hiển thị vì cột đã tắt.` : ''), data.vectorSync?.success === false ? 'warn' : 'success');
  } catch (err) {
    showToast?.(err.message === 'DATA_CONFLICT' ? 'Dữ liệu vừa được cập nhật ở thao tác khác. Thay đổi của bạn chưa được lưu; hãy tải lại và kiểm tra trước khi lưu lại.' : `Không thể lưu cấu hình: ${err.message}`, 'error');
  } finally {
    window.dictionarySavePending = false;
    controls.forEach(({ node, disabled }) => { if (node.isConnected) node.disabled = disabled; });
    if (button?.isConnected) { button.disabled = false; button.innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Lưu tất cả thay đổi'; }
  }
}

async function saveDictionaryColumnDescription(encodedColumnName) {
  const tableName = window.selectedDictionaryTableName;
  const tableId = window.selectedDictionaryTableId;
  const columnName = decodeURIComponent(encodedColumnName);
  const input = Array.from(document.querySelectorAll('.dictionary-column-description'))
    .find(el => el.dataset.column === columnName);
  const displayInput = Array.from(document.querySelectorAll('.dictionary-column-display-name'))
    .find(el => el.dataset.column === columnName);
  const description = input?.value.trim() || '';
  const currentColumn = findDictionaryTable(tableId || tableName)?.columns?.find(c => c.columnName === columnName);
  const displayName = displayInput ? displayInput.value.trim() : (currentColumn?.displayName || '');
  if (!tableName || !columnName) return;
  try {
    const res = await fetch('/api/dictionary/update-column', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableId, tableName, columnName, description, displayName })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    const table = findDictionaryTable(tableId || tableName);
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
  if (window.dictionarySyncSubmitting) return;
  window.dictionarySyncSubmitting = true;
  if (typeof showToast === 'function') showToast('Đang đồng bộ Lược đồ CSDL vào Qdrant...', 'info');
  try {
    const res = await fetch('/api/qdrant/sync', { method: 'POST' });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${res.status}`);
    if (typeof showToast === 'function') showToast(data.data?.scheduled ? 'Đã xếp hàng đồng bộ Lược đồ CSDL.' : 'Đã đồng bộ Lược đồ CSDL cho AI.', 'success');
    window.refreshDictionarySyncStatus?.();
  } catch (err) {
    if (typeof showToast === 'function') showToast(`Không thể đồng bộ Lược đồ CSDL: ${err.message}`, 'error');
  } finally { window.dictionarySyncSubmitting = false; }
}

function getActiveDictionaryTables() {
  return getDictionaryTables().filter(table => table.isActive);
}

function getVisibleDictionaryColumns(table) {
  return (table?.columns || []).filter(column => column.isVisible !== false);
}

async function openRelationshipDiagram() {
  loadRelationshipDiagramState();
  if (typeof openModal === 'function') openModal('relationship-diagram-modal');
  try {
    const res = await fetch('/api/dictionary/relationships');
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    window.tableRelationshipsData = scopeDictionaryMutationRelationships(Array.isArray(data) ? data : []);
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
    window.tableRelationshipsData = scopeDictionaryMutationRelationships(data.relationships || []);
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
  select.innerHTML = getVisibleDictionaryColumns(table).map(column => `<option value="${escapeDictHtml(column.columnName)}">${escapeDictHtml(column.columnName)}</option>`).join('');
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
  const nodeHeights = tables.map(table => 38 + Math.max(1, getVisibleDictionaryColumns(table).length) * 21 + 12);
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
    const visibleColumns = getVisibleDictionaryColumns(table);
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
      <header class="relationship-node-drag-handle"><strong>${escapeDictHtml(table.tableName)}</strong><span>${visibleColumns.length}</span><button class="relationship-node-remove" onpointerdown="event.stopPropagation()" onclick="removeTableFromRelationshipDiagram('${encodeURIComponent(table.tableName)}')" title="Bỏ khỏi sơ đồ"><i class="fa-solid fa-xmark"></i></button></header>
      <div class="relationship-node-columns">${visibleColumns.map(column => `<div class="relationship-node-column ${relationColumns.has(column.columnName) ? 'linked' : ''}"><button class="relationship-port left" data-table="${escapeDictHtml(table.tableName)}" data-column="${escapeDictHtml(column.columnName)}" title="Kéo để nối cột"></button><span>${escapeDictHtml(column.columnName)}</span><code>${escapeDictHtml(column.dataType || '-')}</code>${column.isPrimaryKey ? '<b>PK</b>' : relationColumns.has(column.columnName) ? '<b>FK</b>' : ''}</div>`).join('')}</div>
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
    if (!sourcePort || !targetPort) return '';
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
    window.tableRelationshipsData = scopeDictionaryMutationRelationships(data.relationships || []);
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
    window.tableRelationshipsData = scopeDictionaryMutationRelationships(data.relationships || []);
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
    window.tableRelationshipsData = scopeDictionaryMutationRelationships(data.relationships || []);
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
window.toggleDictionaryColumnVisibility = toggleDictionaryColumnVisibility;
window.setFieldRelationshipStatus = setFieldRelationshipStatus;
window.profileFieldRelationship = profileFieldRelationship;
window.previewRelationshipPlan = previewRelationshipPlan;

let dictionarySyncTimer = null;
let dictionarySyncRequest = null;
window.refreshDictionarySyncStatus = function () {
  if (dictionarySyncRequest) return dictionarySyncRequest;
  clearTimeout(dictionarySyncTimer);
  dictionarySyncRequest = (async () => {
    const panel = document.getElementById('dictionary-sync-status');
    if (!panel) return;
    try {
      const response = await fetch('/api/dictionary/sync-status', { cache: 'no-store' });
      if (!response.ok) throw new Error('STATUS_UNAVAILABLE');
      const state = await response.json();
      const messages = {
        pending: Number(state.attempts) > 0 ? 'Cấu hình đã lưu. Đồng bộ vector đang chờ thử lại.' : 'Cấu hình đã lưu. Đồng bộ vector đang chờ xử lý.',
        running: 'Cấu hình đã lưu. Đang đồng bộ vector…',
        failed: 'Cấu hình đã lưu; đồng bộ vector chưa thành công. Hãy kiểm tra nhật ký hệ thống.',
        disabled: 'Tìm kiếm từ khóa đang được sử dụng; embedding đang tắt.'
      };
      panel.hidden = !messages[state.status];
      panel.textContent = messages[state.status] || '';
      panel.dataset.state = state.status;
      if (['pending', 'running'].includes(state.status) && document.getElementById('view-dictionary')?.style.display !== 'none') {
        dictionarySyncTimer = setTimeout(() => window.refreshDictionarySyncStatus(), 3000);
      }
    } catch {
      panel.hidden = false;
      panel.textContent = 'Chưa thể kiểm tra trạng thái đồng bộ vector.';
      panel.dataset.state = 'unavailable';
    }
  })().finally(() => { dictionarySyncRequest = null; });
  return dictionarySyncRequest;
};
