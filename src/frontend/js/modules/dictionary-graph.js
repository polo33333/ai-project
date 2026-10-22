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

function getVerifiedDictionaryGraphRelationships() {
  return (window.tableRelationshipsData || []).filter(relation =>
    relation?.status === 'verified' && relation.isActive !== false);
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

async function selectDictionaryGraphTable(encodedTableName) {
  const tableName = decodeURIComponent(encodedTableName);
  hideDictionaryGraphTooltip();
  if (document.getElementById('dictionary-graph-panel')?.classList.contains('is-fullscreen') || document.fullscreenElement === document.getElementById('dictionary-graph-panel')) {
    window.dictionaryGraphSelection = tableName;
    focusDictionaryGraphTable(tableName);
    return;
  }
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

function buildDictionaryClusterLayout(tables, relationships, viewportWidth = 1280, viewportHeight = 720) {
  const groups = new Map();
  const degrees = new Map();
  relationships.forEach(r => [r.sourceTable, r.targetTable].forEach(name => degrees.set(name, (degrees.get(name) || 0) + 1)));
  tables.forEach(table => {
    const key = table.domain || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(table);
  });
  const ordered = [...groups].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const cellWidth = 220, rowHeight = 76, padding = 12, header = 34, gap = 14;
  let best;
  // Pack small domains into gaps instead of allocating a full row to every cluster.
  for (let columns = 3; columns <= 10; columns++) {
    const skyline = Array(columns).fill(16);
    const positions = new Map(), clusters = [];
    ordered.forEach(([domain, original]) => {
      const members = [...original].sort((a, b) => (degrees.get(b.tableName) || 0) - (degrees.get(a.tableName) || 0) || a.tableName.localeCompare(b.tableName));
      const span = Math.min(columns, Math.max(1, Math.min(3, Math.ceil(Math.sqrt(members.length)))));
      let column = 0, y = Infinity;
      for (let i = 0; i <= columns - span; i++) {
        const top = Math.max(...skyline.slice(i, i + span));
        if (top < y) { column = i; y = top; }
      }
      const x = 16 + column * (cellWidth + gap);
      const width = span * cellWidth + (span - 1) * gap;
      const height = header + Math.ceil(members.length / span) * rowHeight + padding;
      members.forEach((table, i) => positions.set(table.tableName, {
        x: x + padding + (i % span) * (cellWidth + gap),
        y: y + header + Math.floor(i / span) * rowHeight
      }));
      clusters.push({ domain, x, y, width, height, count: members.length });
      for (let i = column; i < column + span; i++) skyline[i] = y + height + gap;
    });
    const width = Math.max(1, ...clusters.map(c => c.x + c.width + 16));
    const height = Math.max(1, ...clusters.map(c => c.y + c.height + 16));
    const scale = Math.min(1, Math.max(1, viewportWidth - 40) / width, Math.max(1, viewportHeight - 40) / height);
    const score = scale - width * height * 1e-10;
    if (!best || score > best.score) best = { positions, clusters, width, height, score };
  }
  return best;
}

function dictionaryGraphMappingLabel(relation) {
  const pairs = relation.columnPairs?.length ? relation.columnPairs : [{ sourceColumn: relation.sourceColumn, targetColumn: relation.targetColumn }];
  return pairs.filter(pair => pair.sourceColumn && pair.targetColumn)
    .map(pair => `${pair.sourceColumn} → ${pair.targetColumn}`).join(' · ') || 'Chưa có ánh xạ khóa';
}

function renderDictionaryGraph() {
  const { domains } = renderDictionaryOverview();
  const graph = document.getElementById('dictionary-domain-graph');
  const nodesRoot = document.getElementById('dictionary-domain-groups');
  const dbRoot = document.getElementById('dictionary-db-root');
  const viewport = document.getElementById('dictionary-graph-viewport');
  const empty = document.getElementById('dictionary-graph-empty');
  if (!graph || !nodesRoot || !dbRoot || !viewport) return;
  ensureDictionaryGraphInteractions(viewport);
  const tables = getDictionaryGraphTables().sort((a, b) => (!!a.domain !== !!b.domain ? (a.domain ? -1 : 1) : String(a.domain || '').localeCompare(String(b.domain || ''), 'vi') || String(a.tableName).localeCompare(String(b.tableName), 'vi')));
  empty.hidden = tables.length > 0;
  nodesRoot.innerHTML = '';
  graph.classList.toggle('has-selection', Boolean(window.dictionaryGraphSelection));
  if (!tables.length) { document.getElementById('dictionary-graph-mappings')?.remove(); dbRoot.hidden = true; graph.style.width = '100%'; graph.style.height = '100%'; drawDictionaryGraphEdges(); return; }

  const layout = buildDictionaryClusterLayout(tables, getVerifiedDictionaryGraphRelationships(), viewport.clientWidth || 1280, viewport.clientHeight || 720);
  const canvasWidth = layout.width;
  const canvasHeight = layout.height;
  const centerX = canvasWidth / 2, centerY = canvasHeight / 2;
  graph.style.width = canvasWidth + 'px'; graph.style.height = canvasHeight + 'px';
  graph.classList.add('dictionary-card-graph');
  dbRoot.hidden = true;
  const rings = [{ tables, radius: 0, direction: 0 }];
  const orbitVerticalRatio = 1;
  const domainIndexes = new Map(domains.sort((a, b) => a.localeCompare(b, 'vi')).map((domain, index) => [domain, index]));
  const aliasAssignments = buildDictionaryAliasAssignments(tables);
  const verifiedRelationships = getVerifiedDictionaryGraphRelationships();
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
      const related = window.dictionaryGraphSelection && verifiedRelationships.some(relation => (relation.sourceTable === window.dictionaryGraphSelection && relation.targetTable === table.tableName) || (relation.targetTable === window.dictionaryGraphSelection && relation.sourceTable === table.tableName));
      const relationTotal = verifiedRelationships.filter(relation => relation.sourceTable === table.tableName || relation.targetTable === table.tableName).length;
      const aliases = aliasAssignments.get(table.tableName) || [];
      const satellites = aliases.slice(0, 6).map((alias, aliasIndex) => `<span class="dictionary-table-alias alias-${aliasIndex}" title="${escapeDictHtml(alias)}"><i></i>${escapeDictHtml(alias)}</span>`).join('');
      markup.push(`<div class="dictionary-orbit-item ${table.domain ? '' : 'is-unassigned'}" data-radius-x="${radiusX}" data-radius-y="${radiusY}" data-base-angle="${angle}" data-speed="${speed}" style="left:${centerX - 75}px;top:${centerY - 20}px;transform:translate3d(${orbitX}px,${orbitY}px,0);--domain-border:${palette.border};--domain-fill:${palette.fill};--domain-accent:${palette.accent}">${satellites}<button class="dictionary-graph-node ${selected ? 'selected' : ''} ${related ? 'related' : ''}" data-table="${escapeDictHtml(table.tableName)}" onclick="selectDictionaryGraphTable('${encodeURIComponent(table.tableName)}')"><span class="dictionary-node-icon"><i class="fa-solid fa-table"></i></span><span class="dictionary-node-copy"><strong>${escapeDictHtml(table.tableName)}</strong><small>${escapeDictHtml(table.tableDescription || `${(table.columns || []).length} cột dữ liệu`)}</small></span><span class="dictionary-node-meta">${escapeDictHtml(dictionaryDomainLabel(table.domain))} · ${(table.columns || []).length} cột${relationTotal ? ` · ${relationTotal} nối` : ''}</span></button></div>`);
    });
  });
  nodesRoot.innerHTML = layout.clusters.map(cluster => `<div class="dictionary-graph-cluster" style="left:${cluster.x}px;top:${cluster.y}px;width:${cluster.width}px;height:${cluster.height}px"><strong>${escapeDictHtml(dictionaryDomainLabel(cluster.domain))}</strong><small>${cluster.count} bảng</small></div>`).join('') + markup.join('');
  window.dictionaryGraphHover = null;
  nodesRoot.querySelectorAll('.dictionary-orbit-item').forEach((item, index) => {
    const position = layout.positions.get(tables[index].tableName);
    item.style.left = position.x + 'px';
    item.style.top = position.y + 'px';
    item.style.transform = 'none';
    const node = item.querySelector('.dictionary-graph-node');
    const table = tables[index];
    node.setAttribute('aria-label', table.tableName);
    node.addEventListener('pointerenter', event => { focusDictionaryGraphTable(node.dataset.table); showDictionaryGraphTooltip(table, node, event); });
    node.addEventListener('focus', () => { focusDictionaryGraphTable(node.dataset.table); showDictionaryGraphTooltip(table, node); });
  });
  applyDictionaryGraphZoom();
  focusDictionaryGraphTable(null);
  requestAnimationFrame(() => {
    if (viewport.dataset.graphCentered !== '1') {
      fitDictionaryGraph(false);
      viewport.dataset.graphCentered = '1';
    } else {
      fitDictionaryGraph(false);
    }
  });
  if (window.dictionaryGraphAnimationFrame) cancelAnimationFrame(window.dictionaryGraphAnimationFrame);
  window.dictionaryGraphAnimationFrame = null;
}

