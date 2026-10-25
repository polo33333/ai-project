(() => {
  const trigger = document.getElementById('header-notification-btn');
  const panel = document.getElementById('header-notification-panel');
  if (!trigger || !panel) return;
  // Keep the popup outside the sticky header's backdrop-filter containing block.
  document.body.appendChild(panel);
  const badge = document.getElementById('header-notification-count');
  const markRead = document.getElementById('notification-mark-read');
  const storageKey = 'knowledgehub.notification.beta-1.0.1.read';
  let read = false;
  try { read = localStorage.getItem(storageKey) === 'true'; } catch { /* In-memory state remains usable. */ }
  function syncReadState() {
    badge.hidden = read;
    trigger.setAttribute('aria-label', read ? 'Thông báo' : 'Thông báo, 1 chưa đọc');
    document.getElementById('beta-notification').classList.toggle('is-unread', !read);
    document.getElementById('notification-read-status').textContent = read ? 'Đã đọc' : 'Chưa đọc';
    markRead.disabled = read;
    markRead.textContent = read ? 'Đã đọc tất cả' : 'Đánh dấu đã đọc';
  }
  function close(restoreFocus = false) {
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus();
  }
  trigger.addEventListener('click', () => {
    if (!panel.hidden) return close();
    const rect = trigger.getBoundingClientRect();
    panel.hidden = false;
    panel.style.left = `${Math.max(12, Math.min(innerWidth - panel.offsetWidth - 12, rect.right - panel.offsetWidth))}px`;
    panel.style.top = `${rect.bottom + 12}px`;
    trigger.setAttribute('aria-expanded', 'true');
    document.getElementById('notification-close').focus({ preventScroll: true });
  });
  document.getElementById('notification-close').addEventListener('click', () => close(true));
  markRead.addEventListener('click', () => {
    read = true;
    try { localStorage.setItem(storageKey, 'true'); } catch { /* Keep in-memory state. */ }
    syncReadState();
    document.getElementById('notification-close').focus({ preventScroll: true });
  });
  document.addEventListener('click', event => {
    if (!panel.contains(event.target) && !trigger.contains(event.target)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); close(true); }
  });
  document.addEventListener('focusin', event => {
    if (!panel.hidden && !panel.contains(event.target) && !trigger.contains(event.target)) close();
  });
  window.addEventListener('resize', () => close());
  document.querySelector('main.main-content')?.addEventListener('scroll', () => close(), { passive: true });
  syncReadState();
})();
