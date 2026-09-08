/**
 * KnowledgeHub AI - Master Application Logic (Clean Modular Architecture)
 * Central Router & System Orchestrator
 */

// Global Toast Notification Engine
function escapeToastHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'success', title = '') {
  let background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';
  let icon = 'fa-circle-check';
  let defaultTitle = 'Thành công';
  if (type === 'error') {
    background = 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)';
    icon = 'fa-triangle-exclamation';
    defaultTitle = 'Có lỗi xảy ra';
  } else if (type === 'warn' || type === 'warning') {
    background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
    icon = 'fa-circle-exclamation';
    defaultTitle = 'Cần chú ý';
  } else if (type === 'info') {
    background = 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)';
    icon = 'fa-circle-info';
    defaultTitle = 'Thông báo';
  }

  const toastTitle = title || defaultTitle;
  const toastMarkup = `
    <div class="kh-toast-content">
      <span class="kh-toast-icon"><i class="fa-solid ${icon}"></i></span>
      <span class="kh-toast-copy">
        <span class="kh-toast-title">${escapeToastHtml(toastTitle)}</span>
        <span class="kh-toast-message">${escapeToastHtml(message)}</span>
      </span>
    </div>`;

  if (typeof Toastify !== 'undefined') {
    Toastify({
      text: toastMarkup,
      duration: 3500,
      gravity: "top",
      position: "right",
      escapeMarkup: false,
      style: {
        background,
        width: "360px",
        maxWidth: "calc(100vw - 28px)",
        minHeight: "72px",
        boxSizing: "border-box",
        borderRadius: "12px",
        boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
        fontFamily: "'Inter', sans-serif",
        fontSize: "13px",
        fontWeight: "400",
        padding: "13px 15px"
      }
    }).showToast();
  } else {
    console.log(`[Toast ${type.toUpperCase()}] ${toastTitle}: ${message}`);
  }
}

// Universal Pagination State Manager
window.paginationState = {
  dictionary: { currentPage: 1, itemsPerPage: 8 },
  glossary: { currentPage: 1, itemsPerPage: 10 },
  ai_providers: { currentPage: 1, itemsPerPage: 10 },
  sql_sources: { currentPage: 1, itemsPerPage: 10 },
  chat_history: { currentPage: 1, itemsPerPage: 10 },
  chat_feedback: { currentPage: 1, itemsPerPage: 10 },
  system_logs: { currentPage: 1, itemsPerPage: 10 },
  library: { currentPage: 1, itemsPerPage: 8 },
  watchfolder_logs: { currentPage: 1, itemsPerPage: 10 }
};

window.renderPaginationControls = function renderPaginationControls(containerId, stateKey, totalItems, onPageChangeCallback) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const state = window.paginationState[stateKey] || { currentPage: 1, itemsPerPage: 10 };
  const totalPages = Math.ceil(totalItems / state.itemsPerPage) || 1;
  if (state.currentPage > totalPages) state.currentPage = totalPages;
  if (state.currentPage < 1) state.currentPage = 1;

  const startItem = totalItems === 0 ? 0 : (state.currentPage - 1) * state.itemsPerPage + 1;
  const endItem = Math.min(state.currentPage * state.itemsPerPage, totalItems);
  const callbackName = onPageChangeCallback ? onPageChangeCallback.name : '';

  const visiblePages = (() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, idx) => idx + 1);
    const pages = [1];
    const start = Math.max(2, state.currentPage - 1);
    const end = Math.min(totalPages - 1, state.currentPage + 1);
    if (start > 2) pages.push('ellipsis-left');
    for (let i = start; i <= end; i++) pages.push(i);
    if (end < totalPages - 1) pages.push('ellipsis-right');
    pages.push(totalPages);
    return pages;
  })();

  let pageButtonsHtml = '';
  visiblePages.forEach(page => {
    if (typeof page === 'string') {
      pageButtonsHtml += `<span class="pagination-ellipsis">...</span>`;
      return;
    }
    const isActive = page === state.currentPage;
    pageButtonsHtml += `
      <button class="pagination-btn ${isActive ? 'active' : ''}" onclick="changePage('${stateKey}', ${page}, '${callbackName}')">
        ${page}
      </button>
    `;
  });

  const pageSizeOptions = [8, 10, 20, 50, 100];
  container.innerHTML = `
    <div class="pagination-summary">
      Hiển thị <strong>${startItem} - ${endItem}</strong> trên tổng số <strong>${totalItems}</strong> mục
    </div>
    <div class="pagination-controls">
      <label class="pagination-size-label">
        Số dòng/trang
        <select onchange="changePageSize('${stateKey}', this.value, '${callbackName}')">
          ${pageSizeOptions.map(size => `<option value="${size}" ${Number(state.itemsPerPage) === size ? 'selected' : ''}>${size}</option>`).join('')}
        </select>
      </label>
      <button class="pagination-btn icon" onclick="changePage('${stateKey}', ${state.currentPage - 1}, '${callbackName}')" ${state.currentPage <= 1 ? 'disabled' : ''}>
        <i class="fa-solid fa-chevron-left"></i>
      </button>
      ${pageButtonsHtml}
      <button class="pagination-btn icon" onclick="changePage('${stateKey}', ${state.currentPage + 1}, '${callbackName}')" ${state.currentPage >= totalPages ? 'disabled' : ''}>
        <i class="fa-solid fa-chevron-right"></i>
      </button>
    </div>
  `;
};

window.changePage = function changePage(stateKey, newPage, callbackName) {
  if (window.paginationState[stateKey]) {
    window.paginationState[stateKey].currentPage = newPage;
    if (callbackName && typeof window[callbackName] === 'function') {
      window[callbackName]();
    } else {
      if (stateKey === 'dictionary' && typeof renderDataDictionary === 'function') renderDataDictionary();
      if (stateKey === 'glossary' && typeof renderGlossaryTable === 'function') renderGlossaryTable();
      if (stateKey === 'ai_providers' && typeof renderAiProvidersTable === 'function') renderAiProvidersTable();
      if (stateKey === 'sql_sources' && typeof renderDbSourcesTable === 'function') renderDbSourcesTable();
      if (stateKey === 'chat_history' && typeof renderChatHistoryTable === 'function') renderChatHistoryTable();
      if (stateKey === 'system_logs' && typeof renderLogsTable === 'function') renderLogsTable();
    }
  }
};

window.changePageSize = function changePageSize(stateKey, newSize, callbackName) {
  if (window.paginationState[stateKey]) {
    window.paginationState[stateKey].itemsPerPage = parseInt(newSize, 10) || 10;
    window.paginationState[stateKey].currentPage = 1;
    if (callbackName && typeof window[callbackName] === 'function') {
      window[callbackName]();
    } else {
      if (stateKey === 'dictionary' && typeof renderDataDictionary === 'function') renderDataDictionary();
      if (stateKey === 'glossary' && typeof renderGlossaryTable === 'function') renderGlossaryTable();
      if (stateKey === 'ai_providers' && typeof renderAiProvidersTable === 'function') renderAiProvidersTable();
      if (stateKey === 'sql_sources' && typeof renderDbSourcesTable === 'function') renderDbSourcesTable();
      if (stateKey === 'chat_history' && typeof renderChatHistoryTable === 'function') renderChatHistoryTable();
      if (stateKey === 'system_logs' && typeof renderLogsTable === 'function') renderLogsTable();
    }
  }
};

// Sidebar Mini Collapse Toggle Engine
function toggleSidebarCollapse() {
  window.workspaceSidebar?.toggle();
}

function initAccountMenu() {
  const trigger = document.getElementById('user-profile-btn');
  const menu = document.getElementById('account-menu');
  if (!trigger || !menu || trigger.dataset.initialized === 'true') return;
  trigger.dataset.initialized = 'true';

  const setOpen = (open) => {
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
  };

  trigger.addEventListener('click', event => {
    event.stopPropagation();
    setOpen(menu.hidden);
  });
  menu.addEventListener('click', event => {
    const item = event.target.closest('.account-menu-item');
    if (item && !item.matches('[data-theme-toggle]')) setOpen(false);
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.sidebar-account-area')) setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || menu.hidden) return;
    setOpen(false);
    trigger.focus();
  });
}

let deferredInstallPrompt = null;

function initPwaInstall() {
  const installButton = document.getElementById('install-app-btn');
  const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (standalone && installButton) installButton.hidden = true;

  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    if (installButton) installButton.hidden = false;
  });

  installButton?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installButton.hidden = true;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    if (installButton) installButton.hidden = true;
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => undefined));
  }
}

async function loadCurrentAccount() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login.html';
      return;
    }
    const nameEl = document.getElementById('account-display-name');
    const roleEl = document.getElementById('account-role-label');
    const settingsButton = document.getElementById('account-settings-btn');
    window.currentAccountRole = data.account?.role || 'user';
    if (settingsButton) settingsButton.hidden = data.account?.role !== 'admin';
    if (nameEl) nameEl.textContent = data.account?.displayName || data.account?.username || 'Admin AI';
    if (roleEl) roleEl.textContent = data.account?.role === 'admin' ? 'Quản trị viên' : 'Thành viên';
  } catch {
    window.location.href = '/login.html';
  }
}

function closeLogoutConfirmation() {
  const modal = document.getElementById('logout-confirm-modal');
  if (!modal) return;
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
}

function logoutAccount() {
  const modal = document.getElementById('logout-confirm-modal');
  if (!modal) return performLogout();
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
  window.setTimeout(() => document.getElementById('logout-cancel-btn')?.focus(), 0);
}

async function performLogout() {
  const confirmButton = document.getElementById('logout-confirm-btn');
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Đang đăng xuất';
  }
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
  } finally {
    try {
      localStorage.removeItem(MAIN_TAB_STORAGE_KEY);
    } catch {
      // Continue logout even when browser storage is unavailable.
    }
    window.location.href = '/login.html';
  }
}