function focusDictionaryGraphTable(tableName) {
  window.dictionaryGraphHover = tableName;
  const graph = document.getElementById('dictionary-domain-graph');
  const selected = tableName || window.dictionaryGraphSelection;
  graph?.classList.toggle('has-focus', Boolean(selected));
  const relations = getVerifiedDictionaryGraphRelationships();
  graph?.querySelectorAll('.dictionary-graph-node').forEach(node => {
    const name = node.dataset.table;
    node.classList.toggle('is-focused', name === selected);
    node.classList.toggle('is-emphasized', name === selected || relations.some(r =>
      (r.sourceTable === selected && r.targetTable === name) || (r.targetTable === selected && r.sourceTable === name)));
  });
  drawDictionaryGraphEdges();
  let panel = document.getElementById('dictionary-graph-mappings');
  if (!panel && graph?.parentElement) {
    panel = document.createElement('aside');
    panel.id = 'dictionary-graph-mappings';
    panel.className = 'dictionary-graph-mappings';
    document.getElementById('dictionary-graph-details').appendChild(panel);
  }
  if (panel) {
    panel.hidden = !selected;
    const mapped = relations.filter(r => r.sourceTable === selected || r.targetTable === selected);
    panel.innerHTML = `<header class="dictionary-mappings-header"><strong>${escapeDictHtml(selected || '')} · Ánh xạ khóa</strong><button type="button" class="dictionary-mappings-close" onclick="closeDictionaryGraphMappings()" aria-label="Đóng ánh xạ khóa">&times;</button></header>` + (mapped.map(r => `<div><span>${escapeDictHtml(r.sourceTable)} → ${escapeDictHtml(r.targetTable)}</span><code>${escapeDictHtml(dictionaryGraphMappingLabel(r))}</code><small>${escapeDictHtml(r.cardinality || '')}</small></div>`).join('') || '<p>Không có quan hệ đã xác minh.</p>');
  }
}

