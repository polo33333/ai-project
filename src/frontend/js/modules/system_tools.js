window.systemToolsData = [];
window.systemToolsActiveGroup = 'all';
window.systemToolsCanManage = false;
const systemToolsSaving = new Set();
const SYSTEM_TOOL_TITLES = {
  get_join_path: 'Tra cứu đường nối bảng', resolve_date_range: 'Xác định khoảng thời gian', read_context_result: 'Đọc kết quả trong ngữ cảnh',
  recall_memory: 'Tra cứu bộ nhớ', remember_preference: 'Lưu tùy chọn', forget_memory: 'Xóa bộ nhớ',
  list_workflows: 'Khám phá luồng công việc', run_workflow: 'Chạy luồng công việc', get_workflow_status: 'Theo dõi tiến độ', resume_workflow: 'Tiếp tục công việc', cancel_workflow: 'Hủy công việc', get_workflow_dataset: 'Kết quả công việc',
  list_sql_metrics: 'Danh mục chỉ tiêu', query_sql_metric: 'Truy vấn chỉ tiêu', get_current_datetime: 'Ngày và giờ', export_data: 'Xuất dữ liệu',
  validate_sql: 'Kiểm tra SQL', repair_sql: 'Sửa truy vấn SQL', execute_sql_query: 'Truy vấn dữ liệu', render_chart: 'Vẽ biểu đồ', calculate_stats: 'Thống kê số liệu', calculate_expression: 'Tính biểu thức', search_schema: 'Tra cứu cấu trúc dữ liệu', get_glossary_term: 'Từ điển nghiệp vụ', search_knowledge_base: 'Tìm kiếm tri thức'
};