window.logoutAccount = logoutAccount;
window.performLogout = performLogout;
window.closeLogoutConfirmation = closeLogoutConfirmation;

const featureSearchItems = [
  { key: 'overview', title: 'Tổng quan', group: 'Tổng quan', icon: 'fa-chart-line', keywords: 'dashboard trang chủ thống kê hệ thống' },
  { key: 'page-chat', title: 'Trò chuyện AI', group: 'Tổng quan', icon: 'fa-comments', keywords: 'chat hỏi đáp text to sql trợ lý' },
  { key: 'library', title: 'Thư viện tri thức', group: 'Tổng quan', icon: 'fa-folder-open', keywords: 'tài liệu knowledge pdf docx upload' },
  { key: 'watchfolder', title: 'Thư mục giám sát', group: 'Tổng quan', icon: 'fa-folder-tree', keywords: 'watch folder quét file tự động' },
  { key: 'sql', title: 'Kết nối CSDL', group: 'Kết nối dữ liệu', icon: 'fa-plug', keywords: 'sql server database ddl nguồn dữ liệu' },
  { key: 'dictionary', title: 'Lược đồ CSDL', group: 'Kết nối dữ liệu', icon: 'fa-table-list', keywords: 'data dictionary bảng cột quan hệ diagram schema' },
  { key: 'glossary', title: 'Thuật ngữ nghiệp vụ', group: 'Kết nối dữ liệu', icon: 'fa-spell-check', keywords: 'business glossary từ điển' },
  { key: 'ai-providers', title: 'Nhà cung cấp AI', group: 'AI & Báo cáo', icon: 'fa-network-wired', keywords: 'provider model gemini openai ollama active' },
  { key: 'analytics', title: 'Báo cáo & Metrics', group: 'AI & Báo cáo', icon: 'fa-chart-pie', keywords: 'analytics chi phí độ trễ thống kê' },
  { key: 'system-logs', title: 'Nhật ký hệ thống', group: 'Giám sát & Audit', icon: 'fa-terminal', keywords: 'system log lỗi cảnh báo audit' },
  { key: 'chat-history', title: 'Lịch sử trò chuyện', group: 'Giám sát & Audit', icon: 'fa-clock-rotate-left', keywords: 'history gọi ai prompt json' },
  { key: 'chat-feedback', title: 'Đánh giá AI', group: 'Giám sát & Audit', icon: 'fa-thumbs-up', keywords: 'feedback chất lượng thích không thích kiểm duyệt ai' },
  { key: 'training-core', title: 'Training Core', group: 'Giám sát & Audit', icon: 'fa-graduation-cap', keywords: 'training report đề xuất cải tiến harness regression lỗi ai' },
  { key: 'workflows', title: 'Quy trình tự động', group: 'Tích hợp & Phát triển', icon: 'fa-diagram-project', keywords: 'workflow automation quy trình luồng tự động hóa tác vụ' },
  { key: 'mcp-sources', title: 'Nguồn MCP Server', group: 'Tích hợp & Phát triển', icon: 'fa-cube', keywords: 'mcp tools server integration' },
  { key: 'system-tools', title: 'Công cụ hệ thống', group: 'Tích hợp & Phát triển', icon: 'fa-screwdriver-wrench', keywords: 'tool function calling schema công cụ hệ thống' },
  { key: 'api-docs', title: 'API tích hợp & Embed Chat', group: 'Tích hợp & Phát triển', icon: 'fa-code-branch', keywords: 'api key developer embed website widget tài liệu lập trình' },
  { key: 'settings', title: 'Cài đặt hệ thống', group: 'Tài khoản & Hệ thống', icon: 'fa-sliders', keywords: 'setting settings cấu hình env môi trường qdrant local model máy chủ', adminOnly: true }
];