function closeDictionaryGraphMappings() {
  window.dictionaryGraphSelection = null;
  window.dictionaryGraphHover = null;
  hideDictionaryGraphTooltip();
  focusDictionaryGraphTable(null);
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
  const graphRect = graph.getBoundingClientRect(); const scale = window.dictionaryGraphZoom || 1; const selected = window.dictionaryGraphHover || window.dictionaryGraphSelection; const hierarchy = [];
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
  const nodeBounds = [...graph.querySelectorAll('.dictionary-graph-node.is-emphasized')].map(node => {
    const rect = node.getBoundingClientRect();
    return { name: node.dataset.table, x: (rect.left - graphRect.left) / scale, y: (rect.top - graphRect.top) / scale, width: rect.width / scale, height: rect.height / scale };
  });
  const relations = getVerifiedDictionaryGraphRelationships().filter(relation => selected && (relation.sourceTable === selected || relation.targetTable === selected)).map((relation, index) => {
    const source = graph.querySelector(`.dictionary-graph-node[data-table="${CSS.escape(relation.sourceTable)}"]`); const target = graph.querySelector(`.dictionary-graph-node[data-table="${CSS.escape(relation.targetTable)}"]`); if (!source || !target) return '';
    const [from, to] = nearestGraphPoints(source, target, graphRect, scale); const middleX = (from.x + to.x) / 2; const active = selected && (relation.sourceTable === selected || relation.targetTable === selected); const muted = selected && !active;
    const relatedNode = relation.sourceTable === selected ? target : source;
    const color = escapeDictHtml(getComputedStyle(relatedNode).getPropertyValue('--domain-accent').trim() || '#64748b');
    const arrowId = `dictionary-relation-arrow-${index}`;
    const crossingRects = dictionaryGraphCrossingRects(nodeBounds, relation.sourceTable, relation.targetTable);
    const maskId = `dictionary-edge-outside-${index}`;
    const clipId = `dictionary-edge-inside-${index}`;
    const curve = `M ${from.x} ${from.y} C ${middleX} ${from.y}, ${middleX} ${to.y}, ${to.x} ${to.y}`;

    const mapping = escapeDictHtml(dictionaryGraphMappingLabel(relation));
    const title = escapeDictHtml(`${relation.sourceTable} → ${relation.targetTable}: ${dictionaryGraphMappingLabel(relation)}`);
    return `<defs><mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${graph.offsetWidth}" height="${graph.offsetHeight}" style="mask-type:luminance"><rect x="0" y="0" width="${graph.offsetWidth}" height="${graph.offsetHeight}" fill="white"></rect><g fill="black">${crossingRects}</g></mask><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${crossingRects}</clipPath><marker id="${arrowId}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" style="fill:${color}"></path></marker></defs><path style="--relation-color:${color}" d="${curve}" mask="url(#${maskId})" class="dictionary-domain-edge ${active ? 'active' : ''} ${muted ? 'muted' : ''}" marker-end="url(#${arrowId})"><title>${title}</title></path><path style="--relation-color:${color}" d="${curve}" clip-path="url(#${clipId})" class="dictionary-domain-edge active crosses-node"></path><circle class="dictionary-edge-source-dot" cx="${from.x}" cy="${from.y}" r="${4 / scale}" style="--relation-color:${color}"></circle>${active ? `<g class="dictionary-edge-badge" style="--relation-color:${color}" data-anchor-x="${middleX}" data-anchor-y="${(from.y + to.y) / 2}"><title>${title}</title><line class="dictionary-edge-label-leader"></line><rect rx="8"></rect><text x="0" y="0" style="font-size:${13 / scale}px" class="dictionary-domain-edge-label">${mapping}</text></g>` : ''}`;
  }).join('');
  svg.innerHTML = `<defs><marker id="dictionary-hierarchy-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z"></path></marker><marker id="dictionary-relation-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z"></path></marker></defs>${[...orbitGuides.values()].join('')}${hierarchy.join('')}${relations}`;
  placeDictionaryGraphEdgeLabels(graph, svg, graphRect, scale);
}

