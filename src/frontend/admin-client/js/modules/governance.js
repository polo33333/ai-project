(function () {
  'use strict';
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  async function api(path, method = 'GET', body) {
    const response = await fetch(path, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message || 'Không xử lý được yêu cầu.'), { status: response.status, data });
    return data;
  }
  const LABELS = {
    type: { sql: 'Nguồn SQL', document: 'Tài liệu', watchfolder: 'Thư mục theo dõi' },
    mode: { all: 'Mọi người', grants: 'Theo nhóm chức năng', admin: 'Chỉ admin' },
    ai: { all: 'Tất cả AI', local: 'Chỉ AI cục bộ', off: 'Tắt AI' },
    level: { full: 'Đầy đủ', lookup: 'Tra cứu', bridge: 'Cầu nối' },
    tone: { all: 'green', grants: 'yellow', admin: 'red', local: 'yellow', off: 'gray' }
  };
  const state = { data: null, selected: new Set(), current: null, draft: null, pkg: null, customize: false };
  let savingPolicy = false;
  window.DG = { el, esc, api, LABELS, state };

  const sourcePaging = { page: 1, size: 10, filter: '' };
  function sourcePageRows() {
    const filter = ['dg-search','dg-filter-type','dg-filter-ai','dg-filter-mode'].map(id => el(id)?.value || '').join('|');
    if (filter !== sourcePaging.filter) { sourcePaging.page = 1; sourcePaging.filter = filter; }
    const rows = visibleRows();
    sourcePaging.page = Math.max(1, Math.min(sourcePaging.page, Math.ceil(rows.length / sourcePaging.size) || 1));
    return rows.slice((sourcePaging.page - 1) * sourcePaging.size, sourcePaging.page * sourcePaging.size);
  }
  window.pageGovernanceSources = (page, size) => {
    if (size) { sourcePaging.size = Number(size); sourcePaging.page = 1; }
    else sourcePaging.page = page;
    window.renderGovernanceSources();
  };
  // ---------- Tabs ----------
  const TABS = ['sources', 'groups', 'inspect', 'metrics'];
  const loaded = new Set(['sources']);
  window.openGovernanceTab = function (name) {
    if (!TABS.includes(name)) return;
    for (const tab of TABS) {
      const button = el(`dg-tab-${tab}`), panel = el(`dg-panel-${tab}`);
      if (!button || !panel) continue;
      const active = tab === name;
      button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; panel.hidden = !active;
    }
    if (loaded.has(name)) return;
    loaded.add(name);
    if (name === 'groups') window.loadFunctionGroups?.();
    if (name === 'inspect') window.loadGovernanceInspect?.();
    if (name === 'metrics') window.loadGovernedMetrics?.();
  };
  document.addEventListener('keydown', event => {
    const tab = event.target?.closest?.('.dg-tabs [role="tab"]');
    if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = TABS.indexOf(tab.id.replace('dg-tab-', ''));
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length;
      window.openGovernanceTab(TABS[next]); el(`dg-tab-${TABS[next]}`)?.focus();
    }
    if (event.key === 'Escape' && el('dg-drawer') && !el('dg-drawer').hidden && !savingPolicy) window.closeGovernanceDrawer();
  });

  // ---------- Sources ----------
  window.loadGovernanceResources = async function () {
    if (!el('dg-sources-body')) return;
    // Operations are independent of resource/metric selection.
    const operationsRequest = window.loadAgentOperations();
    try {
      const response = await fetch('/api/governance/resources', { cache: 'no-store' }), data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Không tải được chính sách.');
      state.data = { ...data, resources: (data.resources || []).sort((a, b) => ['sql', 'watchfolder', 'document'].indexOf(a.type) - ['sql', 'watchfolder', 'document'].indexOf(b.type) || String(a.name).localeCompare(String(b.name), 'vi')) };
      state.selected = new Set([...state.selected].filter(index => index < state.data.resources.length));
      const sql = state.data.resources.filter(resource => resource.type === 'sql').length, documents = state.data.resources.length - sql;
      el('governance-mode').textContent = state.data.resources.length ? `${sql} nguồn SQL · ${documents} tài liệu và thư mục${data.externalReadOnly ? ' · SQL và API chỉ đọc' : ' · SQL chỉ đọc'}` : 'Chưa có nguồn để cấu hình.';
      window.renderGovernanceSources();
      el('metric-source').replaceChildren(...state.data.resources.filter(resource => resource.type === 'sql').map(resource => { const option = document.createElement('option'); option.value = resource.id; option.textContent = resource.name; return option; }));
      window.DG.onResources?.();
      await Promise.all([window.loadGovernedMetrics(), operationsRequest]);
    } catch (error) { el('governance-mode').textContent = error.message; return false; }
  };
  function visibleRows() {
    if (!state.data) return [];
    const keyword = (el('dg-search')?.value || '').trim().toLocaleLowerCase('vi'), type = el('dg-filter-type')?.value, ai = el('dg-filter-ai')?.value, mode = el('dg-filter-mode')?.value;
    return state.data.resources.map((resource, index) => ({ resource, index })).filter(({ resource }) => (!type || resource.type === type)
      && (!ai || resource.policy.aiSharing.level === ai) && (!mode || resource.policy.access.mode === mode)
      && String(resource.name).toLocaleLowerCase('vi').includes(keyword));
  }
  const badge = (tone, text, title = '') => `<span class="metric-tag ${tone} dg-badge"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
  function modeBadge(resource) {
    const access = resource.policy.access, deny = access.denyUsers.length ? ` · chặn ${access.denyUsers.length}` : '';
    if (access.mode === 'grants') return badge('yellow', `${resource.functionGroups.length} nhóm chức năng${access.users.length ? ` + ${access.users.length} người` : ''}${deny}`);
    return badge(LABELS.tone[access.mode], LABELS.mode[access.mode] + deny);
  }
  function scopeText(resource) {
    if (resource.type === 'watchfolder') return '<small>Áp dụng cho tài liệu trong thư mục</small>';
    if (resource.type !== 'sql') return '<small>—</small>';
    const sql = resource.policy.sql;
    if (!sql.packages.length) return `<small>Chưa chia gói · ${resource.tableCount || 0} bảng mở${sql.hiddenTables.length ? ` · ${sql.hiddenTables.length} ẩn` : ''}</small>`;
    const orphans = resource.orphanTables || [];
    return `<small>${sql.packages.length} gói bảng${sql.hiddenTables.length ? ` · ${sql.hiddenTables.length} bảng ẩn` : ''}</small>${orphans.length ? `<small class="dg-warn-text" title="${esc(orphans.map(item => item.name).join(', '))}"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> ${orphans.length} bảng chưa thuộc gói (chỉ admin hỏi được)</small>` : ''}`;
  }
  window.renderGovernanceSources = function () {
    const body = el('dg-sources-body'); if (!body || !state.data) return;
    const rows = sourcePageRows();
    const total = visibleRows().length, pages = Math.max(1, Math.ceil(total / sourcePaging.size)), page = sourcePaging.page;
    const pager = el('dg-sources-pagination');
    if (pager) pager.innerHTML = `<span>${total ? (page - 1) * sourcePaging.size + 1 : 0}&ndash;${Math.min(page * sourcePaging.size, total)} / ${total}</span><div><select class="form-control" aria-label="S\u1ed1 d\u00f2ng m\u1ed7i trang" onchange="pageGovernanceSources(1,this.value)">${[5,10,20,50].map(size => `<option value="${size}" ${size === sourcePaging.size ? 'selected' : ''}>${size} / trang</option>`).join('')}</select><button type="button" class="btn-secondary-sm" ${page <= 1 ? 'disabled' : ''} onclick="pageGovernanceSources(${page - 1})" aria-label="Trang tr\u01b0\u1edbc"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button><span>Trang ${page}/${pages}</span><button type="button" class="btn-secondary-sm" ${page >= pages ? 'disabled' : ''} onclick="pageGovernanceSources(${page + 1})" aria-label="Trang sau"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div>`;
    body.innerHTML = rows.map(({ resource, index }) => `<tr>
      <td class="dg-check"><input type="checkbox" ${state.selected.has(index) ? 'checked' : ''} onchange="toggleGovernanceSelect(${index}, this.checked)" aria-label="Chọn ${esc(resource.name)}"></td>
      <td class="dg-name"><button type="button" class="dg-link" onclick="openGovernanceDrawer(${index})">${esc(resource.name)}</button><small>${LABELS.type[resource.type]}${resource.inherited ? ' · theo thư mục' : ''}${resource.legacy ? ' · còn quyền kiểu cũ' : ''}</small></td>
      <td data-label="Mở cho">${modeBadge(resource)}</td>
      <td data-label="Chia sẻ AI">${badge(LABELS.tone[resource.policy.aiSharing.level], LABELS.ai[resource.policy.aiSharing.level])}</td>
      <td data-label="Phạm vi bảng">${scopeText(resource)}</td>
      <td data-label="Cập nhật"><small>${resource.policy.updatedAt ? esc(new Date(resource.policy.updatedAt).toLocaleString('vi-VN')) : resource.inherited ? 'Theo thư mục' : 'Mặc định'}</small></td>
      <td class="dg-actions"><button type="button" class="btn-secondary-sm" onclick="openGovernanceDrawer(${index})">Chi tiết</button></td></tr>`).join('')
      || '<tr><td colspan="7" class="dg-empty">Không có nguồn phù hợp với bộ lọc.</td></tr>';
    const all = el('dg-select-all');
    if (all) all.checked = rows.length > 0 && rows.every(({ index }) => state.selected.has(index));
    updateBulk();
  };
  function updateBulk() {
    const bar = el('dg-bulk'); if (!bar) return;
    bar.hidden = !state.selected.size;
    el('dg-bulk-count').textContent = `${state.selected.size} nguồn đã chọn`;
  }
  window.toggleGovernanceSelect = (index, checked) => { if (checked) state.selected.add(index); else state.selected.delete(index); window.renderGovernanceSources(); };
  window.toggleGovernanceSelectAll = checked => { for (const { index } of sourcePageRows()) if (checked) state.selected.add(index); else state.selected.delete(index); window.renderGovernanceSources(); };
  window.clearGovernanceSelection = () => { state.selected.clear(); window.renderGovernanceSources(); };
  window.applyGovernanceBulk = async function () {
    const ai = el('dg-bulk-ai').value, mode = el('dg-bulk-mode').value;
    if (!ai && !mode) { window.showToast?.('Chọn mức chia sẻ AI hoặc chế độ mở cần đặt.', 'warning'); return; }
    const items = [...state.selected].map(index => state.data.resources[index]).filter(Boolean);
    const summary = [ai ? `chia sẻ AI: “${LABELS.ai[ai]}”` : '', mode ? `mở cho: “${LABELS.mode[mode]}”` : ''].filter(Boolean).join(', ');
    const ok = window.showUiConfirm ? await window.showUiConfirm(`Đặt ${summary} cho ${items.length} nguồn?`, { title: 'Sửa hàng loạt', confirmText: 'Áp dụng' }) : window.confirm(`Đặt ${summary} cho ${items.length} nguồn?`);
    if (!ok) return;
    try {
      await api('/api/governance/resources/bulk', 'POST', { items: items.map(item => ({ type: item.type, id: item.id, expectedRevision: item.revision })),
        patch: { ...(ai ? { aiSharing: { level: ai } } : {}), ...(mode ? { access: { mode } } : {}) } });
      state.selected.clear(); el('dg-bulk-ai').value = ''; el('dg-bulk-mode').value = '';
      await window.loadGovernanceResources(); window.showToast?.(`Đã cập nhật ${items.length} nguồn.`, 'success');
    } catch (error) {
      const names = (error.data?.conflicts || []).map(item => item.name).join(', ');
      window.showToast?.(names ? `${error.message} (${names})` : error.message, 'error');
    }
  };

  // Opens one source from another page (library badge, watch folder row).
  window.openGovernanceSource = async function (type, id) {
    window.switchMainTab?.('data-governance');
    for (let attempt = 0; attempt < 40 && !state.data?.resources.some(item => item.type === type && item.id === id); attempt++) await new Promise(resolve => setTimeout(resolve, 150));
    const index = state.data?.resources.findIndex(item => item.type === type && item.id === id);
    if (index >= 0) { window.openGovernanceTab('sources'); window.openGovernanceDrawer(index); }
    else window.showToast?.('Không tìm thấy nguồn trong Quản lý dữ liệu. Hãy làm mới trang.', 'warning');
  };

  // ---------- Drawer ----------
  function policyStatus(stateName, text) {
    const message = el('governance-message');
    message.dataset.state = stateName;
    message.setAttribute('role', stateName === 'error' ? 'alert' : 'status');
    message.textContent = text;
  }
  const providerLocal = provider => provider.local;
  function aiHint() {
    const providers = (state.data?.providers || []);
    const refused = providers.filter(provider => provider.rejectInternalData);
    return `Cho phép các AI đang bật sử dụng nguồn dữ liệu này, bao gồm AI được thêm sau.${refused.length ? ` Các AI không nhận dữ liệu nội bộ vẫn bị loại trừ: ${refused.map(provider => provider.name).join(', ')}.` : ''}`;
  }
  const radios = (name, options, value, disabled) => `<div class="dg-segment dg-radios" role="radiogroup">${Object.entries(options).map(([key, label]) => `<label><input type="radio" name="${name}" value="${key}" ${key === value ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="updateGovernanceDrawer()"><span>${esc(label)}</span></label>`).join('')}</div>`;
  function chipPicker(id, label, subjects, disabled) {
    const users = state.data?.users || [], name = subject => users.find(user => user.id === subject)?.name || subject;
    return `<div class="dg-picker" id="${id}"><span class="dg-picker-label">${esc(label)}</span><div class="dg-chips">${subjects.map(subject => `<span class="dg-chip" data-subject="${esc(subject)}">${esc(name(subject))}<button type="button" aria-label="Bỏ ${esc(name(subject))}" ${disabled ? 'disabled' : ''} onclick="this.parentElement.remove()">×</button></span>`).join('')}</div>
      <div class="dg-picker-add"><select class="form-control" aria-label="${esc(label)}" ${disabled ? 'disabled' : ''}><option value="">Chọn tài khoản…</option>${users.filter(user => user.role !== 'admin').map(user => `<option value="${esc(user.id)}">${esc(user.name)}</option>`).join('')}</select><button type="button" class="btn-secondary-sm" ${disabled ? 'disabled' : ''} onclick="addGovernanceChip('${id}')">Thêm</button></div></div>`;
  }
  window.addGovernanceChip = function (id) {
    const box = el(id), select = box.querySelector('select'), value = select.value;
    if (!value || box.querySelector(`[data-subject="${CSS.escape(value)}"]`)) return;
    const chip = document.createElement('span'); chip.className = 'dg-chip'; chip.dataset.subject = value;
    chip.innerHTML = `${esc(select.selectedOptions[0].textContent)}<button type="button" aria-label="Bỏ">×</button>`;
    chip.querySelector('button').onclick = () => chip.remove();
    box.querySelector('.dg-chips').append(chip); select.value = '';
  };
  const chips = id => [...(el(id)?.querySelectorAll('.dg-chip') || [])].map(chip => chip.dataset.subject);
  window.openGovernanceDrawer = function (index) {
    const resource = state.data?.resources[index]; if (!resource) return;
    state.current = resource; state.currentIndex = index; state.pkg = null; state.customize = false;
    el('dg-drawer-kind').textContent = LABELS.type[resource.type].toUpperCase();
    el('dg-drawer-title').textContent = resource.name;
    policyStatus('idle', `Phiên bản chính sách: ${resource.revision}`);
    renderDrawer();
    el('dg-drawer').hidden = false; el('dg-drawer-backdrop').hidden = false;
    el('dg-drawer').querySelector('input:not([disabled]),button:not([disabled])')?.focus();
  };
  window.closeGovernanceDrawer = function () {
    if (savingPolicy) return;
    el('dg-drawer').hidden = true; el('dg-drawer-backdrop').hidden = true; state.current = null;
  };
  function renderDrawer() {
    const resource = state.current, policy = resource.policy, locked = resource.inherited && !state.customize;
    const groups = state.data.functionGroups || [];
    const folder = resource.folderId && (state.data.watchfolders || []).find(item => item.id === resource.folderId);
    const parts = [];
    if (resource.type === 'document' && resource.inherited) parts.push(`<div class="dg-notice"><i class="fa-solid fa-folder-tree" aria-hidden="true"></i><div><strong>Đang dùng chính sách của thư mục</strong><p>${esc(folder?.name || 'Thư mục theo dõi')}. Đổi chính sách thư mục thì tài liệu đổi theo.</p>${locked ? '<button type="button" class="btn-secondary-sm" onclick="customizeGovernanceDocument()">Tùy chỉnh riêng cho tài liệu này</button>' : ''}</div></div>`);
    else if (resource.type === 'document' && resource.folderId) parts.push(`<div class="dg-notice"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i><div><strong>Đã tùy chỉnh riêng</strong><p>Tài liệu thuộc thư mục ${esc(folder?.name || '')} nhưng đang dùng chính sách riêng.</p><button type="button" class="btn-secondary-sm" onclick="restoreGovernanceInheritance()">Khôi phục theo thư mục</button></div></div>`);
    if (resource.type === 'watchfolder') parts.push('<div class="dg-notice"><i class="fa-solid fa-folder-tree" aria-hidden="true"></i><div><strong>Chính sách mặc định của thư mục</strong><p>Áp dụng cho mọi tài liệu lấy từ thư mục này, trừ tài liệu đã tùy chỉnh riêng.</p></div></div>');
    if (resource.legacy) parts.push('<div class="dg-notice dg-notice-warn"><i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><div><strong>Còn quyền kiểu cũ</strong><p>Nguồn còn quyền cấp theo vai trò hoặc widget kiểu cũ. Các quyền này vẫn có hiệu lực. Hãy gán vai trò cho widget hoặc nhóm chức năng cho vai trò tương ứng, rồi bỏ quyền kiểu cũ.</p><label><input type="checkbox" id="dg-drop-legacy"> Bỏ quyền kiểu cũ khi lưu</label></div></div>');
    parts.push(`<fieldset class="dg-section"><legend><i class="fa-solid fa-users" aria-hidden="true"></i> Quyền truy cập</legend>
      ${radios('dg-mode', { all: 'Tất cả', grants: 'Theo nhóm chức năng', admin: 'Chỉ quản trị viên' }, policy.access.mode, locked)}
      <p class="settings-governance-hint" id="dg-mode-hint"></p>
      <div id="dg-access-groups" class="dg-checks" ${policy.access.mode === 'grants' ? '' : 'hidden'}>${groups.length ? groups.map(group => `<label><input type="checkbox" value="${esc(group.id)}" ${resource.functionGroups.includes(group.id) ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>${esc(group.name)}</span></label>`).join('') : '<small>Chưa có nhóm chức năng. Tạo ở thẻ “Nhóm chức năng”.</small>'}</div>
      <details class="settings-governance-help" ${policy.access.users.length || policy.access.denyUsers.length ? 'open' : ''}><summary>Ngoại lệ theo từng người</summary>
        ${chipPicker('dg-users', 'Cấp thêm cho', policy.access.users, locked)}${chipPicker('dg-deny', 'Chặn (ưu tiên cao nhất)', policy.access.denyUsers, locked)}</details>
    </fieldset>`);
    const providers = (state.data.providers || []).filter(provider => !providerLocal(provider));
    parts.push(`<fieldset class="dg-section"><legend><i class="fa-solid fa-robot" aria-hidden="true"></i> Phạm vi sử dụng của agent</legend>
      ${radios('dg-ai', { all: 'Tất cả', local: 'Cục bộ', off: 'Không cho phép' }, policy.aiSharing.level, locked)}
      <p class="settings-governance-hint" id="dg-ai-hint"></p>
      ${providers.length ? `<details class="settings-governance-help" ${policy.aiSharing.excludeDestinations.length ? 'open' : ''}><summary>Nâng cao: loại trừ AI cho riêng nguồn này</summary><div class="dg-checks" id="dg-exclude">${providers.map(provider => `<label><input type="checkbox" value="${esc(provider.id)}" ${policy.aiSharing.excludeDestinations.includes(provider.id) ? 'checked' : ''} ${locked ? 'disabled' : ''}><span>${esc(provider.name)}</span></label>`).join('')}</div></details>` : ''}
    </fieldset>`);
    if (resource.type === 'sql' && resource.orphanTables?.length) parts.push(`<div class="dg-notice dg-notice-warn"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i><div><strong>${resource.orphanTables.length} bảng chưa thuộc gói</strong><p>Thường là bảng mới từ đồng bộ lược đồ. Chỉ admin truy vấn được cho tới khi gán vào gói: ${resource.orphanTables.slice(0, 8).map(item => esc(item.name) + (item.active ? '' : ' (tắt)')).join(', ')}${resource.orphanTables.length > 8 ? '…' : ''}.</p></div></div>`);
    if (resource.type === 'sql') parts.push(`<fieldset class="dg-section"><legend><i class="fa-solid fa-table" aria-hidden="true"></i> Gói bảng</legend><div id="dg-packages">${packageSummary(policy.sql, resource)}</div></fieldset>`);
    el('dg-drawer-body').innerHTML = parts.join('');
    window.updateGovernanceDrawer();
  }
  function packageSummary(sql, resource) {
    const text = sql.packages.length ? `${sql.packages.length} gói: ${sql.packages.map(item => esc(item.name) + (item.base ? ' (nền)' : '')).join(', ')}.` : `Chưa chia gói: mọi ${resource.tableCount || 0} bảng mở cho người đọc được nguồn.`;
    return `<p class="settings-governance-hint">${text}${sql.hiddenTables.length ? ` ${sql.hiddenTables.length} bảng ẩn khỏi AI.` : ''} Vai trò nhận gói qua nhóm chức năng (thẻ “Nhóm chức năng” → Ma trận gói bảng).</p><button type="button" class="btn-secondary-sm" onclick="editGovernancePackages()"><i class="fa-solid fa-pen" aria-hidden="true"></i> Sửa gói bảng</button>`;
  }
  window.updateGovernanceDrawer = function () {
    const mode = document.querySelector('input[name="dg-mode"]:checked')?.value, ai = document.querySelector('input[name="dg-ai"]:checked')?.value;
    if (el('dg-access-groups')) el('dg-access-groups').hidden = mode !== 'grants';
    if (el('dg-mode-hint')) el('dg-mode-hint').textContent = mode === 'all' ? 'Người dùng có quyền tra cứu được phép truy cập nguồn dữ liệu này.' : mode === 'grants' ? 'Cấp quyền qua các nhóm chức năng bên dưới hoặc cho từng người dùng.' : 'Nguồn dữ liệu này chỉ dành cho quản trị viên.';
    if (el('dg-ai-hint')) el('dg-ai-hint').textContent = ai === 'all' ? aiHint() : ai === 'local' ? 'Chỉ AI chạy cục bộ (Ollama/localhost) được sử dụng nguồn dữ liệu này.' : 'AI không sử dụng nguồn này để truy vấn SQL hoặc tìm kiếm tài liệu.';
  };
  window.customizeGovernanceDocument = () => { state.customize = true; renderDrawer(); };
  window.restoreGovernanceInheritance = async function () {
    const resource = state.current;
    try {
      const data = await api('/api/governance/resources', 'PUT', { type: resource.type, id: resource.id, expectedRevision: resource.revision, inherit: true });
      Object.assign(resource, data.resource); renderDrawer(); window.renderGovernanceSources();
      policyStatus('success', 'Đã khôi phục theo chính sách thư mục.');
    } catch (error) { policyStatus('error', error.message); }
  };

  // Package editor inside the drawer (SQL only).
  window.editGovernancePackages = async function () {
    const resource = state.current, box = el('dg-packages');
    box.innerHTML = '<p class="settings-governance-hint">Đang tải danh mục bảng…</p>';
    try {
      const { tables } = await api(`/api/governance/sql/${encodeURIComponent(resource.id)}/tables`);
      const key = value => String(value).toLowerCase();
      const find = name => tables.find(table => [key(table.id), key(table.name), key(table.name.split('.').pop())].includes(key(name)));
      state.pkg = { tables, packages: structuredClone(resource.policy.sql.packages), assign: new Map(), hidden: new Set() };
      for (const item of state.pkg.packages) for (const name of item.tables) { const table = find(name); if (table) state.pkg.assign.set(table.id, item.id); }
      for (const name of resource.policy.sql.hiddenTables) { const table = find(name); if (table) state.pkg.hidden.add(table.id); }
      renderPackages();
    } catch (error) { box.innerHTML = `<p class="dg-error">${esc(error.message)}</p>`; }
  };
  const slug = text => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'goi';
  function renderPackages() {
    const pkg = state.pkg, box = el('dg-packages');
    const count = id => [...pkg.assign.values()].filter(value => value === id).length;
    const options = table => `<option value="">— Chưa thuộc gói —</option>${pkg.packages.map(item => `<option value="${esc(item.id)}" ${pkg.assign.get(table.id) === item.id ? 'selected' : ''}>${esc(item.name)}</option>`).join('')}<option value="__hidden" ${pkg.hidden.has(table.id) ? 'selected' : ''}>Ẩn khỏi AI</option>`;
    const orphans = pkg.tables.filter(table => !pkg.assign.has(table.id) && !pkg.hidden.has(table.id)).length;
    box.innerHTML = `<div class="dg-pkg-actions"><button type="button" class="btn-secondary-sm" onclick="addGovernancePackage()"><i class="fa-solid fa-plus" aria-hidden="true"></i> Thêm gói</button><button type="button" class="btn-secondary-sm" onclick="suggestGovernancePackages()"><i class="fa-solid fa-wand-magic-sparkles" aria-hidden="true"></i> Gợi ý gói</button></div>
      ${pkg.packages.length ? '' : '<p class="settings-governance-hint">Chưa có gói: mọi bảng mở như hiện nay. Khi lưu gói đầu tiên, vai trò chỉ thấy bảng của gói được cấp (cùng gói nền và bảng tra cứu tự động).</p>'}
      <div class="dg-pkg-list">${pkg.packages.map((item, index) => `<article class="dg-pkg">
        <div class="dg-pkg-head"><input class="form-control" value="${esc(item.name)}" aria-label="Tên gói" onchange="renameGovernancePackage(${index}, this.value)"><span class="metric-tag gray">${count(item.id)} bảng</span><button type="button" class="btn-secondary-sm dg-danger" onclick="removeGovernancePackage(${index})" aria-label="Xóa gói ${esc(item.name)}"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></div>
        <div class="dg-pkg-flags"><label><input type="checkbox" ${item.base ? 'checked' : ''} onchange="setGovernancePackage(${index}, 'base', this.checked)"> Gói nền (tự cấp cho mọi vai trò tra SQL)</label>
          <select class="form-control" aria-label="Mức của gói nền" ${item.base ? '' : 'disabled'} onchange="setGovernancePackage(${index}, 'baseLevel', this.value)"><option value="full" ${item.baseLevel !== 'lookup' ? 'selected' : ''}>Đầy đủ</option><option value="lookup" ${item.baseLevel === 'lookup' ? 'selected' : ''}>Tra cứu</option></select>
          <label><input type="checkbox" ${item.allowBridge !== false ? 'checked' : ''} onchange="setGovernancePackage(${index}, 'allowBridge', this.checked)"> Cho làm cầu nối</label></div>
        <details class="settings-governance-help"><summary>Cột nhạy cảm (${item.sensitiveColumns.length})</summary><div class="dg-columns">${pkg.tables.filter(table => pkg.assign.get(table.id) === item.id).map(table => `<div><strong>${esc(table.name)}</strong>${table.columns.map(column => {
          const ref = `${table.name.split('.').pop()}.${column.name}`, checked = item.sensitiveColumns.some(entry => entry.toLowerCase() === ref.toLowerCase());
          return `<label title="${column.key ? 'Khóa nối: luôn dùng được để nối bảng' : ''}"><input type="checkbox" ${checked ? 'checked' : ''} ${column.key ? 'disabled' : ''} onchange="toggleGovernanceSensitive(${index}, '${esc(ref)}', this.checked)"> ${esc(column.name)}${column.key ? ' 🔑' : ''}</label>`; }).join('')}</div>`).join('') || '<small>Gán bảng vào gói trước.</small>'}</div></details>
        <details class="settings-governance-help"><summary>Cột hiện khi chỉ được tra cứu (${(item.lookupColumns || []).length || 'tự chọn tên, mã'})</summary><p>Khóa nối luôn hiện. Không chọn cột nào thì hệ thống tự chọn cột tên và mã, bỏ qua cột thuế, ngân hàng, giấy tờ, liên lạc.</p><div class="dg-columns">${pkg.tables.filter(table => pkg.assign.get(table.id) === item.id).map(table => `<div><strong>${esc(table.name)}</strong>${table.columns.filter(column => !column.key).map(column => `<label><input type="checkbox" ${(item.lookupColumns || []).some(entry => entry.toLowerCase() === column.name.toLowerCase()) ? 'checked' : ''} onchange="toggleGovernanceLookup(${index}, '${esc(column.name)}', this.checked)"> ${esc(column.name)}</label>`).join('')}</div>`).join('') || '<small>Gán bảng vào gói trước.</small>'}</div></details>
      </article>`).join('')}</div>
      <div class="dg-pkg-tables"><div class="dg-pkg-tables-head"><strong>Gán bảng vào gói</strong><small>${orphans} bảng chưa thuộc gói${pkg.packages.length ? ' (chỉ admin hỏi được)' : ''} · ${pkg.hidden.size} bảng ẩn</small><input class="form-control" placeholder="Lọc bảng…" aria-label="Lọc bảng" oninput="filterGovernanceTables(this.value)"></div>
        <ul id="dg-pkg-table-list">${pkg.tables.map(table => `<li data-name="${esc(table.name.toLowerCase())} ${esc(table.description.toLowerCase())}"><span><strong>${esc(table.name)}${table.active === false ? ' <small class="dg-inactive">(chưa bật)</small>' : ''}</strong>${table.description ? `<small>${esc(table.description)}</small>` : ''}</span><select class="form-control" aria-label="Gói của ${esc(table.name)}" onchange="assignGovernanceTable('${esc(table.id)}', this.value)">${options(table)}</select></li>`).join('')}</ul></div>`;
  }
  window.filterGovernanceTables = value => { const keyword = value.trim().toLowerCase(); for (const item of el('dg-pkg-table-list').children) item.hidden = keyword && !item.dataset.name.includes(keyword); };
  window.assignGovernanceTable = (tableId, value) => {
    state.pkg.assign.delete(tableId); state.pkg.hidden.delete(tableId);
    if (value === '__hidden') state.pkg.hidden.add(tableId); else if (value) state.pkg.assign.set(tableId, value);
    const scroll = el('dg-drawer-body').scrollTop; renderPackages(); el('dg-drawer-body').scrollTop = scroll;
  };
  window.addGovernancePackage = async () => {
    const name = window.showUiPrompt ? await window.showUiPrompt('Tên gói bảng mới', '', { title: 'Thêm gói bảng' }) : window.prompt('Tên gói bảng mới');
    if (!name?.trim()) return;
    let id = slug(name); while (state.pkg.packages.some(item => item.id === id)) id += '_2';
    state.pkg.packages.push({ id, name: name.trim(), tables: [], sensitiveColumns: [], allowBridge: true, base: false, baseLevel: 'full' }); renderPackages();
  };
  window.renameGovernancePackage = (index, value) => { if (value.trim()) state.pkg.packages[index].name = value.trim(); };
  window.setGovernancePackage = (index, field, value) => { state.pkg.packages[index][field] = value; renderPackages(); };
  window.removeGovernancePackage = index => {
    const [removed] = state.pkg.packages.splice(index, 1);
    for (const [tableId, packageId] of [...state.pkg.assign]) if (packageId === removed.id) state.pkg.assign.delete(tableId);
    renderPackages();
  };
  window.toggleGovernanceLookup = (index, name, checked) => {
    const list = (state.pkg.packages[index].lookupColumns || []).filter(entry => entry.toLowerCase() !== name.toLowerCase());
    if (checked) list.push(name); state.pkg.packages[index].lookupColumns = list;
  };
  window.toggleGovernanceSensitive = (index, ref, checked) => {
    const list = state.pkg.packages[index].sensitiveColumns.filter(entry => entry.toLowerCase() !== ref.toLowerCase());
    if (checked) list.push(ref); state.pkg.packages[index].sensitiveColumns = list;
  };
  window.suggestGovernancePackages = async () => {
    if (state.pkg.packages.length) {
      const ok = window.showUiConfirm ? await window.showUiConfirm('Thay các gói đang soạn bằng gói gợi ý theo tiền tố tên bảng?', { title: 'Gợi ý gói bảng', confirmText: 'Thay' }) : window.confirm('Thay các gói đang soạn bằng gói gợi ý?');
      if (!ok) return;
    }
    try {
      const suggestion = await api(`/api/governance/sql/${encodeURIComponent(state.current.id)}/package-suggestions`);
      const byName = new Map(state.pkg.tables.map(table => [table.name.toLowerCase(), table.id]));
      state.pkg.packages = suggestion.packages.map(item => ({ ...item, baseLevel: 'full' }));
      state.pkg.assign = new Map(); state.pkg.hidden = new Set(suggestion.hiddenTables.map(name => byName.get(name.toLowerCase())).filter(Boolean));
      for (const item of suggestion.packages) for (const name of item.tables) if (byName.has(name.toLowerCase())) state.pkg.assign.set(byName.get(name.toLowerCase()), item.id);
      renderPackages(); window.showToast?.('Đã tạo bản nháp gói theo tiền tố tên bảng. Đổi tên và gộp gói cho đúng nghiệp vụ rồi lưu.', 'info');
    } catch (error) { window.showToast?.(error.message, 'error'); }
  };
  function collectSql() {
    const sql = structuredClone(state.current.policy.sql);
    if (!state.pkg) return sql;
    const nameOf = id => state.pkg.tables.find(table => table.id === id)?.name;
    sql.packages = state.pkg.packages.map(item => ({ id: item.id, name: item.name, tables: [...state.pkg.assign].filter(([, packageId]) => packageId === item.id).map(([tableId]) => nameOf(tableId)).filter(Boolean),
      sensitiveColumns: item.sensitiveColumns, lookupColumns: item.lookupColumns || [], allowBridge: item.allowBridge !== false, base: Boolean(item.base), baseLevel: item.baseLevel === 'lookup' ? 'lookup' : 'full' }));
    sql.hiddenTables = [...state.pkg.hidden].map(nameOf).filter(Boolean);
    return sql;
  }

  window.saveGovernanceResource = async function (event) {
    event.preventDefault();
    if (savingPolicy) return;
    const resource = state.current; if (!resource) return;
    // The first packages close every table that no function group grants.
    if (resource.type === 'sql' && !resource.policy.sql.packages.length && state.pkg?.packages.length) {
      const message = 'Sau khi lưu gói bảng đầu tiên, mỗi vai trò chỉ truy vấn được bảng thuộc gói nền và gói được cấp qua nhóm chức năng. Vai trò chưa được cấp gói sẽ mất quyền với các bảng còn lại. Tiếp tục?';
      const ok = window.showUiConfirm ? await window.showUiConfirm(message, { title: 'Bật gói bảng cho nguồn', confirmText: 'Lưu gói bảng' }) : window.confirm(message);
      if (!ok) return;
    }
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const originalLabel = button.innerHTML;
    const controls = [...form.querySelectorAll('input, select, textarea, button')];
    const disabledStates = controls.map(control => control.disabled);
    savingPolicy = true;
    controls.forEach(control => { control.disabled = true; });
    form.setAttribute('aria-busy', 'true');
    button.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Đang lưu…';
    policyStatus('saving', `Đang lưu chính sách cho “${resource.name}”… Vui lòng chờ xác nhận.`);
    const slowTimer = setTimeout(() => {
      policyStatus('saving', `Đang chờ máy chủ xác nhận chính sách cho “${resource.name}”. Thao tác lâu hơn bình thường, vui lòng chờ…`);
    }, 10000);
    try {
      const mode = document.querySelector('input[name="dg-mode"]:checked')?.value || resource.policy.access.mode;
      const level = document.querySelector('input[name="dg-ai"]:checked')?.value || resource.policy.aiSharing.level;
      const policy = { schemaVersion: 2, access: { mode, users: chips('dg-users'), denyUsers: chips('dg-deny') },
        aiSharing: { level, excludeDestinations: [...(el('dg-exclude')?.querySelectorAll('input:checked') || [])].map(input => input.value) },
        ...(resource.type === 'sql' ? { sql: collectSql() } : {}) };
      const functionGroups = mode === 'grants' ? [...(el('dg-access-groups')?.querySelectorAll('input:checked') || [])].map(input => input.value) : undefined;
      const dropLegacy = el('dg-drop-legacy')?.checked === true;
      const response = await fetch('/api/governance/resources', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: resource.type, id: resource.id, expectedRevision: resource.revision, policy, ...(functionGroups ? { functionGroups } : {}), ...(dropLegacy ? { dropLegacy } : {}) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Không lưu được chính sách.');
      if (!data.resource?.policy) throw new Error('Máy chủ chưa trả về xác nhận chính sách. Hãy tải lại để kiểm tra trước khi lưu lại.');
      Object.assign(resource, data.resource);
      if (data.resource.functionGroups && state.data.functionGroups) window.DG.onGroupsChanged?.();
      policyStatus('success', `Đã lưu thành công “${resource.name}” · Phiên bản ${resource.revision ?? resource.policy.revision} · ${new Date().toLocaleTimeString('vi-VN')}. Có hiệu lực cho yêu cầu tiếp theo.`);
      window.renderGovernanceSources?.();
    } catch (error) {
      policyStatus('error', `Chưa xác nhận lưu thành công. ${error.message || 'Không kết nối được máy chủ.'} Nội dung bạn nhập vẫn được giữ lại.`);
    } finally {
      clearTimeout(slowTimer);
      savingPolicy = false;
      controls.forEach((control, index) => { control.disabled = disabledStates[index]; });
      form.removeAttribute('aria-busy');
      button.innerHTML = originalLabel;
    }
  };

  // ---------- Metrics ----------
  let metrics = [];
  window.loadGovernedMetrics = async function () {
    try {
      const response = await fetch('/api/governance/metrics', { cache: 'no-store' }), data = await response.json();
      if (!response.ok) throw new Error(data.message);
      metrics = (data.metrics || []).filter(metric => metric.sourceId === el('metric-source').value);
      const fresh = document.createElement('option'); fresh.value = ''; fresh.textContent = 'Tạo mới';
      el('metric-existing').replaceChildren(fresh, ...metrics.map(metric => { const option = document.createElement('option'); option.value = metric.metricId; option.textContent = `${metric.metricId} · v${metric.version} · ${metric.approved ? 'Đã duyệt' : 'Bản nháp'}`; return option; }));
      window.selectGovernedMetric();
    } catch (error) { el('metric-message').textContent = error.message; }
  };
  window.selectGovernedMetric = function () {
    const existing = metrics.find(metric => metric.metricId === el('metric-existing').value);
    const sample = { metricId: 'new_metric', owner: '', definition: '', table: 'dbo.Table', valueColumn: 'Amount', aggregation: 'SUM', unit: '', grain: '', timeColumn: 'CreatedAt', timezone: 'Asia/Ho_Chi_Minh', dimensions: [], nullRule: 'exclude', rounding: 2, approved: false };
    const definition = existing ? Object.fromEntries(Object.keys(sample).map(key => [key, existing[key]])) : sample;
    el('metric-definition').value = JSON.stringify(definition, null, 2);
    el('metric-message').textContent = existing ? `Phiên bản ${existing.version} · Chủ nghiệp vụ: ${existing.owner}` : 'Chưa có chỉ tiêu nghiệp vụ mặc định. Điền định nghĩa trước khi lưu.';
  };
  window.saveGovernedMetric = async function (event) {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      const definition = JSON.parse(el('metric-definition').value), existing = metrics.find(metric => metric.metricId === definition.metricId);
      const response = await fetch('/api/governance/metrics', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: el('metric-source').value, definition, expectedRevision: existing?.version || 0 }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message);
      await window.loadGovernedMetrics(); el('metric-existing').value = data.metric.metricId; window.selectGovernedMetric();
    } catch (error) { el('metric-message').textContent = error.message; }
    finally { button.disabled = false; }
  };

  // ---------- Operations ----------
  window.loadAgentOperations = async function () {
    if (!el('operations-summary')) return;
    const button = el('operations-refresh');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    el('operations-summary').setAttribute('aria-busy', 'true');
    el('operations-message').textContent = 'Đang cập nhật báo cáo vận hành…';
    try {
      const response = await fetch('/api/governance/operations', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Chưa tải được báo cáo vận hành.');
      const measured = value => value === null || value === undefined ? 'Chưa đo' : `${Number(value).toLocaleString('vi-VN')} ms`;
      const count = value => value == null ? 'Chưa có dữ liệu' : Number(value).toLocaleString('vi-VN');
      const summary = [
        ['Lượt đã lưu', count(data.requests), 'Tổng lượt trong lịch sử', 'layer-group', 'indigo'],
        ['Kết quả một phần', count(data.statuses.PARTIAL || 0), 'Chưa hoàn tất toàn bộ yêu cầu', 'circle-half-stroke', 'amber'],
        ['Lượt lỗi', count((data.statuses.ERROR || 0) + (data.statuses.FAILED || 0)), 'Trạng thái lỗi hoặc thất bại', 'circle-exclamation', 'red'],
        ['Thiếu tiêu chí', count(data.missingCriteria), 'Chưa đáp ứng đủ tiêu chí kiểm tra', 'list-check', 'amber'],
        ['Độ trễ P50', measured(data.latency.p50Ms), '50% lượt có độ trễ không vượt mức này', 'gauge', 'indigo'],
        ['Độ trễ P95', measured(data.latency.p95Ms), '95% lượt có độ trễ không vượt mức này', 'stopwatch', 'indigo'],
        ['Chi phí (USD)', data.cost.total == null ? 'Chưa đủ dữ liệu' : (Number(data.cost.total) / 1000000).toLocaleString('vi-VN', { maximumFractionDigits: 6 }), 'Tính từ mức sử dụng và bảng giá', 'coins', 'indigo']
      ];
      el('operations-summary').replaceChildren(...summary.map(([name, value, hint, icon, tone], index) => {
        const card = document.createElement('div'); card.className = `operations-stat ${index >= 4 ? 'operations-stat-secondary' : ''}`;
        const label = document.createElement('dt'), detail = document.createElement('dd'), note = document.createElement('span');
        const symbol = document.createElement('i'); symbol.className = `fa-solid fa-${icon}`; symbol.setAttribute('aria-hidden', 'true');
        const iconBadge = document.createElement('span'); iconBadge.className = `operations-stat-icon ${tone}`; iconBadge.append(symbol);
        label.append(iconBadge, document.createTextNode(name)); detail.textContent = String(value);
        if (value === 'Chưa đủ dữ liệu' || value === 'Chưa đo' || value === 'Chưa có dữ liệu') detail.className = 'operations-stat-unavailable';
        note.className = 'operations-stat-hint'; note.textContent = hint; detail.append(note); card.append(label, detail); return card;
      }));
      const labels = { OPERATIONS_POLICY_UNCONFIGURED: 'Chưa thiết lập ngưỡng cảnh báo vận hành.', COST_EVIDENCE_INCOMPLETE: 'Chưa đủ dữ liệu sử dụng hoặc bảng giá để tính chi phí.',
        ERROR_RATE_HIGH: 'Tỷ lệ lỗi vượt ngưỡng.', LATENCY_P95_HIGH: 'Độ trễ P95 vượt ngưỡng.', COST_BUDGET_EXCEEDED: 'Chi phí vượt ngân sách.' };
      el('operations-alerts').replaceChildren(...(data.alerts || []).map(alert => { const li = document.createElement('li');
        const icon = document.createElement('i'); icon.className = 'fa-solid fa-circle-info'; icon.setAttribute('aria-hidden', 'true');
        li.append(icon, document.createTextNode(labels[alert.code] || 'Có cảnh báo cần kiểm tra.')); return li; }));
      el('operations-alerts').hidden = !(data.alerts || []).length;
      el('operations-message').textContent = 'Thống kê từ lịch sử đã lưu; trạng thái hoàn tất không thay cho nghiệm thu chất lượng nghiệp vụ.';
    } catch (error) { el('operations-message').textContent = error.message; }
    finally { if (button) button.disabled = false; el('operations-summary').setAttribute('aria-busy', 'false'); }
  };
})();
