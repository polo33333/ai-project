// Load Modular HTML Component Templates into #main-view-container
const viewLoadPromises = new Map();
async function loadViewComponents(tabKey) {
  const container = document.getElementById('main-view-container');
  if (!container) return;
  const viewFiles = {
    accounts: 'accounts.html',
    overview: 'dashboard_logs.html', page_chat: 'page_chat.html', dictionary: 'dictionary.html',
    sql: 'sql_connector.html', sql_connector: 'sql_connector.html', ai_providers: 'ai_providers.html',
    library: 'library.html', watchfolder: 'watchfolder.html', glossary: 'glossary.html', analytics: 'analytics.html',
    workflows: 'workflows.html', system_logs: 'system_logs.html', chat_history: 'chat_history.html',
    chat_feedback: 'chat_feedback.html', training_core: 'training_core.html', mcp_sources: 'mcp_sources.html',
    system_tools: 'system_tools.html', settings: 'settings.html', data_governance: 'data_governance.html', memory: 'memory.html', api_docs: 'api_docs.html'
  };
  if (String(tabKey) === 'overview') {
    await loadDashboardView();
  }
  const file = viewFiles[String(tabKey || '').replace(/-/g, '_')];
  if (!file || container.querySelector(`[data-view-file="${file}"]`)) return;
  if (viewLoadPromises.has(file)) return viewLoadPromises.get(file);
  const pending = (async () => { try {
    const response = await fetch(`/views/${file}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const template = document.createElement('template');
    template.innerHTML = await response.text();
    const firstView = template.content.firstElementChild;
    if (firstView) firstView.dataset.viewFile = file;
    container.appendChild(template.content);
  } catch (err) {
    console.error(`Lỗi khi tải view ${file}:`, err);
    throw err;
  } finally { viewLoadPromises.delete(file); }
  })();
  viewLoadPromises.set(file, pending);
  return pending;
}


async function loadDashboardView() {
  const container = document.getElementById('dashboard-view-container');
  if (!container || container.dataset.loaded) return;
  const key = 'dashboard.html';
  if (viewLoadPromises.has(key)) return viewLoadPromises.get(key);
  const pending = (async () => {
    const response = await fetch('/views/dashboard.html');
    if (!response.ok) throw new Error('HTTP ' + response.status);
    container.innerHTML = await response.text();
    container.dataset.loaded = 'true';
  })().finally(() => viewLoadPromises.delete(key));
  viewLoadPromises.set(key, pending);
  return pending;
}
