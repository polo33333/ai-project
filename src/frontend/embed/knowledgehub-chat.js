(function () {
  'use strict';
  if (window.KnowledgeHubEmbedLoaded) return;
  window.KnowledgeHubEmbedLoaded = true;

  const script = document.currentScript;
  const embedId = script?.dataset.embedId || '';
  const apiBase = (script?.dataset.apiBase || new URL(script.src).origin).replace(/\/$/, '');
  const title = script?.dataset.title || 'Trợ lý AI';
  const greeting = script?.dataset.greeting || 'Xin chào! Tôi có thể giúp gì cho bạn?';
  const primary = script?.dataset.color || '#4f46e5';
  const position = script?.dataset.position === 'left' ? 'left' : 'right';
  const history = [];
  let sessionId = createSessionId();
  let activeRequest = null;
  let conversationVersion = 0;

  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const renderText = value => escapeHtml(value)
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
  const chartColors = ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#a855f7', '#14b8a6', '#f97316'];
  const renderEmbedChart = spec => {
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
    const width = 420, height = 220, left = 44, right = 12, top = 18, bottom = 48;
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
    .kh-embed-panel{position:absolute;${position}:0;bottom:72px;display:flex;flex-direction:column;width:min(400px,calc(100vw - 28px));height:min(640px,calc(100vh - 105px));overflow:hidden;border:1px solid rgba(203,213,225,.9);border-radius:22px;background:#fff;box-shadow:0 28px 80px rgba(15,23,42,.26),0 4px 16px rgba(15,23,42,.08);opacity:0;visibility:hidden;transform:translateY(14px) scale(.97);transform-origin:bottom ${position};pointer-events:none;transition:opacity .2s ease,transform .2s ease,visibility .2s}
    .kh-embed-root.open .kh-embed-panel{opacity:1;visibility:visible;transform:translateY(0) scale(1);pointer-events:auto}
    .kh-embed-head{position:relative;display:flex;align-items:center;gap:11px;padding:15px 16px;color:#fff;background:linear-gradient(135deg,#312e81,var(--kh-primary) 55%,#7c3aed)}.kh-embed-head::after{content:"";position:absolute;inset:auto 0 0;height:1px;background:rgba(255,255,255,.18)}
    .kh-embed-avatar{display:grid;place-items:center;width:38px;height:38px;border:1px solid rgba(255,255,255,.3);border-radius:12px;background:rgba(255,255,255,.16);box-shadow:inset 0 1px rgba(255,255,255,.18)}.kh-embed-avatar svg{width:21px;height:21px}
    .kh-embed-identity{flex:1;min-width:0}.kh-embed-identity strong{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:800}.kh-embed-status{display:flex;align-items:center;gap:5px;margin-top:3px;color:rgba(255,255,255,.78);font-size:10.5px}.kh-embed-status::before{content:"";width:6px;height:6px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 3px rgba(74,222,128,.16)}
    .kh-embed-head-actions{display:flex;align-items:center;gap:5px}.kh-embed-close,.kh-embed-reset{display:grid;place-items:center;width:32px;height:32px;padding:0;border:0;border-radius:9px;color:#fff;background:rgba(255,255,255,.1);cursor:pointer}.kh-embed-close:hover,.kh-embed-reset:hover{background:rgba(255,255,255,.2)}.kh-embed-close svg,.kh-embed-reset svg{width:18px;height:18px}
    .kh-embed-messages{flex:1;padding:18px 15px;overflow-y:auto;scroll-behavior:smooth;background:linear-gradient(180deg,#f8fafc,#f4f6fb)}.kh-embed-messages::-webkit-scrollbar{width:5px}.kh-embed-messages::-webkit-scrollbar-thumb{border-radius:8px;background:#cbd5e1}
    .kh-embed-welcome{display:flex;align-items:flex-start;gap:8px;margin-bottom:12px}.kh-embed-mini-avatar{display:grid;place-items:center;flex:0 0 26px;width:26px;height:26px;border-radius:8px;color:var(--kh-primary);background:#eef2ff}.kh-embed-mini-avatar svg{width:15px;height:15px}
    .kh-embed-message{width:fit-content;max-width:86%;margin:0 0 11px;padding:10px 12px;border-radius:14px;font-size:12.8px;line-height:1.58;overflow-wrap:anywhere;box-shadow:0 2px 8px rgba(15,23,42,.04)}.kh-embed-message.ai{border:1px solid #e2e8f0;border-radius:4px 14px 14px;background:#fff;color:#334155}.kh-embed-message.user{margin-left:auto;border-radius:14px 14px 4px;color:#fff;background:linear-gradient(135deg,var(--kh-primary),#6d5dfc);box-shadow:0 5px 14px rgba(79,70,229,.18)}.kh-embed-message code{padding:2px 4px;border-radius:4px;color:#4338ca;background:#eef2ff;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px}.kh-embed-link{display:inline-flex;align-items:center;margin:4px 0;padding:7px 10px;border-radius:8px;color:#fff!important;background:linear-gradient(135deg,var(--kh-primary),#7c3aed);font-weight:750;text-decoration:none;box-shadow:0 4px 10px rgba(79,70,229,.18)}.kh-embed-link:hover{filter:brightness(1.06);text-decoration:none}
    .kh-embed-thinking{display:flex;align-items:center;gap:8px;color:#64748b}
    .kh-embed-spinner{width:14px;height:14px;position:relative;display:inline-block;flex-shrink:0}
    .kh-embed-spinner::before,.kh-embed-spinner::after{content:"";position:absolute;inset:0;border-radius:50%;border:1.5px dotted var(--kh-primary);box-shadow:0 0 5px rgba(99,102,241,.3);animation:khspin 3s linear infinite}
    .kh-embed-spinner::after{animation-direction:reverse;transform:scale(.7) rotate(45deg);border-color:#8b5cf6}
    @keyframes khspin{to{transform:rotate(360deg)}}
    .kh-embed-footer{padding:10px 12px 8px;border-top:1px solid #e2e8f0;background:#fff}.kh-embed-form{display:flex;align-items:center;gap:8px;padding:5px 5px 5px 12px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;transition:border-color .16s,box-shadow .16s}.kh-embed-form:focus-within{border-color:var(--kh-primary);box-shadow:0 0 0 3px rgba(79,70,229,.1)}
    .kh-embed-input{flex:1;min-width:0;height:36px;padding:0;border:0;outline:none;color:#1e293b;background:transparent;font:inherit;font-size:12.5px}.kh-embed-input::placeholder{color:#94a3b8}.kh-embed-send{display:grid;place-items:center;flex:0 0 38px;width:38px;height:38px;padding:0;border:0;border-radius:11px;color:#fff;background:linear-gradient(135deg,var(--kh-primary),#7c3aed);box-shadow:0 5px 12px rgba(79,70,229,.2);cursor:pointer}.kh-embed-send:hover{filter:brightness(1.06)}.kh-embed-send:disabled{opacity:.55;cursor:not-allowed}.kh-embed-send svg{width:17px;height:17px}
    .kh-embed-brand{display:flex;align-items:center;justify-content:center;gap:5px;padding-top:7px;color:#94a3b8;font-size:9.5px}.kh-embed-brand b{color:#64748b}.kh-embed-error{color:#b91c1c!important;border-color:#fecaca!important;background:#fef2f2!important}.kh-embed-data{margin-top:9px;overflow:auto;border:1px solid #e2e8f0;border-radius:8px}.kh-embed-data table{border-collapse:collapse;font-size:11px}.kh-embed-data th,.kh-embed-data td{padding:6px 8px;border-bottom:1px solid #eef2f7;white-space:nowrap;text-align:left}.kh-embed-chart{margin-top:10px;padding:10px;border:1px solid #e2e8f0;border-radius:11px;background:#fff}.kh-embed-chart>strong{display:block;margin-bottom:7px;color:#334155;font-size:11.5px}.kh-embed-chart svg{display:block;width:100%;height:auto;overflow:visible}.kh-chart-grid line{stroke:#e2e8f0;stroke-width:1}.kh-chart-grid text,.kh-chart-labels text{fill:#64748b;font-size:9px}.kh-pie-wrap{display:flex;align-items:center;gap:13px}.kh-pie{flex:0 0 112px;width:112px;height:112px;border-radius:50%}.kh-pie.doughnut{position:relative}.kh-pie.doughnut::after{content:"";position:absolute;inset:28px;border-radius:50%;background:#fff}.kh-chart-legend{display:grid;gap:5px;font-size:9.5px}.kh-chart-legend span{display:flex;align-items:center;gap:5px}.kh-chart-legend i{width:8px;height:8px;border-radius:2px}.kh-chart-legend b{margin-left:auto}
    @media(max-width:480px){.kh-embed-root{${position}:12px;bottom:12px}.kh-embed-panel{width:calc(100vw - 24px);height:calc(100vh - 94px);border-radius:18px}.kh-embed-head{padding:13px 14px}}
  `;
  // Render inside Shadow DOM so host-page styles cannot break the widget.
  const host = document.createElement('div');
  host.id = 'knowledgehub-embed-host';
  host.style.cssText = 'all:initial;position:static;width:0;height:0;display:block;';
  const shadow = host.attachShadow({ mode: 'open' });
  const root = document.createElement('div');
  root.className = 'kh-embed-root';
  root.innerHTML = `<section class="kh-embed-panel" role="dialog" aria-label="${escapeHtml(title)}"><header class="kh-embed-head"><span class="kh-embed-avatar">${botIcon}</span><div class="kh-embed-identity"><strong>${escapeHtml(title)}</strong><span class="kh-embed-status">Đang trực tuyến</span></div><div class="kh-embed-head-actions"><button class="kh-embed-reset" aria-label="Bắt đầu cuộc trò chuyện mới" title="Cuộc trò chuyện mới">${resetIcon}</button><button class="kh-embed-close" aria-label="Đóng">${closeIcon}</button></div></header><div class="kh-embed-messages"></div><footer class="kh-embed-footer"><form class="kh-embed-form"><input class="kh-embed-input" placeholder="Nhập câu hỏi..." autocomplete="off" aria-label="Câu hỏi"><button class="kh-embed-send" aria-label="Gửi">${sendIcon}</button></form><div class="kh-embed-brand">Powered by <b>KnowledgeHub AI</b></div></footer></section><button class="kh-embed-toggle" aria-label="Mở trợ lý AI"><span class="kh-icon-chat">${chatIcon}</span><span class="kh-icon-close">${closeIcon}</span></button>`;
  shadow.append(style, root);
  document.body.appendChild(host);

  const messages = root.querySelector('.kh-embed-messages');
  const input = root.querySelector('.kh-embed-input');
  const sendButton = root.querySelector('.kh-embed-send');
  const toggleButton = root.querySelector('.kh-embed-toggle');
  const append = (content, role, extra = '') => { const node = document.createElement('div'); node.className = `kh-embed-message ${role} ${extra}`; node.innerHTML = content; messages.appendChild(node); messages.scrollTop = messages.scrollHeight; return node; };
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
    input.value = ''; input.disabled = false; sendButton.disabled = false;
    renderWelcome(); input.focus();
  };
  renderWelcome();
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
      const response = await fetch(`${apiBase}/api/embed/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: activeRequest.signal, body: JSON.stringify({ embedId, question, sessionId, history: history.slice(-20) }) });
      const data = await response.json();
      if (!response.ok || data.status !== 'success') throw new Error(data.message || `HTTP ${response.status}`);
      if (requestVersion !== conversationVersion) return;
      let result = renderText(data.reply || '');
      result += renderEmbedChart(data.chartSpec);
      const hasMarkdownTable = data.reply && data.reply.includes('|') && /\|?\s*:?-+:?\s*\|/.test(data.reply);
      if (!hasMarkdownTable && data.toolResult?.rows?.length) {
        const head = data.toolResult.columns.map(column => `<th>${escapeHtml(column)}</th>`).join('');
        const rows = data.toolResult.rows.slice(0, 20).map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
        result += `<details class="kh-embed-data"><summary style="padding:7px 8px;cursor:pointer">Xem dữ liệu (${data.toolResult.rows.length} dòng)</summary><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></details>`;
      }
      thinking.remove(); append(result, 'ai');
      history.push({ role: 'user', content: question }, { role: 'assistant', content: data.reply || '' });
    } catch (error) {
      if (error.name === 'AbortError' || requestVersion !== conversationVersion) return;
      thinking.remove(); append(escapeHtml(error.message), 'ai', 'kh-embed-error');
    } finally { if (requestVersion === conversationVersion) { activeRequest = null; input.disabled = false; sendButton.disabled = false; input.focus(); } }
  };
})();
