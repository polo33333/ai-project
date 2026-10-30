(function () {
  'use strict';
  let items = [], offset = 0, editing = null, canApprove = false, owner = null, loadSequence = 0;
  const size = 20;
  const el = id => document.getElementById(id);
  const scope = () => el('memory-scope').value;
  const endpoint = () => scope() === 'events' ? '/api/memory/events' : '/api/memory';
  async function request(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Không tải được bộ nhớ.');
    return data;
  }
  function editor(item = null) {
    editing = item;
    el('memory-editor').hidden = false;
    el('memory-editor-title').textContent = item ? 'Chỉnh sửa bộ nhớ' : 'Thêm bộ nhớ';
    el('memory-title').value = item?.title || '';
    el('memory-content').value = item?.content || '';
    el('memory-expiry').value = item?.expiresAt?.slice(0, 10) || '';
    el('memory-approved').checked = item?.status === 'approved';
    el('memory-approve-label').hidden = scope() !== 'organization' || !canApprove;
    el('memory-title').focus();
  }
  async function load() {
    const sequence = ++loadSequence;
    el('memory-notice').dataset.error = 'false';
    el('memory-notice').textContent = 'Đang tải…';
    el('memory-list').setAttribute('aria-busy', 'true');
    try {
      const params = new URLSearchParams({ limit: size, offset, q: el('memory-query').value });
      if (scope() !== 'events') params.set('scope', scope());
      const data = await request(`${endpoint()}?${params}`);
      if (sequence !== loadSequence) return;
      items = data.items; canApprove = data.canApprove;
      el('memory-notice').textContent = data.enabled ? '' : 'Bộ nhớ dài hạn đang tắt trong cấu hình hệ thống.';
      el('memory-new').hidden = scope() === 'events';
      el('memory-new').disabled = !data.enabled;
      el('memory-help').textContent = scope() === 'personal'
        ? 'Chỉ bạn được đọc bộ nhớ này, kể cả khi bắt đầu hội thoại mới. Không lưu mật khẩu hoặc dữ liệu nghiệp vụ cần cập nhật.'
        : scope() === 'organization' ? 'Hướng dẫn chung chỉ được dùng trong chat sau khi quản trị viên duyệt. Bản sửa cần được duyệt lại.'
        : 'Các tác vụ thành công của bạn. Trợ lý kiểm tra lại quyền nguồn khi tìm và không coi kết quả cũ là số liệu hiện tại.';
      render();
      el('memory-total').textContent = `${data.total} ${scope() === 'events' ? 'tác vụ' : 'bộ nhớ'}`;
      el('memory-count').textContent = data.total ? `Hiển thị ${offset + 1}–${offset + items.length} trong ${data.total} ${scope() === 'events' ? 'tác vụ' : 'bộ nhớ'}` : 'Chưa có kết quả';
      el('memory-prev').disabled = offset === 0;
      el('memory-next').disabled = !data.hasMore;
    } catch (error) {
      if (sequence !== loadSequence) return;
      el('memory-notice').dataset.error = 'true'; el('memory-notice').textContent = error.message;
    } finally { if (sequence === loadSequence) el('memory-list').setAttribute('aria-busy', 'false'); }
  }
  function render() {
    const list = el('memory-list'); list.replaceChildren();
    if (!items.length) {
      const searching = Boolean(el('memory-query').value.trim());
      const empty = document.createElement('div'); empty.className = 'memory-empty';
      const icon = document.createElement('span'); icon.className = 'memory-empty-icon';
      icon.innerHTML = `<i class="fa-solid ${searching ? 'fa-magnifying-glass' : scope() === 'events' ? 'fa-clock-rotate-left' : 'fa-brain'}" aria-hidden="true"></i>`;
      const title = document.createElement('h3'); title.textContent = searching ? 'Không tìm thấy kết quả' : scope() === 'events' ? 'Chưa có tác vụ được ghi nhớ' : 'Chưa có bộ nhớ';
      const description = document.createElement('p'); description.textContent = searching ? 'Thử từ khóa khác hoặc thay đổi phạm vi tìm kiếm.'
        : scope() === 'events' ? 'Các tác vụ thành công sẽ xuất hiện tại đây để bạn tìm lại khi cần.'
        : scope() === 'organization' ? 'Thêm hướng dẫn chung cho tổ chức. Agent sẽ sử dụng sau khi quản trị viên phê duyệt.'
        : 'Thêm sở thích hoặc cách trình bày bạn muốn Agent ghi nhớ cho những cuộc hội thoại sau.';
      empty.append(icon, title, description); list.appendChild(empty);
    }
    for (const item of items) {
      const card = document.createElement('article'); card.className = 'memory-entry';
      const header = document.createElement('header'), title = document.createElement('h3'), status = document.createElement('small');
      title.textContent = item.title || item.question;
      status.className = 'memory-entry-status'; status.dataset.status = item.status;
      status.textContent = item.status === 'approved' ? 'Đã duyệt' : item.status === 'pending' ? 'Chờ duyệt' : scope() === 'events' ? 'Đã hoàn tất' : 'Cá nhân';
      header.append(title, status); card.appendChild(header);
      const content = document.createElement('p'); content.textContent = item.content || [item.workflowName, item.table, item.runId ? `Mã tác vụ: ${item.runId}` : ''].filter(Boolean).join('\n'); card.appendChild(content);
      const date = document.createElement('small'); date.textContent = `Cập nhật: ${new Date(item.updatedAt).toLocaleString('vi-VN')}${item.expiresAt ? ` · Hết hạn: ${new Date(item.expiresAt).toLocaleDateString('vi-VN')}` : ''}`; card.appendChild(date);
      const editable = item.owner === owner || (canApprove && item.scope === 'organization');
      if (editable) {
        const actions = document.createElement('div'); actions.className = 'memory-entry-actions';
        if (scope() !== 'events') {
          const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'btn btn-secondary'; edit.innerHTML = '<i class="fa-solid fa-pen" aria-hidden="true"></i> Sửa'; edit.onclick = () => editor(item); actions.appendChild(edit);
        }
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-secondary memory-delete'; remove.innerHTML = '<i class="fa-solid fa-trash" aria-hidden="true"></i> Xóa';
        remove.onclick = async () => {
          remove.disabled = true;
          try { await request(endpoint(), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, revision: item.revision }) }); await load(); }
          catch (error) { el('memory-notice').textContent = error.message; remove.disabled = false; }
        };
        actions.appendChild(remove); card.appendChild(actions);
      }
      list.appendChild(card);
    }
  }
  window.loadAiMemory = async function () {
    if (!el('memory-list')) return;
    if (!el('memory-scope').dataset.bound) {
      el('memory-scope').dataset.bound = 'true';
      el('memory-scope').onchange = () => { offset = 0; el('memory-editor').hidden = true; load(); };
      el('memory-search').onclick = () => { offset = 0; load(); };
      el('memory-query').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); offset = 0; load(); } };
      el('memory-new').onclick = () => editor();
      el('memory-cancel').onclick = () => { el('memory-editor').hidden = true; };
      el('memory-prev').onclick = () => { offset = Math.max(0, offset - size); load(); };
      el('memory-next').onclick = () => { offset += size; load(); };
      el('memory-editor').onsubmit = async event => {
        event.preventDefault(); const idle = window.busyButton?.(event.submitter || el('memory-editor').querySelector('[type="submit"]'), 'Đang lưu…'); if (idle === null) return;
        try {
          await request('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            id: editing?.id, revision: editing?.revision, scope: scope(), title: el('memory-title').value,
            content: el('memory-content').value, expiresAt: el('memory-expiry').value || null,
            approved: canApprove && el('memory-approved').checked }) });
          el('memory-editor').hidden = true; await load();
        } catch (error) { el('memory-notice').textContent = error.message; }
        finally { idle?.(); }
      };
    }
    try { const auth = await request('/api/auth/me'); owner = auth.account ? `account:${auth.account.id}` : null; await load(); }
    catch (error) { el('memory-notice').textContent = error.message; return false; }
  };
})();
