(() => {
  const key = 'knowledgehub.theme';
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference;
  let themeTransition;
  let transitionTimer;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const transitionStyles = document.createElement('style');
  transitionStyles.textContent = `
    @keyframes kh-theme-fade-out { to { opacity:0; } }
    @keyframes kh-theme-fade-in { from { opacity:0; } }
    html.kh-theme-crossfade::view-transition-old(root) { animation:kh-theme-fade-out .65s ease both; }
    html.kh-theme-crossfade::view-transition-new(root) { animation:kh-theme-fade-in .65s ease both; }
    html.kh-theme-crossfade::view-transition-old(root),
    html.kh-theme-crossfade::view-transition-new(root) { mix-blend-mode:normal; }
    html.kh-theme-crossfade::view-transition { pointer-events:none; }
    html.kh-theme-colors, html.kh-theme-colors *, html.kh-theme-colors *::before, html.kh-theme-colors *::after {
      transition:background-color .65s ease,color .65s ease,border-color .65s ease,box-shadow .65s ease,fill .65s ease,stroke .65s ease !important;
    }
    @media(prefers-reduced-motion:reduce) {
      html.kh-theme-crossfade::view-transition-old(root),html.kh-theme-crossfade::view-transition-new(root) { animation:none; }
      html.kh-theme-colors,html.kh-theme-colors *,html.kh-theme-colors *::before,html.kh-theme-colors *::after { transition:none !important; }
    }
  `;
  document.head.appendChild(transitionStyles);
  try { preference = localStorage.getItem(key); } catch { /* Follow device appearance. */ }
  function updateCharts(dark) {
    if (!window.Chart) return;
    const text = dark ? '#b8c4d8' : '#64748b', grid = dark ? '#344158' : '#e2e8f0';
    const tooltipBg = dark ? '#202c40' : '#0f172a', tooltipBorder = dark ? '#465773' : '#334155';
    Chart.defaults.color = text;
    Chart.defaults.borderColor = grid;
    Object.values(Chart.instances || {}).forEach(chart => {
      Object.values(chart.options.scales || {}).forEach(scale => {
        if (scale.ticks) scale.ticks.color = text;
        if (scale.grid) scale.grid.color = grid;
        if (scale.border) scale.border.color = grid;
      });
      if (chart.options.plugins?.legend?.labels) chart.options.plugins.legend.labels.color = text;
      if (chart.options.plugins?.title) chart.options.plugins.title.color = text;
      if (chart.options.plugins?.tooltip) {
        Object.assign(chart.options.plugins.tooltip, {
          titleColor: '#f8fafc', bodyColor: '#e2e8f0', backgroundColor: tooltipBg,
          borderColor: tooltipBorder, borderWidth: 1
        });
      }
      chart.update('none');
    });
  }
  function apply(animate = false) {
    const dark = preference === 'dark' || (preference !== 'light' && system.matches);
    const root = document.documentElement;
    const nextTheme = dark ? 'dark' : 'light';
    if (animate && root.dataset.theme !== nextTheme && !reducedMotion.matches) {
      if (document.startViewTransition) {
        if (themeTransition) themeTransition.skipTransition();
        root.classList.add('kh-theme-crossfade');
        const current = document.startViewTransition(() => apply());
        themeTransition = current;
        current.finished.catch(() => {}).finally(() => {
          if (themeTransition !== current) return;
          root.classList.remove('kh-theme-crossfade');
          themeTransition = null;
        });
        return;
      }
      root.classList.add('kh-theme-colors');
      // Establish the old computed colors before applying the new palette.
      void root.offsetWidth;
      clearTimeout(transitionTimer);
      transitionTimer = setTimeout(() => root.classList.remove('kh-theme-colors'), 700);
    }
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === (['light', 'dark'].includes(preference) ? preference : 'auto')));
    });
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
        if (chart.options.plugins?.title) chart.options.plugins.title.color = '#b8c4d8';
      }
    });
    apply();
  });
  document.addEventListener('click', event => {
    const choice = event.target.closest('[data-theme-choice]');
    if (choice && ['light', 'dark', 'auto'].includes(choice.dataset.themeChoice)) {
      preference = choice.dataset.themeChoice;
      try { localStorage.setItem(key, preference); } catch { /* Keep in-memory selection. */ }
      apply(true);
      return;
    }
    if (!event.target.closest('[data-theme-toggle]')) return;
    preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(key, preference); } catch { /* Keep selection for this page. */ }
    apply(true);
  });
  system.addEventListener('change', () => { if (!['dark', 'light'].includes(preference)) apply(true); });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) { preference = event.newValue; apply(true); }
  });
})();
