'use strict';

// Summary figures count up to each new value that a module writes into them.
// Modules keep writing plain text; this watches the stat containers and animates the
// number in place, keeping its formatting ("7.269.258", "$24.92", "43,6 Tr", "8395ms").
(() => {
  const CONTAINERS = [
    '.metrics-grid .metric-val',
    '.log-stat-card > div > div',
    '.workspace-stat-value',
    '.analytics-kpi-card strong',
    '.dictionary-overview-strip strong',
    '.ai-usage-stat strong',
    '.dashboard-activity-stat strong',
    '.operations-summary dd'
  ].join(',');
  const DURATION = 800;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const lastValue = new WeakMap(); // parent element -> last number shown
  const running = new WeakMap(); // text node -> { frame, written }

  // Whole text must be a number with at most a short prefix ("$") and a short unit suffix,
  // so hints such as "50% lượt có độ trễ…" are left alone.
  function parse(text) {
    const match = text.trim().match(/^([^\d\s-]{0,2})(-?\d[\d.,]*)(\D{0,8})$/);
    if (!match) return null;
    const [, prefix, raw, suffix] = match;
    let group = '', decimal = '.';
    const hasDot = raw.includes('.'), hasComma = raw.includes(',');
    if (hasDot && hasComma) {
      [group, decimal] = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? ['.', ','] : [',', '.'];
    } else if (hasDot || hasComma) {
      const mark = hasDot ? '.' : ',';
      const groupsOfThree = raw.split(mark).slice(1).every(part => part.length === 3);
      if (groupsOfThree) group = mark;
      else decimal = mark;
    }
    const normalized = raw.split(group || '\u0000').join('').replace(decimal, '.');
    const value = Number(normalized);
    if (!Number.isFinite(value)) return null;
    const decimals = normalized.includes('.') ? normalized.split('.')[1].length : 0;
    return { prefix, suffix, value, decimals, group, decimal };
  }

  function format(shape, value) {
    const [whole, fraction] = Math.abs(value).toFixed(shape.decimals).split('.');
    const grouped = shape.group ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, shape.group) : whole;
    const sign = value < 0 ? '-' : '';
    return `${shape.prefix}${sign}${grouped}${fraction ? shape.decimal + fraction : ''}${shape.suffix}`;
  }

  function animate(node, from, target) {
    const parsed = parse(node.data);
    const previous = running.get(node);
    if (previous) { cancelAnimationFrame(previous.frame); clearTimeout(previous.settle); }
    const start = performance.now();
    const state = { frame: 0, settle: 0, written: node.data };
    running.set(node, state);
    const finish = () => {
      cancelAnimationFrame(state.frame);
      clearTimeout(state.settle);
      if (node.isConnected && node.data === state.written) node.data = state.written = format(parsed, target);
      running.delete(node);
    };
    const step = now => {
      // A module replaced or rewrote the text meanwhile: its value wins.
      if (!node.isConnected || node.data !== state.written) { finish(); return; }
      // A frame's timestamp can precede `start`; clamp so the first frame never dips below `from`.
      const progress = Math.min(1, Math.max(0, (now - start) / DURATION));
      if (progress >= 1) { finish(); return; }
      const eased = 1 - Math.pow(1 - progress, 3);
      node.data = state.written = format(parsed, from + (target - from) * eased);
      state.frame = requestAnimationFrame(step);
    };
    node.data = state.written = format(parsed, from);
    state.frame = requestAnimationFrame(step);
    // Frames pause in background tabs; never leave a figure stuck part-way.
    state.settle = setTimeout(finish, DURATION + 100);
  }

  function visit(container) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (running.get(node)?.written === node.data) continue;
      const parsed = parse(node.data);
      const owner = node.parentElement;
      if (!parsed || !owner) continue;
      const from = lastValue.has(owner) ? lastValue.get(owner) : 0;
      lastValue.set(owner, parsed.value);
      if (from === parsed.value || reducedMotion.matches || document.hidden || !owner.offsetParent) continue;
      animate(node, from, parsed.value);
    }
  }

  function scan(root) {
    if (!(root instanceof Element)) root = root?.parentElement;
    if (!root) return;
    const container = root.closest(CONTAINERS);
    if (container) visit(container);
    root.querySelectorAll(CONTAINERS).forEach(visit);
  }

  function start() {
    const main = document.getElementById('main-content');
    if (!main) return;
    scan(main);
    new MutationObserver(records => {
      const roots = new Set(records.map(record => record.target));
      roots.forEach(scan);
    }).observe(main, { childList: true, characterData: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
