// State
window.currentChatSessionId = null;
window.chatSessions = [];  // Start empty - first session created on first view open
window.aiPersona = { name: 'KAI', role: 'Trợ lý Dữ liệu Thông minh' }; // default, overridden by API
const CHAT_STORAGE_KEY = 'knowledgehub_chat_sessions_v1';
const CHAT_ACTIVE_SESSION_KEY = 'knowledgehub_active_chat_session_v1';
const normalizedChatSessions = new WeakSet();
window.pageChatAttachments = [];
window.pageChatWebSearchEnabled = false;
window.pageChatRequestController = null;
window.pageChatIsResponding = false;
window.pageChatPendingThinking = null;
window.pageChatMiniPanelState = { status: 'idle', label: '', question: '' };

function ensurePageChatMiniPanel() {
  let panel = document.getElementById('page-chat-mini-panel');
  if (panel) return panel;
  panel = document.createElement('button');
  panel.id = 'page-chat-mini-panel';
  panel.className = 'page-chat-mini-panel';
  panel.type = 'button';
  panel.hidden = true;
  panel.setAttribute('aria-live', 'polite');
  panel.setAttribute('aria-label', 'Mở cuộc trò chuyện AI');
  panel.innerHTML = `
    <span class="page-chat-mini-icon"><svg class="chat-ai-sparkle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.75c.55 4.95 2.3 6.7 7.25 7.25-4.95.55-6.7 2.3-7.25 7.25C11.45 12.3 9.7 10.55 4.75 10 9.7 9.45 11.45 7.7 12 2.75Z"/><path d="M19 15.75c.22 1.97.91 2.66 2.88 2.88-1.97.22-2.66.91-2.88 2.87-.22-1.96-.91-2.65-2.88-2.87 1.97-.22 2.66-.91 2.88-2.88Z"/></svg></span>
    <span class="page-chat-mini-copy"><strong>Chat AI</strong><span class="page-chat-mini-label"></span><small class="page-chat-mini-question"></small></span>
    <span class="page-chat-mini-status" aria-hidden="true"><i class="fa-solid fa-spinner fa-spin"></i></span>
    <span class="page-chat-mini-progress" aria-hidden="true"><span></span></span>`;
  panel.addEventListener('click', () => window.switchMainTab?.('page-chat'));
  document.body.appendChild(panel);
  return panel;
}

window.updatePageChatMiniPanel = function updatePageChatMiniPanel(nextState) {
  if (nextState) window.pageChatMiniPanelState = { ...window.pageChatMiniPanelState, ...nextState };
  const state = window.pageChatMiniPanelState;
  const activeTab = String(window.activeMainTab || '').replace(/-/g, '_');
  const onChatPage = activeTab === 'page_chat';
  const panel = ensurePageChatMiniPanel();

  panel.hidden = onChatPage || state.status === 'idle';
  panel.dataset.status = state.status;
  panel.querySelector('.page-chat-mini-label').textContent = state.label || 'Đang xử lý yêu cầu…';
  panel.querySelector('.page-chat-mini-question').textContent = state.question || 'Bấm để quay lại cuộc trò chuyện';
  const statusIcon = panel.querySelector('.page-chat-mini-status');
  statusIcon.innerHTML = state.status === 'complete'
    ? '<i class="fa-solid fa-check"></i>'
    : state.status === 'error'
      ? '<i class="fa-solid fa-triangle-exclamation"></i>'
      : state.status === 'stopped'
        ? '<i class="fa-solid fa-stop"></i>'
        : '<i class="fa-solid fa-spinner fa-spin"></i>';

  if (onChatPage && state.status !== 'running') {
    window.pageChatMiniPanelState = { status: 'idle', label: '', question: '' };
  }
};

function setPageChatResponding(active) {
  window.pageChatIsResponding = Boolean(active);
  const button = document.getElementById('page-chat-send-button');
  if (!button) return;
  button.classList.toggle('is-stop', window.pageChatIsResponding);
  button.setAttribute('aria-label', window.pageChatIsResponding ? 'Dừng trả lời' : 'Gửi yêu cầu');
  button.setAttribute('aria-pressed', String(window.pageChatIsResponding));
  button.title = window.pageChatIsResponding ? 'Dừng tiến trình trả lời hiện tại' : 'Gửi yêu cầu';
  button.innerHTML = window.pageChatIsResponding
    ? '<i class="fa-solid fa-square"></i>'
    : '<i class="fa-solid fa-paper-plane"></i>';
}

function stopPageChatResponse() {
  if (!window.pageChatRequestController || !window.pageChatIsResponding) return false;
  window.pageChatRequestController.abort();
  return true;
}

function handlePageChatSendAction() {
  if (window.pageChatIsResponding) {
    stopPageChatResponse();
    return;
  }
  sendPageChatMessage();
}

function closePageChatMenus() {
  document.getElementById('page-chat-model-menu')?.classList.remove('is-open');
  document.getElementById('page-chat-add-menu')?.classList.remove('is-open');
  document.getElementById('page-chat-model-trigger')?.setAttribute('aria-expanded', 'false');
  document.getElementById('page-chat-add-trigger')?.setAttribute('aria-expanded', 'false');
  const knowledgePanel = document.getElementById('page-chat-knowledge-panel');
  if (knowledgePanel) knowledgePanel.hidden = true;
  document.getElementById('page-chat-knowledge-toggle')?.classList.remove('is-active');
  document.getElementById('page-chat-knowledge-toggle')?.setAttribute('aria-expanded', 'false');
}

function toggleChatModelMenu(event) {
  event?.stopPropagation();
  const menu = document.getElementById('page-chat-model-menu');
  const trigger = document.getElementById('page-chat-model-trigger');
  const open = !menu?.classList.contains('is-open');
  closePageChatMenus();
  if (open) { menu?.classList.add('is-open'); trigger?.setAttribute('aria-expanded', 'true'); }
}

function toggleChatAddMenu(event) {
  event?.stopPropagation();
  const menu = document.getElementById('page-chat-add-menu');
  const trigger = document.getElementById('page-chat-add-trigger');
  if (!trigger || trigger.disabled) {
    menu?.classList.remove('is-open');
    return;
  }
  const open = !menu?.classList.contains('is-open');
  closePageChatMenus();
  if (open) { menu?.classList.add('is-open'); trigger?.setAttribute('aria-expanded', 'true'); }
}

function selectPageChatModel(value) {
  const selector = document.getElementById('page-chat-model-selector');
  if (!selector) return;
  selector.value = value;
  const option = selector.options[selector.selectedIndex];
  const label = document.getElementById('page-chat-model-label');
  if (label && option) label.textContent = option.dataset.shortLabel || option.textContent;
  document.querySelectorAll('.page-chat-model-option').forEach(button => {
    button.classList.toggle('is-selected', button.dataset.value === value);
  });
  localStorage.setItem('knowledgehub_selected_chat_model', value);
  closePageChatMenus();
}

function openChatFilePicker(type = 'all') {
  closePageChatMenus();
  document.getElementById(type === 'camera' ? 'page-chat-camera-input' : 'page-chat-file-input')?.click();
}

function handlePageChatFiles(event) {
  const incoming = Array.from(event?.target?.files || []);
  incoming.forEach(file => {
    const duplicate = window.pageChatAttachments.some(item => item.name === file.name && item.size === file.size);
    if (!duplicate && file.size <= 10 * 1024 * 1024) window.pageChatAttachments.push(file);
    else if (file.size > 10 * 1024 * 1024 && typeof showToast === 'function') showToast(`Tệp ${file.name} vượt quá 10 MB`, 'warning');
  });
  if (event?.target) event.target.value = '';
  renderPageChatAttachments();
}

function removePageChatAttachment(index) {
  window.pageChatAttachments.splice(index, 1);
  renderPageChatAttachments();
}

function renderPageChatAttachments() {
  const preview = document.getElementById('page-chat-attachment-preview');
  if (!preview) return;
  preview.classList.toggle('has-files', window.pageChatAttachments.length > 0);
  preview.innerHTML = window.pageChatAttachments.map((file, index) => `
    <div class="page-chat-file-chip">
      <i class="fa-solid ${file.type?.startsWith('image/') ? 'fa-image' : 'fa-file-lines'}"></i>
      <span title="${escapeChatMarkdown(file.name)}">${escapeChatMarkdown(file.name)}</span>
      <button type="button" onclick="removePageChatAttachment(${index})" aria-label="Xóa tệp"><i class="fa-solid fa-xmark"></i></button>
    </div>`).join('');
  renderChatKnowledgeChip();
}

function togglePageChatWebSearch(event) {
  event?.stopPropagation();
  window.pageChatWebSearchEnabled = !window.pageChatWebSearchEnabled;
  if (window.pageChatWebSearchEnabled) {
    const knowledgeSource = document.getElementById('page-chat-knowledge-source');
    if (knowledgeSource) setChatKnowledgeValues(knowledgeSource, ['auto']);
    renderChatKnowledgeOptions();
  }
  document.getElementById('page-chat-web-toggle')?.classList.toggle('is-active', window.pageChatWebSearchEnabled);
  document.getElementById('page-chat-web-toggle')?.setAttribute('aria-pressed', String(window.pageChatWebSearchEnabled));
  renderChatKnowledgeChip();
}

function showChatAddNotice(type) {
  closePageChatMenus();
  const labels = { project: 'Dự án', skills: 'Skills', connector: 'Connector', plugins: 'Plugins' };
  if (typeof showToast === 'function') showToast(`${labels[type] || type} sẽ được cấu hình tại trang quản trị tương ứng.`, 'info');
}

async function buildPageChatAttachmentContext(files) {
  if (!files.length) return '';
  const parts = await Promise.all(files.map(async file => {
    const isText = file.type.startsWith('text/') || /\.(txt|md|csv|json|sql|js|ts|html|css)$/i.test(file.name);
    if (!isText || file.size > 1024 * 1024) return `[Tệp đính kèm: ${file.name}, ${Math.ceil(file.size / 1024)} KB]`;
    try { return `[Nội dung tệp ${file.name}:\n${(await file.text()).slice(0, 12000)}\n]`; }
    catch { return `[Tệp đính kèm: ${file.name}]`; }
  }));
  return `\n\n${parts.join('\n')}`;
}

document.addEventListener('click', closePageChatMenus);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closePageChatMenus();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'u') {
    if (document.getElementById('copilot-modal')?.classList.contains('show')) return;
    event.preventDefault(); openChatFilePicker('all');
  }
});