const SYSTEM_TOOL_GROUPS = {
  get_join_path: ['SQL', 'fa-diagram-project'],
  resolve_date_range: ['Tiện ích', 'fa-calendar-days'],
  read_context_result: ['Dữ liệu', 'fa-table'],
  recall_memory: ['Bộ nhớ', 'fa-brain'],
  remember_preference: ['Bộ nhớ', 'fa-bookmark'],
  forget_memory: ['Bộ nhớ', 'fa-eraser'],
  list_workflows: ['Luồng công việc', 'fa-diagram-project'],
  run_workflow: ['Luồng công việc', 'fa-play'],
  get_workflow_status: ['Luồng công việc', 'fa-list-check'],
  resume_workflow: ['Luồng công việc', 'fa-forward'],
  cancel_workflow: ['Luồng công việc', 'fa-stop'],
  get_workflow_dataset: ['Dữ liệu', 'fa-table'],
  list_sql_metrics: ['SQL', 'fa-list-check'],
  query_sql_metric: ['SQL', 'fa-database'],
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

const SYSTEM_TOOL_DESCRIPTIONS = {
  get_join_path: 'Tra cứu đường nối bảng đã xác minh trong danh mục, kể cả qua bảng trung gian. Trả về cặp cột nối, quan hệ một–nhiều và cảnh báo nguy cơ cộng trùng khi tổng hợp; báo rõ khi thiếu hoặc có nhiều đường nối.',
  resolve_date_range: 'Xác định ngày bắt đầu và ngày kết thúc của khoảng thời gian theo ngày, tuần, tháng, quý hoặc năm trong múi giờ được chọn. Bao gồm ngày bắt đầu, không bao gồm ngày kết thúc; tuần bắt đầu vào thứ Hai.',
  read_context_result: 'Đọc các dòng và cột cụ thể từ kết quả đã được cấp quyền trong yêu cầu hiện tại. Hỗ trợ phân trang; không dùng một trang kết quả để tính tổng cho toàn bộ dữ liệu.',
  list_workflows: 'Liệt kê các luồng công việc được phép sử dụng và các lượt chạy đang chờ trong hội thoại hiện tại. Cung cấp thông tin đầu vào để chọn đúng luồng, có hỗ trợ phân trang.',
  run_workflow: 'Khởi chạy một luồng công việc đã xuất bản và được cấp quyền trong hội thoại hiện tại. Trả về mã lượt chạy và trạng thái ngay sau khi khởi chạy.',
  get_workflow_status: 'Xem trạng thái và phiên bản hiện tại của lượt chạy thuộc quyền truy cập. Cần lấy phiên bản mới nhất trước khi tiếp tục hoặc hủy lượt chạy.',
  resume_workflow: 'Tiếp tục lượt chạy thuộc quyền truy cập bằng cách bổ sung đầu vào còn thiếu. Sử dụng phiên bản hiện tại để tránh cập nhật trùng hoặc ghi đè trạng thái mới.',
  cancel_workflow: 'Hủy lượt chạy thuộc quyền truy cập. Sử dụng phiên bản hiện tại để tránh hủy dựa trên trạng thái đã cũ.',
  list_sql_metrics: 'Liệt kê các chỉ tiêu SQL đã được chủ nghiệp vụ phê duyệt, gồm nguồn dữ liệu, đơn vị, mức tổng hợp và quy tắc thời gian. Xem định nghĩa trước khi truy vấn chỉ tiêu.',
  query_sql_metric: 'Truy vấn một phiên bản chỉ tiêu SQL đã được phê duyệt theo khoảng thời gian và các chiều phân nhóm được phép. Bao gồm ngày bắt đầu, không bao gồm ngày kết thúc; không hỗ trợ SQL tùy ý hoặc nối bảng.',
  get_workflow_dataset: 'Đọc dữ liệu kết quả đã được xác minh từ luồng công việc hoàn thành trong hội thoại hiện tại. Kết quả có phân trang; kiểm tra tổng số dòng và thông tin còn trang tiếp theo để tránh nhầm bản xem trước với toàn bộ dữ liệu.'
};

function escapeSystemToolHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getSystemToolMeta(tool) {
  const [group, icon] = SYSTEM_TOOL_GROUPS[tool.name] || ['Khác', 'fa-wrench'];
  return { group, icon, title: SYSTEM_TOOL_TITLES[tool.name] || tool.name, description: SYSTEM_TOOL_DESCRIPTIONS[tool.name] || tool.description || 'Chưa có mô tả.' };
}

async function fetchSystemTools(showNotice = false) {
  const grid = document.getElementById('system-tools-grid');
  if (grid) grid.innerHTML = '<div class="system-tools-loading"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải danh sách tool...</div>';
  try {
    const response = await fetch('/api/tools');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || `HTTP ${response.status}`);
    window.systemToolsData = Array.isArray(payload.tools) ? payload.tools : [];
    window.systemToolsCanManage = payload.canManage === true;
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
  if (!groups.includes(window.systemToolsActiveGroup)) window.systemToolsActiveGroup = 'all';
  root.innerHTML = ['all', ...groups].map(group => {
    const label = group === 'all' ? 'Tất cả nhóm' : group;
    return '<option value="' + escapeSystemToolHtml(group) + '">' + escapeSystemToolHtml(label) + '</option>';
  }).join('');
  root.value = window.systemToolsActiveGroup;
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
    const matchesQuery = !query || `${tool.name} ${meta.title} ${tool.description} ${meta.description} ${meta.group}`.toLowerCase().includes(query);
    return matchesGroup && matchesQuery;
  });
  const allGroups = new Set(window.systemToolsData.map(tool => getSystemToolMeta(tool).group));
  const total = document.getElementById('system-tools-total');
  const available = document.getElementById('system-tools-available');
  const groups = document.getElementById('system-tools-groups');
  if (total) total.textContent = window.systemToolsData.length;
  const matched = document.getElementById('system-tools-matched');
  if (matched) matched.textContent = tools.length;
  if (available) available.textContent = window.systemToolsData.filter(tool => tool.enabled !== false).length;
  if (groups) groups.textContent = allGroups.size;

  if (!tools.length) {
    grid.innerHTML = '<div class="system-tools-empty"><i class="fa-solid fa-magnifying-glass"></i><strong>Không tìm thấy tool phù hợp</strong><span>Thử từ khóa hoặc nhóm chức năng khác.</span></div>';
    return;
  }
  grid.innerHTML = tools.map((tool, index) => {
    const meta = getSystemToolMeta(tool);
    const properties = tool.parameters?.properties || {};
    const params = Object.entries(properties);
    const enabled = tool.enabled !== false;
    return `<article class="system-tool-item" data-group="${escapeSystemToolHtml(meta.group)}">
      <div class="system-tool-head">
        <span class="system-tool-icon"><i class="fa-solid ${meta.icon}"></i></span>
        <div class="system-tool-identity"><h3 title="${escapeSystemToolHtml(meta.title)}">${escapeSystemToolHtml(meta.title)}</h3><code title="${escapeSystemToolHtml(tool.name)}">${escapeSystemToolHtml(tool.name)}</code></div>
        <button type="button" class="system-tool-availability ${enabled ? 'is-available' : ''}" role="switch" aria-checked="${enabled}" aria-label="Bật/tắt ${escapeSystemToolHtml(meta.title)}" data-tool="${escapeSystemToolHtml(tool.name)}" title="${window.systemToolsCanManage ? 'Bật/tắt tool cho toàn hệ thống' : 'Chỉ quản trị viên được thay đổi'}" ${!window.systemToolsCanManage || systemToolsSaving.has(tool.name) ? 'disabled' : ''} onclick="setSystemToolEnabled(this)"></button>
      </div>
      <p title="${escapeSystemToolHtml(meta.description)}">${escapeSystemToolHtml(meta.description)}</p>
      <div class="system-tool-tags"><span>${escapeSystemToolHtml(meta.group)}</span><span>${params.length} tham số</span></div>
      <div class="system-tool-foot">
        <span class="system-tool-state ${enabled ? 'is-available' : ''}"><i class="fa-solid fa-circle"></i> ${enabled ? 'Đang bật' : 'Đã tắt'}</span>
        <button type="button" aria-expanded="false" aria-haspopup="dialog" onclick="toggleSystemToolDetails(this)">Xem chi tiết <i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i></button>
      </div>
    </article>`;
  }).join('');
}

