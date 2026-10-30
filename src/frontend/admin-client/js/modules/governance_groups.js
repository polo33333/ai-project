(function () {
  'use strict';
  // Function groups, the package matrix with its coverage check, and the
  // "Kiểm tra quyền" tab. Shares helpers and state with governance.js (window.DG).
  const dg = () => window.DG;
  const el = id => document.getElementById(id);
  const esc = value => dg().esc(value);
  const groupsState = { data: null, editing: null, matrix: new Map(), saving: false };
  const REASONS = { ADMIN: 'Admin đọc mọi nguồn', MODE_ALL: 'Nguồn mở cho mọi người', MODE_ADMIN: 'Nguồn chỉ dành cho admin', GRANT_FUNCTION_GROUP: 'Nhờ nhóm chức năng',
    GRANT_FOLDER: 'Nhờ nhóm chức năng có thư mục chứa tài liệu', GRANT_USER: 'Được cấp riêng cho tài khoản', LEGACY_ROLE: 'Quyền vai trò kiểu cũ', LEGACY_EMBED: 'Quyền widget kiểu cũ',
    DENIED_USER: 'Bị chặn đích danh', MISSING_PERMISSION: 'Thiếu quyền chức năng tra cứu', LEGACY_SCOPE: 'Phạm vi kiểu cũ của vai trò/tài khoản', NOT_GRANTED: 'Chưa nhóm chức năng nào được cấp nguồn này', NO_SCOPE: 'Không giới hạn' };

  let groupsRequest = null;
  window.loadFunctionGroups = function () {
    if (groupsRequest) return groupsRequest;
    groupsRequest = fetchFunctionGroups().finally(() => { groupsRequest = null; });
    return groupsRequest;
  };
  async function fetchFunctionGroups() {
    setGroupsLoading(true);
    el('dg-groups-message').textContent = 'Đang tải nhóm chức năng…';
    try {
      groupsState.data = await dg().api('/api/governance/function-groups');
      groupsState.matrix = new Map();
      el('dg-groups-message').textContent = '';
      renderGroups();
      el('dg-matrix-source').innerHTML = groupsState.data.catalog.sql.map(source => `<option value="${esc(source.id)}">${esc(source.name)}</option>`).join('');
      if (!el('dg-groups-matrix').hidden) window.renderGovernanceMatrix();
    } catch (error) {
      el('dg-groups-message').textContent = error.message;
      if (!groupsState.data) {
        el('dg-groups-cards').innerHTML = '<button type="button" class="btn-secondary-sm" onclick="loadFunctionGroups()">Th\u1eed l\u1ea1i</button>';
        el('dg-roles-cards').innerHTML = '';
      }
    } finally { setGroupsLoading(false); }
  };
  function setGroupsLoading(loading) {
    el('dg-panel-groups')?.setAttribute('aria-busy', String(loading));
    el('dg-groups-message').classList.toggle('is-loading', loading);
    if (!loading || groupsState.data) return;
    const skeleton = '<div class="dg-skeleton-line"></div>';
    el('dg-groups-cards').innerHTML = Array.from({ length: 6 }, () => `<div class="dg-gcard dg-skeleton-card" aria-hidden="true"><div class="dg-skeleton-head"><span class="dg-skeleton-avatar"></span>${skeleton}</div>${skeleton}${skeleton}<div class="dg-skeleton-foot">${skeleton}</div></div>`).join('');
    el('dg-roles-cards').innerHTML = Array.from({ length: 3 }, () => `<div class="dg-role dg-skeleton-card" aria-hidden="true">${skeleton}${skeleton}${skeleton}</div>`).join('');
  }
  dg().onGroupsChanged = () => { if (groupsState.data) window.loadFunctionGroups(); };
  dg().onResources = () => { if (groupsState.data && !groupsRequest) window.loadFunctionGroups(); if (inspectLoaded) window.loadGovernanceInspect(); };
  window.showGroupsView = function (view) {
    const panels = { list: 'dg-groups-list', roles: 'dg-roles-view', matrix: 'dg-groups-matrix' };
    for (const [key, id] of Object.entries(panels)) { el(id).hidden = key !== view; el(`dg-groups-view-${key}`).setAttribute('aria-pressed', String(key === view)); }
    el('dg-groups-tools').hidden = view !== 'list'; el('dg-roles-tools').hidden = view !== 'roles';
    if (view === 'matrix') window.renderGovernanceMatrix();
  };
  const capabilityLabel = id => groupsState.data.capabilities.find(item => item.id === id)?.label || id;
  // Short labels for permission chips; data permissions come first and are highlighted.
  const SHORT = { 'chat.use': 'Trò chuyện', 'sql:read': 'Tra SQL', 'knowledge:read': 'Tra tài liệu', 'library.read': 'Thư viện', 'history.read': 'Lịch sử',
    'memory.use': 'Bộ nhớ', 'dashboard.read': 'Tổng quan', 'glossary.read': 'Thuật ngữ', 'schema.read': 'Lược đồ', 'sources.read': 'Nguồn CSDL',
    'workflows.use': 'Mẫu nghiệp vụ', 'feedback.read': 'Đánh giá AI', 'analytics.read': 'Báo cáo' };
  const DATA_PERMISSIONS = new Set(['sql:read', 'knowledge:read']);
  const initials = name => String(name).replace(/\(.*?\)/g, '').replace(/[—&-]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() || '?';
  // Workflow packages this group turned on; none when the group may not use workflows at all.
  const workflowsOn = group => group.permissions.includes('workflows.use')
    ? (groupsState.data?.catalog?.workflows || []).filter(item => item.enabled !== false && (group.workflows || []).includes(item.id)).length : 0;
  function groupCard(group, index) {
    const packages = Object.values(group.packages || {}).reduce((sum, grants) => sum + Object.keys(grants).length, 0);
    const sources = (group.sources?.sql?.length || 0) + (group.sources?.documents?.length || 0) + (group.sources?.watchfolders?.length || 0);
    const used = group.impact.roles.length > 0, converted = /_chuyen_doi$/.test(group.id);
    const permissions = [...group.permissions].sort((a, b) => Number(DATA_PERMISSIONS.has(b)) - Number(DATA_PERMISSIONS.has(a)));
    const shown = permissions.slice(0, 3), more = permissions.length - shown.length;
    const stat = (icon, value, label) => `<span class="dg-gstat ${value ? '' : 'is-empty'}" title="${value} ${esc(label)}"><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${value}<span class="sr-only"> ${esc(label)}</span></span>`;
    const chips = shown.map(id => `<li class="${DATA_PERMISSIONS.has(id) ? 'is-data' : ''}" title="${esc(capabilityLabel(id))}">${esc(SHORT[id] || capabilityLabel(id))}</li>`).join('')
      || '<li class="is-none">Không có quyền chức năng</li>';
    return `<article class="dg-gcard ${used ? 'is-used' : ''}">
      <header class="dg-ghead"><span class="dg-gicon" aria-hidden="true">${esc(initials(group.name))}</span>
        <div class="dg-gtitle"><strong title="${esc(group.name)}">${esc(group.name)}</strong><span class="dg-usage ${used ? 'is-used' : ''}" title="${used ? esc('Vai trò: ' + group.impact.roles.map(role => role.name).join(', ')) : ''}">${used ? `<i class="fa-solid fa-circle-check" aria-hidden="true"></i> Đã gán ${group.impact.roles.length} vai trò · ${group.impact.accounts} tài khoản` : 'Chưa gán vai trò'}</span></div>
        ${converted ? '<span class="dg-gtag" title="Tạo tự động khi chuyển sang nhóm chức năng">Chuyển đổi</span>' : ''}</header>
      <p class="dg-gdesc" title="${esc(group.description || '')}">${esc(group.description || '')}</p>
      <ul class="dg-chips-list" aria-label="Quyền chức năng">${chips}${more > 0 ? `<li class="is-more" title="${esc(permissions.slice(3).map(capabilityLabel).join(', '))}">+${more}</li>` : ''}</ul>
      <footer class="dg-gfoot">
        <code class="dg-gid">${esc(group.id)}</code><div class="dg-gstats">${stat('table-cells', packages, 'gói bảng')}${stat('database', sources, 'nguồn hạn chế')}${stat('diagram-project', workflowsOn(group), 'mẫu nghiệp vụ đang bật')}</div>
        <button type="button" class="btn-secondary-sm" onclick="openFunctionGroupEditor(${index})" aria-label="Sửa nhóm ${esc(group.name)}"><i class="fa-solid fa-pen" aria-hidden="true"></i> Sửa</button>
      </footer></article>`;
  }
  window.renderFunctionGroups = function () {
    if (!groupsState.data) return;
    const { groups } = groupsState.data;
    const keyword = (el('dg-groups-search')?.value || '').trim().toLocaleLowerCase('vi'), filter = el('dg-groups-filter')?.value || '';
    const rows = groups.map((group, index) => ({ group, index }))
      .filter(({ group }) => `${group.name} ${group.id} ${group.description || ''}`.toLocaleLowerCase('vi').includes(keyword)
        && (!filter || (filter === 'used') === group.impact.roles.length > 0))
      .sort((a, b) => Number(b.group.impact.roles.length > 0) - Number(a.group.impact.roles.length > 0) || a.group.name.localeCompare(b.group.name, 'vi'));
    el('dg-groups-count').textContent = rows.length === groups.length ? String(groups.length) : `${rows.length}/${groups.length}`;
    el('dg-groups-cards').innerHTML = rows.map(({ group, index }) => groupCard(group, index)).join('')
      || (groups.length ? '<p class="dg-empty">Không có nhóm phù hợp với bộ lọc.</p>' : '<p class="dg-empty">Chưa có nhóm chức năng. Bấm “Thêm nhóm chức năng” để tạo, ví dụ “Cơ bản”, “Tài chính & công nợ”.</p>');
  };
  // How a permission is built, shown with a real role: account -> role -> groups -> what it allows.
  function renderFlow() {
    const box = el('dg-flow'); if (!box) return;
    const { groups, roles, catalog, capabilities } = groupsState.data;
    const withGroups = roles.filter(role => role.id !== 'admin' && Array.isArray(role.functionGroups) && role.functionGroups.some(id => groups.some(group => group.id === id)));
    // A custom role with about three groups reads best as an example.
    const role = [...withGroups].sort((a, b) => Number(Boolean(a.builtin)) - Number(Boolean(b.builtin)) || Math.abs(a.functionGroups.length - 3) - Math.abs(b.functionGroups.length - 3) || a.name.localeCompare(b.name, 'vi'))[0];
    const node = (kind, icon, body, action, label) => action
      ? `<button type="button" class="dg-node" onclick="${action}" aria-label="${esc(label)}"><span class="dg-node-kind"><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${kind}</span>${body}</button>`
      : `<div class="dg-node"><span class="dg-node-kind"><i class="fa-solid fa-${icon}" aria-hidden="true"></i> ${kind}</span>${body}</div>`;
    const arrow = text => `<div class="dg-arrow" aria-hidden="true"><span>${text}</span></div>`;
    if (!role) {
      box.innerHTML = `<figcaption><strong>Cách phân quyền</strong></figcaption><div class="dg-flow2-row">${node('Tài khoản', 'user', '<strong>Người dùng</strong>')}${arrow('có 1')}${node('Vai trò', 'id-badge', '<strong>Vai trò</strong>')}${arrow('gồm')}${node('Nhóm chức năng', 'layer-group', '<strong>Các nhóm</strong>')}${arrow('cho phép')}${node('Quyền và dữ liệu', 'key', '<strong>Chức năng, nguồn, gói bảng</strong>')}</div>`;
      return;
    }
    const chosen = role.functionGroups.map(id => groups.find(group => group.id === id)).filter(Boolean);
    const permissions = new Set(chosen.flatMap(group => group.permissions));
    const packageName = (sourceId, id) => catalog.sql.find(source => source.id === sourceId)?.packages.find(item => item.id === id)?.name || id;
    const levels = new Map();
    for (const group of chosen) for (const [sourceId, grants] of Object.entries(group.packages || {})) for (const [id, level] of Object.entries(grants)) {
      const name = packageName(sourceId, id); if (levels.get(name) !== 'full') levels.set(name, level);
    }
    const LEVEL = { full: 'Đầy đủ', lookup: 'Tra cứu' };
    const dataText = levels.size ? [...levels].map(([name, level]) => `${esc(name)} <em>(${LEVEL[level]})</em>`).join(', ') : 'Chưa có gói bảng';
    const keyPermissions = capabilities.filter(item => permissions.has(item.id) && ['chat.use', 'sql:read', 'knowledge:read', 'workflows.use'].includes(item.id)).map(item => SHORT[item.id] || item.label);
    const accounts = (window.DG?.state?.data?.users || []).filter(user => user.role === role.id).length;
    box.innerHTML = `<figcaption><strong>Cách phân quyền</strong><span>Ví dụ với vai trò “${esc(role.name)}”. Người dùng được gì là do vai trò của họ, và vai trò gồm những nhóm chức năng nào.</span></figcaption>
      <div class="dg-flow2-row">
        ${node('Tài khoản', 'user', `<strong>${accounts ? `${accounts} tài khoản` : 'Tài khoản'}</strong><small>được gán đúng 1 vai trò</small>`)}
        ${arrow('có vai trò')}
        ${node('Vai trò', 'id-badge', `<strong>${esc(role.name)}</strong><small>ghép từ ${chosen.length} nhóm chức năng</small>`, "showGroupsView('roles')", 'Xem danh sách vai trò')}
        ${arrow('gồm các nhóm')}
        ${node('Nhóm chức năng', 'layer-group', `<span class="dg-node-chips">${chosen.map(group => `<span>${esc(group.name)}</span>`).join('<b aria-hidden="true">+</b>')}</span>`, "showGroupsView('list')", 'Xem danh sách nhóm chức năng')}
        ${arrow('cho phép')}
        ${node('Quyền và dữ liệu', 'key', `<strong>${permissions.size} chức năng</strong><small>${keyPermissions.map(esc).join(' · ') || 'Không có'}</small><small class="dg-node-data"><i class="fa-solid fa-table-cells" aria-hidden="true"></i> ${dataText}</small>`)}
      </div>`;
  }
  function renderGroups() {
    const { groups, roles } = groupsState.data;
    window.renderFunctionGroups();
    renderFlow();
    // Admin first, then system roles, then custom roles by name.
    const visible = [...roles].sort((a, b) => Number(b.id === 'admin') - Number(a.id === 'admin') || Number(Boolean(b.builtin)) - Number(Boolean(a.builtin)) || a.name.localeCompare(b.name, 'vi'));
    el('dg-roles-count').textContent = String(visible.length);
    const users = window.DG?.state?.data?.users || [];
    el('dg-roles-cards').innerHTML = visible.map(role => {
      const accounts = users.filter(user => user.role === role.id).length;
      const chosen = (role.functionGroups || []).map(id => groups.find(group => group.id === id)).filter(Boolean);
      const chips = role.id === 'admin' ? '<span class="dg-role-empty">Không cần nhóm chức năng</span>' : Array.isArray(role.functionGroups) ? (role.functionGroups.map(id => {
        const index = groups.findIndex(group => group.id === id);
        return index >= 0 ? `<button type="button" class="dg-role-chip" onclick="openFunctionGroupEditor(${index})">${esc(groups[index].name)}</button>` : `<span class="dg-role-chip is-missing">${esc(id)}</span>`;
      }).join('') || '<span class="dg-role-empty">Chưa có nhóm chức năng</span>') : `<span class="dg-role-empty">Kiểu cũ: ${(role.permissions || []).length} quyền</span>`;
      const permissions = new Set(chosen.flatMap(group => group.permissions)), packages = new Set(chosen.flatMap(group => Object.entries(group.packages || {}).flatMap(([source, grants]) => Object.keys(grants).map(id => source + '/' + id))));
      const summary = role.id === 'admin' ? '<span class="dg-gtag is-admin">Toàn quyền</span>' : `<span class="dg-role-sum"><i class="fa-solid fa-key" aria-hidden="true"></i> ${permissions.size} quyền</span><span class="dg-role-sum"><i class="fa-solid fa-table-cells" aria-hidden="true"></i> ${packages.size} gói bảng</span>`;
      return `<tr><td class="dg-name" data-label="Vai trò"><strong>${esc(role.name)}</strong> ${role.id !== 'admin' && role.builtin ? '<span class="dg-gtag is-system">Hệ thống</span>' : ''}<small>${esc(role.id)}</small></td>
        <td data-label="Nhóm chức năng"><div class="dg-role-chips">${chips}</div></td><td data-label="Tài khoản">${accounts}</td><td data-label="Quyền tổng hợp"><div class="dg-role-sums">${summary}</div></td></tr>`;
    }).join('') || '<tr><td colspan="4" class="dg-empty">Chưa có vai trò.</td></tr>';
  }

  // ---------- Group editor ----------
  window.openFunctionGroupEditor = function (index) {
    if (!groupsState.data) { window.loadFunctionGroups().then(() => { if (groupsState.data) window.openFunctionGroupEditor(index); }); return; }
    const group = index === undefined ? null : groupsState.data.groups[index];
    groupsState.editing = group;
    const { capabilities, catalog } = groupsState.data;
    const checked = (list, id) => (list || []).includes(id) ? 'checked' : '';
    const restricted = items => items.filter(item => item.mode === 'grants');
    const sources = group?.sources || {}, packages = group?.packages || {};
    el('dg-group-title').textContent = group ? `Sửa “${group.name}”` : 'Thêm nhóm chức năng';
    el('dg-group-delete').hidden = !group;
    el('dg-group-message').textContent = group ? `Dùng trong: ${group.impact.roles.map(role => role.name).join(', ') || 'chưa vai trò nào'} · ${group.impact.accounts} tài khoản. Sửa sẽ áp dụng cho tất cả.` : '';
    const sourceChecks = (type, items) => items.length ? items.map(item => `<label><input type="checkbox" data-source="${type}" value="${esc(item.id)}" ${checked(sources[type], item.id)}><span>${esc(item.name)}</span></label>`).join('') : '<small>Không có nguồn nào đặt “Theo nhóm chức năng”.</small>';
    const sqlWithPackages = catalog.sql.filter(source => source.packages.some(item => !item.base));
    const restrictedCount = restricted(catalog.sql).length + restricted(catalog.documents).length + restricted(catalog.watchfolders).length;
    const levelOptions = value => `<option value="">—</option><option value="lookup" ${value === 'lookup' ? 'selected' : ''}>Tra cứu</option><option value="full" ${value === 'full' ? 'selected' : ''}>Đầy đủ</option>`;
    const sourceBlock = (type, title, items) => items.length ? `<div class="dg-gsrc"><strong>${title}</strong>${items.map(item => `<label><input type="checkbox" data-source="${type}" value="${esc(item.id)}" ${checked(sources[type], item.id)} onchange="updateGroupTabCounts()"><span>${esc(item.name)}</span></label>`).join('')}</div>` : '';
    el('dg-group-body').innerHTML = `
      <div class="dg-form-grid dg-form-compact">${group ? '' : '<label>Mã nhóm<input id="dg-group-id" class="form-control" required pattern="[a-z][a-z0-9_\\-]{1,59}" placeholder="vi_du: tai_chinh"></label>'}
        <label>Tên nhóm<input id="dg-group-name" class="form-control" required maxlength="100" value="${esc(group?.name || '')}" placeholder="Ví dụ: Tài chính & công nợ"></label>
        <label class="${group ? '' : 'dg-span'}">Mô tả<input id="dg-group-description" class="form-control" maxlength="400" value="${esc(group?.description || '')}" placeholder="Nhóm dùng cho việc gì"></label></div>
      <div class="dg-subtabs" role="tablist" aria-label="Nội dung nhóm chức năng">
        ${[['permissions', 'Quyền chức năng'], ['sources', 'Nguồn hạn chế'], ['packages', 'Gói bảng'], ['workflows', 'Mẫu nghiệp vụ']].map(([key, label], index) =>
          `<button type="button" role="tab" id="dg-gtab-${key}" aria-controls="dg-gpanel-${key}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}" onclick="showGroupTab('${key}')">${label} <span class="dg-count" id="dg-gcount-${key}"></span></button>`).join('')}
      </div>
      <div class="dg-subpanels">
        <section id="dg-gpanel-permissions" role="tabpanel" aria-labelledby="dg-gtab-permissions">
          <div class="dg-panel-tools"><span class="settings-governance-hint">Chức năng mà vai trò có nhóm này được dùng.</span><button type="button" class="dg-link-sm" onclick="toggleGroupPermissions(true)">Chọn tất cả</button><button type="button" class="dg-link-sm" onclick="toggleGroupPermissions(false)">Bỏ chọn</button></div>
          <div class="dg-checks dg-checks-grid" id="dg-group-permissions">${capabilities.map(item => `<label><input type="checkbox" value="${esc(item.id)}" ${checked(group?.permissions, item.id)} onchange="updateGroupTabCounts()"><span>${esc(item.label)}</span></label>`).join('')}</div>
        </section>
        <section id="dg-gpanel-sources" role="tabpanel" aria-labelledby="dg-gtab-sources" hidden>
          <p class="settings-governance-hint">Chỉ cần với nguồn đặt “Theo nhóm chức năng”. Nguồn “Mọi người” đã mở cho mọi vai trò có quyền tra cứu.</p>
          ${restrictedCount ? `<div class="dg-gsrc-grid" id="dg-group-sources">${sourceBlock('sql', 'Nguồn SQL', restricted(catalog.sql))}${sourceBlock('documents', 'Tài liệu', restricted(catalog.documents))}${sourceBlock('watchfolders', 'Thư mục theo dõi', restricted(catalog.watchfolders))}</div>`
            : '<div class="dg-empty-state"><i class="fa-solid fa-lock-open" aria-hidden="true"></i><p>Chưa có nguồn nào đặt “Theo nhóm chức năng”. Mọi nguồn đang mở cho người có quyền tra cứu.</p></div>'}
        </section>
        <section id="dg-gpanel-packages" role="tabpanel" aria-labelledby="dg-gtab-packages" hidden>
          ${sqlWithPackages.map(source => `<div class="dg-group-packages" data-source-id="${esc(source.id)}">
            <div class="dg-panel-tools"><strong>${esc(source.name)}</strong><label class="dg-inline-label">Đặt tất cả<select class="form-control" aria-label="Đặt mức cho mọi gói của ${esc(source.name)}" onchange="setAllGroupPackages(this)"><option value="keep">Giữ nguyên</option><option value="">—</option><option value="lookup">Tra cứu</option><option value="full">Đầy đủ</option></select></label></div>
            <div class="dg-gpkg-grid">${source.packages.filter(item => !item.base).map(item => `<label><span>${esc(item.name)} <small>${item.tables} bảng</small></span><select class="form-control dg-level ${packages[source.id]?.[item.id] ? 'is-' + packages[source.id][item.id] : ''}" data-package="${esc(item.id)}" onchange="this.className='form-control dg-level '+(this.value?'is-'+this.value:'');updateGroupTabCounts()">${levelOptions(packages[source.id]?.[item.id])}</select></label>`).join('')}</div>
            ${source.packages.some(item => item.base) ? `<p class="settings-governance-hint">Gói nền tự cấp cho mọi vai trò tra SQL: ${source.packages.filter(item => item.base).map(item => esc(item.name)).join(', ')}.</p>` : ''}</div>`).join('')
            || '<div class="dg-empty-state"><i class="fa-solid fa-table-cells" aria-hidden="true"></i><p>Chưa nguồn SQL nào chia gói bảng: mọi bảng đang mở cho người đọc được nguồn. Chia gói tại thẻ Nguồn dữ liệu → Chi tiết → Gói bảng.</p></div>'}
        </section>
        <section id="dg-gpanel-workflows" role="tabpanel" aria-labelledby="dg-gtab-workflows" hidden>
          ${catalog.workflows.length ? `<p class="settings-governance-hint">Chỉ hiện mẫu đã phát hành. Mẫu mới phát hành mặc định tắt: bật mẫu mà nhóm này được dùng. Vai trò dùng được mẫu khi ít nhất một nhóm của nó bật mẫu đó.</p>
            <p class="dg-gwf-warning" id="dg-group-workflows-warning" hidden><i class="fa-solid fa-circle-info" aria-hidden="true"></i> Nhóm chưa có quyền “Sử dụng mẫu nghiệp vụ” (thẻ Quyền chức năng), nên các công tắc dưới đây chưa có tác dụng.</p>
            <div class="dg-gwf-list" id="dg-group-workflows">${catalog.workflows.map(item => `<label class="dg-workflow ${item.enabled === false ? 'is-off' : ''}"><span>${esc(item.name)}${item.enabled === false ? '<small class="dg-workflow-note">Gói đang tắt trên toàn hệ thống.</small>' : ''}</span><span class="dg-switch"><input type="checkbox" role="switch" value="${esc(item.id)}" ${checked(group?.workflows, item.id)} aria-label="Dùng mẫu ${esc(item.name)} trong nhóm này" onchange="updateGroupTabCounts()"><span class="dg-switch-track" aria-hidden="true"></span><span class="dg-switch-label"></span></span></label>`).join('')}</div>`
            : '<div class="dg-empty-state"><i class="fa-solid fa-diagram-project" aria-hidden="true"></i><p>Chưa có gói mẫu nghiệp vụ nào được đăng.</p></div>'}
        </section>
      </div>`;
    window.updateGroupTabCounts();
    el('dg-group-editor').hidden = false;
    el(group ? 'dg-group-name' : 'dg-group-id')?.focus();
  };
  const GROUP_TABS = ['permissions', 'sources', 'packages', 'workflows'];
  window.showGroupTab = function (key) {
    for (const tab of GROUP_TABS) {
      const active = tab === key;
      el(`dg-gtab-${tab}`).setAttribute('aria-selected', String(active)); el(`dg-gtab-${tab}`).tabIndex = active ? 0 : -1;
      el(`dg-gpanel-${tab}`).hidden = !active;
    }
  };
  window.updateGroupTabCounts = function () {
    const body = el('dg-group-body'), count = selector => body.querySelectorAll(selector).length;
    const set = (key, value) => { const badge = el(`dg-gcount-${key}`); if (badge) { badge.textContent = value; badge.classList.toggle('is-zero', !value); } };
    set('permissions', count('#dg-group-permissions input:checked'));
    set('sources', count('input[data-source]:checked'));
    set('packages', [...body.querySelectorAll('select[data-package]')].filter(select => select.value).length);
    const total = count('#dg-group-workflows input[role="switch"]'), on = count('#dg-group-workflows input[role="switch"]:checked');
    set('workflows', total ? `${on}/${total}` : 0);
    const warning = el('dg-group-workflows-warning');
    if (warning) warning.hidden = !total || count('#dg-group-permissions input[value="workflows.use"]:checked') > 0;
  };
  window.toggleGroupPermissions = on => { el('dg-group-permissions').querySelectorAll('input').forEach(input => { input.checked = on; }); window.updateGroupTabCounts(); };
  window.setAllGroupPackages = function (select) {
    if (select.value === 'keep') return;
    for (const item of select.closest('.dg-group-packages').querySelectorAll('select[data-package]')) { item.value = select.value; item.className = 'form-control dg-level ' + (select.value ? 'is-' + select.value : ''); }
    select.value = 'keep'; window.updateGroupTabCounts();
  };
  document.addEventListener('keydown', event => {
    const tab = event.target?.closest?.('.dg-subtabs [role="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const index = GROUP_TABS.indexOf(tab.id.replace('dg-gtab-', '')), next = GROUP_TABS[(index + (event.key === 'ArrowRight' ? 1 : GROUP_TABS.length - 1)) % GROUP_TABS.length];
    window.showGroupTab(next); el(`dg-gtab-${next}`).focus();
  });
  window.closeFunctionGroupEditor = () => { if (!groupsState.saving) el('dg-group-editor').hidden = true; };
  function readGroupForm() {
    const values = selector => [...el('dg-group-body').querySelectorAll(selector)].map(input => input.value);
    const packages = {};
    for (const box of el('dg-group-body').querySelectorAll('.dg-group-packages')) {
      const grants = {};
      for (const select of box.querySelectorAll('select[data-package]')) if (select.value) grants[select.dataset.package] = select.value;
      // Keep grants of base packages, which the editor does not show.
      Object.assign(grants, Object.fromEntries(Object.entries(groupsState.editing?.packages?.[box.dataset.sourceId] || {}).filter(([id]) => !box.querySelector(`select[data-package="${CSS.escape(id)}"]`))));
      if (Object.keys(grants).length) packages[box.dataset.sourceId] = grants;
    }
    const keepOther = (type, list) => [...new Set([...list, ...(groupsState.editing?.sources?.[type] || []).filter(id => !el('dg-group-body').querySelector(`input[data-source="${type}"][value="${CSS.escape(id)}"]`))])];
    return { ...(groupsState.editing ? {} : { id: el('dg-group-id').value.trim() }), name: el('dg-group-name').value, description: el('dg-group-description').value,
      permissions: values('#dg-group-permissions input:checked'),
      sources: { sql: keepOther('sql', values('input[data-source="sql"]:checked')), documents: keepOther('documents', values('input[data-source="documents"]:checked')), watchfolders: keepOther('watchfolders', values('input[data-source="watchfolders"]:checked')) },
      packages: { ...Object.fromEntries(Object.entries(groupsState.editing?.packages || {}).filter(([sourceId]) => !el('dg-group-body').querySelector(`.dg-group-packages[data-source-id="${CSS.escape(sourceId)}"]`))), ...packages },
      // Keep packages the list does not show (not published or removed) as they were.
      workflows: [...new Set([...values('#dg-group-workflows input[role="switch"]:checked'), ...(groupsState.editing?.workflows || []).filter(id => !(groupsState.data?.catalog?.workflows || []).some(item => item.id === id))])],
      revision: groupsState.editing?.revision };
  }
  window.saveFunctionGroup = async function (event) {
    event.preventDefault(); if (groupsState.saving) return;
    groupsState.saving = true; el('dg-group-save').disabled = true; el('dg-group-message').textContent = 'Đang lưu…';
    try {
      const body = readGroupForm(), editing = groupsState.editing;
      const result = await dg().api(editing ? `/api/governance/function-groups/${encodeURIComponent(editing.id)}` : '/api/governance/function-groups', editing ? 'PUT' : 'POST', body);
      groupsState.saving = false; window.closeFunctionGroupEditor();
      await window.loadFunctionGroups();
      window.showToast?.(editing ? `Đã lưu “${result.group.name}”${result.impact?.roles?.length ? ` · áp dụng cho ${result.impact.roles.length} vai trò` : ''}.` : `Đã tạo “${result.group.name}”. Gán nhóm vào vai trò tại Tài khoản → Vai trò.`, 'success');
    } catch (error) { el('dg-group-message').textContent = error.message; }
    finally { groupsState.saving = false; el('dg-group-save').disabled = false; }
  };
  window.deleteFunctionGroup = async function () {
    const group = groupsState.editing; if (!group) return;
    const ok = window.showUiConfirm ? await window.showUiConfirm(`Xóa nhóm chức năng “${group.name}”?`, { title: 'Xóa nhóm chức năng', confirmText: 'Xóa' }) : window.confirm(`Xóa “${group.name}”?`);
    if (!ok) return;
    try { await dg().api(`/api/governance/function-groups/${encodeURIComponent(group.id)}?revision=${group.revision}`, 'DELETE'); window.closeFunctionGroupEditor(); await window.loadFunctionGroups(); }
    catch (error) { el('dg-group-message').textContent = error.message; }
  };

  // ---------- Package matrix ----------
  let matrixPage = 1, matrixSource = '';
  window.pageGovernanceMatrix = page => { matrixPage = page; window.renderGovernanceMatrix(); };
  window.renderGovernanceMatrix = function () {
    if (!groupsState.data) return;
    const source = groupsState.data.catalog.sql.find(item => item.id === el('dg-matrix-source').value);
    const table = el('dg-matrix'), groups = groupsState.data.groups;
    if (matrixSource !== source?.id) { matrixSource = source?.id; matrixPage = 1; }
    matrixPage = Math.max(1, Math.min(matrixPage, Math.ceil((source?.packages.length || 0) / 10) || 1));
    el('dg-matrix-pagination').innerHTML = inspectPager(source?.packages.length || 0, matrixPage, 10, next => `pageGovernanceMatrix(${next})`);
    if (!source) { table.innerHTML = '<tbody><tr><td class="dg-empty">Chưa có nguồn SQL.</td></tr></tbody>'; return; }
    if (!source.packages.length) { table.innerHTML = '<tbody><tr><td class="dg-empty">Nguồn chưa chia gói bảng: mọi bảng đang mở cho người đọc được nguồn. Chia gói tại thẻ Nguồn dữ liệu → Chi tiết → Gói bảng.</td></tr></tbody>'; el('dg-coverage').innerHTML = ''; return; }
    if (!groups.length) { table.innerHTML = '<tbody><tr><td class="dg-empty">Chưa có nhóm chức năng.</td></tr></tbody>'; return; }
    const value = (group, item) => groupsState.matrix.has(`${group.id}|${item.id}`) ? groupsState.matrix.get(`${group.id}|${item.id}`) : group.packages?.[source.id]?.[item.id] || '';
    table.innerHTML = `<thead><tr><th scope="col">Gói bảng \\ Nhóm chức năng</th>${groups.map(group => `<th scope="col">${esc(group.name)}</th>`).join('')}</tr></thead><tbody>${source.packages.slice((matrixPage - 1) * 10, matrixPage * 10).map(item => `<tr><th scope="row">${esc(item.name)}<small>${item.tables} bảng</small></th>${item.base ? `<td colspan="${groups.length}"><span class="metric-tag green">Gói nền · tự động cho mọi vai trò tra SQL</span></td>` : groups.map(group => `<td><select class="form-control dg-level ${value(group, item) ? `is-${value(group, item)}` : ''}" aria-label="${esc(item.name)} cho ${esc(group.name)}" onchange="setGovernanceMatrix('${esc(group.id)}', '${esc(item.id)}', this)"><option value="">—</option><option value="lookup" ${value(group, item) === 'lookup' ? 'selected' : ''}>Tra cứu</option><option value="full" ${value(group, item) === 'full' ? 'selected' : ''}>Đầy đủ</option></select></td>`).join('')}</tr>`).join('')}</tbody>`;
    el('dg-matrix-save').disabled = !groupsState.matrix.size;
    refreshCoverage();
  };
  window.setGovernanceMatrix = (groupId, packageId, select) => {
    groupsState.matrix.set(`${groupId}|${packageId}`, select.value); select.className = `form-control dg-level ${select.value ? `is-${select.value}` : ''}`;
    el('dg-matrix-save').disabled = false; refreshCoverage();
  };
  function draftGroups(sourceId) {
    return groupsState.data.groups.map(group => {
      const grants = { ...(group.packages?.[sourceId] || {}) };
      for (const [key, level] of groupsState.matrix) { const [groupId, packageId] = key.split('|'); if (groupId === group.id) { if (level) grants[packageId] = level; else delete grants[packageId]; } }
      return { id: group.id, packages: { ...(group.packages || {}), [sourceId]: grants } };
    });
  }
  let coverageTimer = null;
  function refreshCoverage() {
    clearTimeout(coverageTimer);
    coverageTimer = setTimeout(async () => {
      const sourceId = el('dg-matrix-source').value; if (!sourceId) return;
      el('dg-coverage').innerHTML = '<p class="settings-governance-hint">Đang kiểm tra…</p>';
      try {
        const report = await dg().api('/api/governance/coverage', 'POST', { sourceId, groups: draftGroups(sourceId) });
        el('dg-coverage').innerHTML = `<div class="dg-coverage-grid">${report.roles.map(role => `<article class="dg-card"><div><strong>${esc(role.name)}</strong>${role.sqlRead ? `<small>${role.tables} bảng đọc được (${role.full} đầy đủ)</small>${role.codeOnly.length ? `<details><summary>${role.codeOnly.length} chỗ sẽ chỉ hiện mã</summary><ul>${role.codeOnly.map(item => `<li>${esc(item.from)} → ${esc(item.to)}: ${item.reason === 'NO_DISPLAY_COLUMN' ? 'quan hệ chưa có cột hiển thị' : 'bảng đích ngoài phạm vi'}</li>`).join('')}</ul></details>` : '<small class="dg-ok">Không thiếu tên ở bảng tra cứu</small>'}` : '<small>Không có quyền tra SQL</small>'}</div></article>`).join('')}</div>
          ${report.relations ? '' : '<p class="dg-notice dg-notice-warn">Nguồn chưa có quan hệ bảng đã xác minh: không tự thêm bảng tra cứu và không nối bảng được. Hãy xác minh quan hệ ở trang Lược đồ.</p>'}
          ${report.orphans.length ? `<details class="settings-governance-help"><summary>${report.orphans.length} bảng chưa thuộc gói nào (chỉ admin hỏi được)</summary><p>${report.orphans.map(esc).join(', ')}</p></details>` : ''}
          ${report.noJoin.length ? `<details class="settings-governance-help"><summary>${report.noJoin.length} bảng không nối được với bảng khác trong cùng gói</summary><p>${report.noJoin.map(item => `${esc(item.table)} (${esc(item.packageName)})`).join(', ')}</p></details>` : ''}`;
      } catch (error) { el('dg-coverage').textContent = error.message; }
    }, 250);
  }
  window.saveGovernanceMatrix = async function () {
    const sourceId = el('dg-matrix-source').value, cells = [...groupsState.matrix].map(([key, level]) => { const [groupId, packageId] = key.split('|'); return { groupId, packageId, level: level || null }; });
    if (!cells.length) return;
    el('dg-matrix-save').disabled = true;
    try {
      await dg().api('/api/governance/function-groups/matrix', 'POST', { sourceId, cells, revisions: Object.fromEntries(groupsState.data.groups.map(group => [group.id, group.revision])) });
      await window.loadFunctionGroups(); window.showToast?.('Đã lưu ma trận gói bảng.', 'success');
    } catch (error) { window.showToast?.(error.message, 'error'); el('dg-matrix-save').disabled = false; }
  };

  // ---------- Inspect ----------
  let inspectLoaded = false;
  window.loadGovernanceInspect = async function () {
    inspectLoaded = true;
    const data = dg().state.data; if (!data) return;
    const select = el('dg-inspect-actor'), current = select.value;
    select.innerHTML = `<option value="">Chọn…</option><optgroup label="Tài khoản">${(data.users || []).filter(user => user.isActive).map(user => `<option value="subject=${encodeURIComponent(user.id)}">${esc(user.name)}</option>`).join('')}</optgroup>
      <optgroup label="Vai trò">${(data.roles || []).map(role => `<option value="role=${encodeURIComponent(role.id)}">${esc(role.name)}</option>`).join('')}</optgroup>
      <optgroup label="Widget">${(data.embeds || []).map(embed => `<option value="embed=${encodeURIComponent(embed.id)}">${esc(embed.name)}</option>`).join('')}</optgroup>`;
    select.value = [...select.options].some(option => option.value === current) ? current : '';
    el('dg-try-source').innerHTML = data.resources.filter(resource => resource.type === 'sql').map(resource => `<option value="${esc(resource.id)}">${esc(resource.name)}</option>`).join('');
    if (select.value) window.inspectGovernanceActor();
  };
  const inspectPaging = { report: null, page: 1, size: 10 };
  function inspectPager(total, page, size, action) {
    const pages = Math.max(1, Math.ceil(total / size));

    return `<nav class="dg-pagination" aria-label="Ph\u00e2n trang"><span>${total ? (page - 1) * size + 1 : 0}&ndash;${Math.min(page * size, total)} / ${total}</span><div><button type="button" class="btn-secondary-sm" ${page <= 1 ? 'disabled' : ''} onclick="${action(page - 1)}" aria-label="Trang tr\u01b0\u1edbc"><i class="fa-solid fa-chevron-left" aria-hidden="true"></i></button><span>Trang ${page}/${pages}</span><button type="button" class="btn-secondary-sm" ${page >= pages ? 'disabled' : ''} onclick="${action(page + 1)}" aria-label="Trang sau"><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div></nav>`;
  }
  function inspectTablePage(index, page = 1) {
    const tables = inspectPaging.report.resources[index].tables, size = 10;
    page = Math.max(1, Math.min(page, Math.ceil(tables.length / size)));
    return `<ul class="dg-table-levels">${tables.slice((page - 1) * size, page * size).map(table => `<li><span class="metric-tag ${table.level === 'full' ? 'green' : table.level === 'lookup' ? 'yellow' : 'gray'}">${dg().LABELS.level[table.level]}</span> ${esc(table.name)}${table.packageName ? ` <small>${esc(table.packageName)}</small>` : ''}</li>`).join('')}</ul>${inspectPager(tables.length, page, size, next => `pageInspectTables(${index},${next})`)}`;
  }
  window.pageInspectTables = (index, page) => { el(`dg-inspect-table-page-${index}`).innerHTML = inspectTablePage(index, page); };
  window.pageInspectResources = page => {
    if (!inspectPaging.report) return;
    inspectPaging.page = Math.max(1, Math.min(page, Math.ceil(inspectPaging.report.resources.length / inspectPaging.size) || 1));
    renderInspectReport();
  };
  let inspectRequestId = 0;
  window.inspectGovernanceActor = async function () {
    const requestId = ++inspectRequestId;
    const query = el('dg-inspect-actor').value, box = el('dg-inspect-result');
    inspectPaging.report = null;
    if (!query) { box.innerHTML = '<p class="settings-governance-hint">Chọn một tài khoản, vai trò hoặc widget.</p>'; return; }
    box.innerHTML = '<p class="settings-governance-hint">Đang kiểm tra…</p>';
    try {
      const report = await dg().api(`/api/governance/effective?${query}`), { LABELS } = dg();
      if (requestId !== inspectRequestId) return;
      inspectPaging.report = report;
      inspectPaging.page = 1;
      renderInspectReport();
    } catch (error) { if (requestId === inspectRequestId) box.innerHTML = `<p class="dg-error">${esc(error.message)}</p>`; }
  };
  function renderInspectReport() {
    const report = inspectPaging.report, actor = report.actor, { LABELS } = dg(), box = el('dg-inspect-result');
      box.innerHTML = `<div class="dg-actor"><strong>${esc(actor.label)}</strong><span class="metric-tag purple">${esc(actor.role || '')}</span>${actor.functionGroups.map(group => `<span class="metric-tag gray">${esc(group.name)}</span>`).join('') || (actor.role === 'admin' ? '<small>Toàn quyền truy cập các nguồn</small>' : '<small>Không có nhóm chức năng</small>')}${actor.workflows?.length ? `<small>${actor.workflows.length} gói mẫu nghiệp vụ</small>` : ''}</div>
        <div class="dg-table-wrap dg-inspect-table"><table class="dg-table"><colgroup><col class="dg-inspect-source"><col class="dg-inspect-access"><col class="dg-inspect-ai"></colgroup><thead><tr><th scope="col">Nguồn</th><th scope="col">Đọc được</th><th scope="col">AI nhận dữ liệu</th></tr></thead><tbody>${report.resources.slice((inspectPaging.page - 1) * inspectPaging.size, inspectPaging.page * inspectPaging.size).map((item, offset) => `<tr>
          <td class="dg-name"><strong>${esc(item.name)}</strong><small>${LABELS.type[item.type]}</small></td>
          <td data-label="Đọc được"><span class="dg-verdict ${item.allowed ? 'is-yes' : 'is-no'}">${item.allowed ? '✓ Có' : '✗ Không'}</span><small>${esc(REASONS[item.reason] || item.reason)}${item.via.length ? `: ${item.via.map(esc).join(', ')}` : ''}</small>
            ${item.tables?.length ? `<details class="dg-inspect-tables"><summary>${item.open ? `Mọi ${item.tables.length} bảng (nguồn chưa chia gói)` : `${item.tables.filter(table => table.level !== 'bridge').length} bảng đọc được`}</summary><div id="dg-inspect-table-page-${(inspectPaging.page - 1) * inspectPaging.size + offset}">${inspectTablePage((inspectPaging.page - 1) * inspectPaging.size + offset)}</div></details>` : ''}</td>
          <td data-label="AI nhận dữ liệu"><small>${LABELS.ai[item.aiLevel]}</small><div class="dg-ai-list">${item.ai.map(ai => `<span class="${ai.allowed ? 'is-yes' : 'is-no'}">${ai.allowed ? '✓' : '✗'} ${esc(ai.name)}</span>`).join('')}</div></td></tr>`).join('')}</tbody></table></div>${inspectPager(report.resources.length, inspectPaging.page, inspectPaging.size, next => `pageInspectResources(${next})`)}`;
  }
  window.tryGovernanceQuery = async function () {
    const query = new URLSearchParams(el('dg-inspect-actor').value), result = el('dg-try-result');
    if (![...query.keys()].length) { result.textContent = 'Chọn người cần kiểm tra trước.'; return; }
    result.textContent = 'Đang kiểm tra…';
    try {
      const response = await dg().api(`/api/governance/sql/${encodeURIComponent(el('dg-try-source').value)}/check-query`, 'POST', { ...Object.fromEntries(query), sql: el('dg-try-sql').value });
      result.className = response.allowed ? 'dg-ok' : 'dg-error';
      result.textContent = response.allowed ? `Được phép. Câu sẽ chạy: ${response.sql}` : `Bị chặn: ${response.message}`;
    } catch (error) { result.className = 'dg-error'; result.textContent = error.message; }
  };
})();