function normalizeFeatureSearch(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function initGlobalFeatureSearch() {
  const wrapper = document.getElementById('global-feature-search');
  const input = document.getElementById('global-search-input');
  const results = document.getElementById('feature-search-results');
  if (!wrapper || !input || !results || input.dataset.ready === '1') return;
  input.dataset.ready = '1';
  let activeIndex = 0;
  let filteredItems = [];
  const render = () => {
    const query = normalizeFeatureSearch(input.value);
    const queryTokens = query.split(/\s+/).filter(Boolean);
    filteredItems = featureSearchItems.filter(item => {
      if (item.adminOnly && window.currentAccountRole !== 'admin') return false;
      const searchable = normalizeFeatureSearch(`${item.title} ${item.group} ${item.keywords}`);
      return queryTokens.every(token => searchable.includes(token));
    }).slice(0, 20);
    activeIndex = Math.max(0, Math.min(activeIndex, Math.max(0, filteredItems.length - 1)));
    results.innerHTML = filteredItems.length ? filteredItems.map((item, index) => `<button type="button" class="feature-search-item ${index === activeIndex ? 'active' : ''}" data-key="${item.key}"><span class="feature-result-icon"><i class="fa-solid ${item.icon}"></i></span><span><strong>${item.title}</strong><small>${item.group}</small></span><i class="fa-solid fa-arrow-turn-down feature-enter-icon"></i></button>`).join('') : '<div class="feature-search-empty"><i class="fa-solid fa-magnifying-glass"></i> Không tìm thấy chức năng phù hợp</div>';
    results.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const select = item => {
    if (!item) return;
    switchMainTab(item.key);
    input.value = '';
    results.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.blur();
  };
  input.addEventListener('focus', render);
  input.addEventListener('input', () => { activeIndex = 0; render(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); activeIndex = Math.max(0, Math.min(activeIndex + 1, filteredItems.length - 1)); render(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); render(); }
    else if (event.key === 'Enter') { event.preventDefault(); select(filteredItems[activeIndex]); }
    else if (event.key === 'Escape') { results.hidden = true; input.setAttribute('aria-expanded', 'false'); input.blur(); }
  });
  results.addEventListener('mousedown', event => {
    event.preventDefault();
    const button = event.target.closest('.feature-search-item');
    select(featureSearchItems.find(item => item.key === button?.dataset.key));
  });
  document.addEventListener('mousedown', event => { if (!wrapper.contains(event.target)) { results.hidden = true; input.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      input.focus();
      input.select();
    }
  });
}

window.architectureSuggestionAction = null;

async function refreshArchitectureSuggestion() {
  const banner = document.getElementById('ai-suggestion-banner');
  if (!banner || sessionStorage.getItem('knowledgehub.dismissArchitectureSuggestion') === '1') return;
  try {
    const [sourcesRes, qdrantRes] = await Promise.all([fetch('/api/sql/sources'), fetch('/api/qdrant/status')]);
    const sourcesData = sourcesRes.ok ? await sourcesRes.json() : [];
    const qdrant = qdrantRes.ok ? await qdrantRes.json() : { connected: false };
    const sources = Array.isArray(sourcesData) ? sourcesData : (sourcesData.sources || []);
    const title = document.getElementById('banner-title');
    const text = document.getElementById('banner-text');
    const actionButton = document.getElementById('banner-action-btn');
    if (sources.length === 0) {
      title.textContent = 'Chưa có nguồn dữ liệu';
      text.textContent = 'Kết nối ít nhất một nguồn CSDL để AI có thể đọc lược đồ và hỗ trợ truy vấn dữ liệu.';
      actionButton.textContent = 'Kết nối CSDL';
      window.architectureSuggestionAction = 'go-sql';
    } else if (qdrant.connected !== true) {
      title.textContent = 'Qdrant đang ngoại tuyến';
      text.textContent = `Đã có ${sources.length} nguồn dữ liệu nhưng Vector DB chưa kết nối. Hãy bật Qdrant rồi kiểm tra lại.`;
      actionButton.textContent = 'Kiểm tra lại';
      window.architectureSuggestionAction = 'retry';
    } else if (Number(qdrant.pointsCount || 0) === 0) {
      title.textContent = 'Dữ liệu AI chưa được đồng bộ';
      text.textContent = `Qdrant đã kết nối nhưng chưa có vector. Đồng bộ các bảng Active để hoàn tất ngữ cảnh tìm kiếm.`;
      actionButton.textContent = 'Đồng bộ ngay';
      window.architectureSuggestionAction = 'sync';
    } else {
      banner.hidden = true;
      window.architectureSuggestionAction = null;
      return;
    }
    banner.hidden = false;
  } catch {
    banner.hidden = true;
  }
}

async function runArchitectureSuggestionAction() {
  if (window.architectureSuggestionAction === 'go-sql') return switchMainTab('sql');
  if (window.architectureSuggestionAction === 'retry') {
    await fetchQdrantStatus();
    return refreshArchitectureSuggestion();
  }
  if (window.architectureSuggestionAction === 'sync') {
    const button = document.getElementById('banner-action-btn');
    if (button) { button.disabled = true; button.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đồng bộ'; }
    try {
      const res = await fetch('/api/qdrant/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      if (typeof showToast === 'function') showToast('Đã đồng bộ dữ liệu vào Qdrant.', 'success');
      await fetchQdrantStatus();
      await refreshArchitectureSuggestion();
    } catch (err) {
      if (typeof showToast === 'function') showToast(err.message, 'error', 'Không thể đồng bộ');
    } finally {
      if (button) button.disabled = false;
    }
  }
}

function dismissArchitectureSuggestion() {
  sessionStorage.setItem('knowledgehub.dismissArchitectureSuggestion', '1');
  const banner = document.getElementById('ai-suggestion-banner');
  if (banner) banner.hidden = true;
}

window.runArchitectureSuggestionAction = runArchitectureSuggestionAction;
window.dismissArchitectureSuggestion = dismissArchitectureSuggestion;

const MAIN_TAB_STORAGE_KEY = 'knowledgehub.activeMainTab';
const MAIN_TAB_ALIASES = Object.freeze({
  dashboard: 'overview',
  sql_connector: 'sql',
  sql_connectors: 'sql',
  providers: 'ai-providers',
  mcp: 'mcp-sources'
});
const MAIN_TAB_KEYS = new Set([
  'overview',
  'page-chat',
  'library',
  'watchfolder',
  'sql',
  'dictionary',
  'glossary',
  'ai-providers',
  'analytics',
  'system-logs',
  'chat-history',
  'chat-feedback',
  'training-core',
  'workflows',
  'mcp-sources',
  'system-tools',
  'settings',
  'api-docs'
]);

function normalizeMainTabKey(tabKey) {
  const rawKey = String(tabKey || '')
    .trim()
    .replace(/^#/, '')
    .split(/[?&]/, 1)[0]
    .replace(/^\/+|\/+$/g, '');
  const aliasKey = MAIN_TAB_ALIASES[rawKey] || MAIN_TAB_ALIASES[rawKey.replace(/-/g, '_')];
  const normalizedKey = aliasKey || rawKey.replace(/_/g, '-');
  return MAIN_TAB_KEYS.has(normalizedKey) ? normalizedKey : '';
}

function getRememberedMainTab() {
  const pathTab = normalizeMainTabKey(window.location.pathname);
  if (pathTab) return pathTab;
  // Migrate the previous hash-based route to a clean URL.
  const hashTab = normalizeMainTabKey(window.location.hash);
  if (hashTab) return hashTab;
  try {
    return normalizeMainTabKey(localStorage.getItem(MAIN_TAB_STORAGE_KEY)) || 'overview';
  } catch {
    return 'overview';
  }
}

function rememberMainTab(tabKey) {
  window.activeMainTab = tabKey;
  try {
    localStorage.setItem(MAIN_TAB_STORAGE_KEY, tabKey);
  } catch {
    // The URL hash still preserves the route when browser storage is unavailable.
  }

  const nextPath = tabKey === 'overview' ? '/' : `/${tabKey}`;
  if (window.location.pathname !== nextPath || window.location.hash) {
    window.history.replaceState(null, '', `${nextPath}${window.location.search}`);
  }
}

// Global Tab Switcher (Router)
window.switchMainTab = async function switchMainTab(tabKey) {
  tabKey = normalizeMainTabKey(tabKey);
  if (!tabKey) return;
  rememberMainTab(tabKey);
  window.updatePageChatMiniPanel?.();
  const cleanKey = tabKey.replace(/-/g, '_');
  const isDashboard = cleanKey === 'overview' || cleanKey === 'dashboard';
  const mainContent = document.querySelector('main.main-content');
  mainContent?.classList.toggle('chat-workspace-page', cleanKey === 'page_chat');
  mainContent?.classList.toggle('training-workspace', cleanKey === 'training_core');
  mainContent?.classList.toggle('dictionary-workspace', cleanKey === 'dictionary');
  mainContent?.classList.toggle('settings-workspace', cleanKey === 'settings');

  if (isDashboard) refreshArchitectureSuggestion();

  const banner = document.getElementById('ai-suggestion-banner');
  const metrics = document.querySelector('.metrics-grid');
  const middleGrid = document.querySelector('.middle-grid');
  const activityCard = document.getElementById('dashboard-activity-card');
  const routerSection = document.querySelector('.dashboard-router-section');
  const dashboardLower = document.querySelector('.dashboard-overview-lower');

  if (banner) banner.style.display = isDashboard ? 'flex' : 'none';
  if (metrics) metrics.style.display = isDashboard ? 'grid' : 'none';
  if (middleGrid) middleGrid.style.display = isDashboard ? 'grid' : 'none';
  if (activityCard) activityCard.style.display = isDashboard ? 'block' : 'none';
  if (routerSection) routerSection.style.display = isDashboard ? 'block' : 'none';
  if (dashboardLower) dashboardLower.classList.toggle('is-dashboard', isDashboard);
  if (isDashboard && typeof refreshDashboardMetrics === 'function') refreshDashboardMetrics();

  const pageHeading = document.getElementById('page-heading');
  const dashboardHeadingIcon = document.getElementById('dashboard-heading-icon');
  const dashboardHeadingSubtitle = document.getElementById('dashboard-heading-subtitle');
  if (dashboardHeadingIcon) dashboardHeadingIcon.hidden = false;
  const titles = {
    settings: 'Cài đặt hệ thống',
    overview: 'Tổng quan hệ thống',
    dashboard: 'Tổng quan hệ thống',
    page_chat: 'Trò chuyện AI',
    dictionary: 'Lược đồ CSDL',
    glossary: 'Thuật ngữ nghiệp vụ',
    sql: 'Kết nối CSDL',
    sql_connector: 'Kết nối CSDL',
    providers: 'Nhà cung cấp AI',
    ai_providers: 'Nhà cung cấp AI & Multi-LLM Router',
    analytics: 'Báo cáo & Thống kê Metrics',
    workflows: 'Quy trình Tự động',
    mcp: 'Nguồn MCP Server',
    mcp_sources: 'Nguồn MCP Server',
    system_tools: 'Công cụ hệ thống',
    watchfolder: 'Thư mục giám sát',
    system_logs: 'Nhật ký hệ thống',
    chat_history: 'Lịch sử trò chuyện & Gọi AI',
    chat_feedback: 'Đánh giá chất lượng AI',
    training_core: 'Training Core · Báo cáo cải tiến',
    api_docs: 'API tích hợp',
    library: 'Thư viện tri thức'
  };
  const pageMeta = {
    settings: { icon: 'fa-gear', subtitle: 'Quản lý cấu hình và tùy chọn vận hành hệ thống' },
    page_chat: { icon: 'fa-comments', subtitle: 'Trao đổi, phân tích dữ liệu và làm việc cùng trợ lý AI' },
    dictionary: { icon: 'fa-table-columns', subtitle: 'Khám phá cấu trúc bảng, cột và quan hệ trong cơ sở dữ liệu' },
    glossary: { icon: 'fa-book-open', subtitle: 'Quản lý thuật ngữ và ngữ cảnh nghiệp vụ dùng chung' },
    sql: { icon: 'fa-plug', subtitle: 'Quản lý các kết nối cơ sở dữ liệu an toàn' },
    sql_connector: { icon: 'fa-plug', subtitle: 'Quản lý các kết nối cơ sở dữ liệu an toàn' },
    sql_connectors: { icon: 'fa-plug', subtitle: 'Quản lý các kết nối cơ sở dữ liệu an toàn' },
    providers: { icon: 'fa-microchip', subtitle: 'Cấu hình mô hình và nhà cung cấp trí tuệ nhân tạo' },
    ai_providers: { icon: 'fa-microchip', subtitle: 'Cấu hình mô hình, định tuyến và nhà cung cấp AI' },
    analytics: { icon: 'fa-chart-line', subtitle: 'Theo dõi mức sử dụng, chi phí và hiệu suất hệ thống' },
    workflows: { icon: 'fa-diagram-project', subtitle: 'Thiết kế và quản lý các quy trình tự động hóa' },
    mcp: { icon: 'fa-server', subtitle: 'Quản lý nguồn công cụ và ngữ cảnh từ MCP Server' },
    mcp_sources: { icon: 'fa-server', subtitle: 'Quản lý nguồn công cụ và ngữ cảnh từ MCP Server' },
    system_tools: { icon: 'fa-screwdriver-wrench', subtitle: 'Kiểm tra và vận hành các công cụ của hệ thống' },
    watchfolder: { icon: 'fa-folder-open', subtitle: 'Theo dõi và tự động tiếp nhận tài liệu từ thư mục' },
    system_logs: { icon: 'fa-file-lines', subtitle: 'Theo dõi sự kiện và trạng thái vận hành hệ thống' },
    chat_history: { icon: 'fa-clock-rotate-left', subtitle: 'Tra cứu lịch sử hội thoại và các lượt gọi AI' },
    chat_feedback: { icon: 'fa-thumbs-up', subtitle: 'Theo dõi phản hồi và chất lượng câu trả lời AI' },
    training_core: { icon: 'fa-graduation-cap', subtitle: 'Đánh giá dữ liệu huấn luyện và đề xuất cải tiến mô hình' },
    api_docs: { icon: 'fa-code', subtitle: 'Tài liệu và hướng dẫn tích hợp API hệ thống' },
    library: { icon: 'fa-book-bookmark', subtitle: 'Quản lý tài liệu và nguồn tri thức dành cho AI' }
  };
  const activeMeta = pageMeta[cleanKey] || pageMeta[tabKey];
  if (dashboardHeadingIcon) {
    dashboardHeadingIcon.classList.toggle('is-page-icon', !isDashboard);
    dashboardHeadingIcon.innerHTML = isDashboard
      ? '<i></i><i></i><i></i>'
      : `<i class="fa-solid ${activeMeta?.icon || 'fa-layer-group'}" aria-hidden="true"></i>`;
  }
  if (dashboardHeadingSubtitle) {
    dashboardHeadingSubtitle.hidden = false;
    dashboardHeadingSubtitle.textContent = isDashboard
      ? 'Tổng hợp hoạt động và hiệu suất của hệ thống AI'
      : (activeMeta?.subtitle || 'Quản lý và vận hành hệ thống KnowledgeHub AI');
  }
  if (pageHeading) {
    pageHeading.textContent = titles[cleanKey] || titles[tabKey] || 'KnowledgeHub AI';
  }

  const viewMap = {
    settings: 'view-settings',
    page_chat: 'view-page_chat',
    dictionary: 'view-dictionary',
    glossary: 'view-glossary',
    sql: 'view-sql_connector',
    sql_connector: 'view-sql_connector',
    sql_connectors: 'view-sql_connector',
    providers: 'view-ai-providers',
    ai_providers: 'view-ai-providers',
    analytics: 'view-analytics',
    workflows: 'view-workflows',
    library: 'view-library',
    watchfolder: 'view-watchfolder',
    system_logs: 'view-system-logs',
    chat_history: 'view-chat-history',
    chat_feedback: 'view-chat-feedback',
    training_core: 'view-training-core',
    mcp: 'view-mcp-sources',
    mcp_sources: 'view-mcp-sources',
    system_tools: 'view-system-tools',
    api_docs: 'view-api-docs'
  };

  const directChildren = document.querySelectorAll('#main-view-container > div, #main-view-container > section');
  directChildren.forEach(v => {
    v.style.display = 'none';
  });

  // Keep the sidebar selection in sync before any view-specific early return.
  const navItems = document.querySelectorAll('.nav-list .nav-item');
  navItems.forEach(item => {
    const link = item.querySelector('a');
    const attr = link ? (link.getAttribute('onclick') || '') : '';
    const isActive = attr.includes(`'${tabKey}'`) || attr.includes(`'${cleanKey}'`);
    item.classList.toggle('active', isActive);
    if (link) {
      if (isActive) {
        link.setAttribute('aria-current', 'page');
        link.scrollIntoView({ block: 'nearest' });
      }
      else link.removeAttribute('aria-current');
    }
  });

  if (isDashboard) {
    const dashLogs = document.getElementById('view-dashboard-logs');
    if (dashLogs) dashLogs.style.display = 'block';
    if (typeof fetchDashboardLogs === 'function') fetchDashboardLogs();
    return;
  }

  const targetId = viewMap[cleanKey] || `view-${cleanKey.replace(/_/g, '-')}`;
  let targetView = document.getElementById(targetId);
  if (!targetView && typeof loadViewComponents === 'function') {
    await loadViewComponents();
    targetView = document.getElementById(targetId);
  }

  if (targetView) {
    targetView.style.display = targetView.dataset.display || 'block';
  } else {
    console.warn(`Không tìm thấy view: ${targetId}`);
  }

  // Trigger Data Fetchers from Modules
  if (typeof fetchSettings === 'function' && cleanKey === 'settings') fetchSettings();
  if (typeof fetchAiProviders === 'function' && cleanKey.includes('provider')) fetchAiProviders();
  if (typeof fetchDataDictionary === 'function' && cleanKey === 'dictionary') fetchDataDictionary();
  if (typeof fetchGlossaryData === 'function' && cleanKey === 'glossary') fetchGlossaryData();
  if (typeof fetchDbSources === 'function' && (cleanKey === 'sql' || cleanKey === 'sql_connector')) fetchDbSources();
  if (typeof fetchLogs === 'function' && cleanKey.includes('log')) fetchLogs();
  if (typeof fetchChatHistory === 'function' && cleanKey.includes('chat_history')) fetchChatHistory();
  if (typeof fetchChatFeedback === 'function' && cleanKey === 'chat_feedback') fetchChatFeedback();
  if (typeof fetchMcpServers === 'function' && cleanKey === 'mcp_sources') fetchMcpServers();
  if (typeof fetchTrainingReport === 'function' && cleanKey === 'training_core') fetchTrainingReport();
  if (typeof fetchSystemTools === 'function' && cleanKey === 'system_tools') fetchSystemTools();
  if (typeof fetchMcpServers === 'function' && cleanKey === 'mcp_sources') fetchMcpServers();
  if (typeof fetchSystemTools === 'function' && cleanKey === 'system_tools') fetchSystemTools();
  if (typeof fetchApiKeys === 'function' && cleanKey === 'api_docs') fetchApiKeys();
  if (typeof fetchEmbedConfigs === 'function' && cleanKey === 'api_docs') fetchEmbedConfigs();
  if (typeof fetchLibraryDocuments === 'function' && cleanKey === 'library') fetchLibraryDocuments();
  if (typeof fetchWatchFolderData === 'function' && cleanKey === 'watchfolder') fetchWatchFolderData();
  if (typeof initWorkflowsView === 'function' && cleanKey === 'workflows') initWorkflowsView();
  if (typeof initPageAnalyticsCharts === 'function' && cleanKey === 'analytics') initPageAnalyticsCharts();
  if (typeof populateChatModelSelector === 'function' && cleanKey === 'page_chat') populateChatModelSelector();
  if (typeof populateChatKnowledgeSources === 'function' && cleanKey === 'page_chat') populateChatKnowledgeSources();
  if (typeof renderChatSessionsList === 'function' && cleanKey === 'page_chat') renderChatSessionsList();
  if (typeof renderCurrentChatMessages === 'function' && cleanKey === 'page_chat') renderCurrentChatMessages();
  if (typeof fetchAndRenderQuickPrompts === 'function' && cleanKey === 'page_chat') fetchAndRenderQuickPrompts();
};


// Load Modular HTML Component Templates into #main-view-container
async function loadViewComponents() {
  const container = document.getElementById('main-view-container');
  if (!container) return;
  const views = [
    'dashboard_logs.html',
    'page_chat.html',
    'dictionary.html',
    'sql_connector.html',
    'ai_providers.html',
    'library.html',
    'watchfolder.html',
    'glossary.html',
    'analytics.html',
    'workflows.html',
    'system_logs.html',
    'chat_history.html',
    'chat_feedback.html',
    'training_core.html',
    'mcp_sources.html',
    'system_tools.html',
    'settings.html',
    'api_docs.html'
  ];

  try {
    const htmlContents = await Promise.all(
      views.map(v => fetch(`/views/${v}`).then(res => res.text()))
    );
    container.innerHTML = htmlContents.join('\n');
  } catch (err) {
    console.error("Lỗi khi tải các view module:", err);
  }
}

// Fetch Qdrant Status
async function fetchQdrantStatus() {
  const cardEl = document.getElementById('sidebar-footer-card');
  const statusEl = document.getElementById('sidebar-qdrant-status');
  const descEl = document.getElementById('sidebar-qdrant-desc');
  const progressEl = document.getElementById('sidebar-qdrant-progress');

  try {
    const res = await fetch('/api/qdrant/status');
    const data = await res.json();
    if (!res.ok || data.connected !== true) {
      throw new Error(data.error || `Qdrant unavailable (HTTP ${res.status})`);
    }
    const pointsCount = Number.isFinite(Number(data.pointsCount)) ? Number(data.pointsCount) : 0;

    if (cardEl) {
      cardEl.classList.remove('status-offline');
      cardEl.classList.add('status-online');
    }
    if (statusEl) {
      statusEl.className = 'health-status-tag online';
      statusEl.innerHTML = `<i class="fa-solid fa-circle-check"></i> Connected`;
    }
    if (descEl) {
      descEl.style.display = 'inline-block';
      descEl.innerHTML = `<strong>${pointsCount.toLocaleString()}</strong> vectors`;
    }
    if (progressEl) {
      progressEl.style.width = pointsCount > 0 ? '100%' : '0%';
    }
  } catch (err) {
    if (cardEl) {
      cardEl.classList.remove('status-online');
      cardEl.classList.add('status-offline');
    }
    if (statusEl) {
      statusEl.className = 'health-status-tag offline';
      statusEl.innerHTML = `<i class="fa-solid fa-circle-xmark"></i> Offline`;
    }
    if (descEl) {
      descEl.style.display = 'none';
      descEl.textContent = '';
    }
    if (progressEl) {
      progressEl.style.width = '0%';
    }
  }
}

// Sidebar Copilot Popup Chat - single temporary conversation
window.copilotPopupHistory = [];
window.copilotPopupSessionId = `copilot-${Date.now()}`;

function getCopilotWelcomeHtml() {
  return `
    <div class="chat-bubble ai">
      <i class="fa-solid fa-robot" style="color: #6366f1; margin-right: 6px;"></i>
      Xin chào! Tôi là <strong>KAI</strong> - Trợ lý AI chuyên nghiệp của bạn. Tôi có thể trả lời câu hỏi, truy vấn
      SQL, vẽ biểu đồ và tính toán dữ liệu. Bạn cần hỗ trợ gì hôm nay?
    </div>
  `;
}

function escapeCopilotHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCopilotText(text) {
  const raw = String(text ?? '')
    .replace(/\{\s*(?:render[_-]?)?chart\s*\}/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const jsonBlocks = [];
  const withPlaceholders = raw.replace(/```json\s*([\s\S]*?)```/gi, (_, json) => {
    const idx = jsonBlocks.push(json.trim()) - 1;
    return `__KAI_JSON_BLOCK_${idx}__`;
  }).replace(/(^|\n)(\s*\{[\s\S]*?\}\s*)(?=\n|$)/g, (match, prefix, json) => {
    try {
      JSON.parse(json.trim());
      const idx = jsonBlocks.push(json.trim()) - 1;
      return `${prefix}__KAI_JSON_BLOCK_${idx}__`;
    } catch {
      return match;
    }
  });

  let html = parseMarkdown(withPlaceholders);
  jsonBlocks.forEach((json, idx) => {
    let pretty = json;
    try {
      pretty = JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      // keep raw block
    }
    const highlighted = escapeCopilotHtml(pretty).replace(/(&quot;(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\&])*&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (match, quoted, colon, literal, number) => {
      if (quoted) return `<span class="json-token ${colon ? 'json-key' : 'json-string'}">${quoted}</span>${colon || ''}`;
      if (literal) return `<span class="json-token json-literal">${literal}</span>`;
      return `<span class="json-token json-number">${number}</span>`;
    });
    html = html.replace(`__KAI_JSON_BLOCK_${idx}__`, `<div class="json-code-viewer copilot-json-viewer"><div class="json-code-header"><span><i class="fa-solid fa-brackets-curly"></i> JSON</span><button type="button" onclick="navigator.clipboard.writeText(this.closest('.json-code-viewer').querySelector('code').textContent);"><i class="fa-solid fa-copy"></i> Sao chép</button></div><pre class="copilot-json-block"><code>${highlighted}</code></pre></div>`);
  });
  return html;
}

function renderCopilotDownloadAction(downloadUrl, renderedReply = '') {
  const url = String(downloadUrl || '').trim();
  if (!/^\/api\/exports\/[^\s<>"']+$/i.test(url) || String(renderedReply).includes('chat-download-link')) return '';
  return `<div><a class="chat-download-link" href="${escapeCopilotHtml(url)}" download><i class="fa-solid fa-download"></i>Tải file báo cáo</a></div>`;
}

function renderCopilotToolCalls(toolCalls = []) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return '';
  const steps = toolCalls.map(tc => {
    const ok = tc.success !== false;
    const label = tc.name || tc.toolName || 'tool';
    return `
      <div class="copilot-tool-step ${ok ? 'ok' : 'error'}">
        <i class="fa-solid ${label === 'execute_sql_query' ? 'fa-database' : label === 'render_chart' ? 'fa-chart-column' : label === 'get_current_datetime' ? 'fa-clock' : 'fa-wrench'}"></i>
        <strong>${escapeCopilotHtml(label)}</strong>
        ${tc.rowCount != null ? `<span>${escapeCopilotHtml(tc.rowCount)} dòng</span>` : ''}
        <em>${ok ? 'Thành công' : 'Lỗi'}</em>
      </div>
    `;
  }).join('');
  return `
    <details class="copilot-tool-panel" open>
      <summary>Quá trình xử lý <span>${toolCalls.length} bước</span></summary>
      <div>${steps}</div>
    </details>
  `;
}

function renderCopilotSql(sqlQuery, label = 'Câu lệnh SQL') {
  if (!sqlQuery) return '';
  return `
    <details class="copilot-sql-panel" open>
      <summary><span><i class="fa-solid fa-code"></i> ${escapeCopilotHtml(label)}</span><i class="fa-solid fa-chevron-down"></i></summary>
      <div class="copilot-sql-code">
        <button type="button" onclick="navigator.clipboard.writeText(this.nextElementSibling.textContent);"><i class="fa-solid fa-copy"></i> Sao chép</button>
        <code>${escapeCopilotHtml(sqlQuery)}</code>
      </div>
    </details>
  `;
}

function renderCopilotToolResult(toolResult, label = 'Xem dữ liệu') {
  if (!toolResult || !Array.isArray(toolResult.columns) || !Array.isArray(toolResult.rows) || toolResult.rows.length === 0) return '';
  const head = toolResult.columns.map(col => `<th>${escapeCopilotHtml(col)}</th>`).join('');
  const body = toolResult.rows.slice(0, 50).map(row => `
    <tr>${row.map(cell => `<td>${escapeCopilotHtml(cell ?? '')}</td>`).join('')}</tr>
  `).join('');
  return `
    <details class="copilot-result-table" open>
      <summary><i class="fa-solid fa-table-list"></i> ${escapeCopilotHtml(label)} (${toolResult.rows.length} dòng)<i class="fa-solid fa-chevron-down"></i></summary>
      <div><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    </details>
  `;
}

function renderCopilotExecutionResults(sqlExecutions = [], toolResult = null) {
  const executionsWithRows = Array.isArray(sqlExecutions)
    ? sqlExecutions.filter(execution => Array.isArray(execution.rows) && execution.rows.length > 0)
    : [];
  if (executionsWithRows.length) {
    return executionsWithRows.map((execution, index) => renderCopilotToolResult(
      execution,
      executionsWithRows.length === 1 ? 'Kết quả dữ liệu' : `Kết quả dữ liệu ${index + 1}`
    )).join('');
  }
  return renderCopilotToolResult(toolResult, 'Kết quả dữ liệu');
}

function renderCopilotTechnicalDetails(toolCalls, sqlQuery, toolResult, sqlExecutions = [], progressEvents = [], executionTime = '') {
  const executions = Array.isArray(sqlExecutions) && sqlExecutions.length > 0
    ? sqlExecutions
    : (sqlQuery ? [{ index: 1, sql: sqlQuery, columns: toolResult?.columns || [], rows: toolResult?.rows || [] }] : []);
  const executionPanels = executions.map((execution, index) => {
    const number = execution.index || index + 1;
    return renderCopilotSql(execution.sql, `Câu lệnh SQL ${number}/${executions.length}`);
  }).join('');
  const resultPanels = renderCopilotExecutionResults(sqlExecutions, toolResult);
  const thinkingTimeline = progressEvents.length ? `
    <div class="chat-embedded-thinking">
      <div class="chat-embedded-thinking-title"><i class="fa-solid fa-brain"></i> Thinking · ${progressEvents.length} bước${executionTime ? ` · ${escapeCopilotHtml(executionTime)}` : ''}</div>
      <div class="chat-embedded-thinking-steps">
        ${progressEvents.map(event => {
          const status = event.status || 'running';
          const color = status === 'done' ? '#16a34a' : status === 'error' ? '#dc2626' : status === 'warning' ? '#d97706' : '#6366f1';
          const fallbackIcon = status === 'done' ? 'check' : status === 'error' ? 'xmark' : status === 'warning' ? 'triangle-exclamation' : 'circle-notch';
          const icon = String(event.icon || fallbackIcon).replace(/[^a-z0-9-]/gi, '') || fallbackIcon;
          return `<div class="chat-embedded-thinking-step"><span style="color:${color}"><i class="fa-solid fa-${icon}"></i></span><span>${escapeCopilotHtml(event.label || 'Đang xử lý')}</span></div>`;
        }).join('')}
      </div>
    </div>` : '';
  const content = `${thinkingTimeline}${renderCopilotToolCalls(toolCalls)}${resultPanels}${executionPanels}`;
  if (!content) return '';
  return `
    <details class="copilot-technical-details">
      <summary><span><i class="fa-solid fa-brain"></i> Thinking · Quá trình xử lý</span><i class="fa-solid fa-chevron-down"></i></summary>
      <div>${content}</div>
    </details>
  `;
}

function renderCopilotChart(chartSpec) {
  if (!chartSpec || typeof chartSpec !== 'object') return '';
  const chartId = `copilot-chart-${Date.now()}`;
  requestAnimationFrame(() => {
    setTimeout(() => {
      if (typeof renderChartSpec === 'function') renderChartSpec(chartId, chartSpec);
    }, 80);
  });
  return `<div class="copilot-chart-box"><canvas id="${chartId}"></canvas></div>`;
}

function addCopilotThinkingStep(containerId, icon, label, status = 'running') {
  const stepsEl = document.getElementById(`${containerId}-steps`);
  if (!stepsEl) return;
  typeCopilotThinkingText(document.getElementById(`${containerId}-current`), label);
  const color = status === 'done' ? '#22c55e' : status === 'error' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#6366f1';
  const fallbackIcon = status === 'done' ? 'check' : status === 'error' ? 'xmark' : status === 'warning' ? 'triangle-exclamation' : 'circle-notch';
  const statusIcon = String(status === 'done' ? 'check' : status === 'error' ? 'xmark' : icon || fallbackIcon).replace(/[^a-z0-9-]/gi, '') || fallbackIcon;
  const spinIcons = ['spinner', 'circle-notch', 'arrows-rotate', 'sync', 'gear', 'cog'];
  const spinClass = (status === 'running' && spinIcons.includes(statusIcon)) ? 'fa-spin' : '';
  stepsEl.insertAdjacentHTML('beforeend', `<div class="chat-thinking-step"><span style="color:${color};"><i class="fa-solid fa-${statusIcon} ${spinClass}"></i></span><span>${escapeCopilotHtml(label)}</span></div>`);
}

function typeCopilotThinkingText(element, value) {
  if (!element) return;
  if (element._typingTimer) clearInterval(element._typingTimer);
  const text = String(value || 'Đang xử lý...');
  let index = 0;
  element.textContent = '';
  element._typingTimer = setInterval(() => {
    index += 1;
    element.textContent = text.slice(0, index);
    if (index >= text.length) {
      clearInterval(element._typingTimer);
      element._typingTimer = null;
    }
  }, 14);
}

async function fetchCopilotStreamingChat(payload, onProgress, signal = null) {
  const response = await fetch('/api/intelligent-core/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try { detail = (await response.json()).message || detail; } catch (_) { }
    throw new Error(detail);
  }
  if (!response.body) throw new Error('Trình duyệt không hỗ trợ streaming response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalPayload = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) {
      let eventName = 'message';
      const dataLines = [];
      frame.split(/\r?\n/).forEach(line => {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      });
      if (!dataLines.length) continue;
      const data = JSON.parse(dataLines.join('\n'));
      if (eventName === 'progress') onProgress?.(data);
      else if (eventName === 'final') finalPayload = data;
      else if (eventName === 'error') throw new Error(data.message || 'Streaming chat gặp lỗi.');
    }
    if (done) break;
  }
  if (!finalPayload) throw new Error('Stream kết thúc mà không có câu trả lời cuối.');
  return finalPayload;
}

window.openModal = function openModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.style.display = 'flex';
    modal.classList.add('show');
  }
};

window.closeModal = function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) {
    modal.classList.remove('show');
    modal.style.display = '';
  }
};

window.copilotAttachments = [];
window.copilotWebSearchEnabled = false;
window.copilotRequestController = null;
window.copilotIsResponding = false;

function setCopilotResponding(active) {
  window.copilotIsResponding = Boolean(active);
  const button = document.getElementById('copilot-send-button');
  if (!button) return;
  button.classList.toggle('is-stop', window.copilotIsResponding);
  button.setAttribute('aria-label', window.copilotIsResponding ? 'Dừng trả lời' : 'Gửi yêu cầu');
  button.setAttribute('aria-pressed', String(window.copilotIsResponding));
  button.title = window.copilotIsResponding ? 'Dừng tiến trình trả lời hiện tại' : 'Gửi yêu cầu';
  button.innerHTML = window.copilotIsResponding
    ? '<i class="fa-solid fa-square"></i>'
    : '<i class="fa-solid fa-paper-plane"></i>';
}

window.stopCopilotResponse = function stopCopilotResponse() {
  if (!window.copilotRequestController || !window.copilotIsResponding) return false;
  window.copilotRequestController.abort();
  return true;
};

window.handleCopilotSendAction = function handleCopilotSendAction() {
  if (window.copilotIsResponding) {
    window.stopCopilotResponse();
    return;
  }
  window.sendChatMessage();
};

function closeCopilotComposerMenus() {
  document.getElementById('copilot-model-menu')?.classList.remove('is-open');
  document.getElementById('copilot-add-menu')?.classList.remove('is-open');
  document.getElementById('copilot-model-trigger')?.setAttribute('aria-expanded', 'false');
  document.getElementById('copilot-add-trigger')?.setAttribute('aria-expanded', 'false');
  const knowledgePanel = document.getElementById('copilot-knowledge-panel');
  if (knowledgePanel) knowledgePanel.hidden = true;
  document.getElementById('copilot-knowledge-toggle')?.classList.remove('is-active');
  document.getElementById('copilot-knowledge-toggle')?.setAttribute('aria-expanded', 'false');
}

window.toggleCopilotModelMenu = function toggleCopilotModelMenu(event) {
  event?.stopPropagation();
  const menu = document.getElementById('copilot-model-menu');
  const shouldOpen = !menu?.classList.contains('is-open');
  closeCopilotComposerMenus();
  if (shouldOpen) { menu?.classList.add('is-open'); document.getElementById('copilot-model-trigger')?.setAttribute('aria-expanded', 'true'); }
};

window.toggleCopilotAddMenu = function toggleCopilotAddMenu(event) {
  event?.stopPropagation();
  const menu = document.getElementById('copilot-add-menu');
  const shouldOpen = !menu?.classList.contains('is-open');
  closeCopilotComposerMenus();
  if (shouldOpen) { menu?.classList.add('is-open'); document.getElementById('copilot-add-trigger')?.setAttribute('aria-expanded', 'true'); }
};

window.selectCopilotModel = function selectCopilotModel(value) {
  const selector = document.getElementById('chat-model-selector');
  if (!selector) return;
  selector.value = value;
  const option = selector.options[selector.selectedIndex];
  const label = document.getElementById('copilot-model-label');
  if (label && option) label.textContent = option.dataset.shortLabel || option.textContent;
  document.querySelectorAll('#copilot-model-menu .page-chat-model-option').forEach(button => button.classList.toggle('is-selected', button.dataset.value === value));
  localStorage.setItem('knowledgehub_selected_copilot_model', value);
  closeCopilotComposerMenus();
};

window.openCopilotFilePicker = function openCopilotFilePicker(type = 'all') {
  closeCopilotComposerMenus();
  document.getElementById(type === 'camera' ? 'copilot-camera-input' : 'copilot-file-input')?.click();
};

window.handleCopilotFiles = function handleCopilotFiles(event) {
  Array.from(event?.target?.files || []).forEach(file => {
    const duplicate = window.copilotAttachments.some(item => item.name === file.name && item.size === file.size);
    if (!duplicate && file.size <= 10 * 1024 * 1024) window.copilotAttachments.push(file);
    else if (file.size > 10 * 1024 * 1024 && typeof showToast === 'function') showToast(`Tệp ${file.name} vượt quá 10 MB`, 'warning');
  });
  if (event?.target) event.target.value = '';
  renderCopilotAttachments();
};

window.removeCopilotAttachment = function removeCopilotAttachment(index) {
  window.copilotAttachments.splice(index, 1);
  renderCopilotAttachments();
};

function renderCopilotAttachments() {
  const preview = document.getElementById('copilot-attachment-preview');
  if (!preview) return;
  preview.classList.toggle('has-files', window.copilotAttachments.length > 0);
  preview.innerHTML = window.copilotAttachments.map((file, index) => `<div class="page-chat-file-chip"><i class="fa-solid ${file.type?.startsWith('image/') ? 'fa-image' : 'fa-file-lines'}"></i><span title="${escapeCopilotHtml(file.name)}">${escapeCopilotHtml(file.name)}</span><button type="button" onclick="removeCopilotAttachment(${index})" aria-label="Xóa tệp"><i class="fa-solid fa-xmark"></i></button></div>`).join('');
  renderCopilotKnowledgeChip();
}

function renderCopilotRetrievalContext(contextSelection) {
  if (!contextSelection || contextSelection.knowledgeMode === 'disabled') return '';
  const pipeline = contextSelection.retrievalPipeline || {};
  const sources = Array.isArray(contextSelection.documentSources) ? contextSelection.documentSources : [];
  if (!sources.length) return '';
  const modeLabels = {
    hybrid: 'Hybrid RAG', hybrid_graph: 'Hybrid + GraphRAG', selected_hybrid: 'Hybrid theo tài liệu'
  };
  const labels = [
    modeLabels[contextSelection.knowledgeMode] || 'Knowledge RAG',
    pipeline.reranked ? 'Đã rerank' : 'RRF',
    pipeline.chunksSelected ? `${pipeline.chunksSelected} chunks` : null
  ].filter(Boolean);
  return `<div class="copilot-rag-context"><div><i class="fa-solid fa-diagram-project"></i>${labels.map(label => `<span>${escapeCopilotHtml(label)}</span>`).join('')}</div><small><i class="fa-solid fa-book-open"></i> ${escapeCopilotHtml(sources.join(' · '))}</small></div>`;
}

function getCopilotKnowledgeValues(select = document.getElementById('copilot-knowledge-source')) {
  const values = select ? [...select.selectedOptions].map(option => option.value) : [];
  return values.length ? values : ['auto'];
}
function setCopilotKnowledgeValues(select, values) {
  if (!select) return;
  const wanted = new Set(values?.length ? values : ['auto']);
  [...select.options].forEach(option => { option.selected = wanted.has(option.value); });
}
window.populateCopilotKnowledgeSources = async function () {
  const select = document.getElementById('copilot-knowledge-source'); if (!select) return; const current = getCopilotKnowledgeValues(select);
  try { const response = await fetch('/api/library'); const data = await response.json(); window.copilotKnowledgeDocuments = (Array.isArray(data) ? data : []).filter(item => Number(item.chunksCount || 0) > 0); select.innerHTML = '<option value="auto">Tự động</option><option value="none">Không dùng thư viện tri thức</option>' + window.copilotKnowledgeDocuments.map(item => `<option value="${escapeCopilotHtml(item.id)}">${escapeCopilotHtml(item.title)}</option>`).join(''); const available = new Set([...select.options].map(option => option.value)); setCopilotKnowledgeValues(select, current.filter(value => available.has(value))); renderCopilotKnowledgeOptions(); renderCopilotKnowledgeChip(); } catch (_) { }
};
window.toggleCopilotKnowledgePanel = function (event) { event?.stopPropagation(); const panel = document.getElementById('copilot-knowledge-panel'); if (!panel) return; panel.hidden = !panel.hidden; document.getElementById('copilot-knowledge-toggle')?.classList.toggle('is-active', !panel.hidden); document.getElementById('copilot-knowledge-toggle')?.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) { renderCopilotKnowledgeOptions(); setTimeout(() => document.getElementById('copilot-knowledge-search')?.focus(), 0); } };
window.renderCopilotKnowledgeOptions = function () { const root = document.getElementById('copilot-knowledge-options'), select = document.getElementById('copilot-knowledge-source'); if (!root || !select) return; const q = (document.getElementById('copilot-knowledge-search')?.value || '').toLowerCase(); const docs = (window.copilotKnowledgeDocuments || []).filter(x => x.title.toLowerCase().includes(q)); const selected = new Set(getCopilotKnowledgeValues(select)); const option = (value, icon, title, note) => `<button type="button" class="chat-knowledge-option ${selected.has(value) ? 'active' : ''}" data-value="${escapeCopilotHtml(value)}" onclick="selectCopilotKnowledgeSource(this.dataset.value,event)"><i class="fa-solid ${icon}"></i><span><strong>${escapeCopilotHtml(title)}</strong><small>${escapeCopilotHtml(note)}</small></span><i class="fa-solid fa-check"></i></button>`; root.innerHTML = option('auto', 'fa-wand-magic-sparkles', 'Tự động chọn nguồn', 'Hybrid RAG trong toàn bộ thư viện') + option('none', 'fa-ban', 'Không dùng nguồn tri thức', 'Chỉ dùng CSDL và hội thoại') + docs.map(x => option(x.id, 'fa-file-lines', x.title, `${x.fileType} · ${x.chunksCount} chunks · ${x.status === 'Đã lập chỉ mục' ? 'Hybrid' : 'chỉ BM25'}`)).join(''); };
window.selectCopilotKnowledgeSource = function (value, event) { event?.stopPropagation(); const select = document.getElementById('copilot-knowledge-source'); if (!select) return; const current = new Set(getCopilotKnowledgeValues(select)); if (value === 'auto' || value === 'none') { setCopilotKnowledgeValues(select, [value]); if (value === 'none') { window.copilotWebSearchEnabled = false; document.getElementById('copilot-web-toggle')?.classList.remove('is-active'); document.getElementById('copilot-web-toggle')?.setAttribute('aria-pressed', 'false'); } } else { current.delete('auto'); current.delete('none'); if (current.has(value)) current.delete(value); else current.add(value); setCopilotKnowledgeValues(select, [...current]); window.copilotWebSearchEnabled = false; document.getElementById('copilot-web-toggle')?.classList.remove('is-active'); document.getElementById('copilot-web-toggle')?.setAttribute('aria-pressed', 'false'); } renderCopilotKnowledgeOptions(); renderCopilotKnowledgeChip(); };
function renderCopilotKnowledgeChip() {
  const root = document.getElementById('copilot-knowledge-inline'), select = document.getElementById('copilot-knowledge-source');
  if (!root || !select) return;
  const chips = [];
  getCopilotKnowledgeValues(select).filter(value => value !== 'auto').forEach(value => {
    const option = [...select.options].find(item => item.value === value);
    const label = option?.textContent || 'Nguồn tri thức';
    chips.push(`<span class="chat-knowledge-chip ${value === 'none' ? 'disabled' : ''}" title="${escapeCopilotHtml(label)}"><i class="fa-solid ${value === 'none' ? 'fa-ban' : 'fa-book-open'}"></i><span>${escapeCopilotHtml(label)}</span><button type="button" data-value="${escapeCopilotHtml(value)}" title="Bỏ nguồn đã chọn" onclick="selectCopilotKnowledgeSource(this.dataset.value,event)"><i class="fa-solid fa-xmark"></i></button></span>`);
  });
  if (window.copilotWebSearchEnabled) {
    chips.push('<span class="chat-knowledge-chip web-search-chip" title="Tìm kiếm trên web đang bật"><i class="fa-solid fa-globe"></i><span>Tìm kiếm web</span><button type="button" title="Tắt tìm kiếm web" onclick="toggleCopilotWebSearch(event)"><i class="fa-solid fa-xmark"></i></button></span>');
  }
  root.hidden = chips.length === 0;
  root.innerHTML = chips.join('');
}

