// Chat client (/chat): a client of its own for end users, with its own login (/chat/login),
// separate from the admin app. The conversation itself is the in-app "Trò chuyện" view
// (views/page_chat.html + page_chat.js); this file only adds the outer frame: the left
// navigation, the signed-in account and its usage limit.
(function initStandaloneChat() {
  'use strict';
  // ?embed=<id> marks the page shown inside a customer site (embed "page" mode); keep it on every move.
  const embedId = new URLSearchParams(window.location.search).get('embed');
  const EMBED_QUERY = embedId && /^[a-zA-Z0-9-]{1,64}$/.test(embedId) ? '?embed=' + embedId : '';
  const HOME_URL = '/chat' + EMBED_QUERY, LOGIN_URL = '/chat/login' + EMBED_QUERY;
  const HEARTBEAT_MS = 4 * 60 * 1000;
  const NAV_OPEN = 'kh-nav-open', NAV_COLLAPSED = 'kh-nav-collapsed', COLLAPSED_KEY = 'knowledgehub.chatNavCollapsed';
  const PERIODS = { day: 'ngày', week: 'tuần', month: 'tháng' };
  let account = null, usage = null;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const formatNumber = value => Number(value || 0).toLocaleString('vi-VN');
  const isMobile = () => matchMedia('(max-width: 760px)').matches;
  const initials = name => String(name || '?').trim().split(/\s+/).filter(Boolean).slice(-2).map(part => part[0]).join('').toUpperCase() || '?';

  async function loadAccount() {
    const response = await fetch('/api/auth/me', { cache: 'no-store' });
    const data = await response.json();
    if (!data.authenticated) { window.location.replace(LOGIN_URL); return null; }
    window.currentAccountRole = data.account?.role || 'user';
    window.currentAccountPermissions = data.account?.permissions || null;
    return data.account;
  }

  async function loadView() {
    const response = await fetch('/views/page_chat.html', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const template = document.createElement('template');
    template.innerHTML = await response.text();
    const container = document.getElementById('main-view-container');
    container.replaceChildren(template.content);
    container.removeAttribute('aria-busy');
    const view = document.getElementById('view-page_chat');
    view.style.display = 'block';
    return view;
  }

  function navItem(icon, label, action, extra = '') {
    return `<button type="button" class="kh-nav-item" data-kh-action="${action}" ${extra}><i class="${icon}" aria-hidden="true"></i><span>${label}</span></button>`;
  }

  // Turns the view's history column into the page's left navigation.
  function decorate(view) {
    document.querySelector('.account-settings-nav nav')?.insertAdjacentHTML('beforeend',
      `<button type="button" data-account-tab="help" onclick="selectAccountTab('help')"><i class="fa-regular fa-circle-question"></i>Trợ giúp</button>`);
    document.querySelector('.account-settings-content')?.insertAdjacentHTML('beforeend', `
      <section data-account-panel="help" hidden>
        <div class="account-panel-heading"><span class="account-panel-eyebrow">HƯỚNG DẪN SỬ DỤNG</span><h2>Trợ giúp</h2><p>Các thao tác thường dùng trong KnowledgeHub Chat.</p></div>
        <div class="kh-help-topics">
          <details open><summary>Trò chuyện và lịch sử</summary><p>Chọn Trò chuyện mới để bắt đầu. Các hội thoại nằm trong Gần đây; chọn Xem tất cả để mở rộng danh sách. Menu ba chấm cho phép đổi tên, ghim hoặc xóa từng hội thoại.</p></details>
          <details><summary>Đính kèm và dùng lại tệp</summary><p>Dùng nút đính kèm trong khung soạn để gửi tối đa 5 tệp. Mở mục Tệp trong hội thoại để xem và chọn tệp đã tải lên cho câu hỏi tiếp.</p></details>
          <details><summary>Tài khoản và hạn mức</summary><p>Mở Tài khoản để cập nhật tên, email hoặc đổi mật khẩu. Mục Hạn mức sử dụng hiển thị lượng token và thời điểm đặt lại. Liên hệ quản trị viên khi cần thay đổi hạn mức hoặc quyền truy cập.</p></details>
        </div>
      </section>`);
    const sidebar = view.querySelector('.chat-sidebar');
    sidebar.id = 'kh-chat-nav';
    // The in-app view folds this column into a bar on phones; here it is always a full drawer.
    sidebar.classList.add('sessions-open');
    sidebar.setAttribute('aria-label', 'Lịch sử trò chuyện');
    sidebar.insertAdjacentHTML('afterbegin', `
      <div class="kh-nav-brand">
        <a class="kh-nav-logo" href="${HOME_URL}" aria-label="KnowledgeHub Chat"><img src="/favicon.svg?v=20260908-brand-sync" alt="" aria-hidden="true"><span>KnowledgeHub Chat</span></a>
        <button type="button" class="kh-icon-btn kh-nav-collapse" data-kh-action="toggle-nav" title="Đóng thanh bên" aria-label="Đóng thanh bên" aria-controls="kh-chat-nav"><i class="fa-solid fa-table-columns" aria-hidden="true"></i></button>
      </div>
      <nav class="kh-nav-actions" aria-label="Chức năng">
        ${navItem('fa-regular fa-pen-to-square', 'Trò chuyện mới', 'new-chat')}
        ${navItem('fa-solid fa-magnifying-glass', 'Tìm kiếm đoạn chat', 'search')}
        ${navItem('fa-solid fa-gauge-high', 'Hạn mức sử dụng', 'usage', 'aria-haspopup="dialog"')}
      </nav>`);
    sidebar.insertAdjacentHTML('beforeend', `
      <div class="kh-nav-account">
        <div id="kh-account-menu" class="kh-account-menu" role="menu" hidden>
          ${navItem('fa-regular fa-user', 'Tài khoản', 'account-details', 'role="menuitem" aria-haspopup="dialog"')}
          <div class="kh-menu-separator" role="separator"></div>
          <div class="kh-appearance" role="group" aria-label="Giao diện">
            <span class="kh-menu-label">Giao diện</span>
            <div class="kh-theme-choices">
              <button type="button" data-theme-choice="light" aria-pressed="false"><i class="fa-regular fa-sun" aria-hidden="true"></i>Sáng</button>
              <button type="button" data-theme-choice="dark" aria-pressed="false"><i class="fa-regular fa-moon" aria-hidden="true"></i>Tối</button>
              <button type="button" data-theme-choice="auto" aria-pressed="false"><i class="fa-solid fa-desktop" aria-hidden="true"></i>Hệ thống</button>
            </div>
          </div>
          <div class="kh-menu-separator" role="separator"></div>
          ${navItem('fa-solid fa-gauge-high', 'Hạn mức sử dụng', 'usage', 'role="menuitem"')}
          <div class="kh-menu-separator" role="separator"></div>
          ${navItem('fa-regular fa-circle-question', 'Trợ giúp', 'help', 'role="menuitem" aria-haspopup="dialog"')}
          ${navItem('fa-solid fa-arrow-right-from-bracket', 'Đăng xuất', 'logout', 'role="menuitem"')}
        </div>
        <div id="kh-usage-mini" class="kh-usage-mini" hidden></div>
        <button type="button" class="kh-account-button" data-kh-action="account-menu" aria-haspopup="menu" aria-controls="kh-account-menu" aria-expanded="false">
          <span class="kh-avatar" aria-hidden="true">${escapeHtml(initials(account.displayName || account.username))}</span>
          <span class="kh-account-copy"><strong>${escapeHtml(account.displayName || account.username)}</strong><small>${escapeHtml(account.roleLabel || (account.role === 'admin' ? 'Quản trị viên' : 'Thành viên'))}</small></span>
          <i class="fa-solid fa-ellipsis" aria-hidden="true"></i>
        </button>
      </div>`);

    view.querySelector('.chat-main')?.insertAdjacentHTML('afterbegin', `
      <header class="kh-chat-topbar">
        <button type="button" class="kh-icon-btn kh-nav-open-btn" data-kh-action="toggle-nav" title="Mở thanh bên" aria-label="Mở thanh bên" aria-controls="kh-chat-nav" aria-expanded="false"><i class="fa-solid fa-bars" aria-hidden="true"></i></button>
        <span class="kh-chat-topbar-title"></span>
        <button type="button" class="kh-usage-chip" data-kh-action="usage" hidden aria-haspopup="dialog"></button>
        <button type="button" class="kh-icon-btn kh-topbar-new" data-kh-action="new-chat" title="Trò chuyện mới" aria-label="Trò chuyện mới"><i class="fa-regular fa-pen-to-square" aria-hidden="true"></i></button>
      </header>`);
  }

  function setNav(open) {
    const body = document.body;
    if (isMobile()) body.classList.toggle(NAV_OPEN, open);
    else {
      body.classList.toggle(NAV_COLLAPSED, !open);
      try { localStorage.setItem(COLLAPSED_KEY, open ? '0' : '1'); } catch (_) { /* per-device convenience only */ }
    }
    const expanded = isMobile() ? body.classList.contains(NAV_OPEN) : !body.classList.contains(NAV_COLLAPSED);
    document.querySelectorAll('.kh-nav-open-btn').forEach(button => button.setAttribute('aria-expanded', String(expanded)));
  }
  function navIsOpen() { return isMobile() ? document.body.classList.contains(NAV_OPEN) : !document.body.classList.contains(NAV_COLLAPSED); }
  function closeNav() { if (isMobile()) setNav(false); }

  function toggleAccountMenu(open) {
    const menu = document.getElementById('kh-account-menu');
    const button = document.querySelector('.kh-account-button');
    if (!menu || !button) return;
    const next = open ?? menu.hidden;
    menu.hidden = !next;
    button.setAttribute('aria-expanded', String(next));
    if (next) {
      let preference = 'auto';
      try { preference = localStorage.getItem('knowledgehub.theme') || 'auto'; } catch (_) {}
      menu.querySelectorAll('[data-theme-choice]').forEach(control => control.setAttribute('aria-pressed', String(control.dataset.themeChoice === preference)));
      menu.querySelector('.kh-nav-item')?.focus();
    }
  }

  function usageLevel(status) {
    if (!status) return null;
    if (status.locked) return 'locked';
    if (!status.limited || status.ratio === null) return 'free';
    return status.ratio >= 1 ? 'reached' : status.ratio >= 0.8 ? 'near' : 'ok';
  }

  function resetText(status) {
    if (!status?.resetAt) return '';
    const date = new Date(status.resetAt);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' });
  }

  async function loadUsage() {
    try {
      const response = await fetch('/api/ai-usage/me', { cache: 'no-store', headers: { Accept: 'application/json' } });
      if (response.status === 401) { window.location.replace(LOGIN_URL); return; }
      if (!response.ok) throw new Error('HTTP ' + response.status);
      usage = await response.json();
    } catch (_) {
      usage = { failed: true };
    }
    renderUsage();
  }

  function renderUsage() {
    const level = usage?.failed ? null : usageLevel(usage);
    const share = level && !['free', 'locked'].includes(level) ? Math.min(1, Number(usage.ratio) || 0) : null;
    const percent = share === null ? null : Math.round(share * 100);
    const mini = document.getElementById('kh-usage-mini');
    if (mini) {
      mini.hidden = share === null && level !== 'locked';
      mini.dataset.level = level || '';
      mini.innerHTML = level === 'locked'
        ? '<span><i class="fa-solid fa-lock" aria-hidden="true"></i> Đang bị khóa sử dụng AI</span>'
        : share === null ? '' : `<span>Đã dùng ${percent}% hạn mức ${PERIODS[usage.period] || ''}</span><span class="kh-meter" role="img" aria-label="Đã dùng ${percent}% hạn mức"><span style="width:${percent}%"></span></span>`;
    }
    const chip = document.querySelector('.kh-usage-chip');
    if (chip) {
      chip.hidden = !['near', 'reached', 'locked'].includes(level);
      chip.dataset.level = level || '';
      chip.innerHTML = level === 'locked' ? '<i class="fa-solid fa-lock" aria-hidden="true"></i> Đang khóa'
        : `<i class="fa-solid fa-gauge-high" aria-hidden="true"></i> ${percent ?? 0}%`;
      chip.title = 'Xem hạn mức sử dụng';
    }
    const body = document.getElementById('kh-usage-body');
    if (!body) return;
    if (!usage) { body.innerHTML = '<p class="kh-usage-note">Đang tải hạn mức…</p>'; return; }
    if (usage.failed) { body.innerHTML = '<p class="kh-usage-note">Không tải được hạn mức. Hãy thử lại sau.</p><button type="button" class="kh-usage-retry" data-kh-action="usage-refresh"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> Thử lại</button>'; return; }
    const name = escapeHtml(account.displayName || account.username);
    const head = `<div class="kh-usage-account"><span class="kh-avatar" aria-hidden="true">${escapeHtml(initials(account.displayName || account.username))}</span><span><strong>${name}</strong><small>${escapeHtml(account.roleLabel || (account.role === 'admin' ? 'Quản trị viên' : 'Thành viên'))}</small></span></div>`;
    let detail;
    if (level === 'locked') detail = '<div class="kh-usage-state" data-level="locked"><i class="fa-solid fa-lock" aria-hidden="true"></i><div><strong>Tài khoản đang bị khóa sử dụng AI</strong><p>Liên hệ quản trị viên để được mở lại.</p></div></div>';
    else if (level === 'free') detail = '<div class="kh-usage-state" data-level="free"><i class="fa-solid fa-infinity" aria-hidden="true"></i><div><strong>Không giới hạn</strong><p>Tài khoản chưa được đặt hạn mức token.</p></div></div>';
    else {
      const remaining = Math.max(0, Number(usage.tokenLimit) - Number(usage.used));
      detail = `<div class="kh-usage-figure"><strong>${formatNumber(usage.used)}</strong><span>/ ${formatNumber(usage.tokenLimit)} token mỗi ${PERIODS[usage.period] || 'kỳ'}</span></div>
        <div class="kh-meter kh-meter-lg" data-level="${level}" role="img" aria-label="Đã dùng ${percent}% hạn mức"><span style="width:${percent}%"></span></div>
        <dl class="kh-usage-stats">
          <div><dt>Đã dùng</dt><dd>${percent}%</dd></div>
          <div><dt>Còn lại</dt><dd>${formatNumber(remaining)} token</dd></div>
          <div><dt>Đặt lại lúc</dt><dd>${escapeHtml(resetText(usage)) || '—'}</dd></div>
        </dl>
        ${level === 'reached' ? '<p class="kh-usage-note" data-level="reached">Đã hết hạn mức của kỳ này. Câu hỏi mới sẽ bị chặn tới khi hạn mức được đặt lại.</p>' : level === 'near' ? '<p class="kh-usage-note" data-level="near">Sắp hết hạn mức của kỳ này.</p>' : ''}`;
    }
    body.innerHTML = head + detail + '<p class="kh-usage-note">Cần thay đổi hạn mức? Liên hệ quản trị viên.</p>';
  }

  let usageReturnFocus = null;
  function openUsage() {
    toggleAccountMenu(false); closeNav();
    usageReturnFocus = document.activeElement;
    const dialog = document.getElementById('kh-usage-dialog');
    dialog.hidden = false;
    renderUsage(); loadUsage();
    dialog.querySelector('.kh-icon-btn')?.focus();
  }
  function closeUsage() {
    const dialog = document.getElementById('kh-usage-dialog');
    if (dialog.hidden) return;
    dialog.hidden = true;
    usageReturnFocus?.focus?.();
  }

  async function logout() {
    toggleAccountMenu(false);
    const confirmed = await window.showUiConfirm?.('Bạn có chắc muốn đăng xuất khỏi KnowledgeHub Chat?', { title: 'Đăng xuất', confirmText: 'Đăng xuất' });
    if (!confirmed) return;
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', cache: 'no-store' });
      if (!response.ok) throw new Error('LOGOUT_FAILED');
      window.location.replace(LOGIN_URL);
    } catch (_) {
      window.showToast?.('Chưa thể đăng xuất. Vui lòng kiểm tra kết nối và thử lại.', 'error');
    }
  }

  function handleAction(action) {
    switch (action) {
      case 'toggle-nav': setNav(!navIsOpen()); break;
      case 'new-chat': window.createNewChatSession?.(); closeNav(); document.getElementById('page-chat-user-input')?.focus(); break;
      case 'search': {
        if (!navIsOpen()) setNav(true);
        const input = document.getElementById('chat-history-search');
        input?.focus(); input?.select();
        break;
      }
      case 'history-all': window.khChatShowAllHistory = !window.khChatShowAllHistory; window.renderChatSessionsList?.(); break;
      case 'help':
        toggleAccountMenu(false); closeNav();
        window.openChangePassword(); window.selectAccountTab('help');
        break;
      case 'usage': openUsage(); break;
      case 'usage-refresh': usage = null; renderUsage(); loadUsage(); break;
      case 'account-menu': toggleAccountMenu(); break;
      case 'account-details': toggleAccountMenu(false); closeNav(); window.openChangePassword(); break;
      case 'logout': logout(); break;
    }
  }

  function bindEvents() {
    window.addEventListener('account-profile-updated', event => {
      account = event.detail;
      const copy = document.querySelector('.kh-account-copy');
      if (copy) copy.querySelector('strong').textContent = account.displayName || account.username;
      const avatar = document.querySelector('.kh-account-button .kh-avatar');
      if (avatar) avatar.textContent = initials(account.displayName || account.username);
      renderUsage();
    });
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-kh-action]');
      if (target) { handleAction(target.dataset.khAction); return; }
      if (!event.target.closest('.kh-nav-account')) toggleAccountMenu(false);
      // Choosing a conversation on a phone closes the drawer so the answer is visible.
      if (event.target.closest('#kh-chat-nav .chat-session-main')) closeNav();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      if (!document.getElementById('kh-usage-dialog').hidden) { closeUsage(); return; }
      if (!document.getElementById('kh-account-menu')?.hidden) { toggleAccountMenu(false); document.querySelector('.kh-account-button')?.focus(); return; }
      if (document.body.classList.contains(NAV_OPEN)) closeNav();
    });
    // Leaving phone width with the drawer open must not leave the backdrop behind.
    matchMedia('(max-width: 760px)').addEventListener('change', () => document.body.classList.remove(NAV_OPEN));
    // Each answer uses tokens, so refresh the limit after a reply finishes.
    let wasResponding = false;
    setInterval(() => {
      const responding = Boolean(window.pageChatIsResponding);
      if (wasResponding && !responding) loadUsage();
      wasResponding = responding;
    }, 1500);
  }

  // The chat session can end (expired, signed out elsewhere); go to the chat login, but never
  // in the middle of an answer.
  function startHeartbeat() {
    const check = async () => {
      if (document.hidden || window.pageChatRequestController) return;
      try {
        const data = await fetch('/api/auth/me', { cache: 'no-store' }).then(response => response.json());
        if (!data.authenticated) window.location.replace(LOGIN_URL);
      } catch (_) { /* a short network drop must not sign the user out */ }
    };
    setInterval(check, HEARTBEAT_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  }

  async function start() {
    if (EMBED_QUERY) document.body.classList.add('kh-chat-embedded');
    try { if (localStorage.getItem(COLLAPSED_KEY) === '1') document.body.classList.add(NAV_COLLAPSED); } catch (_) { /* default open */ }
    try {
      account = await loadAccount();
      if (!account) return;
      if (account.role !== 'admin' && Array.isArray(account.permissions) && !account.permissions.includes('chat.use')) {
        document.getElementById('main-view-container').innerHTML = '<p class="kh-chat-loading" role="alert">Tài khoản chưa được cấp quyền trò chuyện. Vui lòng liên hệ quản trị viên.</p>';
        return;
      }
      // The conversation is always on screen here, so page_chat.js treats this as its own tab
      // (no "go back to the conversation" mini panel).
      window.activeMainTab = 'page-chat';
      const view = await loadView();
      decorate(view);
      bindEvents();
      window.renderChatSessionsList?.();
      window.renderCurrentChatMessages?.();
      await Promise.allSettled([window.populateChatModelSelector?.(), window.populateChatKnowledgeSources?.(), window.fetchAndRenderQuickPrompts?.()]);
      startHeartbeat();
      loadUsage();
    } catch (error) {
      console.error('Không tải được trang trò chuyện:', error);
      const container = document.getElementById('main-view-container');
      container.removeAttribute('aria-busy');
      container.innerHTML = '<div class="kh-chat-loading" role="alert">Không tải được trang trò chuyện. <button type="button" onclick="location.reload()">Tải lại</button></div>';
    }
  }

  window.KhStandaloneChat = { closeNav, closeUsage, openUsage };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