function saveChatSessions() {
  try {
    localStorage.setItem(CHAT_ACTIVE_SESSION_KEY, window.currentChatSessionId || '');
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify({
      currentChatSessionId: window.currentChatSessionId,
      chatSessions: window.chatSessions || []
    }));
  } catch (err) {
    console.warn('Không thể lưu chat session:', err);
  }
}

function clearBackendConversationMemory(sessionId) {
  if (!sessionId) return;
  fetch('/api/conversation-memory/clear', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId })
  }).catch(() => { });
}

function fixStoredMojibake(value) {
  if (typeof value !== 'string') return value;
  const replacements = [
    ['T\u00c3\u00b4i \u00c4\u2018\u00c3\u00a3 x\u00e1\u00bb\u00ad l\u00c3\u00bd y\u00c3\u00aau c\u00e1\u00ba\u00a7u c\u00e1\u00bb\u00a7a b\u00e1\u00ba\u00a1n.', 'Tôi đã xử lý yêu cầu của bạn.'],
    ['Cu\u00e1\u00bb\u2122c tr\u00c3\u00b2 chuy\u00e1\u00bb\u2021n m\u00e1\u00bb\u203ai', 'Cuộc trò chuyện mới'],
    ['\u00c4\u0090ang x\u00e1\u00bb\u00ad l\u00c3\u00bd', 'Đang xử lý'],
    ['\u00c4\u0090\u00e1\u00bb\u008dc schema v\u00c3\u00a0 ng\u00e1\u00bb\u00af c\u00e1\u00ba\u00a3nh d\u00e1\u00bb\u00af li\u00e1\u00bb\u2021u', 'Phân tích cấu trúc CSDL & Ngữ cảnh'],
    ['G\u00e1\u00bb\u00adi y\u00c3\u00aau c\u00e1\u00ba\u00a7u \u00c4\u2018\u00e1\u00ba\u00bfn AI', 'Khởi chạy chuỗi suy luận AI (Reasoning)'],
    ['L\u00e1\u00bb\u2014i k\u00e1\u00ba\u00bft n\u00e1\u00bb\u2018i AI', 'Lỗi kết nối AI'],
    ['Th\u00c3\u00a0nh c\u00c3\u00b4ng', 'Thành công'],
    ['d\u00c3\u00b2ng', 'dòng'],
    ['b\u00c6\u00b0\u00e1\u00bb\u203ac', 'bước'],
    ['Bi\u00e1\u00bb\u0192u \u00c4\u2018\u00e1\u00bb\u201c d\u00e1\u00bb\u00af li\u00e1\u00bb\u2021u', 'Biểu đồ dữ liệu'],
    ['Cu?c tr? chuy?n m?i', 'Cuộc trò chuyện mới'],
    ['Ch?a c? cu?c tr? chuy?n.', 'Chưa có cuộc trò chuyện.'],
    ['T?o ?o?n chat m?i', 'Tạo đoạn chat mới'],
    ['T?i ?? x? l? y?u c?u c?a b?n.', 'Tôi đã xử lý yêu cầu của bạn.'],
    ['V? bi?u ??', 'Vẽ biểu đồ'],
    ['Xu?t file', 'Xuất file'],
    ['Ki?m tra SQL', 'Kiểm tra SQL'],
    ['S?a SQL', 'Sửa SQL'],
    ['T?m schema', 'Tìm schema'],
    ['Th?ng k?', 'Thống kê'],
    ['d?ng', 'dòng'],
    ['Th?nh c?ng', 'Thành công'],
    ['L?i', 'Lỗi'],
    ['b??c', 'bước'],
    ['Bi?u ?? d? li?u', 'Biểu đồ dữ liệu'],
    ['L?i k?t n?i AI', 'Lỗi kết nối AI']
  ];
  const repaired = replacements.reduce((text, [bad, good]) => text.replaceAll(bad, good), value);
  const sparkle = '<svg class="chat-ai-sparkle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.75c.55 4.95 2.3 6.7 7.25 7.25-4.95.55-6.7 2.3-7.25 7.25C11.45 12.3 9.7 10.55 4.75 10 9.7 9.45 11.45 7.7 12 2.75Z"/><path d="M19 15.75c.22 1.97.91 2.66 2.88 2.88-1.97.22-2.66.91-2.88 2.87-.22-1.96-.91-2.65-2.88-2.87 1.97-.22 2.66-.91 2.88-2.88Z"/></svg>';
  return repaired.replaceAll('<i class="fa-solid fa-wand-magic-sparkles"></i>', sparkle);
}