function dictionaryGraphCrossingRects(nodes, sourceTable, targetTable) {
  return nodes.filter(node => node.name !== sourceTable && node.name !== targetTable)
    .map(node => `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${node.height / 2}"></rect>`).join('');
}

function findDictionaryGraphLabelPosition(anchor, width, height, bounds, occupied) {
  let best;
  for (const dy of [-24, 24, -52, 52, -84, 84, -120, 120, -164, 164, -210, 210, -260, 260]) {
    for (const dx of [0, -80, 80, -160, 160, -260, 260]) {
      const x = Math.max(8, Math.min(anchor.x + dx - width / 2, bounds.width - width - 8));
      const y = Math.max(8, Math.min(anchor.y + dy - height / 2, bounds.height - height - 8));
      const collisions = occupied.reduce((sum, box) => sum + (x < box.x + box.width + 5 && x + width + 5 > box.x && y < box.y + box.height + 5 && y + height + 5 > box.y ? 1 : 0), 0);
      const score = collisions * 100000 + Math.hypot(x + width / 2 - anchor.x, y + height / 2 - anchor.y);
      if (!best || score < best.score) best = { x, y, width, height, score };
    }
  }
  return best;
}

function placeDictionaryGraphEdgeLabels(graph, svg, graphRect, scale) {
  const occupied = [...graph.querySelectorAll('.dictionary-graph-node')].map(node => {
    const rect = node.getBoundingClientRect();
    return { x: (rect.left - graphRect.left) / scale, y: (rect.top - graphRect.top) / scale, width: rect.width / scale, height: rect.height / scale };
  });
  svg.querySelectorAll('.dictionary-edge-badge').forEach(badge => {
    // Keep all labels above paths, even paths added later in the relationship list.
    svg.appendChild(badge);
    const text = badge.querySelector('text');
    const size = text.getBBox();
    const width = size.width + 20, height = size.height + 12;
    const anchor = { x: Number(badge.dataset.anchorX), y: Number(badge.dataset.anchorY) };
    const box = findDictionaryGraphLabelPosition(anchor, width, height, { width: graph.offsetWidth, height: graph.offsetHeight }, occupied);
    occupied.push(box);
    const background = badge.querySelector('rect');
    for (const [key, value] of Object.entries({ x: box.x, y: box.y, width, height })) background.setAttribute(key, value);
    text.setAttribute('x', box.x + width / 2);
    text.setAttribute('y', box.y + 6 - size.y);
    const leader = badge.querySelector('line');
    for (const [key, value] of Object.entries({ x1: anchor.x, y1: anchor.y, x2: box.x + width / 2, y2: box.y + height / 2 })) leader.setAttribute(key, value);
  });
}