window.toggleCopilotWebSearch = function toggleCopilotWebSearch(event) {
  event?.stopPropagation();
  window.copilotWebSearchEnabled = !window.copilotWebSearchEnabled;
  if (window.copilotWebSearchEnabled) {
    const knowledgeSource = document.getElementById('copilot-knowledge-source');
    if (knowledgeSource) setCopilotKnowledgeValues(knowledgeSource, ['auto']);
    window.renderCopilotKnowledgeOptions();
  }
  document.getElementById('copilot-web-toggle')?.classList.toggle('is-active', window.copilotWebSearchEnabled);
  document.getElementById('copilot-web-toggle')?.setAttribute('aria-pressed', String(window.copilotWebSearchEnabled));
  renderCopilotKnowledgeChip();
};

window.updateCopilotCharacterCount = function updateCopilotCharacterCount(value = '') {
  const count = document.getElementById('copilot-character-count');
  if (count) count.textContent = `${String(value).length}/4000`;
};

window.showCopilotAddNotice = function showCopilotAddNotice(type) {
  closeCopilotComposerMenus();
  const labels = { project: 'Dự án', skills: 'Skills', connector: 'Connector', plugins: 'Plugins' };
  if (typeof showToast === 'function') showToast(`${labels[type] || type} sẽ được cấu hình tại trang quản trị tương ứng.`, 'info');
};

