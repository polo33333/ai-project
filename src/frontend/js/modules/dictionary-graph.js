'use strict';

window.dictionaryView = 'list';
window.dictionaryGraphZoom = 1;
window.dictionaryGraphSelection = null;
window.dictionaryGraphAnimationFrame = null;

const DICTIONARY_GRAPH_COLORS = [
  { border: '#a5b4fc', fill: '#eef2ff', accent: '#4f46e5' }, { border: '#93c5fd', fill: '#eff6ff', accent: '#2563eb' },
  { border: '#86efac', fill: '#f0fdf4', accent: '#059669' }, { border: '#fcd34d', fill: '#fffbeb', accent: '#d97706' },
  { border: '#f9a8d4', fill: '#fdf2f8', accent: '#db2777' }, { border: '#c4b5fd', fill: '#f5f3ff', accent: '#7c3aed' }
];

function dictionaryDomainLabel(key) {
  if (!key) return 'Chưa phân loại';
  return String(key).replace(/[_-]+/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function getDictionaryGraphTables() {
  const keyword = document.getElementById('dict-search-input')?.value.trim().toLowerCase() || '';
  return getDictionaryTables().filter(table => table.isActive && (!keyword
    || dictionaryDomainLabel(table.domain).toLowerCase().includes(keyword)
    || String(table.tableName || '').toLowerCase().includes(keyword)
    || String(table.tableDescription || '').toLowerCase().includes(keyword)
    || (table.columns || []).some(column => String(column.columnName || '').toLowerCase().includes(keyword))));
}

function setDictionaryView(view) {
  window.dictionaryView = view === 'list' ? 'list' : 'graph';
  document.querySelector('#view-dictionary .dictionary-content-card')?.classList.toggle('is-graph-view', window.dictionaryView === 'graph');
  document.getElementById('dictionary-graph-panel')?.toggleAttribute('hidden', window.dictionaryView !== 'graph');
  document.getElementById('dictionary-list-panel')?.toggleAttribute('hidden', window.dictionaryView !== 'list');
  document.getElementById('btn-dict-view-graph')?.classList.toggle('active', window.dictionaryView === 'graph');
  document.getElementById('btn-dict-view-list')?.classList.toggle('active', window.dictionaryView === 'list');
  document.getElementById('dictionary-status-filters')?.toggleAttribute('hidden', window.dictionaryView === 'graph');
  document.getElementById('dict-tables-counter')?.toggleAttribute('hidden', window.dictionaryView === 'graph');
  if (window.dictionaryView === 'graph') renderDictionaryGraph(); else renderDataDictionary();
}

function selectDictionaryGraphTable(encodedTableName) {
  const tableName = decodeURIComponent(encodedTableName);
  window.dictionaryGraphSelection = tableName;
  renderDictionaryGraph();
  openDictionaryDrawer(encodeURIComponent(tableName));
}

function buildDictionaryAliasAssignments(tables) {
  const assignments = new Map(tables.map(table => [table.tableName, []]));
  const byDomain = new Map();
  tables.filter(table => table.domain).forEach(table => {
    if (!byDomain.has(table.domain)) byDomain.set(table.domain, []);
    byDomain.get(table.domain).push(table);
  });
  byDomain.forEach((domainTables, domain) => {
    (window.businessDomainsData?.[domain] || []).forEach((alias, index) => assignments.get(domainTables[index % domainTables.length].tableName).push(alias));
  });
  return assignments;
}

function renderDictionaryGraph() {
  const graph = document.getElementById('dictionary-domain-graph');
  const nodesRoot = document.getElementById('dictionary-domain-groups');
  const dbRoot = document.getElementById('dictionary-db-root');
  const viewport = document.getElementById('dictionary-graph-viewport');
  const empty = document.getElementById('dictionary-graph-empty');
  if (!graph || !nodesRoot || !dbRoot || !viewport) return;
  ensureDictionaryGraphInteractions(viewport);
  const allActive = getDictionaryTables().filter(table => table.isActive);
  const tables = getDictionaryGraphTables().sort((a, b) => (!!a.domain !== !!b.domain ? (a.domain ? -1 : 1) : String(a.domain || '').localeCompare(String(b.domain || ''), 'vi') || String(a.tableName).localeCompare(String(b.tableName), 'vi')));
  const domains = [...new Set(allActive.map(table => table.domain).filter(Boolean))];
  const setText = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  setText('dict-stat-active', allActive.length); setText('dict-stat-domains', domains.length); setText('dict-stat-unassigned', allActive.filter(table => !table.domain).length);
  empty.hidden = tables.length > 0;
  nodesRoot.innerHTML = '';
  graph.classList.toggle('has-selection', Boolean(window.dictionaryGraphSelection));
  if (!tables.length) { dbRoot.hidden = true; graph.style.width = '100%'; graph.style.height = '100%'; drawDictionaryGraphEdges(); return; }

  const assignedTables = tables.filter(table => table.domain);
  const unassignedTables = tables.filter(table => !table.domain);
  const rings = [];
  for (let start = 0; start < assignedTables.length; start += 10) {
    rings.push({ tables: assignedTables.slice(start, start + 10), radius: 260 + rings.length * 175, direction: rings.length % 2 === 0 ? 1 : -1 });
  }
  const unassignedStartRadius = Math.max(460, 260 + Math.max(1, rings.length) * 190);
  for (let start = 0; start < unassignedTables.length; start += 16) {
    const unassignedRingIndex = Math.floor(start / 16);
    rings.push({ tables: unassignedTables.slice(start, start + 16), radius: unassignedStartRadius + unassignedRingIndex * 190, direction: unassignedRingIndex % 2 === 0 ? -1 : 1 });
  }
  const largestRadius = Math.max(...rings.map(ring => ring.radius), 260);
  const canvasWidth = Math.max(viewport.clientWidth, largestRadius * 2 + 280, 1080);
  const orbitVerticalRatio = .82;
  const canvasHeight = Math.max(720, largestRadius * 2 * orbitVerticalRatio + 280);
  const centerX = canvasWidth / 2; const centerY = canvasHeight / 2;
  graph.style.width = `${canvasWidth}px`; graph.style.height = `${canvasHeight}px`;
  const dbNames = [...new Set(tables.map(table => table.dbName).filter(Boolean))];
  const dbLabel = dbNames.length === 1 ? dbNames[0] : `${dbNames.length || 1} nguồn CSDL`;
  dbRoot.hidden = false; dbRoot.style.left = `${centerX - 75}px`; dbRoot.style.top = `${centerY - 22}px`;
  dbRoot.innerHTML = `<span><i class="fa-solid fa-database"></i></span><div><strong>${escapeDictHtml(dbLabel)}</strong><small>${tables.length} bảng active · ${domains.length} domain</small></div>`;

  const domainIndexes = new Map(domains.sort((a, b) => a.localeCompare(b, 'vi')).map((domain, index) => [domain, index]));
  const aliasAssignments = buildDictionaryAliasAssignments(tables);
  const markup = [];
  rings.forEach((ring, ringIndex) => {
    const ringTables = ring.tables;
    const radiusX = ring.radius; const radiusY = ring.radius * orbitVerticalRatio;
    ringTables.forEach((table, index) => {
      const angle = -Math.PI / 2 + index * (Math.PI * 2 / ringTables.length) + ringIndex * .13;
      const speed = ring.direction * (ringIndex === 0 ? .000025 : .000018);
      const currentAngle = angle + (typeof performance !== 'undefined' ? performance.now() : 0) * speed;
      const orbitX = Math.cos(currentAngle) * radiusX; const orbitY = Math.sin(currentAngle) * radiusY;
      const palette = table.domain ? DICTIONARY_GRAPH_COLORS[(domainIndexes.get(table.domain) || 0) % DICTIONARY_GRAPH_COLORS.length] : { border: '#cbd5e1', fill: '#f1f5f9', accent: '#64748b' };
      const selected = window.dictionaryGraphSelection === table.tableName;
      const related = window.dictionaryGraphSelection && (window.tableRelationshipsData || []).some(relation => (relation.sourceTable === window.dictionaryGraphSelection && relation.targetTable === table.tableName) || (relation.targetTable === window.dictionaryGraphSelection && relation.sourceTable === table.tableName));
      const relationTotal = (window.tableRelationshipsData || []).filter(relation => relation.sourceTable === table.tableName || relation.targetTable === table.tableName).length;
      const aliases = aliasAssignments.get(table.tableName) || [];
      const satellites = aliases.slice(0, 6).map((alias, aliasIndex) => `<span class="dictionary-table-alias alias-${aliasIndex}" title="${escapeDictHtml(alias)}"><i></i>${escapeDictHtml(alias)}</span>`).join('');
      markup.push(`<div class="dictionary-orbit-item ${table.domain ? '' : 'is-unassigned'}" data-radius-x="${radiusX}" data-radius-y="${radiusY}" data-base-angle="${angle}" data-speed="${speed}" style="left:${centerX - 75}px;top:${centerY - 20}px;transform:translate3d(${orbitX}px,${orbitY}px,0);--domain-border:${palette.border};--domain-fill:${palette.fill};--domain-accent:${palette.accent}">${satellites}<button class="dictionary-graph-node ${selected ? 'selected' : ''} ${related ? 'related' : ''}" data-table="${escapeDictHtml(table.tableName)}" onclick="selectDictionaryGraphTable('${encodeURIComponent(table.tableName)}')"><span class="dictionary-node-icon"><i class="fa-solid fa-table"></i></span><span class="dictionary-node-copy"><strong>${escapeDictHtml(table.tableName)}</strong><small>${escapeDictHtml(table.tableDescription || `${(table.columns || []).length} cột dữ liệu`)}</small></span><span class="dictionary-node-meta">${escapeDictHtml(dictionaryDomainLabel(table.domain))} · ${(table.columns || []).length} cột${relationTotal ? ` · ${relationTotal} nối` : ''}</span></button></div>`);
    });
  });
  nodesRoot.innerHTML = markup.join('');
  applyDictionaryGraphZoom();
  requestAnimationFrame(() => {
    if (viewport.dataset.graphCentered !== '1') {
      fitDictionaryGraph(false);
      viewport.dataset.graphCentered = '1';
    } else {
      drawDictionaryGraphEdges();
    }
  });
  startDictionaryGraphAnimation();
}

function graphPoint(element, graphRect, scale, side = 'center') {
  const rect = element.getBoundingClientRect();
  return { x: (rect.left - graphRect.left + (side === 'left' ? 0 : side === 'right' ? rect.width : rect.width / 2)) / scale, y: (rect.top - graphRect.top + (side === 'top' ? 0 : side === 'bottom' ? rect.height : rect.height / 2)) / scale };
}

function nearestGraphPoints(fromElement, toElement, graphRect, scale) {
  const from = fromElement.getBoundingClientRect(); const to = toElement.getBoundingClientRect();
  const dx = to.left + to.width / 2 - from.left - from.width / 2; const dy = to.top + to.height / 2 - from.top - from.height / 2;
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? [graphPoint(fromElement, graphRect, scale, 'right'), graphPoint(toElement, graphRect, scale, 'left')] : [graphPoint(fromElement, graphRect, scale, 'left'), graphPoint(toElement, graphRect, scale, 'right')];
  return dy > 0 ? [graphPoint(fromElement, graphRect, scale, 'bottom'), graphPoint(toElement, graphRect, scale, 'top')] : [graphPoint(fromElement, graphRect, scale, 'top'), graphPoint(toElement, graphRect, scale, 'bottom')];
}

function drawDictionaryGraphEdges() {
  const graph = document.getElementById('dictionary-domain-graph'); const svg = document.getElementById('dictionary-domain-edges'); const dbRoot = document.getElementById('dictionary-db-root');
  if (!graph || !svg || !dbRoot) return;
  svg.setAttribute('width', graph.offsetWidth); svg.setAttribute('height', graph.offsetHeight);
  const graphRect = graph.getBoundingClientRect(); const scale = window.dictionaryGraphZoom || 1; const selected = window.dictionaryGraphSelection; const hierarchy = [];
  const orbitGuides = new Map();
  const dbIcon = dbRoot.querySelector(':scope > span');
  graph.querySelectorAll('.dictionary-orbit-item').forEach(wrapper => {
    const guideKey = `${wrapper.dataset.radiusX}:${wrapper.dataset.radiusY}`;
    const centerX = parseFloat(wrapper.style.left) + 75;
    const centerY = parseFloat(wrapper.style.top) + 20;
    orbitGuides.set(guideKey, `<ellipse cx="${centerX}" cy="${centerY}" rx="${wrapper.dataset.radiusX}" ry="${wrapper.dataset.radiusY}" class="dictionary-orbit-guide"></ellipse>`);
    const node = wrapper.querySelector('.dictionary-graph-node');
    const nodeIcon = node?.querySelector('.dictionary-node-icon');
    if (!node || !nodeIcon || !dbIcon || dbRoot.hidden) return;
    const [from, to] = nearestGraphPoints(nodeIcon, dbIcon, graphRect, scale);
    hierarchy.push(`<path d="M ${from.x} ${from.y} L ${to.x} ${to.y}" class="dictionary-hierarchy-edge table-db ${wrapper.classList.contains('is-unassigned') ? 'unassigned' : ''}" marker-end="url(#dictionary-hierarchy-arrow)"></path>`);
    wrapper.querySelectorAll('.dictionary-table-alias').forEach(alias => { const [a, b] = nearestGraphPoints(alias, nodeIcon, graphRect, scale); hierarchy.push(`<path d="M ${a.x} ${a.y} L ${b.x} ${b.y}" class="dictionary-hierarchy-edge alias-table" marker-end="url(#dictionary-hierarchy-arrow)"></path>`); });
  });
  const relations = (window.tableRelationshipsData || []).filter(relation => relation.isActive !== false).map(relation => {
    const source = graph.querySelector(`.dictionary-graph-node[data-table="${CSS.escape(relation.sourceTable)}"] .dictionary-node-icon`); const target = graph.querySelector(`.dictionary-graph-node[data-table="${CSS.escape(relation.targetTable)}"] .dictionary-node-icon`); if (!source || !target) return '';
    const [from, to] = nearestGraphPoints(source, target, graphRect, scale); const middleX = (from.x + to.x) / 2; const active = selected && (relation.sourceTable === selected || relation.targetTable === selected); const muted = selected && !active;
    return `<path d="M ${from.x} ${from.y} C ${middleX} ${from.y}, ${middleX} ${to.y}, ${to.x} ${to.y}" class="dictionary-domain-edge ${active ? 'active' : ''} ${muted ? 'muted' : ''}" marker-end="url(#dictionary-relation-arrow)"></path>`;
  }).join('');
  svg.innerHTML = `<defs><marker id="dictionary-hierarchy-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z"></path></marker><marker id="dictionary-relation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"></path></marker></defs>${[...orbitGuides.values()].join('')}${hierarchy.join('')}${relations}`;
}

function ensureDictionaryGraphInteractions(viewport) {
  if (viewport.dataset.graphInteractions === '1') return; viewport.dataset.graphInteractions = '1';
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    const oldScale = window.dictionaryGraphZoom || 1; const nextScale = Math.min(1.6, Math.max(.3, oldScale * (event.deltaY < 0 ? 1.1 : .9)));
    const rect = viewport.getBoundingClientRect(); const pointerX = event.clientX - rect.left; const pointerY = event.clientY - rect.top;
    const logicalX = (viewport.scrollLeft + pointerX) / oldScale; const logicalY = (viewport.scrollTop + pointerY) / oldScale;
    window.dictionaryGraphZoom = nextScale; applyDictionaryGraphZoom(); viewport.scrollLeft = logicalX * nextScale - pointerX; viewport.scrollTop = logicalY * nextScale - pointerY; drawDictionaryGraphEdges();
  }, { passive: false });
}

