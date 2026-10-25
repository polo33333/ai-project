/* Shared desktop rail / mobile drawer navigation. */
(() => {
  const sidebar = document.querySelector('aside.sidebar');
  if (!sidebar) return;
  const toggle = document.getElementById('sidebar-toggle-btn');
  const backdrop = document.getElementById('sidebar-backdrop');
  const main = document.querySelector('main.main-content');
  const compactScreen = window.matchMedia('(max-width: 860px)');
  const storageKey = 'knowledgehub.sidebar.collapsed';
  // Local outline icons share one optical size and stroke; no icon-font dependency.
  const iconPaths = {
    dashboard: '<path d="M4 4v16h16M7 14l4-4 4 3 5-7"/>',
    'page-chat': '<path d="M20 11a8 8 0 0 1-8 8H5l-3 3V11a9 9 0 0 1 18 0Z"/><path d="M7 10h8M7 14h5"/>',
    library: '<path d="M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v1M3 8h17l-2 10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    watchfolder: '<path d="M3 5h5l2 3h10v11H3Z"/><path d="M8 13h7m-3-3 3 3-3 3"/>',
    'sql-connector': '<path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0ZM12 16v5"/>',
    'data-dictionary': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11"/>',
    glossary: '<path d="m3 17 5-12 5 12M5 13h6m4-3h6m-3-3v3c0 5-3 8-5 9m2-7c1 3 3 5 6 7"/>',
    'ai-providers': '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-4h12v4"/>',
    'cost-tracker': '<path d="M10 3a9 9 0 1 0 11 11H10ZM14 3v7h7a9 9 0 0 0-7-7Z"/>',
    'system-logs': '<path d="m4 6 6 6-6 6m9 0h7"/>',
    'chat-history': '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6m3-3v5l3 2"/>',
    'chat-feedback': '<path d="M8 10 12 3a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2l-2 8a2 2 0 0 1-2 2H8ZM3 10h5v11H3Z"/>',
    'training-core': '<path d="m2 8 10-5 10 5-10 5ZM6 10v7c4 3 8 3 12 0v-7m4-2v8"/>',
    workflows: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h6a3 3 0 0 1 3 3v6M3 18h7m-3-3 3 3-3 3"/>',
    'mcp-sources': '<path d="m12 3 9 5v9l-9 5-9-5V8ZM3 8l9 5 9-5m-9 5v9M7 5.8l9 5"/>',
    'system-tools': '<path d="M14 4a5 5 0 0 0-6 6l-5 7a2.8 2.8 0 0 0 4 4l7-7a5 5 0 0 0 6-6l-4 3-3-3Z"/>',
    'api-docs': '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
    sparkles: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5ZM20 2v4m-2-2h4"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>'
  };
  const outlineIcon = paths => `<svg class="sidebar-outline-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
  sidebar.querySelectorAll('.nav-item').forEach(item => {
    const paths = iconPaths[item.id.replace('nav-', '')];
    if (paths) item.querySelector('.nav-icon').innerHTML = outlineIcon(paths);
  });
  const copilotIcon = sidebar.querySelector('.copilot-btn-icon');
  if (copilotIcon) copilotIcon.innerHTML = outlineIcon(iconPaths.sparkles);
  const databaseIcon = sidebar.querySelector('.card-icon-badge');
  if (databaseIcon) databaseIcon.innerHTML = outlineIcon(iconPaths.database);
  let desktopCollapsed = false;
  try { desktopCollapsed = localStorage.getItem(storageKey) === 'true'; } catch { /* Storage can be unavailable. */ }
  const tooltip = document.createElement('div');
  tooltip.className = 'sidebar-tooltip';
  tooltip.id = 'sidebar-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.appendChild(tooltip);
  let tooltipTarget;

  function hideTooltip() {
    tooltip.hidden = true;
    tooltipTarget?.removeAttribute('aria-describedby');
    tooltipTarget = null;
  }

  function sync() {
    hideTooltip();
    const drawerOpen = compactScreen.matches && sidebar.classList.contains('expanded-mobile');
    const collapsed = compactScreen.matches ? !drawerOpen : desktopCollapsed;
    sidebar.classList.toggle('collapsed', collapsed);
    backdrop.hidden = !drawerOpen;
    main.inert = drawerOpen;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const label = collapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng';
    toggle.setAttribute('aria-label', label);
    toggle.dataset.tooltip = label;
    toggle.innerHTML = outlineIcon(`<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m${collapsed ? '4-11 3 3-3 3' : '7-11-3 3 3 3'}"/>`);
  }

  function closeDrawer(restoreFocus = false) {
    sidebar.classList.remove('expanded-mobile');
    sync();
    if (restoreFocus) toggle.focus();
  }

  window.workspaceSidebar = {
    toggle() {
      if (compactScreen.matches) sidebar.classList.toggle('expanded-mobile');
      else {
        desktopCollapsed = !desktopCollapsed;
        try { localStorage.setItem(storageKey, String(desktopCollapsed)); } catch { /* Keep in-memory preference. */ }
      }
      sync();
    }
  };

  sidebar.querySelectorAll('.nav-item a, .btn-copilot, .sidebar-toggle-btn, #user-profile-btn').forEach(el => {
    const label = el.getAttribute('title') || el.textContent.trim();
    el.dataset.tooltip = label;
    el.setAttribute('aria-label', label);
    el.removeAttribute('title');
  });
  sidebar.querySelector('.nav-item.active a')?.setAttribute('aria-current', 'page');
  const status = document.getElementById('sidebar-footer-card');
  if (status) {
    status.tabIndex = 0;
    status.dataset.tooltip = 'Qdrant DB';
    function syncStatus() {
      const label = `Qdrant DB · ${status.classList.contains('status-online') ? 'Đã kết nối' : 'Chưa kết nối'}`;
      status.dataset.tooltip = label;
      status.setAttribute('aria-label', label);
      if (tooltipTarget === status) tooltip.textContent = label;
    }
    new MutationObserver(syncStatus).observe(status, { attributes: true, attributeFilter: ['class'] });
    syncStatus();
  }

  function showTooltip(target) {
    hideTooltip();
    if (!sidebar.classList.contains('collapsed') || !target) return;
    tooltipTarget = target;
    tooltip.textContent = target.dataset.tooltip;
    tooltip.hidden = false;
    target.setAttribute('aria-describedby', tooltip.id);
    const rect = target.getBoundingClientRect();
    tooltip.style.left = `${sidebar.getBoundingClientRect().right + 10}px`;
    tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - tooltip.offsetHeight - 8, rect.top + (rect.height - tooltip.offsetHeight) / 2))}px`;
  }
  sidebar.addEventListener('pointerover', event => {
    if (event.pointerType !== 'touch') showTooltip(event.target.closest('[data-tooltip]'));
  });
  sidebar.addEventListener('pointerout', event => {
    if (!tooltipTarget?.contains(event.relatedTarget)) hideTooltip();
  });
  sidebar.addEventListener('focusin', event => showTooltip(event.target.closest('[data-tooltip]')));
  sidebar.addEventListener('focusout', hideTooltip);
  sidebar.querySelector('.sidebar-nav').addEventListener('scroll', hideTooltip, { passive: true });
  sidebar.addEventListener('click', event => {
    hideTooltip();
    if (compactScreen.matches && event.target.closest('.nav-item a, .btn-copilot')) closeDrawer();
  });
  sidebar.addEventListener('dragstart', event => {
    if (event.target.closest('.nav-item a, .btn-copilot, .sidebar-toggle-btn, .sidebar-footer-card, .account-menu-trigger')) {
      event.preventDefault();
    }
  });
  backdrop.addEventListener('click', () => closeDrawer(true));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      hideTooltip();
      if (sidebar.classList.contains('expanded-mobile')) closeDrawer(true);
    }
    if (event.key === 'Tab' && sidebar.classList.contains('expanded-mobile')) {
      const focusable = [...sidebar.querySelectorAll('button, a, [tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  compactScreen.addEventListener('change', () => closeDrawer());
  window.addEventListener('resize', hideTooltip);
  sync();
})();