const SYSTEM_TOOL_PARAMETER_HELP = {
  get_join_path: {
    fromTable: ['Bảng nguồn', 'Tên bảng, schema.tên bảng hoặc mã bảng trong danh mục.'],
    toTable: ['Bảng đích', 'Bảng cần tìm đường nối tới từ bảng nguồn.'],
    maxHops: ['Số bước nối tối đa', 'Mặc định 3 bước nối; có thể đi qua bảng trung gian.']
  },
  resolve_date_range: {
    unit: ['Đơn vị thời gian', 'day: ngày · week: tuần · month: tháng · quarter: quý · year: năm.'],
    offset: ['Độ lệch kỳ', 'Mặc định 0: kỳ hiện tại; -1: kỳ trước; 1: kỳ tiếp theo.'],
    count: ['Số kỳ liên tiếp', 'Mặc định 1. Các kỳ liên tiếp kết thúc ở kỳ được chọn bằng độ lệch.'],
    timezone: ['Múi giờ', 'Tên múi giờ IANA. Mặc định Asia/Ho_Chi_Minh (giờ Việt Nam).']
  },
  read_context_result: {
    resultId: ['Mã kết quả', 'Mã kết quả được trả về từ công cụ trước trong yêu cầu hiện tại.'],
    offset: ['Vị trí bắt đầu', 'Số dòng bỏ qua, tính từ 0. Mặc định 0.'],
    limit: ['Số dòng cần đọc', 'Mỗi lần đọc từ 1 đến 20 dòng. Mặc định 10.'],
    columns: ['Các cột cần đọc', 'Danh sách tên cột cụ thể. Bỏ trống để đọc các cột có sẵn.']
  }
};

function renderSystemToolParameter(tool, name, schema, required) {
  const esc = escapeSystemToolHtml;
  const [label, help] = SYSTEM_TOOL_PARAMETER_HELP[tool.name]?.[name] || [name, schema.description || ''];
  const types = { string: 'Văn bản', integer: 'Số nguyên', number: 'Số', boolean: 'Đúng / sai', array: 'Danh sách', object: 'Đối tượng' };
  const constraints = [];
  if (schema.minimum !== undefined) constraints.push(`Tối thiểu: ${schema.minimum}`);
  if (schema.maximum !== undefined) constraints.push(`Tối đa: ${schema.maximum}`);
  if (schema.maxItems !== undefined) constraints.push(`Tối đa ${schema.maxItems} phần tử`);
  if (schema.default !== undefined) constraints.push(`Mặc định: ${JSON.stringify(schema.default)}`);
  return `<section class="system-tool-param">
    <div class="system-tool-param-heading"><div><strong>${esc(label)}</strong><code>${esc(name)}</code></div><span class="system-tool-param-badge ${required ? 'is-required' : ''}">${required ? 'Bắt buộc' : 'Tùy chọn'}</span></div>
    ${help ? `<p>${esc(help)}</p>` : ''}
    <div class="system-tool-param-meta"><span>${esc(types[schema.type] || schema.type || 'Theo cấu trúc')}</span>${constraints.map(c => `<span>${esc(c)}</span>`).join('')}</div>
    ${schema.enum ? `<div class="system-tool-param-values">${schema.enum.map(v => `<code>${esc(v)}</code>`).join('')}</div>` : ''}
    ${schema.properties || schema.items || schema.anyOf || schema.oneOf ? `<details><summary>Cấu trúc dữ liệu</summary><pre>${esc(JSON.stringify(schema, null, 2))}</pre></details>` : ''}
  </section>`;
}

