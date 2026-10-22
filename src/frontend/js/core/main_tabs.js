const MAIN_TAB_STORAGE_KEY = 'knowledgehub.activeMainTab';
const MAIN_TAB_ALIASES = Object.freeze({
  dashboard: 'overview',
  sql_connector: 'sql',
  sql_connectors: 'sql',
  providers: 'ai-providers',
  mcp: 'mcp-sources'
});
const MAIN_TAB_KEYS = new Set([
  'accounts',
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
  'data-governance',
  'memory',
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
let mainTabNavigationVersion = 0;
window.switchMainTab = async function switchMainTab(tabKey) {
  tabKey = normalizeMainTabKey(tabKey);
  if (!tabKey) return;
  if (window.canAccessMainTab && !window.canAccessMainTab(tabKey)) {
    const fallback=[...MAIN_TAB_KEYS].find(key=>window.canAccessMainTab(key));
    if(fallback) tabKey=fallback;
    else { document.querySelectorAll('#main-view-container > div, #main-view-container > section').forEach(node=>node.style.display='none');
      const root=document.getElementById('main-view-container');if(root&&!root.querySelector('.accounts-no-access')){const note=document.createElement('p');note.className='accounts-no-access';note.textContent='Tài khoản chưa được cấp quyền sử dụng chức năng. Vui lòng liên hệ quản trị viên.';root.append(note);}return; }
  }
  const navigationVersion = ++mainTabNavigationVersion;
  rememberMainTab(tabKey);
  try {
    document.querySelectorAll(".tab-load-error").forEach(node => node.remove());
    window.updatePageChatMiniPanel?.();
    const cleanKey = tabKey.replace(/-/g, '_');
    const isDashboard = cleanKey === 'overview' || cleanKey === 'dashboard';
    const mainContent = document.querySelector('main.main-content');
    mainContent?.classList.toggle('chat-workspace-page', cleanKey === 'page_chat');
    mainContent?.classList.toggle('training-workspace', cleanKey === 'training_core');
    mainContent?.classList.toggle('dictionary-workspace', cleanKey === 'dictionary');
    mainContent?.classList.toggle('settings-workspace', ['settings', 'data_governance', 'memory'].includes(cleanKey));

    const dashboardContainer = document.getElementById('dashboard-view-container');
    if (dashboardContainer) dashboardContainer.hidden = !isDashboard;
    if (isDashboard) {
      await loadViewComponents('overview');
      if (navigationVersion !== mainTabNavigationVersion) return;
    }

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

    const pageHeading = document.getElementById('page-heading');
    const dashboardHeadingIcon = document.getElementById('dashboard-heading-icon');
    const dashboardHeadingSubtitle = document.getElementById('dashboard-heading-subtitle');
    if (dashboardHeadingIcon) dashboardHeadingIcon.hidden = false;
    const titles = {
      accounts: 'Quản lý tài khoản',
      settings: 'Cài đặt hệ thống',
      data_governance: 'Quản trị dữ liệu',
      memory: 'Bộ nhớ Agent',
      overview: 'Tổng quan hệ thống',
      dashboard: 'Tổng quan hệ thống',
      page_chat: 'Trò chuyện',
      dictionary: 'Lược đồ CSDL',
      glossary: 'Thuật ngữ nghiệp vụ',
      sql: 'Kết nối CSDL',
      sql_connector: 'Kết nối CSDL',
      providers: 'Nhà cung cấp AI',
      ai_providers: 'Nhà cung cấp AI & Multi-LLM Router',
      analytics: 'Báo cáo & Thống kê Metrics',
      workflows: 'Mẫu nghiệp vụ',
      mcp: 'Nguồn MCP Server',
      mcp_sources: 'Nguồn MCP Server',
      system_tools: 'Công cụ hệ thống',
      watchfolder: 'Thư mục giám sát',
      system_logs: 'Nhật ký hệ thống',
      chat_history: 'Lịch sử Trò chuyện',
      chat_feedback: 'Đánh giá chất lượng AI',
      training_core: 'Training Core',
      api_docs: 'API tích hợp',
      library: 'Thư viện tri thức'
    };
    const pageMeta = {
      accounts: { icon: 'fa-users-gear', subtitle: 'Tài khoản đăng nhập và phân quyền sử dụng ứng dụng' },
      settings: { icon: 'fa-gear', subtitle: 'Quản lý cấu hình và tùy chọn vận hành hệ thống' },
      data_governance: { icon: 'fa-shield-halved', subtitle: 'Quyền truy cập, xử lý dữ liệu và chỉ tiêu SQL' },
      memory: { icon: 'fa-brain', subtitle: 'Bộ nhớ cá nhân, hướng dẫn tổ chức và lịch sử tác vụ' },
      page_chat: { icon: 'fa-comments', subtitle: 'Trao đổi, phân tích dữ liệu và làm việc cùng trợ lý AI' },
      dictionary: { icon: 'fa-table-columns', subtitle: 'Khám phá cấu trúc bảng, cột và quan hệ trong cơ sở dữ liệu' },
      glossary: { icon: 'fa-book-open', subtitle: 'Quản lý thuật ngữ và ngữ cảnh nghiệp vụ dùng chung' },
      sql: { icon: 'fa-plug', subtitle: 'Quản lý các kết nối cơ sở dữ liệu an toàn' },
      sql_connector: { icon: 'fa-plug', subtitle: 'Quản lý các kết nối cơ sở dữ liệu an toàn' },
      sql_connectors: { icon: 'fa-plug', subtitle: 'Quản lý các kết nối cơ sở dữ liệu an toàn' },
      providers: { icon: 'fa-microchip', subtitle: 'Cấu hình mô hình và nhà cung cấp trí tuệ nhân tạo' },
      ai_providers: { icon: 'fa-microchip', subtitle: 'Cấu hình mô hình, định tuyến và nhà cung cấp AI' },
      analytics: { icon: 'fa-chart-line', subtitle: 'Theo dõi mức sử dụng, chi phí và hiệu suất hệ thống' },
      workflows: { icon: 'fa-diagram-project', subtitle: 'Thiết lập kịch bản để trợ lý xử lý câu hỏi nghiệp vụ' },
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
      accounts: 'view-accounts',
      settings: 'view-settings',
      data_governance: 'view-data-governance',
      memory: 'view-memory',
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
      if (!document.getElementById('view-dashboard-logs')) await loadViewComponents('overview');
      if (navigationVersion !== mainTabNavigationVersion) return;
      const dashLogs = document.getElementById('view-dashboard-logs');
      if (dashLogs) dashLogs.style.display = 'block';
      await loadTabData(tabKey, [window.refreshDashboardMetrics, window.fetchDashboardLogs, window.refreshArchitectureSuggestion]);
      return;
    }

    const targetId = viewMap[cleanKey] || `view-${cleanKey.replace(/_/g, '-')}`;
    let targetView = document.getElementById(targetId);
    if (!targetView && typeof loadViewComponents === 'function') {
      const loading=document.createElement('div'); loading.className='tab-view-loading'; loading.setAttribute('role','status');
      loading.dataset.tab=cleanKey;
      loading.innerHTML=window.tabViewSkeletonMarkup(cleanKey);
      document.getElementById('main-view-container')?.appendChild(loading);
      try { await loadViewComponents(cleanKey); } finally { loading.remove(); }
      targetView = document.getElementById(targetId);
    }
    if (navigationVersion !== mainTabNavigationVersion) return;

    if (targetView) {
      targetView.style.display = targetView.dataset.display || 'block';
    } else {
      throw new Error(`Không tìm thấy view: ${targetId}`);
    }

    const tabLoaders = {
      accounts: [window.loadAccounts],
      settings: [window.fetchSettings],
      data_governance: [window.loadGovernanceResources],
      memory: [window.loadAiMemory],
      ai_providers: [window.fetchAiProviders],
      dictionary: [window.fetchDataDictionary],
      glossary: [window.fetchGlossaryData],
      sql: [window.fetchDbSources], sql_connector: [window.fetchDbSources],
      system_logs: [window.fetchLogs],
      chat_history: [window.fetchChatHistory],
      chat_feedback: [window.fetchChatFeedback],
      mcp_sources: [window.fetchMcpServers],
      training_core: [window.fetchTrainingReport],
      system_tools: [window.fetchSystemTools],
      api_docs: [window.fetchApiKeys, window.fetchEmbedConfigs],
      library: [window.fetchLibraryDocuments],
      watchfolder: [window.fetchWatchFolderData],
      workflows: [window.initWorkflowsView],
      analytics: [window.initPageAnalyticsCharts],
      page_chat: [window.populateChatModelSelector, window.populateChatKnowledgeSources, window.fetchAndRenderQuickPrompts]
    };
    if (typeof renderChatSessionsList === 'function' && cleanKey === 'page_chat') renderChatSessionsList();
    if (typeof renderCurrentChatMessages === 'function' && cleanKey === 'page_chat') renderCurrentChatMessages();
    if (cleanKey === 'dictionary') window.refreshDictionarySyncStatus?.();
    await loadTabData(tabKey, tabLoaders[cleanKey] || []);
  } catch (error) {
    console.error('Không thể tải tab ' + tabKey, error);
    if (navigationVersion !== mainTabNavigationVersion) return;
    const panel = document.createElement('div');
    panel.className = 'tab-load-error';
    panel.setAttribute('role', 'alert');
    const message = document.createElement('p');
    message.textContent = 'Không thể tải nội dung. Vui lòng thử lại.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn-secondary';
    retry.textContent = 'Thử lại';
    retry.onclick = () => { window.invalidateMainTabData(tabKey); window.switchMainTab(tabKey); };
    panel.append(message, retry);
    document.getElementById('main-view-container')?.appendChild(panel);
  }
};


