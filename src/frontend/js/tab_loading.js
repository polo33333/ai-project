/* Shared loading state for tab data, including manual refreshes. */
(function () {
  const targets = {
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
    let pending;
    window[name] = function (...args) {
      if (pending) return pending;
      const panels = [...document.querySelectorAll(selector)].map(node =>
        node.closest('.data-table-container') || node);
      const overlays = [...new Set(panels)].map(panel => {
        const overlay = document.createElement('div');
        overlay.className = 'tab-data-loading';
        overlay.setAttribute('role', 'status');
        overlay.innerHTML = '<span class="tab-data-spinner" aria-hidden="true"></span><span>Đang tải dữ liệu…</span>';
        panel.classList.add('tab-data-loading-host');
        panel.setAttribute('aria-busy', 'true');
        panel.appendChild(overlay);
        return { panel, overlay };
      });
      pending = Promise.resolve().then(() => loader.apply(this, args)).finally(() => {
        overlays.forEach(({ panel, overlay }) => {
          overlay.remove();
          panel.classList.remove('tab-data-loading-host');
          panel.removeAttribute('aria-busy');
        });
        pending = null;
      });
      return pending;
    };
  }
})();