function ensureDictionaryGraphInteractions(viewport) {
  const panel = document.getElementById('dictionary-graph-panel');
  if (panel && !document.getElementById('dictionary-graph-details')) {
    const details = document.createElement('aside');
    details.id = 'dictionary-graph-details';
    details.className = 'dictionary-graph-details';
    details.setAttribute('aria-label', 'Chi ti\u1ebft b\u1ea3ng v\u00e0 quan h\u1ec7');
    details.innerHTML = '<div class="dictionary-details-empty"><i class="fa-solid fa-diagram-project" aria-hidden="true"></i><strong>Chi ti\u1ebft b\u1ea3ng</strong><p>R\u00ea ho\u1eb7c ch\u1ecdn m\u1ed9t b\u1ea3ng \u0111\u1ec3 xem m\u00f4 t\u1ea3 v\u00e0 \u00e1nh x\u1ea1 kh\u00f3a.</p></div>';
    panel.appendChild(details);
    panel.classList.add('has-details-rail');
  }
  if (viewport.dataset.graphInteractions === '1') return; viewport.dataset.graphInteractions = '1';
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    const oldScale = window.dictionaryGraphZoom || 1; const nextScale = Math.min(1.6, Math.max(.3, oldScale * (event.deltaY < 0 ? 1.1 : .9)));
    const rect = viewport.getBoundingClientRect(); const pointerX = event.clientX - rect.left; const pointerY = event.clientY - rect.top;
    const logicalX = (viewport.scrollLeft + pointerX) / oldScale; const logicalY = (viewport.scrollTop + pointerY) / oldScale;
    window.dictionaryGraphZoom = nextScale; applyDictionaryGraphZoom(); viewport.scrollLeft = logicalX * nextScale - pointerX; viewport.scrollTop = logicalY * nextScale - pointerY; drawDictionaryGraphEdges();
  }, { passive: false });
}

function hideDictionaryGraphTooltip() {
  const tooltip = document.getElementById('dictionary-graph-tooltip');
  if (tooltip) tooltip.hidden = true;
}

function showDictionaryGraphTooltip(table, node, event) {
  let tooltip = document.getElementById('dictionary-graph-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'dictionary-graph-tooltip';
    tooltip.className = 'dictionary-graph-tooltip';
    tooltip.setAttribute('role', 'region');
    document.getElementById('dictionary-graph-details').prepend(tooltip);
  }
  const description = String(table.tableDescription || '').trim();
  tooltip.innerHTML = `<span class="dictionary-tooltip-kicker">${escapeDictHtml(dictionaryDomainLabel(table.domain))}</span><strong>${escapeDictHtml(table.tableName)}</strong>${description ? `<p>${escapeDictHtml(description)}</p>` : ''}<small>${(table.columns || []).length} cột · Chọn để xem cấu trúc</small>`;
  tooltip.hidden = false;
  node.setAttribute('aria-describedby', tooltip.id);

}


function syncDictionaryGraphFullscreen(expanded) {
  const panel = document.getElementById('dictionary-graph-panel');
  panel?.classList.toggle('is-fullscreen', expanded);
  const button = document.getElementById('dictionary-graph-fullscreen');
  button?.setAttribute('aria-pressed', String(expanded));
  button?.setAttribute('aria-label', expanded ? 'Thoát toàn màn hình' : 'Toàn màn hình');
  if (button) button.innerHTML = `<i class="fa-solid ${expanded ? 'fa-compress' : 'fa-expand'}" aria-hidden="true"></i>`;
  hideDictionaryGraphTooltip();
  requestAnimationFrame(() => { if (window.dictionaryView === 'graph') renderDictionaryGraph(); });
}

async function toggleDictionaryGraphFullscreen() {
  const panel = document.getElementById('dictionary-graph-panel');
  if (!panel) return;
  if (document.fullscreenElement === panel) { await document.exitFullscreen(); return; }
  if (panel.classList.contains('is-fullscreen')) { syncDictionaryGraphFullscreen(false); return; }
  try {
    if (!panel.requestFullscreen) throw new Error('Fullscreen unavailable');
    await panel.requestFullscreen({ navigationUI: 'hide' });
    syncDictionaryGraphFullscreen(true);
  } catch {
    syncDictionaryGraphFullscreen(true);
    if (typeof showToast === 'function') showToast('Trình duyệt đang chặn toàn màn hình. Nhấn F11 để ẩn thanh trình duyệt.', 'warn');
  }
}

document.addEventListener('fullscreenchange', () => syncDictionaryGraphFullscreen(document.fullscreenElement === document.getElementById('dictionary-graph-panel')));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    hideDictionaryGraphTooltip();
    if (!document.fullscreenElement && document.getElementById('dictionary-graph-panel')?.classList.contains('is-fullscreen')) syncDictionaryGraphFullscreen(false);
  }
});

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
