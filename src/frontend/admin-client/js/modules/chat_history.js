/**
 * Chat History & AI Audit Logs Module
 */

window.chatHistoryData = [];

async function fetchChatHistory() {
  try {
    const res = await fetch('/api/chat-history?list=1');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    window.chatHistoryData = await res.json();
    renderChatHistoryTable();
  } catch (err) {
    console.error("Lỗi nạp Lịch sử Chat:", err);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatJson(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch (_) {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function highlightAuditJson(json) {
  const normalized = String(json)
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return escapeHtml(normalized).replace(/(&quot;(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\&])*&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (match, quoted, colon, literal, number) => {
    if (quoted) return `<span class="json-token ${colon ? 'json-key' : 'json-string'}">${quoted}</span>${colon || ''}`;
    if (literal) return `<span class="json-token json-literal">${literal}</span>`;
    return `<span class="json-token json-number">${number}</span>`;
  });
}

function getAuditPayload(item) {
  const requestPayload = item.requestPayload || item.aiRequestData || item.payload;
  const query = item.sqlQuery || item.sql || item.generatedSql || null;
  const auditJson = {
    question: item.prompt || item.question || null,
    sqlQuery: query,
    requestPayload: requestPayload || null,
    replyText: item.replyText || item.reply || null,
    errorReason: item.errorReason || null
  };
  return {
    icon: requestPayload ? 'fa-code' : 'fa-database',
    text: formatJson(auditJson)
  };
}

function getChatSource(item) {
  const payload = item.requestPayload || item.aiRequestData || item.payload || {};
  const endpoint = String(payload.endpoint || '');
  if (endpoint === '/api/embed/chat' || payload.embedId) {
    return { label: 'Embed Chat', icon: 'fa-window-restore', tone: 'embed', detail: payload.origin || payload.embedId || '' };
  }
  if (endpoint.startsWith('/api/intelligent-core/chat') || endpoint === '/api/chat/attachments') {
    return { label: 'Page Chat', icon: 'fa-comments', tone: 'page', detail: '' };
  }
  if (endpoint === '/api/v1/chat/completions') {
    return { label: 'OpenAI API', icon: 'fa-code', tone: 'api', detail: endpoint };
  }
  if (endpoint) return { label: 'API', icon: 'fa-plug', tone: 'api', detail: endpoint };
  return { label: 'Không xác định', icon: 'fa-circle-question', tone: 'unknown', detail: '' };
}

// Who asked: the signed-in account, the visitor the website vouched for, or an anonymous widget visitor.
function getChatUser(item) {
  const payload = item.requestPayload || item.aiRequestData || item.payload || {};
  if (payload.account?.id) return { name: payload.account.name || payload.account.id, detail: payload.account.username ? '@' + payload.account.username : 'Tài khoản', tone: 'account', icon: 'fa-user' };
  if (payload.visitorIdentity?.verified) return { name: payload.visitorIdentity.name || payload.visitorIdentity.subject, detail: payload.visitorIdentity.subject || 'Đã xác thực', tone: 'visitor', icon: 'fa-user-check' };
  if (payload.endpoint === '/api/embed/chat' || payload.embedId) return { name: 'Khách' + (payload.sessionId ? ' #' + String(payload.sessionId).slice(-8) : ''), detail: 'Chưa xác thực', tone: 'guest', icon: 'fa-user-secret' };
  return { name: '—', detail: 'Chưa ghi nhận', tone: 'unknown', icon: 'fa-circle-question' };
}

function renderChatHistoryStats(history) {
  const totalEl = document.getElementById('chat-stat-total');
  const successEl = document.getElementById('chat-stat-success');
  const errorEl = document.getElementById('chat-stat-error');
  const latencyEl = document.getElementById('chat-stat-latency');
  if (!totalEl && !successEl && !errorEl && !latencyEl) return;

  const total = history.length;
  const errors = history.filter(item => String(item.status || 'SUCCESS').toUpperCase() === 'ERROR').length;
  const success = total - errors;
  const latencyItems = history
    .map(item => Number(item.latencyMs ?? String(item.latency || '').replace(/[^\d.]/g, '')))
    .filter(value => Number.isFinite(value) && value >= 0);
  const avgLatency = latencyItems.length
    ? Math.round(latencyItems.reduce((sum, value) => sum + value, 0) / latencyItems.length)
    : 0;

  if (totalEl) totalEl.textContent = total;
  if (successEl) successEl.textContent = success;
  if (errorEl) errorEl.textContent = errors;
  if (latencyEl) latencyEl.textContent = avgLatency;
}


function searchChatHistory() {
  if (window.paginationState?.chat_history) window.paginationState.chat_history.currentPage = 1;
  renderChatHistoryTable();
}

function filterChatHistory(history, query) {
  const normalize = value => String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  return terms.length ? history.filter(item => {
    const source = getChatSource(item), user = getChatUser(item);
    const text = normalize(JSON.stringify(item) + ' ' + source.label + ' ' + source.detail + ' ' + user.name + ' ' + user.detail);
    return terms.every(term => text.includes(term));
  }) : history;
}

function renderChatHistoryTable() {
  const tbody = document.getElementById('page-chat-history-tbody') || document.getElementById('chat-history-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const query = document.getElementById('chat-history-search')?.value || '';
  const allHistory = window.chatHistoryData || [];
  const history = filterChatHistory(allHistory, query);
  renderChatHistoryStats(allHistory);

  if (history.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9" class="chat-history-empty">
          <i class="fa-solid fa-clock-rotate-left"></i>
          <strong>${query.trim() ? 'Không tìm thấy trò chuyện phù hợp.' : 'Chưa có lịch sử trò chuyện nào.'}</strong>
        </td>
      </tr>
    `;
    if (typeof renderPaginationControls === 'function') {
      renderPaginationControls('chat-pagination', 'chat_history', 0, renderChatHistoryTable);
    }
    return;
  }

  const state = (window.paginationState && window.paginationState.chat_history) || { currentPage: 1, itemsPerPage: 10 };
  state.currentPage = Math.min(Math.max(1, state.currentPage), Math.max(1, Math.ceil(history.length / state.itemsPerPage)));
  const startIndex = (state.currentPage - 1) * state.itemsPerPage;
  const paginated = history.slice(startIndex, startIndex + state.itemsPerPage);

  paginated.forEach(item => {
    const status = String(item.status || 'SUCCESS').toUpperCase();
    const isError = status === 'ERROR';
    const latency = item.latencyMs != null ? `${item.latencyMs}ms` : (item.latency || '0ms');
    const source = getChatSource(item);
    const user = getChatUser(item);
    const model = item.modelName || item.model || 'Chưa rõ model';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="chat-time">${escapeHtml(item.timestamp || '-')}</td>
      <td>
        <div class="chat-user ${user.tone}" title="${escapeHtml(user.name + ' · ' + user.detail)}">
          <i class="fa-solid ${user.icon}" aria-hidden="true"></i>
          <span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.detail)}</small></span>
        </div>
      </td>
      <td>
        <div class="chat-prompt">${escapeHtml(item.prompt || item.question || '-')}</div>
        ${item.errorReason ? `<div class="chat-error-text">${escapeHtml(item.errorReason)}</div>` : ''}
      </td>
      <td>
        <span class="metric-tag purple chat-model-tag" title="${escapeHtml(model)}">
          <i class="fa-solid fa-wand-magic-sparkles"></i>
          ${escapeHtml(model)}
        </span>
      </td>
      <td>
        <span class="chat-source-tag ${source.tone}" title="${escapeHtml(source.detail || source.label)}">
          <i class="fa-solid ${source.icon}"></i>
          <span>${escapeHtml(source.label)}</span>
        </span>
        ${source.detail && source.tone === 'embed' ? `<code class="chat-source-detail">${escapeHtml(source.detail)}</code>` : ''}
      </td>
      <td><span class="chat-latency">${escapeHtml(latency)}</span></td>
      <td>
        <span class="metric-tag ${isError ? 'red' : 'green'} chat-status-tag">
          <i class="fa-solid ${isError ? 'fa-circle-xmark' : 'fa-shield-halved'}"></i>
          ${escapeHtml(status)}
        </span>
      </td>
      <td>
        ${item.feedback === 'like'
          ? '<span class="metric-tag green"><i class="fa-solid fa-thumbs-up"></i> Thích</span>'
          : item.feedback === 'dislike'
            ? '<span class="metric-tag red"><i class="fa-solid fa-thumbs-down"></i> Không thích</span>'
            : '<span style="color:#94a3b8;font-size:11px;">Chưa đánh giá</span>'}
      </td>
      <td>
        <details class="chat-audit-details" data-audit-id="${escapeHtml(item.id)}" ontoggle="loadChatAuditDetails(this)">
          <summary>Xem JSON</summary>
          <div class="chat-payload-card json-audit-card" data-audit-json></div>
        </details>
      </td>
    `;
    tbody.appendChild(tr);
  });

  if (typeof renderPaginationControls === 'function') {
    renderPaginationControls('chat-pagination', 'chat_history', history.length, renderChatHistoryTable);
  }
}

async function loadChatAuditDetails(panel) {
  if (!panel.open || panel.dataset.loading === 'true' || panel.dataset.loaded === 'true') return;
  const host=panel.querySelector('[data-audit-json]');
  const id=panel.dataset.auditId;
  panel.dataset.loading='true';host.setAttribute('aria-busy','true');host.textContent='Đang tải chi tiết…';
  try {
    const response=await fetch('/api/chat-history?id='+encodeURIComponent(id),{cache:'no-store'});
    const item=await response.json();
    if(!response.ok)throw new Error(item.message||'Không tải được chi tiết.');
    const json = getAuditPayload(item).text;
    host.innerHTML='<div class="chat-audit-actions"><span class="chat-audit-format">{ } <span>JSON</span></span><span class="chat-audit-copy-status" role="status" aria-live="polite"></span><button type="button" title="Sao chép toàn bộ JSON" aria-label="Copy JSON"><i class="fa-regular fa-copy" aria-hidden="true"></i><span>Sao chép</span></button></div><pre><code>'+highlightAuditJson(json)+'</code></pre>';
    host.querySelector('button').addEventListener('click', event => copyAuditJson(event.currentTarget, json));
    panel.dataset.loaded='true';
  }catch(error){host.textContent=error.message+' Đóng và mở lại để thử lại.';}
  finally{delete panel.dataset.loading;host.removeAttribute('aria-busy');}
}

async function copyAuditJson(button, json) {
  const status = button.parentElement.querySelector('[role="status"]');
  const previousFocus = document.activeElement;
  button.disabled = true;
  try {
    let copied = false;
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      try { await navigator.clipboard.writeText(json); copied = true; } catch (_) { /* Try the LAN-compatible fallback. */ }
    }
    if (!copied) {
      const textarea = document.createElement('textarea');
      textarea.value = json;
      textarea.readOnly = true;
      textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(textarea);
      try {
        textarea.focus();
        textarea.select();
        if (!document.execCommand('copy')) throw new Error('Copy failed');
      } finally { textarea.remove(); }
    }
    status.textContent = 'Đã sao chép JSON';
    button.innerHTML = '<i class="fa-solid fa-check" aria-hidden="true"></i><span>Đã chép</span>';
    button.classList.add('is-copied');
    setTimeout(() => {
      button.innerHTML = '<i class="fa-regular fa-copy" aria-hidden="true"></i><span>Sao chép</span>';
      button.classList.remove('is-copied');
      status.textContent = '';
    }, 2000);
  } catch (_) {
    status.textContent = 'Không thể sao chép. Hãy chọn nội dung JSON và nhấn Ctrl+C.';
  } finally {
    button.disabled = false;
    previousFocus?.focus({ preventScroll: true });
  }
}

async function exportChatHistory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const status = form.querySelector('.chat-export-status');
  const data = new FormData(form);
  const params = new URLSearchParams({ channel: data.get('channel') || 'all', format: data.get('format') || 'json' });
  for (const key of ['limit', 'from', 'to']) if (data.get(key)) params.set(key, data.get(key));
  if (data.get('issues')) params.set('issues', '1');
  status.classList.remove('is-error');
  if (params.has('from') && params.has('to') && params.get('from') > params.get('to')) {
    status.classList.add('is-error');
    status.textContent = '"Từ ngày" phải trước hoặc bằng "Đến ngày".';
    return;
  }
  button.disabled = true;
  status.textContent = 'Đang chuẩn bị tệp…';
  try {
    const response = await fetch('/api/chat-history/export?' + params, { cache: 'no-store' });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).message || 'Không xuất được lịch sử chat.');
    const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || `chat-export.${params.get('format')}`;
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = `Đã xuất ${name}`;
  } catch (error) {
    status.classList.add('is-error');
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function chatExportDay(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() - offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Presets fill the date inputs; "Hôm nay" is one day, "7 ngày" includes today and the six days before.
function setChatExportRange(button) {
  const form = button.form;
  if (button.dataset.days === 'custom') {
    syncChatExportDates(form, button);
    form.elements.from.focus();
    return;
  }
  const days = Number(button.dataset.days);
  form.elements.from.value = days ? chatExportDay(days - 1) : '';
  form.elements.to.value = days ? chatExportDay() : '';
  syncChatExportDates(form, button);
}

function syncChatExportDates(form, activePreset = null) {
  const { from, to } = form.elements;
  from.max = to.value || chatExportDay();
  to.min = from.value;
  to.max = chatExportDay();
  const customButton = form.querySelector('[data-days="custom"]');
  const custom = !activePreset || activePreset === customButton;
  form.querySelector('.chat-export-dates').hidden = !custom;
  customButton.setAttribute('aria-expanded', String(custom));
  form.querySelectorAll('.chat-export-presets button').forEach(button => {
    const active = activePreset ? button === activePreset : button === customButton;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

window.exportChatHistory = exportChatHistory;
window.setChatExportRange = setChatExportRange;
window.syncChatExportDates = syncChatExportDates;
window.loadChatAuditDetails = loadChatAuditDetails;
window.fetchChatHistory = fetchChatHistory;
window.renderChatHistoryTable = renderChatHistoryTable;
