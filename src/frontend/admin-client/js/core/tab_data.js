const TAB_DATA_CACHE_TTL_MS = 60_000;
const tabDataLoadState = new Map();

function loadTabData(tabKey, loaders = []) {
  tabKey = normalizeMainTabKey(tabKey) || tabKey;
  const callable = loaders.filter(loader => typeof loader === 'function');
  if (!callable.length) return Promise.resolve();
  let states = tabDataLoadState.get(tabKey);
  if (!states) { states = new Map(); tabDataLoadState.set(tabKey, states); }
  return Promise.all(callable.map(loader => {
    const current = states.get(loader) || {};
    if (current.promise) return current.promise;
    if (current.loadedAt && Date.now() - current.loadedAt < TAB_DATA_CACHE_TTL_MS) return Promise.resolve();
    const promise = Promise.resolve().then(loader)
      .then(result => {
        if (result === false) throw new Error('Không thể tải dữ liệu.');
        states.set(loader, { loadedAt: Date.now(), promise: null });
      })
      .catch(error => { states.delete(loader); throw error; });
    states.set(loader, { ...current, promise });
    return promise;
  }));
}

window.invalidateMainTabData = function invalidateMainTabData(tabKey) {
  if (tabKey) tabDataLoadState.delete(normalizeMainTabKey(tabKey) || tabKey);
  else tabDataLoadState.clear();
};


// Invalidate dependent screens after a successful write; refresh when next visited.
const TAB_DATA_DEPENDENCIES = Object.freeze({
  sql: ['sql', 'dictionary', 'data-governance', 'page-chat', 'overview', 'workflows'],
  providers: ['ai-providers', 'data-governance', 'page-chat', 'overview'],
  schema: ['dictionary', 'glossary', 'data-governance', 'page-chat', 'overview', 'workflows'],
  knowledge: ['library', 'watchfolder', 'data-governance', 'page-chat', 'overview']
});
window.invalidateRelatedTabData = function (domain) {
  window.dashboardAnalyticsLoadedAt = 0;
  for (const key of TAB_DATA_DEPENDENCIES[domain] || [domain]) window.invalidateMainTabData(key);
};