function startDictionaryGraphAnimation() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || window.dictionaryGraphAnimationFrame) return;
  let lastDraw = 0;
  const animate = timestamp => {
    const graph = document.getElementById('dictionary-domain-graph');
    if (graph && window.dictionaryView === 'graph') {
      graph.querySelectorAll('.dictionary-orbit-item').forEach(item => {
        const angle = Number(item.dataset.baseAngle) + timestamp * Number(item.dataset.speed);
        const x = Math.cos(angle) * Number(item.dataset.radiusX);
        const y = Math.sin(angle) * Number(item.dataset.radiusY);
        item.style.transform = `translate3d(${x}px,${y}px,0)`;
      });
      if (timestamp - lastDraw > 32) { drawDictionaryGraphEdges(); lastDraw = timestamp; }
    }
    window.dictionaryGraphAnimationFrame = requestAnimationFrame(animate);
  };
  window.dictionaryGraphAnimationFrame = requestAnimationFrame(animate);
}

function zoomDictionaryGraph(delta) { window.dictionaryGraphZoom = Math.min(1.6, Math.max(.3, (window.dictionaryGraphZoom || 1) + delta)); applyDictionaryGraphZoom(); requestAnimationFrame(drawDictionaryGraphEdges); }
function applyDictionaryGraphZoom() {
  const graph = document.getElementById('dictionary-domain-graph');
  const viewport = document.getElementById('dictionary-graph-viewport');
  const scale = window.dictionaryGraphZoom || 1;
  if (graph) {
    graph.style.zoom = scale;
    const graphWidth = parseFloat(graph.style.width) || graph.offsetWidth;
    const graphHeight = parseFloat(graph.style.height) || graph.offsetHeight;
    graph.style.left = viewport ? `${Math.max(0, (viewport.clientWidth / scale - graphWidth) / 2)}px` : '0px';
    graph.style.top = viewport ? `${Math.max(0, (viewport.clientHeight / scale - graphHeight) / 2)}px` : '0px';
  }
  const label = document.getElementById('dictionary-graph-zoom');
  if (label) label.textContent = `${Math.round(scale * 100)}%`;
}
function fitDictionaryGraph(smooth = true) {
  const graph = document.getElementById('dictionary-domain-graph');
  const viewport = document.getElementById('dictionary-graph-viewport');
  if (!graph || !viewport) return;
  const graphWidth = parseFloat(graph.style.width) || graph.offsetWidth;
  const graphHeight = parseFloat(graph.style.height) || graph.offsetHeight;
  const availableWidth = Math.max(1, viewport.clientWidth - 40);
  const availableHeight = Math.max(1, viewport.clientHeight - 40);
  window.dictionaryGraphZoom = Math.min(1, Math.max(.3, Math.min(availableWidth / graphWidth, availableHeight / graphHeight)));
  applyDictionaryGraphZoom();
  const scale = window.dictionaryGraphZoom;
  viewport.scrollTo({
    left: Math.max(0, (graphWidth * scale - viewport.clientWidth) / 2),
    top: Math.max(0, (graphHeight * scale - viewport.clientHeight) / 2),
    behavior: smooth ? 'smooth' : 'auto'
  });
  requestAnimationFrame(drawDictionaryGraphEdges);
}
window.addEventListener('resize', () => { clearTimeout(window.dictionaryGraphResizeTimer); window.dictionaryGraphResizeTimer = setTimeout(() => { if (window.dictionaryView === 'graph') renderDictionaryGraph(); }, 100); });