async function buildCopilotAttachmentContext(files) {
  const parts = await Promise.all(files.map(async file => {
    const isText = file.type.startsWith('text/') || /\.(txt|md|csv|json|sql|js|ts|html|css)$/i.test(file.name);
    if (!isText || file.size > 1024 * 1024) return `[Tệp đính kèm: ${file.name}, ${Math.ceil(file.size / 1024)} KB]`;
    try { return `[Nội dung tệp ${file.name}:\n${(await file.text()).slice(0, 12000)}\n]`; }
    catch { return `[Tệp đính kèm: ${file.name}]`; }
  }));
  return parts.length ? `\n\n${parts.join('\n')}` : '';
}

document.addEventListener('click', closeCopilotComposerMenus);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeCopilotComposerMenus();
    if (document.getElementById('logout-confirm-modal')?.classList.contains('show')) closeLogoutConfirmation();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'u' && document.getElementById('copilot-modal')?.classList.contains('show')) {
    event.preventDefault();
    openCopilotFilePicker('all');
  }
});

window.resetCopilotChatModal = function resetCopilotChatModal() {
  if (window.copilotIsResponding) window.stopCopilotResponse();
  window.copilotRequestController = null;
  setCopilotResponding(false);
  const previousSessionId = window.copilotPopupSessionId;
  if (previousSessionId) {
    fetch('/api/conversation-memory/clear', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: previousSessionId })
    }).catch(() => { });
  }
  window.copilotPopupHistory = [];
  window.copilotPopupSessionId = `copilot-${Date.now()}`;
  const messages = document.getElementById('chat-messages-container');
  const input = document.getElementById('chat-user-input');
  if (messages) messages.innerHTML = getCopilotWelcomeHtml();
  if (input) input.value = '';
  window.updateCopilotCharacterCount?.('');
  window.copilotAttachments = [];
  renderCopilotAttachments();
};

