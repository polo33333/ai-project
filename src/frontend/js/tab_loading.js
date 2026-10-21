/* Shared loading state for tab data, including manual refreshes. */
(function () {
  window.tabSkeletonMarkup = function (kind = 'list') {
    if (kind === 'chart') return '<span class="tab-loading-label">Đang tải biểu đồ…</span><div class="tab-skeleton-chart" aria-hidden="true">' +
      [35,58,42,76,52,90,65,82].map(height => '<span class="tab-skeleton-line" style="height:' + height + '%"></span>').join('') + '</div>';
    const row = '<span class="tab-skeleton-line"></span><span class="tab-skeleton-line"></span><span class="tab-skeleton-line"></span>';
    return '<span class="tab-loading-label">Đang tải dữ liệu…</span><div class="tab-skeleton tab-skeleton-' + kind + '" aria-hidden="true">' +
      Array.from({ length: kind === 'cards' ? 6 : 5 }, () => '<div class="tab-skeleton-row">' + row + '</div>').join('') + '</div>';
  };
  window.workflowSkeletonCardMarkup = () => "<div class=\"wp-skeleton-heading\"><span class=\"wp-skeleton-icon\"></span><div><span class=\"wp-skeleton-line short\"></span><span class=\"wp-skeleton-line title\"></span></div></div><div class=\"wp-skeleton-copy\"><span class=\"wp-skeleton-line\"></span><span class=\"wp-skeleton-line\"></span><span class=\"wp-skeleton-line medium\"></span></div><div class=\"wp-skeleton-chips\"><span></span><span></span></div><div class=\"wp-skeleton-footer\"><span></span><span></span><span></span></div>";
  window.tabViewSkeletonMarkup = function (key) {
    // HTML has not arrived yet: do not invent a card layout for an unknown view.
    if (key !== 'workflows') return '<span class="tab-loading-label">Đang tải giao diện…</span><span class="tab-view-progress" aria-hidden="true"></span>';
    return '<span class="tab-loading-label">Đang tải mẫu nghiệp vụ…</span><section class="system-tools-card workflow-view-skeleton" aria-hidden="true"><div class="module-section-heading"><div><span class="module-section-kicker">KỊCH BẢN HỘI THOẠI</span><h3>Mẫu nghiệp vụ</h3><p>Khi câu hỏi khớp một mẫu đang sử dụng, trợ lý hỏi thêm thông tin cần thiết và thực hiện theo kịch bản đã thiết lập.</p></div></div><div class="wp-section-heading"><div><h3>Thiết kế nghiệp vụ</h3><p>Soạn kịch bản và chạy thử trước khi đưa vào hội thoại.</p></div></div><div class="workflow-skeleton-toolbar"><span class="tab-skeleton-line"></span><span class="tab-skeleton-line"></span></div><div class="workflow-skeleton-grid">' + Array.from({ length:3 }, () => '<div class="wp-skeleton-card">' + window.workflowSkeletonCardMarkup() + '</div>').join('') + '</div></section>';
  };
  const busyPanels = new WeakMap();
  const targets = {
    refreshDashboardMetrics: '.metrics-grid > .metric-card',
    fetchDashboardLogs: '#view-dashboard-logs',
    fetchSettings: '#settings-form',
    loadGovernanceResources: '#view-data-governance > .settings-governance-card',
    loadAiMemory: '#view-memory',
    fetchSystemTools: '#system-tools-grid',
    initPageAnalyticsCharts: '#view-analytics',
    fetchAiProviders: '#page-ai-providers-tbody',
    fetchDataDictionary: '#dictionary-tables-accordion',
    fetchGlossaryData: '#glossary-tbody',
    fetchDbSources: '#db-sources-tbody',
    fetchLogs: '#system-logs-tbody',
    fetchChatHistory: '#chat-history-tbody',
    fetchChatFeedback: '#chat-feedback-tbody',
    fetchMcpServers: '#mcp-servers-tbody',
    fetchApiKeys: '#api-keys-tbody',
    fetchEmbedConfigs: '#embed-config-list',
    fetchLibraryDocuments: '#library-docs-grid',
    fetchWatchFolderData: '#watchfolder-tbody, #watchfolder-logs-tbody'
  };
  for (const [name, selector] of Object.entries(targets)) {
    const loader = window[name];
    if (typeof loader !== 'function') continue;
    // Serialize distinct parameter sets so an older response cannot overwrite a refresh.
    const requests = [];
    let tail = Promise.resolve();
    window[name] = function (...args) {
      const existing = requests[requests.length - 1];
      if (existing && existing.args.length === args.length &&
          existing.args.every((value, index) => Object.is(value, args[index]))) return existing.promise;
      const panels = [...new Set([...document.querySelectorAll(selector)].map(node =>
        node.closest('.data-table-container') || node))];
      const blocks = panels.flatMap(panel => {
        if (!panel.classList.contains?.('system-tools-page')) return [panel];
        const children = [...(panel.querySelectorAll?.(':scope > section, :scope > .system-tools-card, :scope > .content-card') || [])]
          .filter(node => !node.classList.contains('system-tools-hero'));
        return children.length ? children : [panel];
      });
      const releases = [...new Set(blocks)].map(beginLoading);
      const request = { args };
      request.promise = tail.then(() => loader.apply(this, args)).finally(() => {
        releases.forEach(release => release());
        requests.splice(requests.indexOf(request), 1);
      });
      tail = request.promise.catch(() => {});
      requests.push(request);
      return request.promise;
    };
  }

  // Multiple loaders may share a panel (API keys + embeds). Keep it busy until all finish.
  window.beginTabPanelLoading = beginLoading;
  function beginLoading(panel) {
    let state = busyPanels.get(panel);
    if (!state) {
      const overlay = document.createElement('div');
      overlay.className = 'tab-data-loading';
      overlay.setAttribute('role', 'status');
      const kind = panel.querySelector?.('table') ? 'table' : panel.classList.contains?.('system-tools-page') || panel.id === 'library-docs-grid' ? 'cards' : 'list';
      const bounds = panel.getBoundingClientRect?.();
      const nodes = panel.querySelectorAll?.('h2,h3,h4,p,legend,small,label,input,select,textarea,button,th,td,.card-title,.metric-val,.metric-title,.metric-sub,.metric-main-icon,.system-tool-icon') || [];
      const shapes = bounds ? [...nodes].slice(0, 100).flatMap(node => {
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom <= bounds.top || rect.top >= bounds.bottom) return [];
        const control = ['INPUT','SELECT','TEXTAREA','BUTTON'].includes(node.tagName);
        const left = Math.max(0, rect.left - bounds.left + (panel.scrollLeft || 0));
        const top = Math.max(0, rect.top - bounds.top + (panel.scrollTop || 0));
        const width = Math.max(0, Math.min(rect.width, bounds.width - left));
        const icon = node.classList.contains('metric-main-icon') || node.classList.contains('system-tool-icon');
        const textHeight = node.classList.contains('metric-val') ? 26 : 14;
        const height = Math.min(control || icon ? rect.height : textHeight, bounds.height - top);
        return width > 0 && height > 0 ? ['<span class="tab-skeleton-line tab-skeleton-block" style="left:' + left + 'px;top:' + top + 'px;width:' + width + 'px;height:' + height + 'px"></span>'] : [];
      }) : [];
      overlay.innerHTML = shapes.length ? '<span class="tab-loading-label">Đang tải dữ liệu…</span><div class="tab-skeleton tab-skeleton-measured" aria-hidden="true">' + shapes.join('') + '</div>' : window.tabSkeletonMarkup(kind);
      panel.classList.add('tab-data-loading-host');
      panel.setAttribute('aria-busy', 'true');
      panel.appendChild(overlay);
      state = { count: 0, overlay };
      busyPanels.set(panel, state);
    }
    state.count++;
    return () => {
      if (--state.count) return;
      state.overlay.remove();
      panel.classList.remove('tab-data-loading-host');
      panel.removeAttribute('aria-busy');
      busyPanels.delete(panel);
    };
  }
})();
