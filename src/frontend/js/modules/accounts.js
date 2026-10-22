(function () {
  'use strict';
  let accounts = [], loading = null, editing = null, mode = 'create', trigger = null, saving = false;
  let roles=[], capabilities=[], resources={sql:[],documents:[]}, roleEditing=null, roleSaving=false;
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
      embedConfigs=data.configs;
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
  window.loadAccounts = function () {
    if (loading) return loading;
    if (!el('accounts-rows')) return Promise.resolve();
    window.loadEmbedIdentity();
    el('accounts-refresh').disabled = true; el('accounts-message').textContent = 'Đang tải tài khoản…';
    loading = Promise.all([request('/api/accounts'),request('/api/accounts/roles')]).then(([data,metadata]) => {
      accounts = data.accounts; roles=metadata.roles; capabilities=metadata.capabilities; resources=metadata.resources;
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
    el('accounts-rows').innerHTML = rows.slice((page.currentPage-1)*page.itemsPerPage, page.currentPage*page.itemsPerPage).map((a, index) => `<tr><td class="row-index">${(page.currentPage - 1) * page.itemsPerPage + index + 1}</td><td class="accounts-identity-cell"><strong>${html(a.displayName || a.username)}</strong><span class="accounts-login-name"><span class="accounts-identity-label">Tên đăng nhập:</span> ${html(a.username)}</span>${a.email ? `<span class="accounts-email"><span class="accounts-identity-label">Email:</span> ${html(a.email)}</span>` : ''}</td><td><span class="accounts-badge ${a.role === 'admin' ? 'admin' : ''}">${html(a.roleLabel||a.role)}</span>${a.permissionOverrides!==null?'<small class="accounts-override-label">Quyền riêng</small>':''}</td><td><span class="accounts-badge ${a.isActive ? 'active' : 'locked'}">${a.isActive ? 'Đang hoạt động' : 'Đã khóa'}</span></td><td>${a.lastLoginAt ? html(new Date(a.lastLoginAt).toLocaleString('vi-VN')) : 'Chưa đăng nhập'}</td><td><div class="accounts-row-actions"><button type="button" class="btn-secondary-sm" onclick="openAccountEditor('${html(a.id)}')"><i class="fa-solid fa-pen"></i> Sửa</button><button type="button" class="btn-secondary-sm" onclick="openAccountEditor('${html(a.id)}', 'password')"><i class="fa-solid fa-key"></i> Mật khẩu</button></div></td></tr>`).join('') || '<tr><td colspan="6" class="accounts-empty">Không có tài khoản phù hợp.</td></tr>';
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
    if (editing) { el('accounts-username').value = editing.username; el('accounts-name').value = editing.displayName; el('accounts-email').value = editing.email; el('accounts-role').value = editing.role; el('accounts-active').value = editing.isActive ? 'active' : 'inactive'; }
    else el('accounts-role').value='user';
    el('accounts-permission-mode').value=editing?.permissionOverrides==null?'inherit':'custom';
    renderPermissionChecks('accounts-permissions',editing?.permissionOverrides||roles.find(r=>r.id===el('accounts-role').value)?.permissions||[]);
    renderDataAccess('accounts-data-access',editing?.dataOverrides);
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
        displayName:el('accounts-name').value, email:el('accounts-email').value, role:el('accounts-role').value, isActive:el('accounts-active').value === 'active',
        permissions:el('accounts-role').value==='admin'||el('accounts-permission-mode').value==='inherit'?null:readPermissions('accounts-permissions'),
        dataAccess:el('accounts-role').value==='admin'?null:readDataAccess('accounts-data-access'),
        ...(editing ? { revision:editing.revision } : { username:el('accounts-username').value, password:el('accounts-password').value }) };
      await request('/api/accounts' + (editing ? '/' + encodeURIComponent(editing.id) + (mode === 'password' ? '/password' : '') : ''), mode === 'edit' ? 'PUT' : 'POST', body);
      el('accounts-password').value = '';
      if (mode === 'password') { const me = await request('/api/auth/me'); if (!me.authenticated || me.account?.id === selectedId) { window.location.href='/login.html'; return; } }
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
    el('accounts-roles-list').innerHTML=roles.map(r=>`<article><div><strong>${html(r.name)}</strong><small>${html(r.id)} · ${r.builtin?'Vai trò hệ thống':`${r.permissions.length} quyền sử dụng`}</small><p>${html(r.description|| (r.id==='admin'?'Toàn quyền quản trị hệ thống.':'Quyền mặc định được áp dụng khi tài khoản chọn kế thừa.'))}</p></div><button type="button" class="btn-secondary-sm" onclick="openRoleEditor('${html(r.id)}')">${r.builtin?'Xem quyền':'Chỉnh sửa'}</button></article>`).join('');
  }
  function renderPermissionChecks(id,grants) {
    el(id).innerHTML='<div class="accounts-permission-grid">'+capabilities.map(c=>`<label><input type="checkbox" value="${html(c.id)}" ${grants.includes(c.id)?'checked':''}>${html(c.label)}</label>`).join('')+'</div>';
  }
  function readPermissions(id) {return [...el(id).querySelectorAll('input:checked')].map(n=>n.value);}
  function renderDataAccess(id,access) {
    el(id).innerHTML=['sql','documents'].map(type=>`<fieldset class="accounts-data-scope"><legend>${type==='sql'?'Nguồn SQL được phép':'Tài liệu được phép'}</legend><select class="form-control" data-scope="${type}" onchange="this.nextElementSibling.hidden=this.value==='inherit'"><option value="inherit">${id.startsWith('role')?'Tất cả nguồn theo chính sách':'Kế thừa phạm vi của vai trò'}</option><option value="selected" ${access?.[type]!=null?'selected':''}>Chỉ các nguồn được chọn</option></select><div class="accounts-source-options" ${access?.[type]==null?'hidden':''}>${(resources[type]||[]).map(r=>`<label><input type="checkbox" data-source="${type}" value="${html(r.id)}" ${access?.[type]?.includes(r.id)?'checked':''}><span>${html(r.name)}</span></label>`).join('')||'<small>Chưa có nguồn dữ liệu.</small>'}<small>Không chọn nguồn nào nghĩa là không được truy cập nhóm dữ liệu này.</small></div></fieldset>`).join('');
  }
  function readDataAccess(id) {return Object.fromEntries(['sql','documents'].map(type=>[type,el(id).querySelector(`[data-scope="${type}"]`).value==='inherit'?null:[...el(id).querySelectorAll(`input[data-source="${type}"]:checked`)].map(n=>n.value)]));}
  window.updateAccountPermissionPreview=function() {
    el('accounts-permission-section').hidden=mode==='password'||el('accounts-role').value==='admin';
    const inherit=el('accounts-permission-mode').value==='inherit';
    if(inherit) renderPermissionChecks('accounts-permissions',roles.find(r=>r.id===el('accounts-role').value)?.permissions||[]);
    el('accounts-permissions').querySelectorAll('input').forEach(n=>n.disabled=inherit);
  };
  window.openRoleEditor=function(id) {
    roleEditing=id?roles.find(r=>r.id===id):null;
    const readonly=!!roleEditing?.builtin;
    el('accounts-role-form').reset(); el('account-role-message').textContent='';
    el('accounts-role-title').textContent=readonly?'Chi tiết vai trò':id?'Chỉnh sửa vai trò':'Thêm vai trò';
    el('account-role-id').value=roleEditing?.id||''; el('account-role-id').disabled=!!id;
    el('account-role-name').value=roleEditing?.name||''; el('account-role-description').value=roleEditing?.description||'';
    renderPermissionChecks('role-permissions',roleEditing?.permissions||[]);renderDataAccess('role-data-access',roleEditing?.dataAccess);
    for(const key of ['account-role-name','account-role-description'])el(key).disabled=readonly;
    for(const key of ['role-permissions','role-data-access'])el(key).querySelectorAll('input,select').forEach(node=>node.disabled=readonly);
    el('account-role-save').hidden=readonly;
    if(readonly)el('account-role-message').textContent=roleEditing.id==='admin'?'Admin có toàn quyền sử dụng và quản trị, bao gồm các chức năng bên dưới. Đây là vai trò hệ thống, không sửa hoặc xóa.':'User có các quyền sử dụng mặc định bên dưới, không có quyền quản trị. Để thay đổi quyền, cấu hình riêng cho tài khoản hoặc tạo vai trò tùy chỉnh.';
    el('accounts-role-editor').hidden=false;
    if(readonly)el('accounts-role-form').querySelector('header button').focus();else el(id?'account-role-name':'account-role-id').focus();
  };
  window.closeRoleEditor=function(){if(!roleSaving)el('accounts-role-editor').hidden=true;};
  window.saveRoleEditor=async function(event) {
    event.preventDefault();if(roleSaving||roleEditing?.builtin)return;roleSaving=true;el('account-role-save').disabled=true;
    try {
      const body={id:el('account-role-id').value,name:el('account-role-name').value,description:el('account-role-description').value,permissions:readPermissions('role-permissions'),dataAccess:readDataAccess('role-data-access'),revision:roleEditing?.revision};
      const result=await request('/api/accounts/roles'+(roleEditing?'/'+encodeURIComponent(roleEditing.id):''),roleEditing?'PUT':'POST',body);
      if(loading)await loading;await window.loadAccounts();roleSaving=false;window.closeRoleEditor();
      if(!el('accounts-editor').hidden){el('accounts-role').value=result.role.id;window.updateAccountPermissionPreview();}
      window.showToast?.('Đã lưu vai trò.','success');
    } catch(error){el('account-role-message').textContent=error.message;} finally{roleSaving=false;el('account-role-save').disabled=false;}
  };
  document.addEventListener('keydown', event => {
    const roleOverlay=el('accounts-role-editor');
    const overlay = roleOverlay&&!roleOverlay.hidden?roleOverlay:el('accounts-editor'); if (!overlay || overlay.hidden) return;
    if (event.key === 'Escape') {if(overlay===roleOverlay)window.closeRoleEditor();else window.closeAccountEditor();}
    if (event.key === 'Tab') { const items = [...overlay.querySelectorAll('button,input,select')].filter(node => !node.disabled && node.getClientRects().length); const first=items[0],last=items.at(-1);
      if (event.shiftKey && document.activeElement===first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement===last) { event.preventDefault(); first?.focus(); } }
  });
})();