window.openCopilotPopup = function openCopilotPopup() {
  resetCopilotChatModal();
  populateCopilotModelSelector();
  populateCopilotKnowledgeSources();
  openModal('copilot-modal');
  setTimeout(() => document.getElementById('chat-user-input')?.focus(), 80);
};

window.closeCopilotPopup = function closeCopilotPopup() {
  closeModal('copilot-modal');
  resetCopilotChatModal();
};

window.handleChatKeyPress = function handleChatKeyPress(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (window.copilotIsResponding) {
      if (typeof showToast === 'function') showToast('Hãy dừng câu trả lời hiện tại trước khi gửi yêu cầu mới.', 'info');
      return;
    }
    sendChatMessage();
  }
};

window.populateCopilotModelSelector = async function populateCopilotModelSelector() {
  const selector = document.getElementById('chat-model-selector');
  const menu = document.getElementById('copilot-model-menu');
  if (!selector || !menu) return;

  selector.innerHTML = `<option value="">Đang tải model...</option>`;
  let providers = [];
  try {
    providers = window.aiProvidersData;
    if (!providers || providers.length === 0) {
      const res = await fetch('/api/ai-providers');
      if (res.ok) {
        const data = await res.json();
        providers = Array.isArray(data) ? data : (data.providers || []);
      }
    }

    selector.innerHTML = '';
    if (providers && providers.length > 0) {
      providers.forEach(prov => {
        const opt = document.createElement('option');
        opt.value = prov.id || prov.model || prov.name;
        opt.textContent = prov.model ? `${prov.name} (${prov.model})` : (prov.name || 'AI Provider');
        opt.dataset.shortLabel = prov.model || prov.name || 'AI Provider';
        selector.appendChild(opt);
      });
    }
  } catch (err) {
    console.warn('Không thể tải danh sách model:', err);
  }

  if (!providers || providers.length === 0) selector.innerHTML = `<option value="" data-short-label="Gemini 2.5 Flash">Google Gemini - 2.5 Flash</option>`;
  const savedValue = localStorage.getItem('knowledgehub_selected_copilot_model');
  const activeProvider = (providers || []).find(provider => provider.isActive);
  const activeValue = activeProvider && (activeProvider.id || activeProvider.model || activeProvider.name);
  const selectedValue = Array.from(selector.options).some(option => option.value === savedValue) ? savedValue : (activeValue || selector.options[0]?.value || '');
  menu.innerHTML = Array.from(selector.options).map((option, index) => {
    const provider = (providers || [])[index] || {};
    return `<button type="button" class="page-chat-model-option" data-value="${escapeCopilotHtml(option.value)}" onclick="selectCopilotModel(this.dataset.value)" role="option"><i class="fa-solid fa-check model-check"></i><span class="page-chat-model-copy"><strong>${escapeCopilotHtml(option.dataset.shortLabel || option.textContent)}</strong><small>${escapeCopilotHtml(provider.name || provider.type || 'Trợ giúp toàn diện')}</small></span>${provider.isActive ? '<span class="page-chat-model-badge">Mặc định</span>' : ''}</button>`;
  }).join('');
  selectCopilotModel(selectedValue);
};

