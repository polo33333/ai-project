(function () {
  'use strict';
  if (window.KnowledgeHubEmbedLoaded && document.getElementById('knowledgehub-embed-host')) return;
  window.KnowledgeHubEmbedLoaded = true;

  const script = document.currentScript;
  const embedId = script?.dataset.embedId || '';
  const apiBase = (script?.dataset.apiBase || new URL(script.src).origin).replace(/\/$/, '');
  const title = script?.dataset.title || 'Trợ lý AI';
  const greeting = script?.dataset.greeting || 'Xin chào! Tôi có thể giúp gì cho bạn?';
  const primary = script?.dataset.color || '#4f46e5';
  const position = script?.dataset.position === 'left' ? 'left' : 'right';
  const isPreview = script?.dataset.preview === 'true';
  const requestedTheme = ['light', 'dark'].includes(script?.dataset.theme) ? script.dataset.theme : 'auto';
  const history = [];
  let sessionId = createSessionId();
  let workflowToken = '', workflowRuns = [];
  const workflowPanels = new Map();
  const workflowExecutions = new Map();
  const workflowStorageKey = `knowledgehub-workflows:${apiBase}:${embedId}:${location.pathname}${location.search}`;
  const restoreSession = performance.getEntriesByType('navigation')[0]?.type === 'reload' && !window.KnowledgeHubEmbedInitialized;
  window.KnowledgeHubEmbedInitialized = true;
  try { const saved=restoreSession ? JSON.parse(sessionStorage.getItem(workflowStorageKey)||'null') : null; if(saved) {sessionId=saved.sessionId;workflowToken=saved.token;workflowRuns=saved.runs||[];} } catch (_) {}
  const saveWorkflow = () => { try { sessionStorage.setItem(workflowStorageKey,JSON.stringify({sessionId,token:workflowToken,runs:workflowRuns})); } catch (_) {} };
  saveWorkflow();
  let activeRequest = null;
  let conversationVersion = 0;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const isBooleanDisplayColumn = (columnName = '') => {
    const normalized = String(columnName).trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
    return /^(?:is|has|can|should|allow|enable|active|inactive|deleted|locked|verified|approved|visible)/.test(normalized)
      || /^(?:co|da|duoc|kichhoat|hieuluc)/.test(normalized);
  };
  const formatDisplayValue = (value, columnName = '') => {
    if (value === true || String(value).toLowerCase() === 'true') return 'Có';
    if (value === false || String(value).toLowerCase() === 'false') return 'Không';
    if (isBooleanDisplayColumn(columnName) && (value === 1 || String(value) === '1')) return 'Có';
    if (isBooleanDisplayColumn(columnName) && (value === 0 || String(value) === '0')) return 'Không';
    const text = String(value ?? '');
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
    if (!match) return text;
    const [, year, month, day, hour, minute, second] = match;
    const date = `${day}/${month}/${year}`;
    return hour === undefined || (hour === '00' && minute === '00' && second === '00')
      ? date : `${date} ${hour}:${minute}:${second}`;
  };
  const normalizeDownloadLinks = value => String(value ?? '').replace(
    /\[\[([^\]]+)\]\((\/api\/exports\/[^)\s]+)\)\]\([^)\s]+\)/g,
    '[$1]($2)'
  );
  const sanitizeSystemPaths = value => String(value ?? '')
    .replace(/\[[^\]]*\]\(\s*\[SYSTEM_PATH_HIDDEN\]\s*\)/gi, '')
    .replace(/file:\/{2,3}[^\s<>"'`)]+/gi, '[SYSTEM_PATH_HIDDEN]')
    .replace(/(^|[\s(`"'=])(?:[a-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s<>"'`)]+/gim, '$1[SYSTEM_PATH_HIDDEN]')
    .replace(/(^|[\s(`"'=])\/(?:home|root|etc|var|tmp|srv|opt|Users)\/[^\s<>"'`)]+/g, '$1[SYSTEM_PATH_HIDDEN]')
    .replace(/\[[^\]]*\]\(\s*\[SYSTEM_PATH_HIDDEN\]\s*\)/gi, '')
    .replace(/\[SYSTEM_PATH_HIDDEN\]/g, '')
    .replace(/^[\s>*•-]*(?:🔽\s*)?(?:Tải (?:về|xuống)(?: tại)?|Download)\s*:?\s*(?:\(\s*\))?\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const stripInlineDownloadLink = (value, downloadUrl) => {
    const text = String(value ?? '');
    const url = String(downloadUrl || '').trim();
    if (!/^\/api\/exports\/[^\s<>"']+$/i.test(url)) return text;
    const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return text
      .replace(new RegExp(`\\[[^\\]]*\\]\\(\\s*${escapedUrl}\\s*\\)`, 'gi'), '')
      .replace(new RegExp(escapedUrl, 'gi'), '')
      .replace(/^[\s>*•-]*(?:🔽\s*)?(?:Tải (?:về|xuống|file)(?: tại| kết quả)?|Download)\s*:?\s*[.,]*\s*$/gim, '')
      .replace(/:\s*\.(?=\s|$)/g, '.')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  };
  const renderText = value => escapeHtml(normalizeDownloadLinks(sanitizeSystemPaths(value)))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, rawUrl) => {
      const decodedUrl = rawUrl.replace(/&amp;/g, '&');
      let href = '';
      try {
        if (decodedUrl.startsWith('/api/exports/')) href = new URL(decodedUrl, `${apiBase}/`).href;
        else if (/^https?:\/\//i.test(decodedUrl)) href = new URL(decodedUrl).href;
      } catch (_) {}
      return href ? `<a class="kh-embed-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>` : `${label} (${rawUrl})`;
    })
    .replace(/(^|[\s:])(https?:\/\/[^\s<>()`]+)(?=$|[\s,.!?<])/gi, (_, prefix, rawUrl) => {
      const trailing = rawUrl.match(/[.,!?;:]+$/)?.[0] || '';
      const candidate = rawUrl.slice(0, rawUrl.length - trailing.length).replace(/&amp;/g, '&');
      try {
        const href = new URL(candidate).href;
        return `${prefix}<a class="kh-embed-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(candidate)}</a>${trailing}`;
      } catch (_) { return `${prefix}${rawUrl}`; }
    })
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
  const markdownCells = line => String(line).trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  const renderRichText = value => {
    const lines = normalizeDownloadLinks(value).split(/\r?\n/);
    const output = [];
    let prose = [];
    const flushProse = () => {
      if (prose.length) output.push(renderText(prose.join('\n')));
      prose = [];
    };
    for (let index = 0; index < lines.length; index += 1) {
      const separator = lines[index + 1];
      if (lines[index].includes('|') && separator && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(separator)) {
        flushProse();
        const headers = markdownCells(lines[index]);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          rows.push(markdownCells(lines[index]));
          index += 1;
        }
        index -= 1;
        output.push(`<div class="kh-embed-table-wrap"><table><thead><tr>${headers.map(cell => `<th>${renderText(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((header, cellIndex) => `<td>${renderText(formatDisplayValue(row[cellIndex] ?? '', header))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      } else prose.push(lines[index]);
    }
    flushProse();
    return output.join('');
  };
  const chartColors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#a855f7', '#14b8a6', '#f97316'];
  const renderEmbedChart = spec => {
    if (spec?.kind === 'bar-chart' && Array.isArray(spec.points)) {
      if (!spec.points.length) return '<section class="kh-embed-chart">Không có dữ liệu sản lượng để vẽ biểu đồ.</section>';
      spec = {
        type: 'bar', title: `${spec.title || 'Biểu đồ dữ liệu'}${spec.unit ? ` (${spec.unit})` : ''}`,
        data: { labels: spec.points.map(point => point.label), datasets: [{ data: spec.points.map(point => point.value) }] }
      };
    }
    if (!spec || !spec.data || !Array.isArray(spec.data.datasets)) return '';
    const labels = Array.isArray(spec.data.labels) ? spec.data.labels : [];
    const datasets = spec.data.datasets.filter(item => Array.isArray(item.data));
    if (!datasets.length) return '';
    const titleText = spec.options?.plugins?.title?.text || spec.title || 'Biểu đồ dữ liệu';
    if (['pie', 'doughnut'].includes(spec.type)) {
      const values = datasets[0].data.map(Number).map(value => Number.isFinite(value) ? Math.max(0, value) : 0);
      const total = values.reduce((sum, value) => sum + value, 0) || 1; let angle = 0;
      const stops = values.map((value, index) => { const start = angle; angle += value / total * 360; return `${chartColors[index % chartColors.length]} ${start}deg ${angle}deg`; }).join(',');
      const legend = labels.map((label, index) => `<span><i style="background:${chartColors[index % chartColors.length]}"></i>${escapeHtml(label)}: <b>${escapeHtml(values[index] ?? 0)}</b></span>`).join('');
      return `<section class="kh-embed-chart"><strong>${escapeHtml(titleText)}</strong><div class="kh-pie-wrap"><div class="kh-pie ${spec.type}" style="background:conic-gradient(${stops})"></div><div class="kh-chart-legend">${legend}</div></div></section>`;
    }
    const width = 420, height = 250, left = 64, right = 14, top = 20, bottom = 52;
    const allValues = datasets.flatMap(item => item.data.map(Number)).filter(Number.isFinite); const max = Math.max(...allValues, 1); const plotW = width - left - right, plotH = height - top - bottom; const slots = Math.max(labels.length, ...datasets.map(item => item.data.length), 1);
    const grid = [0, .25, .5, .75, 1].map(ratio => { const y = top + plotH * (1 - ratio); return `<line x1="${left}" y1="${y}" x2="${width - right}" y2="${y}"/><text x="${left - 5}" y="${y + 4}" text-anchor="end">${Math.round(max * ratio).toLocaleString('vi-VN')}</text>`; }).join('');
    let marks = '';
    if (spec.type === 'bar') {
      const groupW = plotW / slots, barW = Math.max(3, Math.min(30, groupW * .72 / datasets.length));
      datasets.forEach((dataset, datasetIndex) => dataset.data.forEach((raw, index) => { const value = Number(raw) || 0; const barH = value / max * plotH; const x = left + index * groupW + groupW / 2 - datasets.length * barW / 2 + datasetIndex * barW; marks += `<rect x="${x}" y="${top + plotH - barH}" width="${Math.max(2, barW - 2)}" height="${barH}" rx="3" fill="${chartColors[datasetIndex % chartColors.length]}"><title>${escapeHtml(labels[index] || index + 1)}: ${escapeHtml(value)}</title></rect>`; }));
    } else {
      datasets.forEach((dataset, datasetIndex) => { const color = chartColors[datasetIndex % chartColors.length]; const points = dataset.data.map((raw, index) => `${left + (slots === 1 ? plotW / 2 : index * plotW / (slots - 1))},${top + plotH - (Number(raw) || 0) / max * plotH}`).join(' '); marks += `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3" stroke-linejoin="round"/>`; dataset.data.forEach((raw, index) => { const x = left + (slots === 1 ? plotW / 2 : index * plotW / (slots - 1)), y = top + plotH - (Number(raw) || 0) / max * plotH; marks += `<circle cx="${x}" cy="${y}" r="4" fill="${color}"><title>${escapeHtml(labels[index] || index + 1)}: ${escapeHtml(raw)}</title></circle>`; }); });
    }
    const xLabels = labels.map((label, index) => `<text x="${spec.type === 'bar' ? left + (index + .5) * plotW / slots : left + (slots === 1 ? plotW / 2 : index * plotW / Math.max(1, slots - 1))}" y="${height - 17}" text-anchor="middle">${escapeHtml(String(label).slice(0, 13))}</text>`).join('');
    return `<section class="kh-embed-chart"><strong>${escapeHtml(titleText)}</strong><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(titleText)}"><g class="kh-chart-grid">${grid}</g>${marks}<g class="kh-chart-labels">${xLabels}</g></svg></section>`;
  };
  const renderEmbedCitations = (citations, validation = {}, supportingEvidence = []) => {
    const verified = Array.isArray(citations) ? citations : [];
    const fallback = Array.isArray(supportingEvidence) ? supportingEvidence : [];
    const displayed = verified.length ? verified : fallback;
    if (!displayed.length || (!verified.length && !validation?.missingCitation)) return '';
    const items = displayed.map(citation => {
      const marker = Number(citation.marker) || 0;
      const chunk = (Number(citation.chunkIndex) || 0) + 1;
      const href = citation.sourceUrl ? new URL(citation.sourceUrl, `${apiBase}/`).href : '';
      return `<article><div><b>[${marker}] ${escapeHtml(citation.title || 'Tài liệu')}</b><span>Đoạn ${chunk}</span>${href ? `<a href="${escapeHtml(href)}" download>Tải file gốc</a>` : ''}</div><blockquote>${escapeHtml(citation.excerpt || '')}</blockquote></article>`;
    }).join('');
    const label = verified.length ? 'Đoạn nguồn theo trích dẫn' : 'Các đoạn đã cung cấp cho AI';
    const note = verified.length ? '' : '<p>Model chưa gắn marker; đây là evidence thực tế trong ngữ cảnh.</p>';
    return `<details class="kh-embed-citations"><summary>${label} (${displayed.length})</summary>${note}${items}</details>`;
  };
  const chatIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18.5 3.8 21l.8-4.1A8 8 0 1 1 7 18.5Z"/><path d="M8 10h8M8 14h5"/></svg>';
  const botIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M9 3h6"/><rect x="4" y="7" width="16" height="12" rx="4"/><circle cx="9" cy="13" r="1"/><circle cx="15" cy="13" r="1"/><path d="M9 16h6"/></svg>';
  const closeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"/></svg>';
  const sendIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 17 8-17 8 3-8-3-8Z"/><path d="M7 12h14"/></svg>';
  const resetIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6"/><path d="M4 4v4.6h4.6"/></svg>';
  function createSessionId() { return `embed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }

  const style = document.createElement('style');
  style.textContent = `
    .kh-embed-root{--kh-primary:${primary};position:fixed;${position}:22px;bottom:22px;z-index:2147483000;width:58px;height:58px;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;text-align:left}
    .kh-embed-root *{box-sizing:border-box}.kh-embed-root svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .kh-embed-toggle{position:relative;display:grid;place-items:center;width:58px;height:58px;padding:0;border:0;border-radius:50%;color:#fff;background:linear-gradient(145deg,var(--kh-primary),#7c3aed);box-shadow:0 12px 30px rgba(79,70,229,.38),inset 0 1px rgba(255,255,255,.22);cursor:pointer;transition:transform .2s ease,box-shadow .2s ease}
    .kh-embed-toggle:hover{transform:translateY(-2px) scale(1.03);box-shadow:0 16px 36px rgba(79,70,229,.44)}.kh-embed-toggle .kh-icon-close{display:none}.kh-embed-root.open .kh-embed-toggle .kh-icon-chat{display:none}.kh-embed-root.open .kh-embed-toggle .kh-icon-close{display:block}
    .kh-embed-panel{position:absolute;${position}:0;bottom:72px;display:flex;flex-direction:column;width:min(450px,calc(100vw - 32px));height:min(650px,calc(100vh - 105px));overflow:hidden;border:1px solid rgba(148,163,184,.5);border-radius:18px;background:#fff;box-shadow:0 22px 56px rgba(15,23,42,.2),0 3px 10px rgba(15,23,42,.06);opacity:0;visibility:hidden;transform:translateY(14px) scale(.97);transform-origin:bottom ${position};pointer-events:none;transition:opacity .2s ease,transform .2s ease,visibility .2s}
    .kh-embed-root.open .kh-embed-panel{opacity:1;visibility:visible;transform:translateY(0) scale(1);pointer-events:auto}
    .kh-embed-head{position:relative;display:flex;align-items:center;gap:11px;padding:15px 17px;color:#fff;background:linear-gradient(135deg,#3730a3,var(--kh-primary) 62%,#6d28d9)}.kh-embed-head::after{content:"";position:absolute;inset:auto 0 0;height:1px;background:rgba(15,23,42,.12)}
    .kh-embed-avatar{display:grid;place-items:center;width:38px;height:38px;border:1px solid rgba(255,255,255,.3);border-radius:12px;background:rgba(255,255,255,.16);box-shadow:inset 0 1px rgba(255,255,255,.18)}.kh-embed-avatar svg{width:21px;height:21px}
    .kh-embed-identity{flex:1;min-width:0}.kh-embed-identity strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:800}.kh-embed-status{display:flex;align-items:center;gap:5px;margin-top:3px;color:rgba(255,255,255,.78);font-size:10.5px}.kh-embed-status::before{content:"";width:6px;height:6px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.16)}
    .kh-embed-head-actions{display:flex;align-items:center;gap:5px}.kh-embed-close,.kh-embed-reset{display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:9px;color:#fff;background:rgba(255,255,255,.1);cursor:pointer}.kh-embed-close:hover,.kh-embed-reset:hover{background:rgba(255,255,255,.2)}.kh-embed-close svg,.kh-embed-reset svg{width:18px;height:18px}
    .kh-embed-messages{flex:1;padding:18px 17px;overflow-y:auto;scroll-behavior:smooth;background:#f7f8fc}.kh-embed-messages,.kh-embed-table-wrap,.kh-embed-data{scrollbar-width:thin;scrollbar-color:#a8b0bd transparent}.kh-embed-messages::-webkit-scrollbar,.kh-embed-table-wrap::-webkit-scrollbar,.kh-embed-data::-webkit-scrollbar{width:4px;height:4px}.kh-embed-messages::-webkit-scrollbar-track,.kh-embed-table-wrap::-webkit-scrollbar-track,.kh-embed-data::-webkit-scrollbar-track{background:transparent}.kh-embed-messages::-webkit-scrollbar-thumb,.kh-embed-table-wrap::-webkit-scrollbar-thumb,.kh-embed-data::-webkit-scrollbar-thumb{border:0;border-radius:999px;background:#a8b0bd;background-clip:padding-box}.kh-embed-messages::-webkit-scrollbar-thumb:horizontal,.kh-embed-table-wrap::-webkit-scrollbar-thumb:horizontal,.kh-embed-data::-webkit-scrollbar-thumb:horizontal{border-right:18px solid transparent;border-left:18px solid transparent}.kh-embed-messages::-webkit-scrollbar-thumb:vertical,.kh-embed-table-wrap::-webkit-scrollbar-thumb:vertical,.kh-embed-data::-webkit-scrollbar-thumb:vertical{border-top:12px solid transparent;border-bottom:12px solid transparent}.kh-embed-messages::-webkit-scrollbar-button,.kh-embed-table-wrap::-webkit-scrollbar-button,.kh-embed-data::-webkit-scrollbar-button{display:none;width:0;height:0}
    .kh-embed-welcome{display:flex;align-items:flex-start;gap:8px;margin-bottom:12px}.kh-embed-mini-avatar{display:grid;place-items:center;flex:0 0 26px;width:26px;height:26px;border-radius:8px;color:var(--kh-primary);background:#eef2ff}.kh-embed-mini-avatar svg{width:15px;height:15px}
    .kh-embed-message{width:fit-content;max-width:88%;margin:0 0 11px;padding:11px 13px;border-radius:12px;font-size:12.8px;line-height:1.58;overflow-wrap:anywhere;box-shadow:0 1px 3px rgba(15,23,42,.035)}.kh-embed-message.ai{border:1px solid #dfe5ee;border-radius:5px 12px 12px;background:#fff;color:#334155}.kh-embed-message.user{margin-left:auto;border-radius:12px 12px 5px;color:#fff;background:var(--kh-primary);box-shadow:0 3px 9px rgba(79,70,229,.15)}.kh-embed-message code{padding:2px 4px;border-radius:4px;color:#4338ca;background:#eef2ff;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px}.kh-embed-link{display:inline-flex;align-items:center;margin:5px 0;padding:7px 10px;border-radius:7px;color:#fff!important;background:var(--kh-primary);font-weight:750;text-decoration:none;box-shadow:0 2px 6px rgba(79,70,229,.14)}.kh-embed-link:hover{filter:brightness(1.04);text-decoration:none}
    .kh-embed-message.kh-embed-has-table{width:100%;max-width:100%}
    .kh-embed-table-wrap{width:100%;margin-top:9px;overflow-x:auto;border:1px solid #dbe3ef;border-radius:10px;background:#fff}.kh-embed-table-wrap table{width:100%;border-collapse:collapse;font-size:11px;line-height:1.4}.kh-embed-table-wrap th,.kh-embed-table-wrap td{padding:8px 9px;border-right:1px solid #e8edf4;border-bottom:1px solid #e8edf4;white-space:nowrap;text-align:left;vertical-align:top}.kh-embed-table-wrap th{color:#334155;background:#f5f7fb;font-weight:750}.kh-embed-table-wrap tr:last-child td{border-bottom:0}.kh-embed-table-wrap th:last-child,.kh-embed-table-wrap td:last-child{border-right:0}.kh-embed-table-wrap tbody tr:nth-child(even){background:#fafbfe}
    .kh-embed-thinking{display:flex;align-items:center;gap:8px;color:#64748b}
    .kh-embed-spinner{width:14px;height:14px;position:relative;display:inline-block;flex-shrink:0}
    .kh-embed-spinner::before,.kh-embed-spinner::after{content:"";position:absolute;inset:0;border-radius:50%;border:1.5px dotted var(--kh-primary);box-shadow:0 0 5px rgba(99,102,241,.3);animation:khspin 3s linear infinite}
    .kh-embed-spinner::after{animation-direction:reverse;transform:scale(.7) rotate(45deg);border-color:#8b5cf6}
    @keyframes khspin{to{transform:rotate(360deg)}}
    .kh-embed-footer{padding:11px 13px 8px;border-top:1px solid #e3e8f0;background:#fff}.kh-embed-form{display:flex;align-items:center;gap:8px;padding:5px 5px 5px 12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;transition:border-color .16s,box-shadow .16s}.kh-embed-form:focus-within{border-color:#818cf8;box-shadow:0 0 0 2px rgba(99,102,241,.1)}
    .kh-embed-input{flex:1;min-width:0;height:36px;padding:0;border:0;outline:none;color:#1e293b;background:transparent;font:inherit;font-size:12.5px}.kh-embed-input::placeholder{color:#94a3b8}.kh-embed-send{display:grid;place-items:center;flex:0 0 38px;width:38px;height:38px;padding:0;border:0;border-radius:10px;color:#fff;background:var(--kh-primary);box-shadow:0 2px 7px rgba(79,70,229,.16);cursor:pointer}.kh-embed-send:hover{filter:brightness(1.04)}.kh-embed-send:disabled{opacity:.55;cursor:not-allowed}.kh-embed-send svg{width:17px;height:17px}
    .kh-embed-brand{display:flex;align-items:center;justify-content:center;gap:5px;padding-top:7px;color:#94a3b8;font-size:9.5px}.kh-embed-brand b{color:#64748b}.kh-embed-error{color:#b91c1c!important;border-color:#fecaca!important;background:#fef2f2!important}.kh-embed-data{margin-top:9px;overflow:auto;border:1px solid #e2e8f0;border-radius:8px}.kh-embed-data table{border-collapse:collapse;font-size:11px}.kh-embed-data th,.kh-embed-data td{padding:6px 8px;border-bottom:1px solid #eef2f7;white-space:nowrap;text-align:left}.kh-embed-citations{margin-top:10px;padding:8px;border:1px solid #dbe4f0;border-radius:10px;background:#f8fafc;font-size:10.5px}.kh-embed-citations summary{color:#334155;cursor:pointer;font-weight:800}.kh-embed-citations article{margin-top:7px;padding:8px;border:1px solid #e2e8f0;border-radius:8px;background:#fff}.kh-embed-citations article>div{display:flex;align-items:center;gap:6px}.kh-embed-citations article b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kh-embed-citations article span{color:#64748b;white-space:nowrap}.kh-embed-citations article a{margin-left:auto;color:var(--kh-primary);white-space:nowrap}.kh-embed-citations blockquote{margin:6px 0 0;padding-left:8px;border-left:2px solid #a5b4fc;color:#475569;line-height:1.5}.kh-embed-citation-warning{margin-top:9px;padding:8px;border:1px solid #fde68a;border-radius:8px;color:#92400e;background:#fffbeb;font-size:10.5px}.kh-embed-chart{margin-top:10px;padding:12px;border:1px solid #d7dfeb;border-radius:11px;background:#fff}.kh-embed-chart>strong{display:block;margin-bottom:9px;color:#263449;font-size:12.5px;font-weight:800}.kh-embed-chart svg{display:block;width:100%;height:auto;overflow:visible;stroke:none}.kh-embed-chart svg text{stroke:none;paint-order:normal}.kh-chart-grid line{stroke:#d5deea;stroke-width:1}.kh-chart-grid text,.kh-chart-labels text{fill:#475569;font-size:11px;font-weight:500}.kh-pie-wrap{display:flex;align-items:center;gap:13px}.kh-pie{flex:0 0 112px;width:112px;height:112px;border-radius:50%}.kh-pie.doughnut{position:relative}.kh-pie.doughnut::after{content:"";position:absolute;inset:28px;border-radius:50%;background:#fff}.kh-chart-legend{display:grid;gap:6px;color:#475569;font-size:11px;font-weight:500}.kh-chart-legend span{display:flex;align-items:center;gap:5px}.kh-chart-legend i{width:8px;height:8px;border-radius:2px}.kh-chart-legend b{margin-left:auto}
    .kh-embed-root.dark{color:#e5edf8}.kh-embed-root.dark .kh-embed-panel{border-color:#334158;background:#111b2b;box-shadow:0 24px 64px rgba(2,6,23,.5),0 3px 12px rgba(2,6,23,.25)}
    .kh-embed-root.dark .kh-embed-head{background:linear-gradient(135deg,#29256f,#4338a8 58%,#5b21b6)}.kh-embed-root.dark .kh-embed-messages{background:#0f1928}.kh-embed-root.dark .kh-embed-messages::-webkit-scrollbar-thumb{background:#44516a}
    .kh-embed-root.dark .kh-embed-mini-avatar{color:#c4b5fd;background:#29264b}.kh-embed-root.dark .kh-embed-message.ai{color:#d4deed;border-color:#33435b;background:#182438;box-shadow:none}.kh-embed-root.dark .kh-embed-message.user{background:#5145c7;box-shadow:0 3px 10px rgba(0,0,0,.2)}.kh-embed-root.dark .kh-embed-message code{color:#d8d2ff;background:#29264b}
    .kh-embed-root.dark .kh-embed-table-wrap{border-color:#3a4961;background:#172235;scrollbar-color:#66758e transparent}.kh-embed-root.dark .kh-embed-table-wrap::-webkit-scrollbar-track{background:transparent}.kh-embed-root.dark .kh-embed-table-wrap::-webkit-scrollbar-thumb{background:#66758e;background-clip:padding-box}.kh-embed-root.dark .kh-embed-table-wrap::-webkit-scrollbar-thumb:hover{background:#8290a8}.kh-embed-root.dark .kh-embed-table-wrap th{color:#e2e8f0;background:#222f44}.kh-embed-root.dark .kh-embed-table-wrap th,.kh-embed-root.dark .kh-embed-table-wrap td{border-color:#344258}.kh-embed-root.dark .kh-embed-table-wrap tbody tr:nth-child(even){background:#1b293d}
    .kh-embed-root.dark .kh-embed-thinking{color:#9eabc0}.kh-embed-root.dark .kh-embed-footer{border-color:#303e54;background:#121d2d}.kh-embed-root.dark .kh-embed-form{border-color:#3b4a62;background:#172337}.kh-embed-root.dark .kh-embed-form:focus-within{border-color:#766ce0;box-shadow:0 0 0 2px rgba(118,108,224,.14)}.kh-embed-root.dark .kh-embed-input{color:#e6edf7}.kh-embed-root.dark .kh-embed-input::placeholder{color:#718099}
    .kh-embed-root.dark .kh-embed-brand{color:#718099}.kh-embed-root.dark .kh-embed-brand b{color:#9eabc0}.kh-embed-root.dark .kh-embed-error{color:#fecaca!important;border-color:#7f1d1d!important;background:#3a1c25!important}.kh-embed-root.dark .kh-embed-data,.kh-embed-root.dark .kh-embed-chart,.kh-embed-root.dark .kh-embed-citations{color:#d4deed;border-color:#344258;background:#172337}.kh-embed-root.dark .kh-embed-data th,.kh-embed-root.dark .kh-embed-data td{border-color:#344258}.kh-embed-root.dark .kh-embed-citations summary{color:#dbe5f3}.kh-embed-root.dark .kh-embed-citations article{border-color:#344258;background:#1d2a3e}.kh-embed-root.dark .kh-embed-citations article span,.kh-embed-root.dark .kh-embed-citations blockquote{color:#aebbd0}.kh-embed-root.dark .kh-embed-citation-warning{color:#e5c783;border-color:#66522a;background:#342d20}.kh-embed-root.dark .kh-embed-chart>strong{color:#dbe5f3}.kh-embed-root.dark .kh-chart-grid line{stroke:#344258}.kh-embed-root.dark .kh-chart-grid text,.kh-embed-root.dark .kh-chart-labels text{fill:#9eabc0}.kh-embed-root.dark .kh-pie.doughnut::after{background:#172337}
    @media(max-width:520px){.kh-embed-root{${position}:12px;bottom:12px}.kh-embed-panel{width:calc(100vw - 24px);height:calc(100vh - 94px);border-radius:15px}.kh-embed-head{padding:13px 14px}.kh-embed-messages{padding:15px 13px}}
  `;
  // Render inside Shadow DOM so host-page styles cannot break the widget.
  const host = document.createElement('div');
  host.id = 'knowledgehub-embed-host';
  host.dataset.embedId = embedId;
  host.style.cssText = 'all:initial;position:static;width:0;height:0;display:block;';
  const shadow = host.attachShadow({ mode: 'open' });
  const root = document.createElement('div');
  root.className = 'kh-embed-root';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const applyTheme = () => {
    const pageTheme = document.documentElement.dataset.theme;
    const dark = requestedTheme === 'dark' || (requestedTheme === 'auto' && (pageTheme === 'dark' || (!pageTheme && systemTheme.matches)));
    root.classList.toggle('dark', dark);
  };
  applyTheme();
  const themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  systemTheme.addEventListener?.('change', applyTheme);
  host.destroyEmbed = () => {
    activeRequest?.abort();
    messageResizeObserver.disconnect();
    themeObserver.disconnect();
    systemTheme.removeEventListener?.('change', applyTheme);
    host.remove();
    window.KnowledgeHubEmbedLoaded = false;
  };
  root.innerHTML = `<section class="kh-embed-panel" role="dialog" aria-label="${escapeHtml(title)}"><header class="kh-embed-head"><span class="kh-embed-avatar">${botIcon}</span><div class="kh-embed-identity"><strong>${escapeHtml(title)}</strong><span class="kh-embed-status">Đang trực tuyến</span></div><div class="kh-embed-head-actions"><button class="kh-embed-reset" aria-label="Bắt đầu cuộc trò chuyện mới" title="Cuộc trò chuyện mới">${resetIcon}</button><button class="kh-embed-close" aria-label="Đóng">${closeIcon}</button></div></header><div class="kh-embed-messages"></div><footer class="kh-embed-footer"><form class="kh-embed-form"><input class="kh-embed-input" placeholder="Nhập câu hỏi..." autocomplete="off" aria-label="Câu hỏi"><button class="kh-embed-send" aria-label="Gửi">${sendIcon}</button></form><div class="kh-embed-brand">Powered by <b>KnowledgeHub AI</b></div></footer></section><button class="kh-embed-toggle" aria-label="Mở trợ lý AI"><span class="kh-icon-chat">${chatIcon}</span><span class="kh-icon-close">${closeIcon}</span></button>`;
  shadow.append(style, root);
  document.body.appendChild(host);

  const messages = root.querySelector('.kh-embed-messages');
  const input = root.querySelector('.kh-embed-input');
  const sendButton = root.querySelector('.kh-embed-send');
  const toggleButton = root.querySelector('.kh-embed-toggle');
  const append = (content, role, extra = '') => { const node = document.createElement('div'); node.className = `kh-embed-message ${role} ${extra}`; node.innerHTML = content; messages.appendChild(node); followMessages=true; messages.scrollTo({top:messages.scrollHeight,behavior:'instant'}); return node; };
  let followMessages = true, scrollScheduled = false;
  messages.addEventListener('scroll',()=>{if(!scrollScheduled)followMessages=messages.scrollHeight-messages.scrollTop-messages.clientHeight<60;},{passive:true});
  const settleMessageScroll=()=>{if(!followMessages||scrollScheduled)return;scrollScheduled=true;requestAnimationFrame(()=>{if(messages.isConnected)messages.scrollTo({top:messages.scrollHeight,behavior:'instant'});scrollScheduled=false;});};
  const messageResizeObserver=new ResizeObserver(settleMessageScroll);
  style.textContent += `
    .kh-workflow{border:1px solid #dbe3ef;border-radius:10px;padding:12px;margin-top:10px;min-width:0}.kh-workflow h4{margin:12px 0 8px}.kh-workflow label{display:flex;flex-direction:column;gap:6px;margin:12px 0;font-size:12px}.kh-workflow input,.kh-workflow select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;color:#334155}.kh-workflow-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.kh-workflow button{border:1px solid #cbd5e1;border-radius:8px;padding:7px 10px;background:#f1f5f9;color:#334155;cursor:pointer}.kh-workflow button.primary{background:var(--kh-primary);color:#fff;border-color:var(--kh-primary)}.kh-workflow button:disabled{opacity:.5}.kh-workflow-tokens{font-size:11px;color:#94a3b8;margin-top:10px}.dark .kh-workflow{border-color:#41516b;background:#152033}.dark .kh-workflow input,.dark .kh-workflow select{background:#111b2b;color:#e2e8f0;border-color:#41516b}.dark .kh-workflow button{background:#25324a;color:#e2e8f0;border-color:#41516b}.dark .kh-workflow button.primary{background:var(--kh-primary);color:#fff}
  `;
  style.textContent += `
    .kh-workflow-processing{padding:14px 16px;background:#fafaff;border-color:#e5e3f3;border-radius:12px}
    .kh-workflow-file{display:flex;align-items:center;gap:12px;min-width:0;margin-top:4px}
    .kh-workflow-file-name{flex:1;min-width:0;overflow-wrap:anywhere;line-height:1.5}
    .kh-workflow .kh-workflow-download{display:inline-grid;place-items:center;width:30px;height:30px;padding:5px;margin:0;box-sizing:border-box;flex-shrink:0}
    .kh-workflow-download svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    .kh-workflow-title{display:block;font-size:13px;font-weight:600;line-height:1.5;overflow-wrap:anywhere}
    .kh-workflow-progress{display:flex;align-items:center;gap:10px;margin-top:10px;color:#7b7395;font-size:12px;line-height:1.5}
    .kh-workflow-dots{display:inline-flex;gap:3px;align-items:center;height:14px;flex-shrink:0}
    .kh-workflow-dots i{width:4px;height:4px;border-radius:50%;background:#9485cf;animation:kh-workflow-pulse 1.2s ease-in-out infinite}
    .kh-workflow-dots i:nth-child(2){animation-delay:.15s}.kh-workflow-dots i:nth-child(3){animation-delay:.3s}
    @keyframes kh-workflow-pulse{0%,80%,100%{opacity:.35;transform:translateY(0)}40%{opacity:1;transform:translateY(-3px)}}
    .kh-workflow-processing .kh-workflow-actions{justify-content:flex-end;margin-top:10px}
    .kh-workflow-processing button{padding:3px 6px;border-color:transparent;background:transparent;color:#7b7395;font-size:11px;line-height:1.5}
    .kh-workflow-processing button:hover{background:#eeecf8;color:#665294}
    .dark .kh-workflow-processing{background:#1b2234;border-color:#35364e}.dark .kh-workflow-progress,.dark .kh-workflow-processing button{color:#b3abc9}.dark .kh-workflow-processing button{background:transparent}.dark .kh-workflow-processing button:hover{background:#30304a}
    @media(prefers-reduced-motion:reduce){.kh-workflow-dots i{animation:none}}
    .kh-workflow{padding:16px;border-radius:14px;background:#fff;box-shadow:0 3px 12px rgb(15 23 42 / 3%)}
    .kh-workflow-header{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding-bottom:12px;border-bottom:1px solid #e8edf4}
    .kh-workflow-header>strong{flex:1;min-width:120px;font-size:13px;line-height:1.6}
    .kh-workflow-status{padding:4px 8px;border-radius:6px;background:#f1f5f9;color:#64748b;font-size:10px;font-weight:600}
    .kh-workflow[data-status="WAITING_INPUT"] .kh-workflow-status{background:#fff7e6;color:#946200}
    .kh-workflow[data-status="SUCCEEDED"] .kh-workflow-status{background:#eaf8f0;color:#187349}
    .kh-workflow-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:14px;margin-top:14px}
    .kh-workflow-form>label{margin:0;font-weight:500;line-height:1.6}
    .kh-workflow input,.kh-workflow select{min-height:40px;font:inherit;font-weight:400;padding:9px 10px}
    .kh-workflow input:focus,.kh-workflow select:focus{outline:2px solid color-mix(in srgb,var(--kh-primary) 30%,transparent);outline-offset:2px;border-color:var(--kh-primary)}
    .kh-workflow-form>.kh-boolean-field{min-width:0;margin:0;padding:0;border:0}
    .kh-boolean-field>legend{padding:0;margin-bottom:8px;font-weight:500;line-height:1.6}
    .kh-boolean-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
    .kh-workflow .kh-boolean-choice{display:flex;align-items:center;justify-content:center;gap:8px;min-height:44px;box-sizing:border-box;padding:8px 12px;margin:0;border:1px solid #dbe3ef;border-radius:9px;cursor:pointer}
    .kh-boolean-choice:has(input:checked){border-color:var(--kh-primary);background:color-mix(in srgb,var(--kh-primary) 12%,transparent)}
    .kh-workflow .kh-boolean-choice input[type="radio"]{width:16px;height:16px;min-height:0;padding:0;margin:0;flex-shrink:0;accent-color:var(--kh-primary);box-shadow:none;outline:none}
    .kh-boolean-choice:has(input:focus-visible){outline:2px solid var(--kh-primary);outline-offset:3px}
    .dark .kh-boolean-choice{border-color:#41516b}
    .kh-workflow-hint{font-size:10px;color:#7c899c;font-weight:400}
    .kh-workflow-actions{padding-top:12px;border-top:1px solid #e8edf4}
    .kh-workflow-actions>button{min-height:36px;font:500 11px Inter,system-ui,sans-serif;line-height:1.5;padding:8px 12px}
    .kh-workflow .kh-embed-table-wrap{border:1px solid #e1e7f0;border-radius:9px;max-height:360px;overflow:auto;margin:8px 0}
    .kh-workflow .kh-embed-table-wrap th{position:sticky;top:0;background:#f5f7fb;z-index:1;font-size:11px;padding:10px 12px;white-space:nowrap}
    .kh-workflow .kh-embed-table-wrap td{padding:10px 12px;font-size:12px;line-height:1.6;vertical-align:top;max-width:240px;overflow-wrap:anywhere}
    .kh-workflow .kh-embed-table-wrap tbody tr:nth-child(even){background:rgb(148 163 184 / 4%)}
    .kh-workflow .kh-embed-table-wrap tbody tr:hover{background:rgb(112 87 217 / 5%)}
    .kh-workflow .kh-cell-number{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
    .kh-workflow-count{font-size:11px;color:#64748b;margin:6px 0}
    .dark .kh-workflow-header,.dark .kh-workflow-actions{border-color:#354158}.dark .kh-workflow .kh-embed-table-wrap{border-color:#354158}.dark .kh-workflow .kh-embed-table-wrap th{background:#253149;color:#cbd5e1}.dark .kh-workflow-status{background:#25324a;color:#cbd5e1}.dark .kh-workflow[data-status="WAITING_INPUT"] .kh-workflow-status{background:#3c3220;color:#f3ca7e}.dark .kh-workflow[data-status="SUCCEEDED"] .kh-workflow-status{background:#17392f;color:#83dcb1}.dark .kh-workflow-hint,.dark .kh-workflow-count{color:#94a3b8}
    .kh-input-caption{display:flex;align-items:flex-start;gap:8px}
    .kh-workflow-header>strong{flex:1;min-width:0}
    .kh-workflow .kh-workflow-header .kh-workflow-fold{display:grid;place-items:center;flex:0 0 30px;width:30px;height:30px;padding:5px;border:1px solid #d9e1ee;border-radius:8px;background:transparent;color:#7387a9;cursor:pointer}
    .kh-workflow-fold svg{width:16px;height:16px}.kh-workflow .kh-workflow-fold:hover{color:var(--kh-primary);background:color-mix(in srgb,var(--kh-primary) 12%,transparent)}
    .kh-workflow-fold:focus-visible{outline:2px solid var(--kh-primary);outline-offset:2px}
    .dark .kh-workflow .kh-workflow-header .kh-workflow-fold{border-color:#354158;color:#a8b6cd}
    .kh-workflow[data-collapsed="true"]>:not(.kh-workflow-header){display:none!important}
    .kh-workflow[data-collapsed="true"]>.kh-workflow-header{margin-bottom:0;padding-bottom:0;border-bottom:0}
    .kh-input-icon{display:grid;place-items:center;flex:0 0 26px;height:26px;border-radius:8px;background:color-mix(in srgb,var(--kh-primary) 12%,transparent);color:var(--kh-primary)}
    .kh-input-icon svg{width:15px;height:15px}
    .kh-workflow-progress.kh-processing{display:flex;flex-direction:column;gap:18px;padding:28px 8px;color:var(--kh-primary)}
    .kh-processing-graphic{display:flex;align-items:center;gap:10px;width:100%;max-width:300px}
    .kh-processing-source,.kh-processing-core{display:grid;place-items:center;flex:0 0 36px;height:36px;border-radius:11px;background:color-mix(in srgb,var(--kh-primary) 12%,transparent)}
    .kh-processing-source svg{width:19px;height:19px}
    .kh-processing-core{flex-basis:50px;height:50px;border-radius:15px;background:var(--kh-primary);color:#fff;animation:kh-processing-pulse 2s ease-in-out infinite}
    .kh-processing-core svg{width:26px;height:26px}
    .kh-processing-flow{display:flex;flex:1;justify-content:space-around;gap:3px}
    .kh-processing-flow b{width:4px;height:4px;border-radius:2px;background:currentColor;animation:kh-processing-data 1.5s ease-in-out infinite}
    .kh-processing-flow b:nth-child(2){animation-delay:.2s}.kh-processing-flow b:nth-child(3){animation-delay:.4s}
    .kh-processing-copy{display:grid;gap:6px;text-align:center}.kh-processing-copy strong{color:#172033;font-size:14px}.kh-processing-copy>span{color:#64748b;font-size:12px}
    .dark .kh-processing-copy strong{color:#e1e8f5}.dark .kh-processing-copy>span{color:#a8b6cd}
    .dark .kh-input-icon,.dark .kh-processing-graphic{color:color-mix(in srgb,var(--kh-primary) 60%,#fff)}
    @keyframes kh-processing-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}
    @keyframes kh-processing-data{0%,100%{opacity:.2;transform:translateX(-3px)}50%{opacity:1;transform:translateX(3px)}}
    @media(prefers-reduced-motion:reduce){.kh-processing-core,.kh-processing-flow b{animation:none}}
    @supports selector(::-webkit-scrollbar){
      .kh-embed-root :is(.kh-embed-messages,.kh-embed-table-wrap,.kh-embed-data){scrollbar-width:auto}
      .kh-embed-root :is(.kh-embed-messages,.kh-embed-table-wrap,.kh-embed-data)::-webkit-scrollbar{width:6px;height:6px}
    }
  `;
  const workflowApi = async body => {
    const response=await fetch(`${apiBase}/api/embed/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({embedId,sessionId,preview:isPreview,workflowToken,...body})});
    const data=await response.json();if(!response.ok||data.status!=='success')throw new Error(data.message||`HTTP ${response.status}`);return data;
  };
  function decorateWorkflowTable(wrapper,rows,keys) {
    const count=document.createElement('p');count.className='kh-workflow-count';count.textContent=`${rows.length} kết quả`;wrapper.before(count);
    wrapper.querySelectorAll('th').forEach(cell=>cell.scope='col');
    const numeric=keys.map(key=>rows.some(row=>typeof row[key]==='number')&&rows.every(row=>row[key]==null||typeof row[key]==='number'));
    wrapper.querySelectorAll('tbody tr').forEach((line,index)=>line.querySelectorAll('td').forEach((cell,column)=>{if(numeric[column]){cell.className='kh-cell-number';const value=rows[index][keys[column]];if(typeof value==='number')cell.textContent=new Intl.NumberFormat('vi-VN',{maximumFractionDigits:20}).format(value);}}));
  }
  function workflowIcon(kind) {
    const paths={number:'M9 3 7 21M17 3l-2 18M3 9h18M2 15h18',calendar:'M4 5h16v16H4zM8 3v4M16 3v4M4 10h16',toggle:'M8 6h8a6 6 0 0 1 0 12H8A6 6 0 0 1 8 6zM8 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',list:'M9 6h12M9 12h12M9 18h12M3 6h1M3 12h1M3 18h1',layers:'m12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5',text:'M4 5h16M12 5v15M8 20h8',data:'M4 6c0-4 16-4 16 0s-16 4-16 0M4 6v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0',file:'M5 3h9l5 5v13H5zM14 3v6h5M9 13h6M9 17h6'};
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[kind]||paths.text}"/></svg>`;
  }
  function workflowInput(parent,schema,label,required=true) {
    const group=document.createElement(schema.type==='boolean'?'fieldset':'label');const title=document.createElement(schema.type==='boolean'?'legend':'span');title.textContent=label;group.appendChild(title);parent.appendChild(group);
    title.className='kh-input-caption';
    const kind=schema.enum?'list':schema.type==='boolean'?'toggle':['date','date-time'].includes(schema.format)?'calendar':['integer','number'].includes(schema.type)?'number':schema.type==='array'?'list':schema.type==='object'?'layers':'text';
    const icon=document.createElement('span');icon.className='kh-input-icon';icon.innerHTML=workflowIcon(kind);title.prepend(icon);
    if(schema.type==='boolean') {
      group.className='kh-boolean-field';
      const options=document.createElement('div');options.className='kh-boolean-choices';group.appendChild(options);
      const name=`kh-boolean-${createSessionId()}`;
      for(const value of schema.enum||[true,false]) {
        const card=document.createElement('label');card.className='kh-boolean-choice';
        const input=document.createElement('input');input.type='radio';input.name=name;input.value=String(value);input.required=required;
        const caption=document.createElement('span');caption.textContent=value?'C\u00f3':'Kh\u00f4ng';card.append(input,caption);options.appendChild(card);
      }
      if(required){const hint=document.createElement('span');hint.className='kh-workflow-hint';hint.textContent='B\u1eaft bu\u1ed9c';group.appendChild(hint);}
      return ()=>{const selected=options.querySelector('input:checked');return selected?selected.value==='true':undefined;};
    }
    if(schema.type==='object') {const reads=Object.entries(schema.properties||{}).map(([key,s])=>[key,workflowInput(group,s,s.title||key)]);return ()=>Object.fromEntries(reads.map(([key,read])=>[key,read()]));}
    if(schema.type==='array') {const reads=[];const add=document.createElement('button');add.type='button';add.textContent='Thêm mục';add.onclick=()=>reads.push(workflowInput(group,schema.items,`Mục ${reads.length+1}`));group.appendChild(add);return ()=>reads.map(read=>read());}
    const choices=schema.enum||(schema.type==='boolean'?[true,false]:null);const control=document.createElement(choices?'select':'input');
    if(choices) {control.appendChild(new Option('Chọn…',''));choices.forEach((value,index)=>control.appendChild(new Option(formatDisplayValue(value),String(index))));}
    else {control.type=['number','integer'].includes(schema.type)?'number':schema.format==='date'?'date':'text';if(control.type==='number')control.placeholder='0';if(schema.type==='integer')control.step='1';}
    control.required=required;for(const [key,attr]of [['minimum','min'],['maximum','max'],['minLength','minLength'],['maxLength','maxLength']])if(schema[key]!==undefined)control[attr]=schema[key];if(schema.type==='number')control.step='any';
    group.appendChild(control);const hint=document.createElement('span');hint.className='kh-workflow-hint';hint.textContent=schema.minimum!==undefined&&schema.maximum!==undefined?`Từ ${schema.minimum} đến ${schema.maximum}`:required?'Bắt buộc':'';if(hint.textContent)group.appendChild(hint);return ()=>choices?(control.value===''?undefined:choices[Number(control.value)]):control.value===''?undefined:['number','integer'].includes(schema.type)?Number(control.value):control.value;
  }
  function mountWorkflow(node,execution) {
    messageResizeObserver.observe(node);
    if(execution.id) {
      const previous=workflowPanels.get(execution.id);
      if(previous&&previous!==node&&previous.isConnected) {
        if(previous.compareDocumentPosition(node)&Node.DOCUMENT_POSITION_FOLLOWING) {
          previous.replaceChildren();previous.dataset.workflowArchived='true';
          previous.classList.remove('kh-workflow-processing');previous.setAttribute('aria-busy','false');
          const notice=document.createElement('span');notice.textContent='Tác vụ này được tiếp tục ở tin nhắn mới hơn. ';
          const link=document.createElement('button');link.type='button';link.textContent='Đến form hiện tại';link.onclick=()=>workflowPanels.get(execution.id)?.scrollIntoView({block:'center',behavior:'smooth'});
          previous.append(notice,link);
        } else return;
      }
      workflowPanels.set(execution.id,node);delete node.dataset.workflowArchived;
      workflowExecutions.set(execution.id,execution);
    }
    if(execution.id&&!workflowRuns.includes(execution.id)){workflowRuns.push(execution.id);workflowRuns=workflowRuns.slice(-20);saveWorkflow();}
    node.replaceChildren();node.classList.add('kh-workflow');node.dataset.status=execution.status;const heading=document.createElement('strong');const states={READY:'Đang chờ chạy',RUNNING:'Đang xử lý',WAITING_INPUT:'Chờ bổ sung',SUCCEEDED:'Hoàn thành',FAILED:'Không thành công',CANCELLED:'Đã hủy',NEEDS_REVIEW:'Cần kiểm tra'};heading.textContent=execution.name||'Chọn nghiệp vụ';const header=document.createElement('div');header.className='kh-workflow-header';const badge=document.createElement('span');badge.className='kh-workflow-status';badge.textContent=states[execution.status]||execution.status;header.append(heading,badge);node.appendChild(header);
    const processing=['READY','RUNNING','QUEUED'].includes(execution.status);
    const fold=document.createElement('button');fold.type='button';fold.className='kh-workflow-fold';
    const updateFold=()=>{const collapsed=node.dataset.collapsed==='true';fold.setAttribute('aria-expanded',String(!collapsed));fold.setAttribute('aria-label',collapsed?'Mở rộng nghiệp vụ':'Thu gọn nghiệp vụ');fold.title=collapsed?'Mở rộng':'Thu gọn';fold.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="${collapsed?'m6 9 6 6 6-6':'m6 15 6-6 6 6'}"/></svg>`;};
    fold.onclick=()=>{node.dataset.collapsed=String(node.dataset.collapsed!=='true');updateFold();};updateFold();header.appendChild(fold);
    node.classList.toggle('kh-workflow-processing',processing);node.setAttribute('aria-busy',String(processing));
    if(processing){
      heading.textContent=execution.name||'Xử lý nghiệp vụ';heading.className='kh-workflow-title';
      const progress=document.createElement('div');progress.className='kh-workflow-progress';progress.setAttribute('role','status');
      progress.classList.add('kh-processing');
      progress.innerHTML=`<div class="kh-processing-graphic" aria-hidden="true"><span class="kh-processing-source">${workflowIcon('data')}</span><span class="kh-processing-flow"><b></b><b></b><b></b></span><span class="kh-processing-core">${workflowIcon('layers')}</span><span class="kh-processing-flow"><b></b><b></b><b></b></span><span class="kh-processing-source">${workflowIcon('file')}</span></div><div class="kh-processing-copy"><strong>Đang xử lý thông tin</strong><span>Kết quả sẽ hiển thị khi hoàn tất.</span></div>`;node.appendChild(progress);
    }
    const actions=document.createElement('div');actions.className='kh-workflow-actions';
    const action=(text,body,primary=false)=>{const button=document.createElement('button');button.type='button';button.textContent=text;if(primary)button.className='primary';button.onclick=async()=>{if(button.disabled)return;const version=conversationVersion;button.disabled=true;const originalText=button.textContent;const payload=typeof body==='function'?null:body;if(payload?.parentRunId)button.textContent='Đang mở form…';try{const data=await workflowApi(payload||body());if(version!==conversationVersion||!node.isConnected)return;if(body.workflowAction==='create'){if(body.parentRunId)mountWorkflow(node,{...execution,retryRunId:data.execution.id,retryWaitingInput:data.execution.status==='WAITING_INPUT'});const next=append('','ai');mountWorkflow(next,data.execution);next.scrollIntoView({block:'start',behavior:'smooth'});next.querySelector('input,select,textarea')?.focus({preventScroll:true});}else mountWorkflow(node,data.execution);}catch(e){if(version===conversationVersion)append(escapeHtml(e.message),'ai','kh-embed-error');}finally{button.disabled=false;button.textContent=originalText;}};actions.appendChild(button);return button;};
    if(execution.status==='SELECT_TEMPLATE')for(const candidate of execution.candidates||[])action(candidate.name,{workflowAction:'create',templateId:candidate.id,requestId:createSessionId()});
    if(execution.status==='WAITING_INPUT'){const form=document.createElement('form');form.className='kh-workflow-form';node.appendChild(form);const reads=(execution.missingInputs||[]).map(slot=>[slot.key,workflowInput(form,slot.schema,slot.ask||slot.label,slot.required!==false)]);const submit=action('Bổ sung và tiếp tục',()=>{if(!form.reportValidity())throw new Error('Vui lòng hoàn thiện thông tin bắt buộc.');return {workflowAction:'inputs',runId:execution.id,revision:execution.revision,inputs:Object.fromEntries(reads.map(([key,read])=>[key,read()]))};},true);form.onsubmit=event=>{event.preventDefault();submit.click();};}
    for(const [key,value] of Object.entries(execution.result||{})){
      if(key==='empty'&&typeof value==='boolean')continue;
      const title=document.createElement('h4');title.textContent=execution.presentation?.labels?.[key]||key;node.appendChild(title);
      if(value?.kind==='bar-chart'&&Array.isArray(value.points)){const wrapper=document.createElement('div');wrapper.innerHTML=renderEmbedChart(value);node.appendChild(wrapper);continue;}
      if(Array.isArray(value)&&value.every(row=>row&&typeof row==='object')){const keys=execution.presentation?.columns?.[key]||[...new Set(value.flatMap(row=>Object.keys(row)))];const wrapper=document.createElement('div');wrapper.className='kh-embed-table-wrap';wrapper.innerHTML=value.length?`<table><thead><tr>${keys.map(column=>`<th>${escapeHtml(execution.presentation?.labels?.[`${key}.${column}`]||column)}</th>`).join('')}</tr></thead><tbody>${value.map(row=>`<tr>${keys.map(column=>`<td>${escapeHtml(formatDisplayValue(row[column],column))}</td>`).join('')}</tr>`).join('')}</tbody></table>`:escapeHtml(execution.presentation?.emptyText||'Không có dữ liệu.');node.appendChild(wrapper);decorateWorkflowTable(wrapper,value,keys);}
      else {const text=document.createElement('span');text.textContent=formatDisplayValue(value);node.appendChild(text);}
    }
    if(execution.error){const text=document.createElement('p');text.textContent=execution.error;node.appendChild(text);}
    for(const artifact of execution.artifacts||[]) {
      const download=document.createElement('button');download.type='button';download.className='kh-workflow-download';download.title=`Tải ${artifact.filename}`;download.setAttribute('aria-label',download.title);
      download.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4"/></svg>';
      download.onclick=async()=>{
        download.disabled=true;
        try {
          const response=await fetch(`${apiBase}/api/embed/chat`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({embedId,sessionId,preview:isPreview,workflowToken,workflowAction:'artifact',runId:execution.id,artifactId:artifact.id})});
          if(!response.ok){const error=await response.json();throw new Error(error.message||'Không tải được file.');}
          const url=URL.createObjectURL(await response.blob());const link=document.createElement('a');link.href=url;link.download=artifact.filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
        }catch(error){append(escapeHtml(error.message),'ai','kh-embed-error');}finally{download.disabled=false;}
      };
      const filename=[...node.children].find(child=>child.tagName==='SPAN'&&child.textContent===artifact.filename);
      const row=document.createElement('div');row.className='kh-workflow-file';
      if(filename){filename.before(row);filename.className='kh-workflow-file-name';row.appendChild(filename);}
      else{const name=document.createElement('span');name.className='kh-workflow-file-name';name.textContent=artifact.filename;row.appendChild(name);node.appendChild(row);}
      row.appendChild(download);
    }
    if(['SUCCEEDED','FAILED','CANCELLED'].includes(execution.status)&&!execution.retryRunId&&!execution.retrySuperseded){const retry=action('Làm lại',{workflowAction:'create',templateId:execution.templateId,requestId:createSessionId(),parentRunId:execution.id});retry.disabled=Boolean(execution.retryWaitingInput);if(retry.disabled)retry.title='Hoàn thiện form làm lại để tiếp tục.';}
    else if(execution.id&&!['SUCCEEDED','FAILED','CANCELLED'].includes(execution.status))action('Hủy tác vụ',{workflowAction:'cancel',runId:execution.id,revision:execution.revision});
    node.appendChild(actions);
    settleMessageScroll();
    if(execution.parentRunId){const parent=workflowExecutions.get(execution.parentRunId),parentNode=workflowPanels.get(execution.parentRunId);if(parent&&parentNode?.isConnected&&parent.retryRunId===execution.id&&parent.retryWaitingInput!==(execution.status==='WAITING_INPUT'))mountWorkflow(parentNode,{...parent,retryWaitingInput:execution.status==='WAITING_INPUT'});}
    if(processing||execution.retryWaitingInput){const version=conversationVersion;setTimeout(async()=>{if(version!==conversationVersion||!node.isConnected||workflowPanels.get(execution.id)!==node)return;try{const data=await workflowApi({workflowAction:'get',runId:execution.id});if(version===conversationVersion&&workflowPanels.get(execution.id)===node)mountWorkflow(node,data.execution);}catch(e){if(workflowPanels.get(execution.id)===node)node.appendChild(document.createTextNode(e.message));}},4000);}
  }
  // Keep host-page keyboard shortcuts (Space, arrows, etc.) away from chat input.
  // Do not preventDefault here: the input must retain its native text behavior.
  ['keydown', 'keypress', 'keyup', 'beforeinput', 'input'].forEach(eventName => {
    input.addEventListener(eventName, event => event.stopPropagation());
  });
  const renderWelcome = () => { messages.innerHTML = `<div class="kh-embed-welcome"><span class="kh-embed-mini-avatar">${botIcon}</span><div class="kh-embed-message ai">${escapeHtml(greeting)}</div></div>`; };
  const resetConversation = () => {
    conversationVersion++;
    activeRequest?.abort(); activeRequest = null;
    history.splice(0, history.length); sessionId = createSessionId();
    workflowToken='';workflowRuns=[];workflowPanels.clear();workflowExecutions.clear();messageResizeObserver.disconnect();followMessages=true;saveWorkflow();
    input.value = ''; input.disabled = false; sendButton.disabled = false;
    renderWelcome(); input.focus();
  };
  renderWelcome();
  if(workflowToken) {
    const version=conversationVersion;
    const savedRuns=[...new Set(workflowRuns)].map(runId=>({runId,node:append('Đang tải tác vụ đã lưu…','ai')}));
    (async()=>{
      for(const {runId,node} of savedRuns){
        if(version!==conversationVersion||!node.isConnected)return;
        try{const data=await workflowApi({workflowAction:'get',runId});if(version!==conversationVersion||!node.isConnected)return;mountWorkflow(node,data.execution);}
        catch(error){if(version!==conversationVersion||!node.isConnected)return;node.textContent=error.message==='DATA_CONFLICT'?'Chưa tải được tác vụ do dữ liệu đang cập nhật. Vui lòng thử lại.':error.message;}
      }
    })();
  }
  toggleButton.onclick = () => {
    root.classList.toggle('open');
    const isOpen = root.classList.contains('open');
    toggleButton.setAttribute('aria-label', isOpen ? 'Đóng trợ lý AI' : 'Mở trợ lý AI');
    if (isOpen) setTimeout(() => input.focus(), 50);
  };
  root.querySelector('.kh-embed-close').onclick = () => { root.classList.remove('open'); toggleButton.setAttribute('aria-label', 'Mở trợ lý AI'); toggleButton.focus(); };
  root.querySelector('.kh-embed-reset').onclick = resetConversation;
  root.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const question = input.value.trim();
    if (!question) return;
    if (!embedId) return append('Widget chưa được cấu hình Embed ID.', 'ai', 'kh-embed-error');
    input.value = ''; input.disabled = true; sendButton.disabled = true;
    append(escapeHtml(question), 'user');
    const thinking = append('<span class="kh-embed-spinner"></span><span>Đang suy nghĩ...</span>', 'ai', 'kh-embed-thinking');
    const requestVersion = conversationVersion;
    activeRequest = new AbortController();
    try {
      const response = await fetch(`${apiBase}/api/embed/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: activeRequest.signal, body: JSON.stringify({ embedId, question, sessionId,workflowToken, history: history.slice(-20), preview: isPreview }) });
      const data = await response.json();
      if (!response.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${response.status}`);
      if (requestVersion !== conversationVersion) return;
      if(data.workflowToken){workflowToken=data.workflowToken;saveWorkflow();}
      if(data.execution){thinking.remove();const node=append('','ai');mountWorkflow(node,data.execution);return;}
      const replyWithoutDownloadLink = stripInlineDownloadLink(data.reply || '', data.downloadUrl);
      const hasMarkdownTable = replyWithoutDownloadLink.includes('|') && /\|?\s*:?-+:?\s*\|/.test(replyWithoutDownloadLink);
      let result = hasMarkdownTable ? renderRichText(replyWithoutDownloadLink) : renderText(replyWithoutDownloadLink);
      if (data.downloadUrl) {
        const downloadHref = new URL(data.downloadUrl, `${apiBase}/`).href;
        result += `<br><a class="kh-embed-link" href="${escapeHtml(downloadHref)}" target="_blank" rel="noopener noreferrer">Tải file kết quả</a>`;
      }
      result += renderEmbedChart(data.chartSpec);
      result += renderEmbedCitations(data.citations, data.citationValidation, data.supportingEvidence);
      if (!hasMarkdownTable && data.toolResult?.rows?.length) {
        const head = data.toolResult.columns.map(column => `<th>${escapeHtml(column)}</th>`).join('');
        const rows = data.toolResult.rows.slice(0, 20).map(row => `<tr>${row.map((cell, cellIndex) => `<td>${escapeHtml(formatDisplayValue(cell, data.toolResult.columns[cellIndex]))}</td>`).join('')}</tr>`).join('');
        result += `<details class="kh-embed-data"><summary style="padding:7px 8px;cursor:pointer">Xem dữ liệu (${data.toolResult.rows.length} dòng)</summary><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></details>`;
      }
      thinking.remove(); append(result, 'ai', hasMarkdownTable ? 'kh-embed-has-table' : '');
      if (data.completionStatus === 'SUCCESS') {
        history.push({ role: 'user', content: question }, { role: 'assistant', content: data.reply || '' });
      }
    } catch (error) {
      if (error.name === 'AbortError' || requestVersion !== conversationVersion) return;
      thinking.remove(); append(escapeHtml(error.message), 'ai', 'kh-embed-error');
    } finally { if (requestVersion === conversationVersion) { activeRequest = null; input.disabled = false; sendButton.disabled = false; input.focus(); } }
  };
})();
