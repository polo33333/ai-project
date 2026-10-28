(function () {
  'use strict';
  let accounts = [], loading = null, editing = null, mode = 'create', trigger = null, saving = false;
  let roles=[], capabilities=[], functionGroups=[], roleEditing=null, roleSaving=false;
  const el = id => document.getElementById(id);
  const html = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  async function request(path, method = 'GET', body) {
    const response = await fetch(path, { method, cache:'no-store', headers:{'Content-Type':'application/json'}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message === 'FORBIDDEN' ? 'Chỉ Admin được quản lý tài khoản.' : ['DATA_CONFLICT','ACCOUNT_CONFLICT'].includes(data.message) ? 'Dữ liệu tài khoản đã thay đổi hoặc tên đăng nhập bị trùng. Hãy làm mới rồi thử lại.' : data.message || 'Không thể xử lý tài khoản.');
    return data;
  }
  let embedConfigs = [];
  window.updateEmbedIdentityState = function() {
    const enabled=el('embed-identity-enabled').checked;
    el('embed-identity-status').textContent=enabled?'Đã bật xác thực':'Chưa bật';
    el('embed-identity-status').classList.toggle('is-enabled',enabled);
    el('embed-identity-required').disabled=!enabled;
  };
  function renderEmbedSessions(sessions) {
    el('embed-session-count').textContent=sessions.length;
    el('embed-identity-sessions').innerHTML=sessions.map(s=>'<tr><td><strong>'+html(s.identity?.name || 'Khách #'+s.sessionId.slice(-8))+'</strong><span>'+html(s.identity?.subject || s.sessionId)+'</span></td><td>'+html(s.embedName)+'<span>'+html(s.origin)+'</span></td><td><span class="embed-session-status '+(s.online?'is-online':'')+'">'+(s.online?'Online':'Offline')+'</span></td><td>'+html(new Date(s.lastSeen).toLocaleString('vi-VN'))+'</td></tr>').join('') || '<tr><td colspan="4" class="embed-session-empty"><i class="fa-regular fa-comments" aria-hidden="true"></i><strong>Chưa có phiên chat</strong><p>Các phiên sẽ xuất hiện khi người dùng mở widget trên website.</p></td></tr>';
  }
  window.refreshEmbedSessions = async function() {
    const button=el('embed-sessions-refresh'); button.disabled=true;
    try {renderEmbedSessions((await request('/api/accounts/embed-identity')).sessions);}
    catch(error) {window.showToast?.(error.message,'error');}
    finally {button.disabled=false;}
  };
  window.selectEmbedIdentity = function() {
    const setup = embedConfigs.find(c=>c.id===el('embed-identity-config').value)?.identity || {};
    el('embed-identity-enabled').checked=!!setup.enabled;
    el('embed-identity-required').checked=!!setup.required;
    for(const [field,key] of [['server','serverUrl'],['issuer','issuer'],['audience','audience'],['key','publicKey']]) el('embed-identity-'+field).value=setup[key] || '';
    el('embed-identity-save').disabled=!embedConfigs.length;
    window.updateEmbedIdentityState();
  };
  window.loadEmbedIdentity = async function() {
    if(!el('embed-identity-config')) return;
    try {
      const data=await request('/api/accounts/embed-identity'), selected=el('embed-identity-config').value;
      embedConfigs=data.configs.filter(c=>c.mode!=='page'||c.identity?.enabled);
      if(el('embed-auth-card')) el('embed-auth-card').hidden=!embedConfigs.length;
      // Visitor sessions come from the chat-bubble widget; page-mode widgets sign in inside /chat instead.
      if(el('embed-sessions-card')) el('embed-sessions-card').hidden=!data.configs.some(c=>c.mode!=='page');
      el('embed-identity-config').innerHTML=embedConfigs.map(c=>'<option value="'+html(c.id)+'">'+html(c.name)+'</option>').join('');
      if(embedConfigs.some(c=>c.id===selected)) el('embed-identity-config').value=selected;
      window.selectEmbedIdentity();
      el('embed-identity-message').textContent=embedConfigs.length?'':'Tạo cấu hình Embed Chat trước khi thiết lập xác thực.';
      renderEmbedSessions(data.sessions);
    } catch(error) {el('embed-identity-message').textContent=error.message;}
  };
  window.saveEmbedIdentity = async function(event) {
    event.preventDefault(); el('embed-identity-save').disabled=true;
    el('embed-identity-message').classList.remove('is-error');
    el('embed-identity-message').textContent='Đang lưu cấu hình…';
    try {
      await request('/api/accounts/embed-identity','PUT',{embedId:el('embed-identity-config').value,identity:{enabled:el('embed-identity-enabled').checked,required:el('embed-identity-required').checked,serverUrl:el('embed-identity-server').value,issuer:el('embed-identity-issuer').value,audience:el('embed-identity-audience').value,publicKey:el('embed-identity-key').value}});
      await window.loadEmbedIdentity(); el('embed-identity-message').textContent='Đã lưu server xác thực.';
    } catch(error) {el('embed-identity-message').textContent=error.message;el('embed-identity-message').classList.add('is-error');}
    finally {el('embed-identity-save').disabled=!embedConfigs.length;}
  };
  // Which client the account may sign in to (see auth_service.clientAccess).
  const CLIENT_ACCESS_LABELS = { both: 'Trò chuyện + quản lý', chat: 'Chỉ trò chuyện', admin: 'Chỉ quản lý' };
  window.loadAccounts = function () {
    if (loading) return loading;
    if (!el('accounts-rows')) return Promise.resolve();
    window.loadEmbedIdentity();
    el('accounts-refresh').disabled = true; el('accounts-message').textContent = 'Đang tải tài khoản…';
    loading = Promise.all([request('/api/accounts'),request('/api/accounts/roles')]).then(([data,metadata]) => {
      accounts = data.accounts; roles=metadata.roles; capabilities=metadata.capabilities; functionGroups=metadata.functionGroups||[];
      renderRoleOptions(); window.renderAccountsTable(); el('accounts-message').textContent = `${accounts.length} tài khoản`;
    })
      .catch(error => { el('accounts-message').textContent = error.message; return false; })
      .finally(() => { loading = null; el('accounts-refresh').disabled = false; });
    return loading;
  };
  window.filterAccountsTable = function () { window.paginationState.accounts.currentPage = 1; window.renderAccountsTable(); };
  window.renderAccountsTable = function renderAccountsTable() {
    const keyword = el('accounts-search').value.trim().toLocaleLowerCase('vi'), role = el('accounts-role-filter').value, status = el('accounts-status-filter').value;
    const rows = accounts.filter(a => (!role || a.role === role) && (!status || a.isActive === (status === 'active')) && `${a.username} ${a.displayName} ${a.email}`.toLocaleLowerCase('vi').includes(keyword));
    const page = window.paginationState.accounts; page.currentPage = Math.max(1, Math.min(page.currentPage, Math.ceil(rows.length/page.itemsPerPage) || 1));
    el('accounts-rows').innerHTML = rows.slice((page.currentPage-1)*page.itemsPerPage, page.currentPage*page.itemsPerPage).map((a, index) => `<tr><td class="row-index">${(page.currentPage - 1) * page.itemsPerPage + index + 1}</td><td class="accounts-identity-cell"><strong>${html(a.displayName || a.username)}</strong><span class="accounts-login-name"><span class="accounts-identity-label">Tên đăng nhập:</span> ${html(a.username)}</span>${a.email ? `<span class="accounts-email"><span class="accounts-identity-label">Email:</span> ${html(a.email)}</span>` : ''}</td><td><span class="accounts-badge ${a.role === 'admin' ? 'admin' : ''}">${html(a.roleLabel||a.role)}</span>${a.permissionOverrides!==null?'<small class="accounts-override-label">Quyền riêng kiểu cũ</small>':''}${a.extraFunctionGroups?.length?`<small class="accounts-override-label">+${a.extraFunctionGroups.length} nhóm bổ sung</small>`:''}</td><td><span class="accounts-badge">${CLIENT_ACCESS_LABELS[a.clientAccess] || CLIENT_ACCESS_LABELS.both}</span></td><td><span class="accounts-badge ${a.isActive ? 'active' : 'locked'}">${a.isActive ? 'Đang hoạt động' : 'Đã khóa'}</span></td><td>${a.lastLoginAt ? html(new Date(a.lastLoginAt).toLocaleString('vi-VN')) : 'Chưa đăng nhập'}</td><td><div class="accounts-row-actions"><button type="button" class="btn-secondary-sm" onclick="openAccountEditor('${html(a.id)}')"><i class="fa-solid fa-pen"></i> Sửa</button><button type="button" class="btn-secondary-sm" onclick="openAccountEditor('${html(a.id)}', 'password')"><i class="fa-solid fa-key"></i> Mật khẩu</button></div></td></tr>`).join('') || '<tr><td colspan="7" class="accounts-empty">Không có tài khoản phù hợp.</td></tr>';
    window.renderPaginationControls('accounts-pagination', 'accounts', rows.length, window.renderAccountsTable);
  };
  window.openAccountEditor = function (id, selectedMode) {
    trigger = document.activeElement; editing = id ? accounts.find(a => a.id === id) : null;
    if (id && !editing) return;
    mode = selectedMode === 'password' ? 'password' : editing ? 'edit' : 'create';
    el('accounts-form').reset(); el('accounts-editor-message').textContent = '';
    el('accounts-editor-title').textContent = mode === 'password' ? 'Đặt lại mật khẩu' : editing ? 'Chỉnh sửa tài khoản' : 'Thêm tài khoản';
    el('accounts-editor-subtitle').textContent = mode === 'password' ? `Tài khoản ${editing.username}. Các phiên đăng nhập cũ sẽ bị thu hồi.` : 'Đổi vai trò hoặc khóa tài khoản sẽ thu hồi phiên đăng nhập cũ.';
    for (const name of ['username','name','email']) el(`accounts-${name}-label`).hidden = mode === 'password';
    el('accounts-access-fields').hidden = mode === 'password'; el('accounts-password-label').hidden = mode === 'edit';
    for (const name of ['username','name','email']) el('accounts-'+name).disabled = mode === 'password' || (name === 'username' && mode === 'edit');
    el('accounts-password').disabled = mode === 'edit'; el('accounts-password').required = mode !== 'edit';
    if (editing) { el('accounts-username').value = editing.username; el('accounts-name').value = editing.displayName; el('accounts-email').value = editing.email; el('accounts-role').value = editing.role; el('accounts-active').value = editing.isActive ? 'active' : 'inactive'; el('accounts-client-access').value = editing.clientAccess || 'both'; }
    else { el('accounts-role').value='user'; el('accounts-client-access').value='both'; }
    renderGroupChecks('accounts-extra-groups',editing?.extraFunctionGroups||[],'updateAccountPermissionPreview()');
    el('accounts-legacy-label').hidden=!(editing&&(editing.permissionOverrides!=null||editing.dataOverrides!=null)); el('accounts-legacy-clear').checked=false;
    window.updateAccountPermissionPreview();
    el('accounts-editor').hidden = false; (mode === 'password' ? el('accounts-password') : mode === 'edit' ? el('accounts-name') : el('accounts-username')).focus();
  };
  window.closeAccountEditor = function () { if (saving) return; el('accounts-editor').hidden = true; el('accounts-password').value = ''; trigger?.focus(); };
  window.saveAccountEditor = async function (event) {
    event.preventDefault(); if (saving) return; saving = true; el('accounts-save').disabled = true;
    el('accounts-editor-message').textContent = '';
    const selectedId = editing?.id;
    try {
      const body = mode === 'password' ? { password:el('accounts-password').value, revision:editing.revision } : {
        displayName:el('accounts-name').value, email:el('accounts-email').value, role:el('accounts-role').value, isActive:el('accounts-active').value === 'active', clientAccess:el('accounts-client-access').value,
        extraFunctionGroups:el('accounts-role').value==='admin'?[]:readChecked('accounts-extra-groups'),
        ...(el('accounts-role').value==='admin'||el('accounts-legacy-clear').checked?{permissions:null,dataAccess:null}:{}),
        ...(editing ? { revision:editing.revision } : { username:el('accounts-username').value, password:el('accounts-password').value }) };
      await request('/api/accounts' + (editing ? '/' + encodeURIComponent(editing.id) + (mode === 'password' ? '/password' : '') : ''), mode === 'edit' ? 'PUT' : 'POST', body);
      el('accounts-password').value = '';
      if (mode === 'password') { const me = await request('/api/auth/me'); if (!me.authenticated || me.account?.id === selectedId) { window.location.href='/admin/login'; return; } }
      saving = false; window.closeAccountEditor(); window.invalidateMainTabData?.('accounts'); if(loading)await loading; await window.loadAccounts(); window.showToast?.('Đã lưu tài khoản.', 'success');
    } catch (error) { el('accounts-editor-message').textContent = error.message; }
    finally { saving = false; el('accounts-save').disabled = false; }
  };
  function renderRoleOptions() {
    for(const id of ['accounts-role','accounts-role-filter']) {
      const value=el(id).value;
      el(id).innerHTML=(id.endsWith('filter')?'<option value="">Tất cả vai trò</option>':'')+roles.map(r=>`<option value="${html(r.id)}">${html(r.name)}</option>`).join('');
      if(roles.some(r=>r.id===value)||id.endsWith('filter')) el(id).value=value;
    }
    window.renderRolesTable();
  }
  // Roles as a paginated table: role, its function groups, accounts using it.
  window.filterRolesTable=function(){window.paginationState.account_roles={...(window.paginationState.account_roles||{itemsPerPage:10}),currentPage:1};window.renderRolesTable();};
  window.renderRolesTable=function renderRolesTable(){
    const body=el('accounts-roles-list'); if(!body) return;
    const keyword=(el('accounts-roles-search')?.value||'').trim().toLocaleLowerCase('vi');
    const groupName=id=>functionGroups.find(g=>g.id===id)?.name||id;
    const order=r=>r.id==='admin'?0:r.builtin?1:2;
    const rows=roles.filter(r=>`${r.name} ${r.id} ${r.description||''} ${(r.functionGroups||[]).map(groupName).join(' ')}`.toLocaleLowerCase('vi').includes(keyword))
      .sort((a,b)=>order(a)-order(b)||a.name.localeCompare(b.name,'vi'));
    const page=window.getAdminListPage(rows,'account_roles');
    body.innerHTML=page.items.map((r,index)=>{
      const used=accounts.filter(a=>a.role===r.id).length;
      const groups=r.id==='admin'?'<span class="accounts-role-muted">Toàn quyền, không cần nhóm</span>':Array.isArray(r.functionGroups)?(r.functionGroups.map(id=>`<span class="accounts-group-chip">${html(groupName(id))}</span>`).join('')||'<span class="accounts-role-muted">Chưa có nhóm</span>'):`<span class="accounts-role-muted">Kiểu cũ: ${(r.permissions||[]).length} quyền</span>`;
      const tag=r.id==='admin'?'<span class="accounts-badge admin">Toàn quyền</span>':r.builtin?'<span class="accounts-badge">Hệ thống</span>':'';
      return `<tr><td class="row-index">${page.start+index+1}</td><td class="accounts-identity-cell"><strong>${html(r.name)}</strong><span class="accounts-login-name">${html(r.id)}</span>${tag}</td><td><div class="accounts-group-chips">${groups}</div></td><td>${used}</td><td class="accounts-role-description">${html(r.description||'')}</td><td><button type="button" class="btn-secondary-sm" onclick="openRoleEditor('${html(r.id)}')">${r.id==='admin'?'<i class="fa-solid fa-eye"></i> Xem quyền':'<i class="fa-solid fa-pen"></i> Sửa'}</button></td></tr>`;
    }).join('')||'<tr><td colspan="6" class="accounts-empty">Không có vai trò phù hợp.</td></tr>';
    window.renderPaginationControls('accounts-roles-pagination','account_roles',rows.length,window.renderRolesTable);
  };
  function renderGroupChecks(id,selected,onchange) {
    el(id).innerHTML=functionGroups.length?'<div class="accounts-permission-grid accounts-group-grid">'+functionGroups.map(g=>`<label title="${html(g.description||'')}"><input type="checkbox" value="${html(g.id)}" ${selected.includes(g.id)?'checked':''} onchange="${onchange}"><span><strong>${html(g.name)}</strong><small>${g.permissions.length} quyền${Object.keys(g.packages||{}).length?' · có gói bảng':''}${(g.workflows||[]).length?` · ${g.workflows.length} mẫu`:''}</small></span></label>`).join('')+'</div>':'<small>Chưa có nhóm chức năng. Tạo tại Quản lý dữ liệu → Nhóm chức năng.</small>';
  }
  function readChecked(id) {return [...el(id).querySelectorAll('input:checked')].map(n=>n.value);}
  // Union of the chosen groups, as the server computes it (account_roles.effective).
  function preview(groupIds) {
    const chosen=groupIds.map(id=>functionGroups.find(g=>g.id===id)).filter(Boolean);
    const permissions=new Set(chosen.flatMap(g=>g.permissions)), packages=new Set(chosen.flatMap(g=>Object.entries(g.packages||{}).flatMap(([s,p])=>Object.keys(p).map(k=>s+'/'+k))));
    const sources=new Set(chosen.flatMap(g=>[...(g.sources?.sql||[]),...(g.sources?.documents||[])])), workflows=new Set(chosen.flatMap(g=>g.workflows||[]));
    return chosen.length?`Quyền tổng hợp: ${permissions.size} quyền chức năng (${capabilities.filter(c=>permissions.has(c.id)).map(c=>c.label).join(', ')||'không có'}) · ${packages.size} gói bảng · ${sources.size} nguồn hạn chế · ${workflows.size} mẫu nghiệp vụ.`:'Chưa chọn nhóm chức năng nào: vai trò không có quyền sử dụng.';
  }
  window.updateAccountPermissionPreview=function() {
    el('accounts-permission-section').hidden=mode==='password'||el('accounts-role').value==='admin';
    const role=roles.find(r=>r.id===el('accounts-role').value);
    el('accounts-effective-preview').textContent=Array.isArray(role?.functionGroups)?preview([...role.functionGroups,...readChecked('accounts-extra-groups')]):'Vai trò kiểu cũ: '+((role?.permissions||[]).length)+' quyền chức năng, cộng thêm các nhóm bổ sung.';
  };
  window.updateRolePreview=function(){el('role-preview').textContent=preview(readChecked('role-function-groups'));};
  window.openRoleEditor=function(id) {
    roleEditing=id?roles.find(r=>r.id===id):null;
    const readonly=roleEditing?.id==='admin', system=!!roleEditing?.builtin;
    el('accounts-role-form').reset(); el('account-role-message').textContent=''; el('account-role-message').dataset.kind='';
    el('accounts-role-title').textContent=readonly?'Chi tiết vai trò':id?'Chỉnh sửa vai trò':'Thêm vai trò';
    el('account-role-id').value=roleEditing?.id||''; el('account-role-id').disabled=!!id;
    el('account-role-name').value=roleEditing?.name||''; el('account-role-description').value=roleEditing?.description||'';
    renderGroupChecks('role-function-groups',roleEditing?.functionGroups||[],'updateRolePreview()');window.updateRolePreview();
    for(const key of ['account-role-name','account-role-description'])el(key).disabled=readonly||system;
    el('role-function-groups').querySelectorAll('input').forEach(node=>node.disabled=readonly);
    el('account-role-save').hidden=readonly;
    el('account-role-delete').hidden=!roleEditing||system;
    if(readonly){el('role-function-groups').innerHTML='';el('role-preview').textContent='';el('account-role-message').textContent='Admin có toàn quyền sử dụng và quản trị. Đây là vai trò hệ thống, không sửa hoặc xóa.';}
    else if(system){el('account-role-message').dataset.kind='info';el('account-role-message').textContent='Vai trò hệ thống: chỉ đổi được các nhóm chức năng, không đổi mã, tên hay mô tả.';}
    else if(roleEditing&&!Array.isArray(roleEditing.functionGroups)){el('account-role-message').dataset.kind='info';el('account-role-message').textContent=`Vai trò kiểu cũ (${(roleEditing.permissions||[]).length} quyền). Chọn nhóm chức năng rồi lưu để chuyển sang cách mới.`;}
    el('accounts-role-editor').hidden=false;
    if(readonly)el('accounts-role-form').querySelector('header button').focus();else el(id?'account-role-name':'account-role-id').focus();
  };
  window.deleteRoleEditor=async function() {
    if(!roleEditing||roleEditing.builtin||roleSaving)return;
    const used=accounts.filter(a=>a.role===roleEditing.id).length;
    if(used){el('account-role-message').textContent=`Vai trò đang được dùng bởi ${used} tài khoản. Hãy đổi vai trò cho các tài khoản này trước.`;return;}
    const ok=window.showUiConfirm?await window.showUiConfirm(`Xóa vai trò “${roleEditing.name}”?`,{title:'Xóa vai trò',confirmText:'Xóa'}):window.confirm(`Xóa vai trò “${roleEditing.name}”?`);
    if(!ok)return;
    roleSaving=true;el('account-role-delete').disabled=true;
    try{await request('/api/accounts/roles/'+encodeURIComponent(roleEditing.id)+'?revision='+roleEditing.revision,'DELETE');roleSaving=false;window.closeRoleEditor();if(loading)await loading;await window.loadAccounts();window.showToast?.('Đã xóa vai trò.','success');}
    catch(error){el('account-role-message').dataset.kind='';el('account-role-message').textContent=error.message;}
    finally{roleSaving=false;el('account-role-delete').disabled=false;}
  };
  window.closeRoleEditor=function(){if(!roleSaving)el('accounts-role-editor').hidden=true;};
  window.saveRoleEditor=async function(event) {
    event.preventDefault();if(roleSaving||roleEditing?.id==='admin')return;roleSaving=true;el('account-role-save').disabled=true;
    try {
      const body={id:el('account-role-id').value,name:el('account-role-name').value,description:el('account-role-description').value,functionGroups:readChecked('role-function-groups'),revision:roleEditing?.revision};
      const result=await request('/api/accounts/roles'+(roleEditing?'/'+encodeURIComponent(roleEditing.id):''),roleEditing?'PUT':'POST',body);
      if(loading)await loading;await window.loadAccounts();roleSaving=false;window.closeRoleEditor();
      if(!el('accounts-editor').hidden){el('accounts-role').value=result.role.id;window.updateAccountPermissionPreview();}
      window.showToast?.('Đã lưu vai trò.','success');
    } catch(error){el('account-role-message').dataset.kind='';el('account-role-message').textContent=error.message;} finally{roleSaving=false;el('account-role-save').disabled=false;}
  };
  document.addEventListener('keydown', event => {
    const roleOverlay=el('accounts-role-editor');
    const overlay = roleOverlay&&!roleOverlay.hidden?roleOverlay:el('accounts-editor'); if (!overlay || overlay.hidden) return;
    if (event.key === 'Escape') {if(overlay===roleOverlay)window.closeRoleEditor();else window.closeAccountEditor();}
    if (event.key === 'Tab') { const items = [...overlay.querySelectorAll('button,input,select')].filter(node => !node.disabled && node.getClientRects().length); const first=items[0],last=items.at(-1);
      if (event.shiftKey && document.activeElement===first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first?.focus(); } }
  });
})();