window.sendChatMessage = async function sendChatMessage() {
  if (window.copilotIsResponding) return;
  const input = document.getElementById('chat-user-input');
  const messages = document.getElementById('chat-messages-container');
  if (!input || !messages) return;

  const text = input.value.trim();
  const attachedFiles = [...window.copilotAttachments];
  if (!text && attachedFiles.length === 0) return;
  const providerId = document.getElementById('chat-model-selector')?.value || null;
  input.value = '';
  window.updateCopilotCharacterCount('');
  window.copilotAttachments = [];
  renderCopilotAttachments();

  messages.insertAdjacentHTML('beforeend', `
    <div class="chat-bubble user">${escapeCopilotHtml(text || 'Đã gửi tệp đính kèm')}${attachedFiles.length ? `<div style="margin-top:7px;font-size:11px;opacity:.85"><i class="fa-solid fa-paperclip"></i> ${attachedFiles.map(file => escapeCopilotHtml(file.name)).join(', ')}</div>` : ''}</div>
  `);

  const thinkingId = `copilot-thinking-${Date.now()}`;
  const progressEvents = [];
  messages.insertAdjacentHTML('beforeend', `
    <div class="chat-thinking-row copilot-thinking-row" id="${thinkingId}">
      <div class="chat-thinking-avatar"><svg class="chat-ai-sparkle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.75c.55 4.95 2.3 6.7 7.25 7.25-4.95.55-6.7 2.3-7.25 7.25C11.45 12.3 9.7 10.55 4.75 10 9.7 9.45 11.45 7.7 12 2.75Z"/><path d="M19 15.75c.22 1.97.91 2.66 2.88 2.88-1.97.22-2.66.91-2.88 2.87-.22-1.96-.91-2.65-2.88-2.87 1.97-.22 2.66-.91 2.88-2.88Z"/></svg></div>
      <div class="chat-thinking-card">
        <div class="chat-thinking-head">
          <canvas class="chat-thinking-spinner" width="22" height="22"></canvas>
          <div class="chat-thinking-copy"><strong>Thinking</strong><span id="${thinkingId}-current">AI đang phân tích yêu cầu của bạn...</span></div>
          <button type="button" class="chat-thinking-toggle" aria-label="Xem chi tiết quá trình xử lý" aria-expanded="false"><i class="fa-solid fa-chevron-down"></i></button>
        </div>
        <div id="${thinkingId}-steps" class="chat-thinking-steps" hidden></div>
      </div>
    </div>
  `);
  const thinkingRoot = document.getElementById(thinkingId);
  const thinkingToggle = thinkingRoot?.querySelector('.chat-thinking-toggle');
  const thinkingSteps = document.getElementById(`${thinkingId}-steps`);
  if (thinkingToggle && thinkingSteps) {
    thinkingToggle.onclick = () => {
      thinkingSteps.hidden = !thinkingSteps.hidden;
      thinkingToggle.setAttribute('aria-expanded', String(!thinkingSteps.hidden));
      thinkingToggle.classList.toggle('is-open', !thinkingSteps.hidden);
    };
  }
  messages.scrollTop = messages.scrollHeight;
  const requestController = new AbortController();
  window.copilotRequestController = requestController;
  setCopilotResponding(true);

  try {
    const attachmentContext = await buildCopilotAttachmentContext(attachedFiles);
    const requestMessage = `${text || 'Hãy phân tích tệp đính kèm.'}${attachmentContext}`;
    const knowledgeSources = getCopilotKnowledgeValues();
    const data = await fetchCopilotStreamingChat({
      question: requestMessage,
      message: requestMessage,
      history: window.copilotPopupHistory.slice(-20),
      sessionId: window.copilotPopupSessionId,
      providerId,
      useTools: true,
      knowledgeSearchEnabled: !window.copilotWebSearchEnabled && !knowledgeSources.includes('none'),
      knowledgeSourceIds: !window.copilotWebSearchEnabled ? knowledgeSources.filter(value => !['auto', 'none'].includes(value)) : [],
      webSearch: window.copilotWebSearchEnabled,
      attachments: attachedFiles.map(file => ({ name: file.name, type: file.type, size: file.size }))
    }, event => {
      progressEvents.push(event);
      addCopilotThinkingStep(thinkingId, event.icon || 'circle-notch', event.label || 'Đang xử lý', event.status || 'running');
    }, requestController.signal);
    const reply = data.reply || data.replyText || data.message || 'Không tìm thấy thông tin tương ứng.';
    const sqlQuery = data.generatedSql || data.sql || null;
    const renderedReply = renderCopilotText(reply);
    const richHtml = [
      renderedReply,
      renderCopilotDownloadAction(data.downloadUrl, renderedReply),
      renderCopilotRetrievalContext(data.contextSelection),
      renderCopilotChart(data.chartSpec),
      renderCopilotTechnicalDetails(data.toolCalls || [], sqlQuery, data.toolResult, data.sqlExecutions || [], progressEvents, data.executionTime || '')
    ].filter(Boolean).join('');

    document.getElementById(thinkingId)?.remove();
    messages.insertAdjacentHTML('beforeend', `
      <div class="chat-bubble ai">${richHtml}${typeof renderChatFeedback === 'function' ? renderChatFeedback(data, data.tokenUsage) : ''}</div>
    `);

    window.copilotPopupHistory.push({ role: 'user', content: requestMessage });
    window.copilotPopupHistory.push({ role: 'assistant', content: reply });
    if (typeof fetchChatHistory === 'function') fetchChatHistory();
  } catch (err) {
    document.getElementById(thinkingId)?.remove();
    if (err?.name === 'AbortError') {
      if (typeof showToast === 'function') showToast('Đã dừng tiến trình trả lời.', 'info');
      return;
    }
    const noAnswer = /local model returned an empty response|stream kết thúc mà không có câu trả lời cuối/i.test(String(err?.message || ''));
    const errorContent = noAnswer
      ? '<strong>Chưa có câu trả lời phù hợp.</strong> Vui lòng thử lại.'
      : `<strong>Lỗi kết nối AI:</strong> ${escapeCopilotHtml(err?.message || 'Không thể kết nối tới mô hình AI.')}`;
    messages.insertAdjacentHTML('beforeend', `
      <div class="chat-bubble ai error">${errorContent}</div>
    `);
  } finally {
    if (window.copilotRequestController === requestController) {
      window.copilotRequestController = null;
      setCopilotResponding(false);
    }
  }

  messages.scrollTop = messages.scrollHeight;
};

