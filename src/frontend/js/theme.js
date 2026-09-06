(() => {
  const key = 'knowledgehub.theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try { preference = localStorage.getItem(key); } catch { /* Follow device appearance. */ }
  function updateCharts(dark) {
    if (!window.Chart) return;
    const text = dark ? '#a9b6ca' : '#64748b', grid = dark ? '#29354a' : '#e2e8f0';
    Chart.defaults.color = text;
    Chart.defaults.borderColor = grid;
    Object.values(Chart.instances || {}).forEach(chart => {
      Object.values(chart.options.scales || {}).forEach(scale => {
        if (scale.ticks) scale.ticks.color = text;
        if (scale.grid) scale.grid.color = grid;
        if (scale.border) scale.border.color = grid;
      });
      if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = text;
      chart.update('none');
    });
  }
  function apply() {
    const dark = preference === 'dark' || (preference !== 'light' && system.matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.setAttribute('aria-label', dark ? 'Tắt giao diện tối' : 'Bật giao diện tối');
      button.title = button.getAttribute('aria-label');
      button.setAttribute('aria-pressed', String(dark));
      const label = button.querySelector('[data-theme-label]');
      if (label) label.textContent = 'Giao diện tối';
    });
    updateCharts(dark);
  }
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    if (window.Chart) Chart.register({
      id: 'knowledgehub-theme',
      beforeUpdate(chart) {
        if (document.documentElement.dataset.theme !== 'dark') return;
        Object.values(chart.options.scales || {}).forEach(scale => {
          if (scale.ticks) scale.ticks.color = '#a9b6ca';
          if (scale.grid) scale.grid.color = '#29354a';
        });
        if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = '#a9b6ca';
      }
    });
    apply();
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('[data-theme-toggle]')) return;
    preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(key, preference); } catch { /* Keep selection for this page. */ }
    apply();
  });
  system.addEventListener('change', () => { if (!['dark', 'light'].includes(preference)) apply(); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = event.newValue; apply(); }
  });
})();
