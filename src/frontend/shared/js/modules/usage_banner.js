// Banner above the chat composer when the user's AI limit is close, reached or locked.
(function initUsageBanner() {
  const HOSTS = ['#view-page_chat .page-chat-composer-area', '#copilot-modal .copilot-chat-input-area'];
  const MESSAGES = ['#page-chat-messages-container', '#chat-messages-container'];
  const NEAR = 0.8;
  // Everything that would start a new AI request. The send button stays usable while it is
  // a "stop" button, so an answer already running can still be cancelled.
  const SENDERS = ['#page-chat-user-input', '#chat-user-input', '#page-chat-send-button:not(.is-stop)', '#copilot-send-button:not(.is-stop)',
    '[data-voice-target]', 'button[onclick^="retryPageChatAnswer"]', 'button[onclick^="editPageChatQuestion"]', '#quick-prompts-bar button'];
  let status = null, timer = null, refreshing = false;
  const watched = new WeakSet();

  function dismissedKey(level) { return `usage-banner:${level}:${status?.periodKey || ''}`; }
  function isDismissed(level) { try { return sessionStorage.getItem(dismissedKey(level)) === '1'; } catch (_) { return false; } }

  function level() {
    if (!status) return null;
    if (status.locked) return 'locked';
    if (!status.limited || status.ratio === null) return null;
    return status.ratio >= 1 ? 'reached' : status.ratio >= NEAR ? 'near' : null;
  }

  function resetText() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Ho_Chi_Minh' })
      .formatToParts(new Date(status.resetAt)).map(part => [part.type, part.value]));
    return `Đặt lại lúc ${parts.hour}:${parts.minute} ngày ${parts.day}/${parts.month} (còn ${remainingText()})`;
  }

  // "6 ngày 20 giờ", "3 giờ 15 phút", "12 phút"
  function remainingText() {
    const minutes = Math.max(1, Math.ceil((new Date(status.resetAt) - Date.now()) / 60000));
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
    if (days) return hours ? `${days} ngày ${hours} giờ` : `${days} ngày`;
    if (hours) return rest ? `${hours} giờ ${rest} phút` : `${hours} giờ`;
    return `${rest} phút`;
  }

  // Out of quota or locked: the server would refuse anyway, so stop new requests at the source
  // to avoid repeated attempts. Only controls disabled here are re-enabled later.
  function lockChat(blocked) {
    for (const control of document.querySelectorAll(SENDERS.join(','))) {
      if (blocked && !control.disabled) {
        control.dataset.usageLocked = '1'; control.disabled = true;
      } else if (!blocked && control.dataset.usageLocked) {
        delete control.dataset.usageLocked; control.disabled = false;
      }
    }
    // A running answer turns into a send button when it ends; lock it then too.
    if (!blocked) return;
    for (const control of document.querySelectorAll('#page-chat-send-button.is-stop, #copilot-send-button.is-stop')) if (control.dataset.usageLocked) { delete control.dataset.usageLocked; control.disabled = false; }
  }

  function render() {
    const current = level();
    lockChat(current === 'reached' || current === 'locked');
    for (const selector of HOSTS) {
      const host = document.querySelector(selector);
      if (!host) continue;
      let banner = host.querySelector(':scope > .usage-banner');
      if (!current || isDismissed(current)) { banner?.remove(); continue; }
      if (!banner) { banner = document.createElement('div'); banner.className = 'usage-banner'; banner.setAttribute('role', 'status'); host.prepend(banner); }
      if (banner.dataset.level !== current) banner.dataset.level = current;
      const title = current === 'locked' ? 'Tài khoản đang bị khóa sử dụng AI'
        : current === 'reached' ? 'Đã đạt hạn mức sử dụng' : 'Sắp đạt hạn mức sử dụng';
      const detail = current === 'locked' ? 'Liên hệ quản trị viên để mở lại'
        : current === 'reached' ? `Câu hỏi mới sẽ bị chặn · ${resetText()}`
        : `Đã dùng ${Math.floor(status.ratio * 100)}% · ${resetText()}`;
      const html = `<i class="fa-solid ${current === 'locked' ? 'fa-lock' : 'fa-gauge-high'}" aria-hidden="true"></i>
        <strong>${title}</strong><span class="usage-banner-detail">${detail}</span>
        <button type="button" class="usage-banner-close" data-usage-action="dismiss" aria-label="Ẩn thông báo" title="Ẩn"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`;
      // Only touch the DOM on a real change: the page-wide observer below would otherwise loop.
      if (banner._html !== html) { banner._html = html; banner.innerHTML = html; }
    }
  }

  async function refresh() {
    if (refreshing || !HOSTS.some(selector => document.querySelector(selector))) return;
    refreshing = true;
    try {
      const response = await fetch('/api/ai-usage/me', { headers: { Accept: 'application/json' } });
      if (response.ok) { status = await response.json(); render(); }
    } catch (_) { /* the banner is advisory; chat keeps working without it */ }
    finally { refreshing = false; }
  }
  const later = (delay = 1200) => { clearTimeout(timer); timer = setTimeout(refresh, delay); };

  // New messages mean tokens were just used; chat views are loaded on demand, so watch for them.
  function watch() {
    for (const selector of MESSAGES) {
      const container = document.querySelector(selector);
      if (!container || watched.has(container)) continue;
      watched.add(container);
      new MutationObserver(() => later()).observe(container, { childList: true });
      later(200);
    }
    render();
  }
  let pending = false;
  new MutationObserver(() => { if (pending) return; pending = true; queueMicrotask(() => { pending = false; watch(); }); })
    .observe(document.documentElement, { childList: true, subtree: true });
  watch(); // containers already in the page (the copilot modal is part of index.html)

  document.addEventListener('click', event => {
    const control = event.target.closest?.('[data-usage-action]');
    if (!control) return;
    if (control.dataset.usageAction === 'dismiss') {
      try { sessionStorage.setItem(dismissedKey(level()), '1'); } catch (_) {}
      render();
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) later(300); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5 * 60 * 1000);
  // Keep the countdown current, and unlock as soon as the period resets.
  setInterval(() => { if (!status || document.hidden) return; if (status.resetAt && Date.now() >= new Date(status.resetAt)) refresh(); else render(); }, 60 * 1000);
  window.refreshUsageBanner = refresh;
})();