function toggleSystemToolDetails(button) {
  const name = button.closest('.system-tool-item')?.querySelector('[data-tool]')?.dataset.tool;
  const tool = window.systemToolsData.find(item => item.name === name);
  const root = document.getElementById('view-system-tools');
  if (!tool || !root) return;
  let dialog = document.getElementById('system-tool-detail-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'system-tool-detail-dialog';
    dialog.className = 'system-tool-detail-dialog';
    dialog.setAttribute('aria-labelledby', 'system-tool-detail-title');
    root.appendChild(dialog);
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  }
  const meta = getSystemToolMeta(tool), esc = escapeSystemToolHtml;
  const params = Object.entries(tool.parameters?.properties || {});
  const required = new Set(tool.parameters?.required || []);
  dialog.innerHTML = `<header><div><span class="system-tool-detail-group">${esc(meta.group)}</span><h2 id="system-tool-detail-title">${esc(meta.title)}</h2><code>${esc(tool.name)}</code></div><button type="button" autofocus aria-label="Đóng chi tiết"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button></header>
    <div class="system-tool-detail-body"><p class="system-tool-detail-description">${esc(meta.description)}</p><h3>Tham số đầu vào <span>${params.length}</span></h3>
    <div class="system-tool-param-list">${params.length ? params.map(([name, schema]) => renderSystemToolParameter(tool, name, schema, required.has(name))).join('') : '<p>Công cụ này không yêu cầu tham số.</p>'}</div></div>
    <footer><span><i class="fa-solid fa-circle-info" aria-hidden="true"></i> AI Agent sử dụng tên kỹ thuật và tham số bên trên.</span><button type="button">Đóng</button></footer>`;
  dialog.querySelectorAll('header button, footer button').forEach(close => close.addEventListener('click', () => dialog.close()));
  dialog.onclose = () => { button.setAttribute('aria-expanded', 'false'); if (button.isConnected) button.focus(); };
  button.setAttribute('aria-controls', dialog.id);
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'true');
  dialog.showModal();
}

async function setSystemToolEnabled(button) {
  const name = button.dataset.tool;
  const tool = window.systemToolsData.find(item => item.name === name);
  if (!tool || !window.systemToolsCanManage || systemToolsSaving.has(name)) return;
  const expectedEnabled = tool.enabled !== false;
  systemToolsSaving.add(name);
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/tools/state', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolName: name, enabled: !expectedEnabled, expectedEnabled }) });
    const payload = await response.json();
    if (!response.ok || payload.success !== true) {
      if (response.status === 409) await fetchSystemTools();
      throw new Error(payload.message || 'Không thể lưu trạng thái công cụ.');
    }
    tool.enabled = payload.enabled;
    if (typeof showToast === 'function') showToast(`${payload.enabled ? 'Đã bật' : 'Đã tắt'} ${getSystemToolMeta(tool).title}. Áp dụng cho yêu cầu mới.`, 'success', 'Công cụ hệ thống');
  } catch (error) {
    if (typeof showToast === 'function') showToast(error.message, 'error', 'Không thể đổi trạng thái');
  } finally {
    systemToolsSaving.delete(name);
    renderSystemTools();
    [...document.querySelectorAll('#system-tools-grid [data-tool]')].find(item => item.dataset.tool === name)?.focus();
  }
}

window.fetchSystemTools = fetchSystemTools;
window.renderSystemTools = renderSystemTools;
window.setSystemToolGroup = setSystemToolGroup;
window.toggleSystemToolDetails = toggleSystemToolDetails;
window.setSystemToolEnabled = setSystemToolEnabled;