function initCopilotSloganRotation() {
  const subtitle = document.getElementById('copilot-rotating-slogan');
  if (!subtitle || subtitle.dataset.rotationReady === 'true') return;

  const slogans = [
    'Text-to-SQL Playground',
    'Hỏi dữ liệu, nhận câu trả lời',
    'Biến câu hỏi thành insight',
    'Truy vấn nhanh bằng AI',
    'Dữ liệu thông minh, quyết định nhanh'
  ];
  let index = 0;
  let typingTimer = null;
  subtitle.dataset.rotationReady = 'true';

  const typeSlogan = slogan => {
    window.clearInterval(typingTimer);
    subtitle.textContent = '';
    subtitle.title = slogan;
    subtitle.classList.remove('is-changing');
    subtitle.classList.add('is-typing');
    let characterIndex = 0;
    typingTimer = window.setInterval(() => {
      characterIndex += 1;
      subtitle.textContent = slogan.slice(0, characterIndex);
      if (characterIndex >= slogan.length) {
        window.clearInterval(typingTimer);
        subtitle.classList.remove('is-typing');
      }
    }, 38);
  };

  window.setInterval(() => {
    if (document.hidden) return;
    subtitle.classList.add('is-changing');
    window.setTimeout(() => {
      index = (index + 1) % slogans.length;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        subtitle.textContent = slogans[index];
        subtitle.title = slogans[index];
        subtitle.classList.remove('is-changing');
        return;
      }
      typeSlogan(slogans[index]);
    }, 160);
  }, 3800);
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  initCopilotSloganRotation();
  initAccountMenu();
  initPwaInstall();
  await loadCurrentAccount();
  await loadViewComponents();
  initGlobalFeatureSearch();
  await switchMainTab(getRememberedMainTab());
  populateCopilotModelSelector();

  // Khởi chạy vòng lặp hiệu ứng 3D Orb cho tất cả canvas.chat-thinking-spinner
  requestAnimationFrame(runOrbAnimation);
});

window.addEventListener('popstate', () => {
  const pathTab = normalizeMainTabKey(window.location.pathname) || 'overview';
  if (pathTab !== window.activeMainTab) switchMainTab(pathTab);
});

// Shared 3D Dotted Orb Animation Loop for all canvas.chat-thinking-spinner
function runOrbAnimation() {
  const canvases = document.querySelectorAll('canvas.chat-thinking-spinner');
  const now = Date.now() * 0.001; // Thời gian thực tính bằng giây

  canvases.forEach(canvas => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Xóa frame cũ
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const radius = Math.min(cx, cy) - 2;

    // Sinh các hạt điểm trên mặt cầu (Fibonacci sphere algorithm)
    const numParticles = 40;
    const points = [];

    for (let i = 0; i < numParticles; i++) {
      const phi = Math.acos(1 - 2 * (i + 0.5) / numParticles);
      const theta = Math.PI * (1 + Math.sqrt(5)) * (i + 0.5);

      // Tạo hiệu ứng lồi lõm hữu cơ (organic morphing)
      const morph = 1 + 0.18 * Math.sin(phi * 2.5 + now * 3.5) * Math.cos(theta * 1.5 + now * 2.5);
      const r = radius * morph;

      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);

      // Xoay quanh trục Y
      const angleY = now * 1.2;
      const x1 = x * Math.cos(angleY) - z * Math.sin(angleY);
      const z1 = x * Math.sin(angleY) + z * Math.cos(angleY);

      // Xoay quanh trục X
      const angleX = now * 0.7;
      const y2 = y * Math.cos(angleX) - z1 * Math.sin(angleX);
      const z2 = y * Math.sin(angleX) + z1 * Math.cos(angleX);

      points.push({ x: x1, y: y2, z: z2 });
    }

    // Thuật toán Painter's algorithm: vẽ các điểm từ xa tới gần (sort theo z)
    points.sort((a, b) => a.z - b.z);

    points.forEach(p => {
      const depth = (p.z + radius * 1.2) / (radius * 2.4); // Chuẩn hóa z về đoạn [0, 1]
      const px = cx + p.x;
      const py = cy + p.y;

      // Chuyển đổi màu mượt mà từ tím sang xanh dương/indigo
      const rColor = Math.floor(139 + (99 - 139) * depth);
      const gColor = Math.floor(92 + (102 - 92) * depth);
      const bColor = Math.floor(246 + (241 - 246) * depth);
      const alpha = 0.25 + 0.75 * depth;

      ctx.beginPath();
      ctx.arc(px, py, 0.7 + 1.3 * depth, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rColor}, ${gColor}, ${bColor}, ${alpha})`;
      ctx.fill();
    });
  });

  requestAnimationFrame(runOrbAnimation);
}
