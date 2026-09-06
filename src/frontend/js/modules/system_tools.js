window.systemToolsData = [];
window.systemToolsActiveGroup = 'all';

const SYSTEM_TOOL_GROUPS = {
  get_current_datetime: ['Tiện ích', 'fa-clock'],
  export_data: ['Dữ liệu', 'fa-file-export'],
  validate_sql: ['SQL', 'fa-shield-halved'],
  repair_sql: ['SQL', 'fa-screwdriver-wrench'],
  execute_sql_query: ['SQL', 'fa-database'],
  render_chart: ['Trực quan hóa', 'fa-chart-column'],
  calculate_stats: ['Tính toán', 'fa-calculator'],
  calculate_expression: ['Tính toán', 'fa-square-root-variable'],
  search_schema: ['Tra cứu', 'fa-table-list'],
  get_glossary_term: ['Tra cứu', 'fa-spell-check'],
  search_knowledge_base: ['Tri thức', 'fa-book-open']
};

function escapeSystemToolHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getSystemToolMeta(tool) {
  const [group, icon] = SYSTEM_TOOL_GROUPS[tool.name] || ['Khác', 'fa-wrench'];
  return { group, icon };
}

async function fetchSystemTools(showNotice = false) {
  const grid = document.getElementById('system-tools-grid');
  if (grid) grid.innerHTML = '<div class="system-tools-loading"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải danh sách tool...</div>';
  try {
    const response = await fetch('/api/tools');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
    window.systemToolsData = Array.isArray(payload.tools) ? payload.tools : [];
    renderSystemToolFilters();
    renderSystemTools();
    if (showNotice && typeof showToast === 'function') showToast('Danh sách tool đã được cập nhật.', 'success', 'Tải lại thành công');
  } catch (error) {
    console.error('Không thể tải system tools:', error);
    if (grid) grid.innerHTML = `<div class="system-tools-empty"><i class="fa-solid fa-triangle-exclamation"></i><strong>Không thể tải danh sách tool</strong><span>${escapeSystemToolHtml(error.message)}</span></div>`;
    if (typeof showToast === 'function') showToast(error.message, 'error', 'Không thể tải công cụ');
  }
}

function renderSystemToolFilters() {
  const root = document.getElementById('system-tools-filters');
  if (!root) return;
  const groups = [...new Set(window.systemToolsData.map(tool => getSystemToolMeta(tool).group))];
  root.innerHTML = ['all', ...groups].map(group => {
    const label = group === 'all' ? 'Tất cả' : group;
    return `<button type="button" class="${window.systemToolsActiveGroup === group ? 'active' : ''}" onclick="setSystemToolGroup('${escapeSystemToolHtml(group)}')">${escapeSystemToolHtml(label)}</button>`;
  }).join('');
}

function setSystemToolGroup(group) {
  window.systemToolsActiveGroup = group;
  renderSystemToolFilters();
  renderSystemTools();
}

function renderSystemTools() {
  const grid = document.getElementById('system-tools-grid');
  if (!grid) return;
  const query = String(document.getElementById('system-tools-search')?.value || '').trim().toLowerCase();
  const tools = window.systemToolsData.filter(tool => {
    const meta = getSystemToolMeta(tool);
    const matchesGroup = window.systemToolsActiveGroup === 'all' || meta.group === window.systemToolsActiveGroup;
    const matchesQuery = !query || `${tool.name} ${tool.description} ${meta.group}`.toLowerCase().includes(query);
    return matchesGroup && matchesQuery;
  });
  const allGroups = new Set(window.systemToolsData.map(tool => getSystemToolMeta(tool).group));
  const total = document.getElementById('system-tools-total');
  const available = document.getElementById('system-tools-available');
  const groups = document.getElementById('system-tools-groups');
  if (total) total.textContent = window.systemToolsData.length;
  if (available) available.textContent = window.systemToolsData.length;
  if (groups) groups.textContent = allGroups.size;

  if (!tools.length) {
    grid.innerHTML = '<div class="system-tools-empty"><i class="fa-solid fa-magnifying-glass"></i><strong>Không tìm thấy tool phù hợp</strong><span>Thử từ khóa hoặc nhóm chức năng khác.</span></div>';
    return;
  }
  grid.innerHTML = tools.map(tool => {
    const meta = getSystemToolMeta(tool);
    const properties = tool.parameters?.properties || {};
    const required = new Set(tool.parameters?.required || []);
    const params = Object.entries(properties);
    return `<article class="system-tool-item">
      <div class="system-tool-head">
        <span class="system-tool-icon"><i class="fa-solid ${meta.icon}"></i></span>
        <div><code>${escapeSystemToolHtml(tool.name)}</code><span>${escapeSystemToolHtml(meta.group)}</span></div>
        <span class="system-tool-status"><i class="fa-solid fa-circle-check"></i> Khả dụng</span>
      </div>
      <p>${escapeSystemToolHtml(tool.description || 'Chưa có mô tả.')}</p>
      <div class="system-tool-foot">
        <span><i class="fa-solid fa-sliders"></i> ${params.length} tham số</span>
        <button type="button" onclick="toggleSystemToolDetails(this)">Xem input schema <i class="fa-solid fa-chevron-down"></i></button>
      </div>
      <div class="system-tool-schema" hidden>
        ${params.length ? params.map(([name, schema]) => `<div><code>${escapeSystemToolHtml(name)}</code><span>${escapeSystemToolHtml(schema.type || 'any')}${required.has(name) ? ' · bắt buộc' : ' · tùy chọn'}</span><p>${escapeSystemToolHtml(schema.description || '')}</p></div>`).join('') : '<span>Tool này không yêu cầu tham số.</span>'}
      </div>
    </article>`;
  }).join('');
}

function toggleSystemToolDetails(button) {
  const schema = button.closest('.system-tool-item')?.querySelector('.system-tool-schema');
  if (!schema) return;
  schema.hidden = !schema.hidden;
  button.classList.toggle('expanded', !schema.hidden);
}

window.fetchSystemTools = fetchSystemTools;
window.renderSystemTools = renderSystemTools;
window.setSystemToolGroup = setSystemToolGroup;
window.toggleSystemToolDetails = toggleSystemToolDetails;