function normalizeStoredChatSession(session) {
  if (!session || typeof session !== 'object') return session;
  if (normalizedChatSessions.has(session)) return session;
  const idTimestamp = Number(String(session.id || '').match(/(\d{10,})/)?.[1]);
  const fallbackTimestamp = Number.isFinite(idTimestamp) ? idTimestamp : Date.now();
  session.createdAt = Number(session.createdAt) || fallbackTimestamp;
  session.updatedAt = Number(session.updatedAt) || session.createdAt;
  session.title = fixStoredMojibake(session.title || '');
  session.messages = Array.isArray(session.messages)
    ? session.messages.map((message, index) => ({
      ...message,
      createdAt: Number(message.createdAt) || session.createdAt + index,
      html: fixStoredMojibake(message.html || '')
    }))
    : [];
  session.history = Array.isArray(session.history)
    ? session.history.map(item => ({
      ...item,
      content: fixStoredMojibake(item.content || '')
    }))
    : [];
  // Older versions permanently shortened generated titles to 40 characters.
  // Restore them from the first user turn so the wider header can show the text.
  if (/\.\.\.$/.test(session.title)) {
    const firstQuestion = session.history.find(item => item?.role === 'user' && String(item.content || '').trim())?.content;
    const titlePrefix = session.title.slice(0, -3);
    if (firstQuestion && String(firstQuestion).startsWith(titlePrefix)) {
      session.title = String(firstQuestion).split(/\n\n\[Nội dung tệp|\n\n\[Tệp đính kèm/)[0].trim().slice(0, 200);
    }
  }
  normalizedChatSessions.add(session);
  return session;
}

function loadChatSessions() {
  try {
    const raw = localStorage.getItem(CHAT_STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.chatSessions)) window.chatSessions = data.chatSessions.map(normalizeStoredChatSession);
    window.currentChatSessionId = localStorage.getItem(CHAT_ACTIVE_SESSION_KEY) || data.currentChatSessionId || null;
    saveChatSessions();
  } catch (err) {
    console.warn('Không thể đọc chat session:', err);
  }
}

// Load persona from server
async function loadPersona() {
  try {
    const res = await fetch('/api/persona');
    if (res.ok) {
      const data = await res.json();
      window.aiPersona = data;
    }
  } catch { /* keep default */ }
}

// Ensure at least 1 session exists before rendering
function ensureChatSession() {
  if (window.chatSessions.length === 0) {
    const newId = `session-${Date.now()}`;
    window.chatSessions.push({
      id: newId,
      title: 'Cuộc trò chuyện mới',
      messages: [],
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
    window.currentChatSessionId = newId;
    saveChatSessions();
  } else if (!window.currentChatSessionId) {
    window.currentChatSessionId = window.chatSessions[0].id;
    saveChatSessions();
  }
}

loadChatSessions();

// Markdown + link + JSON-block cleaner
function cleanReplyText(text) {
  if (!text) return '';
  text = String(text)
    .replace(/\{\s*(?:render[_-]?)?chart\s*\}/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Remove raw JSON blocks that look like chartSpec (starts with { "type": ...)
  text = text.replace(/```json[\s\S]*?```/gi, '').trim();
  // Remove bare JSON objects at start/end of text that came from render_chart
  text = text.replace(/^[\s\n]*\{[\s\n]*"type":[\s\S]*?\}[\s\n]*/m, '').trim();
  return text;
}

function escapeChatMarkdown(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseMarkdownInline(value) {
  let html = escapeChatMarkdown(value);
  html = html.replace(/(^|[\s:])(\/(?:api\/)?exports\/[^\s<>()`]+\.(?:xlsx?|csv|pdf))(?=$|[\s,.!?<])/gi,
    '$1<a class="chat-download-link" href="$2" download><i class="fa-solid fa-download"></i>Tải file tại đây</a>');
  html = html.replace(/\[([^\]]+)\]\s*\(\s*(\/(?:api\/)?exports\/[^)\s]+)\s*\)/g,
    '<a class="chat-download-link" href="$2" download><i class="fa-solid fa-download"></i>$1</a>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a class="chat-answer-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="chat-inline-code">$1</code>');
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map(cell => cell.trim());
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function renderMarkdownTable(headerLine, bodyLines) {
  const headers = splitMarkdownTableRow(headerLine);
  const rows = bodyLines.map(splitMarkdownTableRow);
  const headerHtml = headers.map(cell => `<th>${parseMarkdownInline(cell)}</th>`).join('');
  const bodyHtml = rows.map(row => `<tr>${headers.map((_, index) => {
    const value = row[index] || '';
    const empty = !value || value === '-';
    return `<td${empty ? ' class="is-empty"' : ''}>${empty ? '&mdash;' : parseMarkdownInline(value)}</td>`;
  }).join('')}</tr>`).join('');

  return `<div class="chat-markdown-table-wrap"><table class="chat-markdown-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function parseMarkdown(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length;) {
    if (index + 1 < lines.length && lines[index].includes('|') && isMarkdownTableDivider(lines[index + 1])) {
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(lines[index]);
        index += 1;
      }
      blocks.push(renderMarkdownTable(lines[index - rows.length - 2], rows));
      continue;
    }

    if (/^\s*[-*\u2022]\s+/.test(lines[index])) {
      const items = [];
      while (index < lines.length && /^\s*[-*\u2022]\s+/.test(lines[index])) {
        items.push(`<li>${parseMarkdownInline(lines[index].replace(/^\s*[-*\u2022]\s+/, ''))}</li>`);
        index += 1;
      }
      blocks.push(`<ul class="chat-markdown-list">${items.join('')}</ul>`);
      continue;
    }

    blocks.push(lines[index] ? parseMarkdownInline(lines[index]) : '');
    index += 1;
  }

  return blocks.join('<br>')
    .replace(/<br>(<div class="chat-markdown-table-wrap">)/g, '$1')
    .replace(/(<\/div>)<br>/g, '$1')
    .replace(/<br>(<ul class="chat-markdown-list">)/g, '$1')
    .replace(/(<\/ul>)<br>/g, '$1');
}

// Render Chart.js
let _chartInstances = {};

function renderChartSpec(canvasId, chartSpec) {
  if (!chartSpec || typeof chartSpec !== 'object') return;
  try {
    if (_chartInstances[canvasId]) {
      _chartInstances[canvasId].destroy();
    }
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const isDarkTheme = document.documentElement.dataset.theme === 'dark';
    const themeColors = isDarkTheme
      ? { text: '#d2dbea', grid: '#40506a', tooltipBg: '#202c40', tooltipBorder: '#5a6b88' }
      : { text: '#475569', grid: '#d7dfeb', tooltipBg: '#0f172a', tooltipBorder: '#334155' };
    const specOptions = chartSpec.options || {};
    const specPlugins = specOptions.plugins || {};
    const specScales = specOptions.scales || {};
    const isRadialChart = ['pie', 'doughnut', 'polarArea'].includes(chartSpec.type);

    // Normalize chartSpec
    const config = {
      type: chartSpec.type || 'bar',
      data: chartSpec.data || {},
      options: {
        responsive: true,
        ...specOptions,
        maintainAspectRatio: false,
        devicePixelRatio: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
        plugins: {
          ...specPlugins,
          legend: {
            position: 'top',
            ...(specPlugins.legend || {}),
            labels: {
              font: { family: 'Inter', size: 12, weight: '600' },
              ...(specPlugins.legend?.labels || {}),
              color: themeColors.text
            }
          },
          title: {
            display: !!chartSpec.title,
            text: chartSpec.title || '',
            font: { family: 'Inter', size: 14, weight: '700' },
            ...(specPlugins.title || {}),
            color: themeColors.text
          },
          tooltip: {
            ...(specPlugins.tooltip || {}),
            titleColor: '#f8fafc',
            bodyColor: '#e2e8f0',
            backgroundColor: themeColors.tooltipBg,
            borderColor: themeColors.tooltipBorder,
            borderWidth: 1
          }
        },
        scales: isRadialChart ? {} : {
          x: {
            ...(specScales.x || {}),
            grid: { ...(specScales.x?.grid || {}), color: themeColors.grid },
            border: { ...(specScales.x?.border || {}), color: themeColors.grid },
            ticks: { font: { family: 'Inter', size: 12, weight: '500' }, ...(specScales.x?.ticks || {}), color: themeColors.text }
          },
          y: {
            ...(specScales.y || {}),
            grid: { ...(specScales.y?.grid || {}), color: themeColors.grid },
            border: { ...(specScales.y?.border || {}), color: themeColors.grid },
            ticks: { font: { family: 'Inter', size: 12, weight: '500' }, ...(specScales.y?.ticks || {}), color: themeColors.text }
          }
        }
      }
    };

    // Apply default colors if not set
    if (config.data.datasets) {
      const palette = ['#5b5ce2', '#20a77a', '#df8b16', '#dc5360', '#0897af', '#9253d7'];
      const opaqueColor = color => {
        if (typeof color !== 'string') return color;
        if (/^#[0-9a-f]{8}$/i.test(color)) return color.slice(0, 7);
        const rgba = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
        return rgba ? `rgb(${rgba[1]}, ${rgba[2]}, ${rgba[3]})` : color;
      };
      config.data.datasets.forEach((ds, i) => {
        if (!ds.backgroundColor) {
          ds.backgroundColor = config.type === 'bar' ? palette[i % palette.length] : palette;
        } else {
          ds.backgroundColor = Array.isArray(ds.backgroundColor)
            ? ds.backgroundColor.map(opaqueColor)
            : opaqueColor(ds.backgroundColor);
        }
        if (!ds.borderColor) ds.borderColor = Array.isArray(ds.backgroundColor) ? ds.backgroundColor : palette[i % palette.length];
        else ds.borderColor = Array.isArray(ds.borderColor) ? ds.borderColor.map(opaqueColor) : opaqueColor(ds.borderColor);
        if (config.type === 'bar') {
          ds.borderWidth = ds.borderWidth ?? 1;
          ds.borderRadius = ds.borderRadius ?? 5;
          ds.maxBarThickness = ds.maxBarThickness ?? 120;
        }
        if (config.type === 'line') ds.tension = ds.tension ?? 0.3;
      });
    }

    _chartInstances[canvasId] = new Chart(ctx, config);
  } catch (e) {
    console.warn('Chart render error:', e);
  }
}

// Thinking / Tool Calling Steps UI
function createThinkingBubble(containerId) {
  const div = document.createElement('div');
  div.id = containerId;
  div.className = 'chat-thinking-row';
  div.innerHTML = `
    <div class="chat-thinking-avatar">
      <svg class="chat-ai-sparkle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.75c.55 4.95 2.3 6.7 7.25 7.25-4.95.55-6.7 2.3-7.25 7.25C11.45 12.3 9.7 10.55 4.75 10 9.7 9.45 11.45 7.7 12 2.75Z"/><path d="M19 15.75c.22 1.97.91 2.66 2.88 2.88-1.97.22-2.66.91-2.88 2.87-.22-1.96-.91-2.65-2.88-2.87 1.97-.22 2.66-.91 2.88-2.88Z"/></svg>
    </div>
    <div class="chat-thinking-card">
      <div class="chat-thinking-head">
        <canvas class="chat-thinking-spinner" width="22" height="22" aria-hidden="true"></canvas>
        <div class="chat-thinking-copy">
          <strong>Đang xử lý yêu cầu</strong>
          <span id="${containerId}-current">AI đang phân tích yêu cầu của bạn...</span>
        </div>
        <button type="button" class="chat-thinking-toggle" aria-label="Xem chi tiết quá trình xử lý" aria-expanded="false">
          <i class="fa-solid fa-chevron-down"></i>
        </button>
      </div>
      <div id="${containerId}-steps" class="chat-thinking-steps"></div>
    </div>
  `;
  const toggle = div.querySelector('.chat-thinking-toggle');
  const steps = div.querySelector('.chat-thinking-steps');
  if (steps) steps.hidden = true;
  if (toggle && steps) {
    toggle.onclick = () => {
      steps.hidden = !steps.hidden;
      toggle.setAttribute('aria-expanded', String(!steps.hidden));
      toggle.classList.toggle('is-open', !steps.hidden);
    };
  }
  return div;
}

function formatThinkingDuration(durationMs) {
  const ms = Math.max(0, Number(durationMs) || 0);
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
}

function formatExecutionTime(value) {
  const match = String(value ?? '').match(/[\d.]+/);
  return match ? formatThinkingDuration(Number(match[0])) : String(value || '');
}

function disposeThinkingBubble(root) {
  if (root?._elapsedTimer) clearInterval(root._elapsedTimer);
  root._elapsedTimer = null;
}

function renderPageChatDownloadAction(downloadUrl, renderedAnswer = '') {
  const url = String(downloadUrl || '').trim();
  if (!/^\/api\/exports\/[^\s<>"']+$/i.test(url) || String(renderedAnswer).includes('chat-download-link')) return '';
  return `<div><a class="chat-download-link" href="${escapeChatMarkdown(url)}" download><i class="fa-solid fa-download"></i>Tải file báo cáo</a></div>`;
}

function typeThinkingText(element, value) {
  if (!element) return;
  if (element._typingTimer) clearInterval(element._typingTimer);
  const text = String(value || 'Đang xử lý...');
  let index = 0;
  element.textContent = '';
  element._typingTimer = setInterval(() => {
    index += 1;
    element.textContent = text.slice(0, index);
    if (index >= text.length) {
      clearInterval(element._typingTimer);
      element._typingTimer = null;
    }
  }, 14);
}

function addThinkingStep(containerId, icon, label, status = 'running', event = {}) {
  const pending = window.pageChatPendingThinking;
  const root = pending?.node?.id === containerId ? pending.node : document.getElementById(containerId);
  const stepsEl = root?.querySelector('.chat-thinking-steps');
  if (!stepsEl) return;
  typeThinkingText(root.querySelector('.chat-thinking-copy span'), label);
  const key = event.toolName ? `tool:${event.toolName}` : event.iteration != null && /^model_/.test(event.type || '') ? `model:${event.iteration}` : '';
  let step = key ? Array.from(stepsEl.children).reverse().find(item => item.dataset?.stepKey === key && item.dataset?.status === 'running') : null;
  const statusIcon = status === 'done' ? 'check' : status === 'error' ? 'xmark' : status === 'warning' ? 'triangle-exclamation' : icon;
  const spinIcons = ['spinner', 'circle-notch', 'arrows-rotate', 'sync', 'gear', 'cog'];
  const spinClass = (status === 'running' && spinIcons.includes(statusIcon)) ? 'fa-spin' : '';
  if (!step) {
    step = document.createElement('div');
    step.className = 'chat-thinking-step';
    step.dataset.stepKey = key;
    step._startedAt = performance.now();
    stepsEl.appendChild(step);
  }
  step.dataset.status = status;
  const duration = event.durationMs != null ? event.durationMs : (status !== 'running' ? performance.now() - step._startedAt : null);
  const toolCode = event.toolName ? `<code>${escapeChatMarkdown(event.toolName)}</code>` : '';
  step.innerHTML = `<span class="chat-thinking-step-icon"><i class="fa-solid fa-${statusIcon} ${spinClass}"></i></span><span class="chat-thinking-step-copy"><strong>${escapeChatMarkdown(label)}</strong>${toolCode}</span>${duration != null ? `<time>${formatThinkingDuration(duration)}</time>` : '<time>đang chạy</time>'}`;
}

function finalizeThinkingBubble(containerId, executionTime) {
  const root = document.getElementById(containerId);
  if (!root) return;
  const card = root.querySelector('.chat-thinking-card');
  const head = root.querySelector('.chat-thinking-head');
  disposeThinkingBubble(root);
  const spinner = root.querySelector('.chat-thinking-spinner');
  const title = head?.querySelector('strong');
  const subtitle = head?.querySelector('span');
  const steps = document.getElementById(`${containerId}-steps`);
  if (spinner) spinner.style.display = 'none';
  if (title) title.textContent = 'Đã hoàn thành phân tích';
  if (subtitle) subtitle.textContent = `${steps?.children.length || 0} bước đã hoàn thành`;
  if (card) card.classList.add('is-complete');
  if (steps) steps.hidden = true;
  if (head && steps) {
    head.style.cursor = 'pointer';
    head.onclick = () => { steps.hidden = !steps.hidden; };
  }
}

async function fetchStreamingChat(payload, onProgress, signal = null) {
  const response = await fetch('/api/intelligent-core/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try { detail = (await response.json()).message || detail; } catch (_) {}
    throw new Error(detail);
  }
  if (!response.body) throw new Error('Trình duyệt không hỗ trợ streaming response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finalPayload = null;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() || '';
    for (const frame of frames) {
      let eventName = 'message';
      const dataLines = [];
      frame.split(/\r?\n/).forEach(line => {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      });
      if (!dataLines.length) continue;
      const data = JSON.parse(dataLines.join('\n'));
      if (eventName === 'progress') onProgress?.(data);
      else if (eventName === 'final') finalPayload = data;
      else if (eventName === 'error') throw new Error(data.message || 'Streaming chat gặp lỗi.');
    }
    if (done) break;
  }
  if (!finalPayload) throw new Error('Stream kết thúc mà không có câu trả lời cuối.');
  return finalPayload;
}

function getCurrentChatSession() {
  ensureChatSession();
  let session = window.chatSessions.find(s => s.id === window.currentChatSessionId);
  if (!session) {
    session = window.chatSessions[0];
    window.currentChatSessionId = session?.id || null;
  }
  if (session) normalizeStoredChatSession(session);
  if (session && !session.messages) session.messages = [];
  if (session && !session.history) session.history = [];
  return session;
}

function enhanceUserMessageNode(node, question) {
  if (!node || !question || node.querySelector('.chat-user-message-group')) return;
  const bubble = node.firstElementChild;
  const avatar = node.lastElementChild;
  if (!bubble || bubble === avatar) return;
  node.className = 'chat-user-message-row';
  node.removeAttribute('style');
  bubble.classList.add('chat-user-message-bubble');
  bubble.removeAttribute('style');
  avatar?.classList.add('chat-user-message-avatar');
  avatar?.removeAttribute('style');
  const group = document.createElement('div');
  group.className = 'chat-user-message-group';
  group.dataset.question = encodeURIComponent(question);
  node.insertBefore(group, bubble);
  group.appendChild(bubble);
  const actions = document.createElement('div');
  actions.className = 'chat-user-message-actions';
  actions.innerHTML = '<button type="button" onclick="copyPageChatQuestion(this)" title="Sao chép" aria-label="Sao chép câu hỏi"><i class="fa-regular fa-copy"></i></button><button type="button" onclick="editPageChatQuestion(this)" title="Chỉnh sửa và gửi lại" aria-label="Chỉnh sửa câu hỏi"><i class="fa-solid fa-pen"></i></button>';
  group.appendChild(actions);
}

function enhanceAssistantMessageNode(node) {
  const bubble = node?.children?.[1];
  if (!bubble) return;
  bubble.classList.add('chat-ai-message-bubble');
}

function repairStoredSummaryMarkup(node) {
  if (!node) return false;
  let repaired = false;
  const interactiveSelector = 'a[href],button,input,select,textarea,[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
  node.querySelectorAll('summary').forEach(summary => {
    const details = summary.parentElement;
    if (!details || details.tagName !== 'DETAILS') return;
    [...summary.querySelectorAll(interactiveSelector)].forEach(control => {
      details.insertBefore(control, summary.nextSibling);
      if (control.matches('button') && /copy sql|sao chép/i.test(control.textContent || '')) {
        control.classList.add('chat-sql-copy-btn');
        control.removeAttribute('style');
        control.type = 'button';
      }
      repaired = true;
    });
  });
  return repaired;
}

function addChatMessageTime(node, role, timestamp) {
  const time = new Date(Number(timestamp));
  const label = time.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  if (role === 'user') {
    const bubble = node.querySelector('.chat-user-message-bubble');
    if (bubble && !bubble.querySelector('.chat-message-time')) {
      bubble.insertAdjacentHTML('afterbegin', `<div class="chat-user-message-meta"><strong>Bạn</strong><time class="chat-message-time">${label}</time></div>`);
    }
    return;
  }
  const bubble = node.querySelector('.chat-ai-message-bubble');
  if (!bubble || bubble.querySelector('.chat-message-time')) return;
  const existingHead = bubble.firstElementChild;
  if (existingHead?.querySelector('.fa-robot')) {
    existingHead.classList.add('chat-ai-message-meta');
    existingHead.insertAdjacentHTML('beforeend', `<time class="chat-message-time">${label}</time>`);
  } else {
    bubble.insertAdjacentHTML('afterbegin', `<div class="chat-ai-message-meta"><strong>Trợ lý AI</strong><time class="chat-message-time">${label}</time></div>`);
  }
}

function appendChatMessage(record, shouldPersist = true, shouldScroll = true) {
  const container = document.getElementById('page-chat-messages-container');
  if (!container || !record) return;

  const wrapper = document.createElement('div');
  wrapper.innerHTML = record.html || '';
  const node = wrapper.firstElementChild;
  if (!node) return;
  const repairedStoredMarkup = repairStoredSummaryMarkup(node);
  if (repairedStoredMarkup) record.html = node.outerHTML;
  record.createdAt = Number(record.createdAt) || Date.now();
  if (record.role === 'user') enhanceUserMessageNode(node, record.content || '');
  if (record.role === 'assistant') enhanceAssistantMessageNode(node);
  addChatMessageTime(node, record.role, record.createdAt);

  container.appendChild(node);
  if (shouldScroll) container.scrollTop = container.scrollHeight;

  if (record.chartSpec && record.chartId) {
    requestAnimationFrame(() => {
      setTimeout(() => renderChartSpec(record.chartId, record.chartSpec), 100);
    });
  }

  if (shouldPersist) {
    const session = getCurrentChatSession();
    if (session) {
      session.messages.push(record);
      session.updatedAt = Date.now();
      saveChatSessions();
    }
  }
  return repairedStoredMarkup;
}

function renderCurrentChatMessages() {
  const container = document.getElementById('page-chat-messages-container');
  if (!container) return;
  const session = getCurrentChatSession();
  container.innerHTML = '';
  const userHistory = (session?.history || []).filter(item => item.role === 'user');
  let userIndex = 0;
  let repairedStoredMarkup = false;
  (session?.messages || []).forEach(record => {
    const hydrated = record.role === 'user' && !record.content
      ? { ...record, content: userHistory[userIndex]?.content || '' }
      : record;
    if (record.role === 'user') userIndex += 1;
    repairedStoredMarkup = appendChatMessage(hydrated, false, false) || repairedStoredMarkup;
  });
  if (repairedStoredMarkup) saveChatSessions();
  const pending = window.pageChatPendingThinking;
  if (pending && pending.sessionId === session?.id) {
    container.appendChild(pending.node);
  }
  container.scrollTop = container.scrollHeight;
}

async function submitChatFeedback(button) {
  const group = button?.closest('.chat-feedback');
  if (!group) return;
  const rating = button.dataset.rating;
  try {
    const res = await fetch('/api/chat-feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auditId: group.dataset.auditId || null,
        rating,
        providerId: group.dataset.providerId || null,
        model: group.dataset.model || null
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    group.querySelectorAll('button').forEach(item => item.classList.toggle('is-selected', item.dataset.rating === rating));
    group.querySelector('.chat-feedback-label').textContent = 'Cảm ơn bạn đã đánh giá';
    if (typeof showToast === 'function') showToast('Đã ghi nhận đánh giá.', 'success');
  } catch (_) {
    if (typeof showToast === 'function') showToast('Không thể lưu đánh giá.', 'error');
  }
}

function renderChatFeedback(data = {}, tokenUsage = null) {
  return `<div class="chat-feedback" data-audit-id="${escapeChatMarkdown(data.auditId || '')}" data-provider-id="${escapeChatMarkdown(data.provider?.id || '')}" data-model="${escapeChatMarkdown(data.provider?.model || '')}">
    <div class="chat-feedback-actions">
      <span class="chat-feedback-label">Câu trả lời này có hữu ích không?</span>
      <button type="button" data-rating="like" onclick="submitChatFeedback(this)" title="Hữu ích" aria-label="Thích câu trả lời"><i class="fa-regular fa-thumbs-up"></i></button>
      <button type="button" data-rating="dislike" onclick="submitChatFeedback(this)" title="Chưa hữu ích" aria-label="Không thích câu trả lời"><i class="fa-regular fa-thumbs-down"></i></button>
    </div>
    ${renderChatTokenUsage(tokenUsage, true)}
  </div>`;
}

function renderChatTokenUsage(usage) {
  if (!usage || usage.available === false) return '';
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const total = Number(usage.totalTokens) || input + output;
  return `<div class="chat-token-usage" title="Tổng token của toàn bộ các lượt gọi model trong yêu cầu này">
    <span><i class="fa-solid fa-arrow-up-right-from-square"></i> Đầu vào: <strong>${input.toLocaleString('vi-VN')}</strong></span>
    <span><i class="fa-solid fa-arrow-down"></i> Trả lời: <strong>${output.toLocaleString('vi-VN')}</strong></span>
    <span class="chat-token-total"><i class="fa-solid fa-coins"></i> Tổng: <strong>${total.toLocaleString('vi-VN')}</strong> token</span>
  </div>`;
}

async function copyPageChatQuestion(button) {
  const group = button?.closest('.chat-user-message-group');
  const text = decodeURIComponent(group?.dataset.question || '');
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    if (typeof showToast === 'function') showToast('Không thể sao chép câu hỏi.', 'error');
  }
}

function editPageChatQuestion(button) {
  const group = button?.closest('.chat-user-message-group');
  const text = decodeURIComponent(group?.dataset.question || '');
  const input = document.getElementById('page-chat-user-input');
  if (!input || !text) return;
  input.value = text;
  input.focus();
  input.setSelectionRange?.(text.length, text.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

// Main Send Message
async function sendPageChatMessage() {
  if (window.pageChatIsResponding) return;
  const input = document.getElementById('page-chat-user-input');
  if (!input) return;
  const msg = input.value.trim();
  const attachedFiles = [...window.pageChatAttachments];
  if (!msg && attachedFiles.length === 0) return;

  const container = document.getElementById('page-chat-messages-container');
  if (!container) return;

  // Get current session
  let session = getCurrentChatSession();
  if (!session) return;

  input.value = '';
  updatePageChatCharacterCount('');
  window.resizeChatComposerInput?.(input);
  window.pageChatAttachments = [];
  renderPageChatAttachments();

  // Render User Message
  const userDiv = document.createElement('div');
  userDiv.className = 'chat-user-message-row';
  userDiv.innerHTML = `
    <div class="chat-user-message-group" data-question="${encodeURIComponent(msg || '')}">
      <div class="chat-user-message-bubble">
        ${escapeChatMarkdown(msg || 'Đã gửi tệp đính kèm')}
        ${attachedFiles.length ? `<div style="margin-top:8px;font-size:11px;opacity:.85;"><i class="fa-solid fa-paperclip"></i> ${attachedFiles.map(file => escapeChatMarkdown(file.name)).join(', ')}</div>` : ''}
      </div>
      <div class="chat-user-message-actions" aria-label="Thao tác với câu hỏi">
        <button type="button" onclick="copyPageChatQuestion(this)" title="Sao chép" aria-label="Sao chép câu hỏi"><i class="fa-regular fa-copy"></i></button>
        <button type="button" onclick="editPageChatQuestion(this)" title="Chỉnh sửa và gửi lại" aria-label="Chỉnh sửa câu hỏi"><i class="fa-solid fa-pen"></i></button>
      </div>
    </div>
    <div class="chat-user-message-avatar">
      <i class="fa-solid fa-user"></i>
    </div>
  `;
  appendChatMessage({ role: 'user', content: msg, html: userDiv.outerHTML });

  // Thinking Bubble
  const thinkingId = `thinking-${Date.now()}`;
  const thinkingDiv = createThinkingBubble(thinkingId);
  const progressEvents = [];
  window.pageChatPendingThinking = { sessionId: session.id, node: thinkingDiv };
  container.appendChild(thinkingDiv);
  container.scrollTop = container.scrollHeight;
  const requestController = new AbortController();
  window.pageChatRequestController = requestController;
  setPageChatResponding(true);
  window.updatePageChatMiniPanel({
    status: 'running',
    label: 'Đang bắt đầu xử lý…',
    question: msg || attachedFiles.map(file => file.name).join(', ')
  });

  try {
    const selectedProviderId = document.getElementById('page-chat-model-selector')?.value || null;
    const knowledgeSources = getChatKnowledgeValues();
    const attachmentContext = await buildPageChatAttachmentContext(attachedFiles);
    const requestMessage = `${msg || 'Hãy phân tích tệp đính kèm.'}${attachmentContext}`;
    const requestPayload = {
      question: requestMessage,
      message: requestMessage,
      history: session.history.slice(-20),
      sessionId: session.id,
      providerId: selectedProviderId,
      knowledgeSearchEnabled: !window.pageChatWebSearchEnabled && !knowledgeSources.includes('none'),
      knowledgeSourceIds: !window.pageChatWebSearchEnabled ? knowledgeSources.filter(value => !['auto', 'none'].includes(value)) : [],
      webSearch: window.pageChatWebSearchEnabled,
      attachments: attachedFiles.map(file => ({ name: file.name, type: file.type, size: file.size }))
    };
    const data = await fetchStreamingChat(requestPayload, event => {
      progressEvents.push(event);
      addThinkingStep(thinkingId, event.icon || 'circle-notch', event.label || 'Đang xử lý', event.status || 'running', event);
      window.updatePageChatMiniPanel({ status: 'running', label: event.label || 'Đang xử lý yêu cầu…' });
    }, requestController.signal);
    disposeThinkingBubble(thinkingDiv);
    thinkingDiv.remove();
    if (window.pageChatPendingThinking?.node === thinkingDiv) window.pageChatPendingThinking = null;

    // Build AI Response
    const aiResponseText = cleanReplyText(data.reply || data.replyText || 'Không tìm thấy thông tin tương ứng.');
    const sqlQuery = data.generatedSql || data.sql || null;
    const toolResult = data.toolResult || null;
    const sqlExecutions = Array.isArray(data.sqlExecutions) && data.sqlExecutions.length > 0
      ? data.sqlExecutions
      : (sqlQuery ? [{ index: 1, sql: sqlQuery, columns: toolResult?.columns || [], rows: toolResult?.rows || [], rowCount: toolResult?.rows?.length || 0 }] : []);
    const chartSpec = data.chartSpec || null;
    const persona = window.aiPersona || {};
    const aiName = persona.name || 'KAI';
    const aiRole = persona.role || 'Intelligent Copilot';

    // Save to history for next turn
    session.history.push({ role: 'user', content: requestMessage });
    session.history.push({ role: 'assistant', content: aiResponseText });
    saveChatSessions();

    // Auto-update session title from first message
    if (session.history.length === 2 && session.title.startsWith('Cuộc trò chuyện mới')) {
      session.title = msg.slice(0, 200);
      saveChatSessions();
      renderChatSessionsList();
    }

    // SQL Block
    let sqlHtml = '';
    if (sqlExecutions.length > 0) {
      sqlHtml = sqlExecutions.map((execution, index) => {
        const query = execution.sql || '';
        const escapedSql = escapeChatMarkdown(query);
        return `
        <details class="chat-sql-panel" open style="margin-top:12px;border:1px solid #cbd5e1;border-radius:10px;overflow:hidden;background:#0f172a;">
          <summary style="background:#1e293b;padding:8px 102px 8px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;cursor:pointer;list-style:none;">
            <span style="font-size:11.5px;font-weight:700;color:#38bdf8;"><i class="fa-solid fa-code" style="margin-right:6px;"></i>Câu lệnh SQL ${index + 1}/${sqlExecutions.length}</span>
            <span style="font-size:10px;color:#a5b4fc;background:rgba(99,102,241,.18);padding:2px 7px;border-radius:20px;">${execution.rowCount ?? execution.rows?.length ?? 0} dòng</span>
            <i class="fa-solid fa-chevron-down chat-sql-chevron" style="margin-left:auto;font-size:10px;color:#94a3b8;"></i>
          </summary>
          <button class="chat-sql-copy-btn" type="button" onclick="navigator.clipboard.writeText(this.dataset.sql);" data-sql="${escapedSql}" aria-label="Sao chép câu lệnh SQL">
            <i class="fa-solid fa-copy"></i> Copy SQL
          </button>
          <pre style="color:#38bdf8;padding:12px 14px;font-size:12px;font-family:monospace;margin:0;overflow-x:auto;line-height:1.5;">${escapeChatMarkdown(query)}</pre>
        </details>
      `;
      }).join('');
    }

    // Tool Calling Steps - Beautiful Timeline
    let toolStepsHtml = '';
    if (data.toolCalls && data.toolCalls.length > 0) {
      const toolMeta = {
        execute_sql_query: { icon: 'database', color: '#6366f1', bg: '#eef2ff', label: 'SQL Query' },
        render_chart: { icon: 'chart-column', color: '#f59e0b', bg: '#fffbeb', label: 'Vẽ biểu đồ' },
        export_data: { icon: 'file-arrow-down', color: '#10b981', bg: '#f0fdf4', label: 'Xuất file' },
        validate_sql: { icon: 'shield-check', color: '#3b82f6', bg: '#eff6ff', label: 'Kiểm tra SQL' },
        repair_sql: { icon: 'wrench', color: '#ef4444', bg: '#fef2f2', label: 'Sửa SQL' },
        search_schema: { icon: 'magnifying-glass', color: '#8b5cf6', bg: '#f5f3ff', label: 'Tìm schema' },
        calculate_stats: { icon: 'calculator', color: '#06b6d4', bg: '#ecfeff', label: 'Thống kê' },
        get_current_datetime: { icon: 'clock', color: '#0ea5e9', bg: '#eff6ff', label: 'Thời gian hệ thống' },
        default: { icon: 'gears', color: '#64748b', bg: '#f8fafc', label: 'Tool' }
      };

      const steps = data.toolCalls.map((tc, idx) => {
        const meta = toolMeta[tc.name] || toolMeta.default;
        const isOk = tc.success !== false;
        const statusIcon = isOk ? 'circle-check' : 'circle-xmark';
        const statusColor = isOk ? '#22c55e' : '#ef4444';
        const rowBadge = tc.rowCount != null
          ? `<span style="background:#e0e7ff;color:#4338ca;padding:1px 8px;border-radius:20px;font-size:10.5px;font-weight:700;">${tc.rowCount} dòng</span>`
          : '';
        const errBadge = tc.error
          ? `<span style="background:#fee2e2;color:#b91c1c;padding:1px 8px;border-radius:20px;font-size:10.5px;">${tc.error.slice(0, 40)}</span>`
          : '';
        const durationBadge = tc.durationMs != null
          ? `<time class="chat-tool-duration"><i class="fa-regular fa-clock"></i>${formatThinkingDuration(tc.durationMs)}</time>`
          : '';
        const isLast = idx === data.toolCalls.length - 1;
        return `
          <div style="display:flex;gap:10px;align-items:flex-start;padding-bottom:${isLast ? '0' : '12px'};position:relative;">
            ${!isLast ? `<div style="position:absolute;left:14px;top:28px;bottom:0;width:2px;background:linear-gradient(180deg,${meta.color}44,transparent);"></div>` : ''}
            <div style="width:28px;height:28px;border-radius:50%;background:${meta.bg};border:2px solid ${meta.color}33;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              <i class="fa-solid fa-${meta.icon}" style="font-size:11px;color:${meta.color};"></i>
            </div>
            <div style="flex:1;min-width:0;padding-top:4px;">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span style="font-size:12px;font-weight:700;color:#1e293b;">${meta.label}</span>
                <code style="font-size:10.5px;color:#64748b;background:#f1f5f9;padding:1px 6px;border-radius:4px;font-family:monospace;">${tc.name}</code>
                ${rowBadge}${errBadge}
              </div>
              <div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
                <i class="fa-solid fa-${statusIcon}" style="font-size:10px;color:${statusColor};"></i>
                <span style="font-size:11px;color:${statusColor};font-weight:600;">${isOk ? 'Thành công' : 'Lỗi'}</span>
              </div>
            </div>
            ${durationBadge}
          </div>`;
      }).join('');

      toolStepsHtml = `
        <details class="chat-tool-pipeline" open style="margin:0 0 12px;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.04);">
          <summary style="padding:10px 14px;font-size:12px;font-weight:700;color:#334155;cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;background:linear-gradient(135deg,#f8fafc,#f1f5f9);">
            <span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#6366f1,#a855f7);">
              <i class="fa-solid fa-bolt" style="font-size:10px;color:#fff;"></i>
            </span>
            Công cụ đã sử dụng
            <span style="background:#6366f1;color:#fff;padding:1px 8px;border-radius:20px;font-size:10.5px;font-weight:700;margin-left:4px;">${data.toolCalls.length} bước</span>
            <i class="fa-solid fa-chevron-down chat-tool-chevron" style="margin-left:auto;font-size:10px;color:#94a3b8;"></i>
          </summary>
          <div style="padding:14px 14px 10px;">${steps}</div>
        </details>
      `;
    }

    // Tool Result Table
    let toolResultHtml = '';
    const executionsWithRows = sqlExecutions.filter(execution => Array.isArray(execution.rows) && execution.rows.length > 0);
    if (executionsWithRows.length > 0) {
      toolResultHtml = executionsWithRows.map((execution, index) => {
        const resultLabel = chartSpec
          ? 'Dữ liệu dùng cho biểu đồ'
          : (executionsWithRows.length === 1 ? 'Kết quả dữ liệu' : `Kết quả dữ liệu ${index + 1}`);
        const colsHdr = execution.columns.map(c =>
          `<th style="padding:8px 12px;text-align:left;background:#f8fafc;font-size:12px;color:#475569;border-bottom:1px solid #e2e8f0;">${c}</th>`
        ).join('');
        const rowsBody = execution.rows.map(r =>
          `<tr style="border-bottom:1px solid #f1f5f9;">${r.map(cell =>
            `<td style="padding:8px 12px;font-size:12.5px;color:#1e293b;">${cell ?? ''}</td>`
          ).join('')}</tr>`
        ).join('');
        return `
        <details class="chat-tool-result" open>
          <summary class="chat-tool-result-title">
            <i class="fa-solid fa-table-list" style="color:#6366f1;"></i>
            ${resultLabel} (${execution.rows.length} dòng)
            <i class="fa-solid fa-chevron-down chat-result-chevron"></i>
          </summary>
          <div class="chat-tool-result-scroll">
            <table>
              <thead><tr>${colsHdr}</tr></thead>
              <tbody>${rowsBody}</tbody>
            </table>
          </div>
        </details>
      `;
      }).join('');
    }

    // Chart Canvas
    const chartId = `chart-${Date.now()}`;
    let chartHtml = '';
    if (chartSpec && typeof chartSpec === 'object') {
      chartHtml = `
        <div class="chat-chart-box">
          <div class="chat-chart-title">
            <i class="fa-solid fa-chart-bar" style="color:#6366f1;"></i>
            ${chartSpec.title || 'Biểu đồ dữ liệu'}
          </div>
          <canvas id="${chartId}" class="chat-chart-canvas"></canvas>
        </div>
      `;
    }

    const thinkingTimelineHtml = progressEvents.length ? `
      <div class="chat-embedded-thinking">
        <div class="chat-embedded-thinking-title"><i class="fa-solid fa-brain"></i> Thinking · ${progressEvents.length} bước · ${escapeChatMarkdown(data.executionTime || '')}</div>
        <div class="chat-embedded-thinking-steps">
          ${progressEvents.map(event => {
            const status = event.status || 'running';
            const color = status === 'done' ? '#16a34a' : status === 'error' ? '#dc2626' : status === 'warning' ? '#d97706' : '#6366f1';
            const icon = status === 'done' ? 'check' : status === 'error' ? 'xmark' : status === 'warning' ? 'triangle-exclamation' : (event.icon || 'circle-notch');
            return `<div class="chat-embedded-thinking-step"><span style="color:${color}"><i class="fa-solid fa-${icon}"></i></span><span>${escapeChatMarkdown(event.label || 'Đang xử lý')}</span></div>`;
          }).join('')}
        </div>
      </div>
    ` : '';

    const technicalHtml = (thinkingTimelineHtml || sqlHtml || toolStepsHtml || toolResultHtml) ? `
      <details class="chat-technical-details">
        <summary>
          <span><i class="fa-solid fa-brain"></i> Thinking · Quá trình xử lý</span>
          <time class="chat-process-total"><i class="fa-regular fa-clock"></i>${escapeChatMarkdown(formatExecutionTime(data.executionTime))}</time>
          <i class="fa-solid fa-chevron-down chat-technical-chevron"></i>
        </summary>
        <div class="chat-technical-content">
          ${thinkingTimelineHtml}
          ${toolStepsHtml}
          ${toolResultHtml}
          ${sqlHtml}
          <div class="chat-response-meta">
            <span class="metric-tag green"><i class="fa-solid fa-shield-halved"></i> SELECT ONLY</span>
            <span class="metric-tag purple"><i class="fa-solid fa-bolt"></i> ${data.executionTime || data.executionMode || 'live_llm'}</span>
            ${data.provider ? `<span class="metric-tag chat-provider-tag"><i class="fa-solid fa-microchip"></i> ${data.provider.name || data.provider.model || 'AI'}</span>` : ''}
            ${data.contextSelection?.mode === 'data' ? `<span class="metric-tag purple" title="${escapeChatMarkdown((data.contextSelection.selectedTables || []).join(', '))}"><i class="fa-solid fa-diagram-project"></i> Schema ${data.contextSelection.selectedTables?.length || 0} bảng</span>` : '<span class="metric-tag gray"><i class="fa-solid fa-message"></i> Chat nhẹ</span>'}
          </div>
        </div>
      </details>
    ` : '';

    // Assemble AI Bubble
    const renderedAnswerHtml = parseMarkdown(aiResponseText);
    const downloadActionHtml = renderPageChatDownloadAction(data.downloadUrl, renderedAnswerHtml);
    const aiDiv = document.createElement('div');
    aiDiv.style.cssText = 'display:flex;gap:12px;align-items:flex-start;margin-bottom:16px;';
    aiDiv.innerHTML = `
      <div class="chat-ai-avatar" style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#6366f1 0%,#a855f7 100%);color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 3px 8px rgba(99,102,241,.25);flex-shrink:0;">
        <svg class="chat-ai-sparkle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.75c.55 4.95 2.3 6.7 7.25 7.25-4.95.55-6.7 2.3-7.25 7.25C11.45 12.3 9.7 10.55 4.75 10 9.7 9.45 11.45 7.7 12 2.75Z"/><path d="M19 15.75c.22 1.97.91 2.66 2.88 2.88-1.97.22-2.66.91-2.88 2.87-.22-1.96-.91-2.65-2.88-2.87 1.97-.22 2.66-.91 2.88-2.88Z"/></svg>
      </div>
      <div class="chat-ai-message-bubble" style="background:#fff;border:1px solid #e2e8f0;padding:14px 18px;border-radius:14px;max-width:85%;font-size:13.5px;box-shadow:0 4px 14px rgba(0,0,0,.03);line-height:1.6;flex:1;">
        <div style="font-weight:700;color:#4338ca;margin-bottom:8px;display:flex;align-items:center;gap:8px;">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:linear-gradient(135deg,#6366f1,#a855f7);">
            <i class="fa-solid fa-robot" style="font-size:9px;color:#fff;"></i>
          </span>
          <span>${aiName}</span>
          <span style="font-size:10.5px;font-weight:500;color:#94a3b8;">${aiRole}</span>
        </div>
        <div class="chat-ai-answer">${renderedAnswerHtml}</div>
        ${downloadActionHtml}
        ${chartHtml}
        ${technicalHtml}
        ${renderChatFeedback(data, data.tokenUsage)}
      </div>
    `;
    appendChatMessage({
      role: 'assistant',
      html: aiDiv.outerHTML,
      chartSpec: chartSpec && typeof chartSpec === 'object' ? chartSpec : null,
      chartId: chartSpec && typeof chartSpec === 'object' ? chartId : null
    });
    window.updatePageChatMiniPanel({ status: 'complete', label: 'Đã hoàn thành câu trả lời' });
    if (typeof fetchChatHistory === 'function') fetchChatHistory();

    // Render chart after DOM insert (Chart.js needs canvas in DOM)
    if (chartSpec && typeof chartSpec === 'object') {
      requestAnimationFrame(() => {
        setTimeout(() => renderChartSpec(chartId, chartSpec), 100);
      });
    }

  } catch (err) {
    disposeThinkingBubble(thinkingDiv);
    thinkingDiv.remove();
    if (window.pageChatPendingThinking?.node === thinkingDiv) window.pageChatPendingThinking = null;
    if (err?.name === 'AbortError') {
      window.updatePageChatMiniPanel({ status: 'stopped', label: 'Đã dừng trả lời' });
      if (typeof showToast === 'function') showToast('Đã dừng tiến trình trả lời.', 'info');
      return;
    }
    const noAnswer = /local model returned an empty response|stream kết thúc mà không có câu trả lời cuối/i.test(String(err?.message || ''));
    const errorContent = noAnswer
      ? '<strong>Chưa có câu trả lời phù hợp.</strong> Vui lòng thử lại.'
      : `<strong>Lỗi kết nối AI:</strong> ${escapeChatMarkdown(err?.message || 'Không thể kết nối tới mô hình AI.')}`;
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'display:flex;gap:12px;align-items:flex-start;margin-bottom:16px;';
    errDiv.innerHTML = `
      <div class="chat-ai-avatar" style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#6366f1 0%,#a855f7 100%);color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">
        <svg class="chat-ai-sparkle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.75c.55 4.95 2.3 6.7 7.25 7.25-4.95.55-6.7 2.3-7.25 7.25C11.45 12.3 9.7 10.55 4.75 10 9.7 9.45 11.45 7.7 12 2.75Z"/><path d="M19 15.75c.22 1.97.91 2.66 2.88 2.88-1.97.22-2.66.91-2.88 2.87-.22-1.96-.91-2.65-2.88-2.87 1.97-.22 2.66-.91 2.88-2.88Z"/></svg>
      </div>
      <div class="chat-ai-message-bubble" style="background:#fff;border:1px solid #fee2e2;padding:14px 18px;border-radius:14px;font-size:13.5px;color:#b91c1c;">
        ${errorContent}
      </div>
    `;
    appendChatMessage({ role: 'assistant', html: errDiv.outerHTML });
    window.updatePageChatMiniPanel({ status: 'error', label: 'Không thể hoàn thành câu trả lời' });
  } finally {
    if (window.pageChatRequestController === requestController) {
      window.pageChatRequestController = null;
      setPageChatResponding(false);
    }
  }
}

async function populateChatKnowledgeSources() {
  const select = document.getElementById('page-chat-knowledge-source');
  if (!select) return;
  const current = getChatKnowledgeValues(select);
  try {
    const response = await fetch('/api/library');
    const documents = await response.json();
    const ready = (Array.isArray(documents) ? documents : []).filter(item => Number(item.chunksCount || 0) > 0);
    window.pageChatKnowledgeDocuments = ready;
    select.innerHTML = '<option value="auto">Tự động chọn nguồn tri thức</option><option value="none">Không dùng thư viện tri thức</option>' + ready.map(item => `<option value="${escapeChatMarkdown(item.id)}">${escapeChatMarkdown(item.title)}</option>`).join('');
    const available = new Set([...select.options].map(option => option.value));
    setChatKnowledgeValues(select, current.filter(value => available.has(value)));
    updateChatKnowledgeSourceState();
  } catch (_) { }
}

function getChatKnowledgeValues(select = document.getElementById('page-chat-knowledge-source')) {
  const values = select ? [...select.selectedOptions].map(option => option.value) : [];
  return values.length ? values : ['auto'];
}

function setChatKnowledgeValues(select, values) {
  if (!select) return;
  const wanted = new Set(values?.length ? values : ['auto']);
  [...select.options].forEach(option => { option.selected = wanted.has(option.value); });
}

function updateChatKnowledgeSourceState() {
  const select = document.getElementById('page-chat-knowledge-source');
  if (!select) return;
  renderChatKnowledgeOptions();
  renderChatKnowledgeChip();
}

function toggleChatKnowledgePanel(event) {
  event?.stopPropagation();
  const panel = document.getElementById('page-chat-knowledge-panel');
  if (!panel) return;
  panel.hidden = !panel.hidden;
  document.getElementById('page-chat-knowledge-toggle')?.classList.toggle('is-active', !panel.hidden);
  document.getElementById('page-chat-knowledge-toggle')?.setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) { renderChatKnowledgeOptions(); setTimeout(() => document.getElementById('page-chat-knowledge-search')?.focus(), 0); }
}

function renderChatKnowledgeOptions() {
  const root = document.getElementById('page-chat-knowledge-options');
  const select = document.getElementById('page-chat-knowledge-source');
  if (!root || !select) return;
  const query = (document.getElementById('page-chat-knowledge-search')?.value || '').toLowerCase();
  const documents = (window.pageChatKnowledgeDocuments || []).filter(item => item.title.toLowerCase().includes(query));
  const selected = new Set(getChatKnowledgeValues(select));
  const option = (value, icon, title, note) => `<button type="button" class="chat-knowledge-option ${selected.has(value) ? 'active' : ''}" data-value="${escapeChatMarkdown(value)}" onclick="selectChatKnowledgeSource(this.dataset.value,event)"><i class="fa-solid ${icon}"></i><span><strong>${escapeChatMarkdown(title)}</strong><small>${escapeChatMarkdown(note)}</small></span><i class="fa-solid fa-check"></i></button>`;
  root.innerHTML = option('auto', 'fa-wand-magic-sparkles', 'Tự động chọn nguồn', 'AI tìm trong toàn bộ thư viện') + option('none', 'fa-ban', 'Không dùng nguồn tri thức', 'Chỉ dùng CSDL và hội thoại') + documents.map(item => option(item.id, getLibraryChatIcon(item.fileType), item.title, `${item.fileType} · ${item.chunksCount} chunks`)).join('');
}

function getLibraryChatIcon(type) { return ({ PDF: 'fa-file-pdf', DOCX: 'fa-file-word', XLSX: 'fa-file-excel', XLS: 'fa-file-excel', CSV: 'fa-file-csv' })[String(type).toUpperCase()] || 'fa-file-lines'; }
function selectChatKnowledgeSource(value, event) {
  event?.stopPropagation();
  const select = document.getElementById('page-chat-knowledge-source');
  if (!select) return;
  const current = new Set(getChatKnowledgeValues(select));
  if (value === 'auto' || value === 'none') {
    setChatKnowledgeValues(select, [value]);
    if (value === 'none') {
      window.pageChatWebSearchEnabled = false;
      document.getElementById('page-chat-web-toggle')?.classList.remove('is-active');
      document.getElementById('page-chat-web-toggle')?.setAttribute('aria-pressed', 'false');
    }
  } else {
    current.delete('auto');
    current.delete('none');
    if (current.has(value)) current.delete(value); else current.add(value);
    setChatKnowledgeValues(select, [...current]);
    window.pageChatWebSearchEnabled = false;
    document.getElementById('page-chat-web-toggle')?.classList.remove('is-active');
    document.getElementById('page-chat-web-toggle')?.setAttribute('aria-pressed', 'false');
  }
  updateChatKnowledgeSourceState();
}
function renderChatKnowledgeChip() {
  const root = document.getElementById('page-chat-knowledge-inline');
  const select = document.getElementById('page-chat-knowledge-source');
  if (!root || !select) return;
  const chips = [];
  getChatKnowledgeValues(select).filter(value => value !== 'auto').forEach(value => {
    const option = [...select.options].find(item => item.value === value);
    const label = option?.textContent || 'Nguồn tri thức';
    chips.push(`<span class="chat-knowledge-chip ${value === 'none' ? 'disabled' : ''}" title="${escapeChatMarkdown(label)}"><i class="fa-solid ${value === 'none' ? 'fa-ban' : 'fa-book-open'}"></i><span>${escapeChatMarkdown(label)}</span><button type="button" data-value="${escapeChatMarkdown(value)}" title="Bỏ nguồn đã chọn" onclick="selectChatKnowledgeSource(this.dataset.value,event)"><i class="fa-solid fa-xmark"></i></button></span>`);
  });
  if (window.pageChatWebSearchEnabled) {
    chips.push('<span class="chat-knowledge-chip web-search-chip" title="Tìm kiếm trên web đang bật"><i class="fa-solid fa-globe"></i><span>Tìm kiếm web</span><button type="button" title="Tắt tìm kiếm web" onclick="togglePageChatWebSearch(event)"><i class="fa-solid fa-xmark"></i></button></span>');
  }
  root.hidden = chips.length === 0;
  root.innerHTML = chips.join('');
}

window.populateChatKnowledgeSources = populateChatKnowledgeSources;
window.updateChatKnowledgeSourceState = updateChatKnowledgeSourceState;
window.toggleChatKnowledgePanel = toggleChatKnowledgePanel;
window.renderChatKnowledgeOptions = renderChatKnowledgeOptions;
window.selectChatKnowledgeSource = selectChatKnowledgeSource;

// Session Management
function handlePageChatKeyPress(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (window.pageChatIsResponding) {
      if (typeof showToast === 'function') showToast('Hãy dừng câu trả lời hiện tại trước khi gửi yêu cầu mới.', 'info');
      return;
    }
    sendPageChatMessage();
  }
}

function updatePageChatCharacterCount(value = '') {
  const count = document.getElementById('page-chat-character-count');
  if (count) count.textContent = `${String(value).length}/4000`;
}

function useQuickPrompt(text) {
  if (window.pageChatIsResponding) {
    if (typeof showToast === 'function') showToast('Hãy dừng câu trả lời hiện tại trước khi gửi yêu cầu mới.', 'info');
    return;
  }
  const input = document.getElementById('page-chat-user-input');
  if (!input) return;
  input.value = text;
  input.focus();
  input.setSelectionRange?.(text.length, text.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function renderChatSessionsList() {
  ensureChatSession();
  const container = document.getElementById('chat-sessions-list');
  if (!container) return;
  container.innerHTML = '';
  const sessions = (window.chatSessions || []).map(normalizeStoredChatSession)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  window.chatSessions = sessions;
  if (sessions.length === 0) {
    container.innerHTML = `<div style="text-align:center;padding:20px 10px;color:var(--text-muted);font-size:12.5px;">Chưa có cuộc trò chuyện.<br>Bấm <strong>"+ Tạo đoạn chat mới"</strong> để bắt đầu. </div>`;
    return;
  }
  const formatSessionTime = timestamp => {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const daysAgo = Math.floor((startToday - startDate) / 86400000);
    if (daysAgo <= 0) return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    if (daysAgo === 1) return 'Hôm qua';
    if (daysAgo < 7) return `${daysAgo} ngày trước`;
    return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  };
  const renderSession = session => {
    const isCurrent = session.id === window.currentChatSessionId;
    const div = document.createElement('div');
    div.className = `chat-session-item${isCurrent ? ' is-current' : ''}${session.pinned ? ' is-pinned' : ''}`;
    div.dataset.sessionId = session.id;
    div.innerHTML = `
      <div class="chat-session-main" onclick="selectChatSession('${session.id}')">
        <i class="fa-${session.pinned ? 'solid' : 'regular'} ${session.pinned ? 'fa-thumbtack' : 'fa-message'}"></i>
        <span title="${escapeChatMarkdown(session.title)}">${escapeChatMarkdown(session.title)}</span>
        <time>${formatSessionTime(session.updatedAt)}</time>
      </div>
      <button class="chat-session-more" onclick="toggleChatSessionMenu('${session.id}',event)" title="Tùy chọn" aria-label="Tùy chọn đoạn chat" aria-expanded="false">
        <i class="fa-solid fa-ellipsis"></i>
      </button>
      <div class="chat-session-menu" data-menu-for="${session.id}" hidden>
        <button type="button" onclick="renameChatSession('${session.id}',event)"><i class="fa-solid fa-pen"></i><span>Đổi tên</span></button>
        <button type="button" onclick="togglePinChatSession('${session.id}',event)"><i class="fa-solid fa-thumbtack"></i><span>${session.pinned ? 'Bỏ ghim' : 'Ghim đoạn chat'}</span></button>
        <div class="chat-session-menu-separator"></div>
        <button type="button" class="danger" onclick="deleteSingleChatSession('${session.id}',event)"><i class="fa-regular fa-trash-can"></i><span>Xóa</span></button>
      </div>
    `;
    container.appendChild(div);
  };
  const recentSessions = sessions.filter(session => !session.pinned);
  const pinnedSessions = sessions.filter(session => session.pinned)
    .sort((a, b) => Number(b.pinnedAt || 0) - Number(a.pinnedAt || 0));
  if (recentSessions.length) {
    container.insertAdjacentHTML('beforeend', '<div class="chat-session-group-title"><i class="fa-regular fa-clock"></i> Gần đây</div>');
    recentSessions.forEach(renderSession);
  }
  if (pinnedSessions.length) {
    container.insertAdjacentHTML('beforeend', '<div class="chat-session-group-title is-pinned"><i class="fa-solid fa-thumbtack"></i> Ghim</div>');
    pinnedSessions.forEach(renderSession);
  }

  // Sync title in header
  const currentSession = sessions.find(s => s.id === window.currentChatSessionId);
  const titleEl = document.getElementById('current-session-title');
  if (titleEl && currentSession) titleEl.textContent = currentSession.title;
}

function closeChatSessionMenus(exceptId = null) {
  document.querySelectorAll('.chat-session-menu').forEach(menu => {
    if (exceptId && menu.dataset.menuFor === exceptId) return;
    menu.hidden = true;
    menu.closest('.chat-session-item')?.querySelector('.chat-session-more')?.setAttribute('aria-expanded', 'false');
  });
}

function toggleChatSessionMenu(id, event) {
  event?.stopPropagation();
  const menu = document.querySelector(`.chat-session-menu[data-menu-for="${id}"]`);
  if (!menu) return;
  const willOpen = menu.hidden;
  closeChatSessionMenus(id);
  menu.hidden = !willOpen;
  menu.closest('.chat-session-item')?.querySelector('.chat-session-more')?.setAttribute('aria-expanded', String(willOpen));
}

function togglePinChatSession(id, event) {
  event?.stopPropagation();
  const session = window.chatSessions.find(item => item.id === id);
  if (!session) return;
  session.pinned = !session.pinned;
  session.pinnedAt = session.pinned ? Date.now() : null;
  saveChatSessions();
  renderChatSessionsList();
  showToast(session.pinned ? 'Đã ghim đoạn chat.' : 'Đã bỏ ghim đoạn chat.', 'info');
}

function renameChatSession(id, event) {
  event?.stopPropagation();
  const session = window.chatSessions.find(item => item.id === id);
  if (!session) return;
  const nextTitle = prompt('Đổi tên đoạn chat:', session.title);
  if (nextTitle === null) return;
  const cleanTitle = nextTitle.trim().slice(0, 200);
  if (!cleanTitle) return showToast('Tên đoạn chat không được để trống.', 'warn');
  session.title = cleanTitle;
  saveChatSessions();
  renderChatSessionsList();
  showToast('Đã đổi tên đoạn chat.', 'success');
}

if (!window.__chatSessionMenuOutsideClickBound) {
  window.__chatSessionMenuOutsideClickBound = true;
  document.addEventListener('click', event => {
    if (!event.target.closest('.chat-session-menu') && !event.target.closest('.chat-session-more')) closeChatSessionMenus();
  });
}

function createNewChatSession() {
  if (window.pageChatIsResponding) return showToast('Hãy dừng câu trả lời hiện tại trước khi tạo đoạn chat mới.', 'info');
  const newId = `session-${Date.now()}`;
  const count = window.chatSessions.length + 1;
  const now = Date.now();
  const newSession = { id: newId, title: `Cuộc trò chuyện mới ${count}`, messages: [], history: [], createdAt: now, updatedAt: now };
  window.chatSessions.unshift(newSession);
  window.currentChatSessionId = newId;
  saveChatSessions();
  const titleEl = document.getElementById('current-session-title');
  if (titleEl) titleEl.textContent = newSession.title;
  const msgContainer = document.getElementById('page-chat-messages-container');
  if (msgContainer) msgContainer.innerHTML = '';
  renderChatSessionsList();
}

function deleteSingleChatSession(id, event) {
  event?.stopPropagation();
  const session = window.chatSessions.find(s => s.id === id);
  const title = session ? session.title : 'đoạn chat';
  if (!confirm(`Xóa "${title}"? Hành động này không thể hoàn tác.`)) return;
  window.chatSessions = window.chatSessions.filter(s => s.id !== id);
  clearBackendConversationMemory(id);
  if (window.currentChatSessionId === id) {
    if (window.chatSessions.length > 0) {
      selectChatSession(window.chatSessions[0].id);
    } else {
      window.currentChatSessionId = null;
      const msgContainer = document.getElementById('page-chat-messages-container');
      if (msgContainer) msgContainer.innerHTML = '';
    }
  }
  saveChatSessions();
  renderChatSessionsList();
  showToast(`Đã xóa "${title}"!`, 'info');
}

function selectChatSession(id) {
  if (window.pageChatIsResponding && id !== window.currentChatSessionId) return showToast('Hãy dừng câu trả lời hiện tại trước khi chuyển đoạn chat.', 'info');
  window.currentChatSessionId = id;
  try { localStorage.setItem(CHAT_ACTIVE_SESSION_KEY, id); } catch (_) { /* storage unavailable */ }
  const session = window.chatSessions.find(s => s.id === id);
  if (session) {
    normalizeStoredChatSession(session);
    const titleEl = document.getElementById('current-session-title');
    if (titleEl) titleEl.textContent = session.title;
    renderCurrentChatMessages();
  }
  renderChatSessionsList();
}

function clearAllChatSessions() {
  if (confirm('Bạn có chắc muốn xóa tất cả các cuộc trò chuyện?')) {
    window.chatSessions.forEach(session => clearBackendConversationMemory(session.id));
    window.chatSessions = [];
    saveChatSessions();
    createNewChatSession();
    showToast('Đã xóa tất cả cuộc trò chuyện!', 'info');
  }
}

async function populateChatModelSelector() {
  const selector = document.getElementById('page-chat-model-selector');
  const menu = document.getElementById('page-chat-model-menu');
  if (!selector || !menu) return;
  let providers = [];
  try {
    providers = window.aiProvidersData;
    if (!providers || providers.length === 0) {
      const res = await fetch('/api/ai-providers');
      if (res.ok) {
        const data = await res.json();
        providers = Array.isArray(data) ? data : (data.providers || []);
      }
    }
    selector.innerHTML = '';
    if (providers && providers.length > 0) {
      providers.forEach(prov => {
        const opt = document.createElement('option');
        opt.value = prov.id || prov.model || prov.name;
        opt.textContent = `${prov.name} (${prov.model || prov.type})`;
        opt.dataset.shortLabel = prov.model || prov.name || 'AI';
        selector.appendChild(opt);
      });
    } else {
      selector.innerHTML = `<option value="gemini-2.5-flash" data-short-label="Gemini 2.5 Flash">Google Gemini - 2.5 Flash</option>`;
    }
  } catch {
    selector.innerHTML = `<option value="gemini-2.5-flash" data-short-label="Gemini 2.5 Flash">Google Gemini - 2.5 Flash</option>`;
  }

  const savedValue = localStorage.getItem('knowledgehub_selected_chat_model');
  const activeProvider = (providers || []).find(prov => prov.isActive);
  const activeValue = activeProvider && (activeProvider.id || activeProvider.model || activeProvider.name);
  const selectedValue = Array.from(selector.options).some(option => option.value === savedValue)
    ? savedValue : (activeValue || selector.options[0]?.value || '');

  menu.innerHTML = Array.from(selector.options).map((option, index) => {
    const provider = (providers || [])[index] || {};
    const description = provider.name || provider.type || 'Trợ giúp toàn diện';
    return `<button type="button" class="page-chat-model-option" data-value="${escapeChatMarkdown(option.value)}" onclick="selectPageChatModel(this.dataset.value)" role="option">
      <i class="fa-solid fa-check model-check"></i>
      <span class="page-chat-model-copy"><strong>${escapeChatMarkdown(option.dataset.shortLabel || option.textContent)}</strong><small>${escapeChatMarkdown(description)}</small></span>
      ${provider.isActive ? '<span class="page-chat-model-badge">Mặc định</span>' : ''}
    </button>`;
  }).join('');
  selectPageChatModel(selectedValue);
}

async function fetchAndRenderQuickPrompts() {
  const container = document.getElementById('quick-prompts-bar');
  if (!container) return;
  try {
    const res = await fetch('/api/persona');
    if (!res.ok) throw new Error();
    const data = await res.json();
    const prompts = data.quickPrompts || [];
    if (prompts.length > 0) {
      container.innerHTML = prompts.map(p => `
        <button onclick="useQuickPrompt('${p.prompt.replace(/'/g, "\\'")}')" style="font-size:11.5px;padding:6px 14px;border-radius:20px;background:#fff;border:1px solid #cbd5e1;box-shadow:0 2px 5px rgba(0,0,0,.03);color:#334155;font-weight:600;cursor:pointer;transition:all .2s;white-space:nowrap;">
          <i class="fa-solid ${p.icon || 'fa-lightbulb'}" style="color:#6366f1;margin-right:6px;"></i>${p.label}
        </button>
      `).join('');
    }
  } catch { /* silent */ }
}

// Exports
window.sendPageChatMessage = sendPageChatMessage;
window.handlePageChatSendAction = handlePageChatSendAction;
window.stopPageChatResponse = stopPageChatResponse;
window.handlePageChatKeyPress = handlePageChatKeyPress;
window.updatePageChatCharacterCount = updatePageChatCharacterCount;
window.useQuickPrompt = useQuickPrompt;
window.createNewChatSession = createNewChatSession;
window.deleteSingleChatSession = deleteSingleChatSession;
window.selectChatSession = selectChatSession;
window.clearAllChatSessions = clearAllChatSessions;
window.renderChatSessionsList = renderChatSessionsList;
window.renderCurrentChatMessages = renderCurrentChatMessages;
window.renderChartSpec = renderChartSpec;
window.populateChatModelSelector = populateChatModelSelector;
window.fetchAndRenderQuickPrompts = fetchAndRenderQuickPrompts;
window.submitChatFeedback = submitChatFeedback;
window.renderChatFeedback = renderChatFeedback;
window.renderChatTokenUsage = renderChatTokenUsage;
window.toggleChatModelMenu = toggleChatModelMenu;
window.toggleChatAddMenu = toggleChatAddMenu;
window.selectPageChatModel = selectPageChatModel;
window.openChatFilePicker = openChatFilePicker;
window.handlePageChatFiles = handlePageChatFiles;
window.removePageChatAttachment = removePageChatAttachment;
window.togglePageChatWebSearch = togglePageChatWebSearch;
window.showChatAddNotice = showChatAddNotice;

document.addEventListener('DOMContentLoaded', () => {
  // NOTE: renderChatSessionsList() is called by switchMainTab('page_chat') in app.js
  // when user navigates to the chat page, not on DOMContentLoaded (SPA view not mounted yet)
  populateChatModelSelector();
  fetchAndRenderQuickPrompts();
  document.getElementById('page-chat-web-toggle')?.classList.toggle('is-active', window.pageChatWebSearchEnabled);
  document.getElementById('page-chat-web-toggle')?.setAttribute('aria-pressed', String(window.pageChatWebSearchEnabled));
});
