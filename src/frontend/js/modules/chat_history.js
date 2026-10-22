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
    return { label: 'Embed Chat', icon: 'fa-window-restore', tone: 'embed', detail: (payload.visitorIdentity?.verified ? `${payload.visitorIdentity.name} · ${payload.visitorIdentity.subject}` : `Khách · ${payload.sessionId || ''}`) + ` · ${payload.origin || payload.embedId || ''}` };
  }
  if (endpoint.startsWith('/api/intelligent-core/chat')) {
    return { label: 'Page Chat', icon: 'fa-comments', tone: 'page', detail: '' };
  }
  if (endpoint === '/api/v1/chat/completions') {
    return { label: 'OpenAI API', icon: 'fa-code', tone: 'api', detail: endpoint };
  }
  if (endpoint) return { label: 'API', icon: 'fa-plug', tone: 'api', detail: endpoint };
  return { label: 'Không xác định', icon: 'fa-circle-question', tone: 'unknown', detail: '' };
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
    const source = getChatSource(item);
    const text = normalize(JSON.stringify(item) + ' ' + source.label + ' ' + source.detail);
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
        <td colspan="8" class="chat-history-empty">
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
    const model = item.modelName || item.model || 'Chưa rõ model';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="chat-time">${escapeHtml(item.timestamp || '-')}</td>
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
    host.innerHTML='<pre><code>'+highlightAuditJson(getAuditPayload(item).text)+'</code></pre>';
    panel.dataset.loaded='true';
  }catch(error){host.textContent=error.message+' Đóng và mở lại để thử lại.';}
  finally{delete panel.dataset.loading;host.removeAttribute('aria-busy');}
}

window.loadChatAuditDetails = loadChatAuditDetails;
window.fetchChatHistory = fetchChatHistory;
window.renderChatHistoryTable = renderChatHistoryTable;
