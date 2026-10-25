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
  window.syncPageChatScrollActivity?.();
  renderChatSessionsList();
  const button = document.getElementById('page-chat-send-button');
  if (!button) return;
  button.classList.toggle('is-stop', window.pageChatIsResponding);
  button.setAttribute('aria-label', window.pageChatIsResponding ? 'Dừng trả lời' : 'Gửi yêu cầu');
  button.setAttribute('aria-pressed', String(window.pageChatIsResponding));
  button.title = window.pageChatIsResponding ? 'Dừng tiến trình trả lời hiện tại' : 'Gửi yêu cầu';
  button.innerHTML = window.pageChatIsResponding
    ? '<i class="fa-solid fa-square"></i>'
    : '<i class="fa-solid fa-arrow-up"></i>';
}

window.syncPageChatComposerLayout = function syncPageChatComposerLayout() {
  const area = document.querySelector('#view-page_chat .page-chat-composer-area');
  const main = area?.parentElement;
  if (!area || !main || area._composerLayoutObserver || !window.ResizeObserver) return;
  let previousHeight = 0;
  const update = () => {
    const height = Math.ceil(area.getBoundingClientRect().height);
    if (!height || height === previousHeight) return;
    const messages = document.getElementById('page-chat-messages-container');
    const follow = messages && messages.scrollHeight - messages.clientHeight - messages.scrollTop <= 48;
    previousHeight = height;
    main.style.setProperty('--page-chat-composer-height', `${height}px`);
    if (follow) messages.scrollTop = messages.scrollHeight;
  };
  area._composerLayoutObserver = new window.ResizeObserver(update);
  area._composerLayoutObserver.observe(area);
  update();
};

window.syncPageChatScrollActivity=function syncPageChatScrollActivity(){
  window.syncPageChatComposerLayout?.();
  window.ChatReasoningUI?.watchActivity?.(document.getElementById('page-chat-messages-container'),document.getElementById('quick-prompts-bar') || document.querySelector('#view-page_chat .page-chat-composer'),
    ()=>Boolean(window.pageChatIsResponding&&window.pageChatPendingThinking?.sessionId===window.currentChatSessionId),{showWhenIdle:true,arrow:true});
};

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
  closeChatModelChoices();
  document.querySelectorAll('#page-chat-model-menu .chat-model-submenu-trigger').forEach(button => button.setAttribute('aria-expanded', 'false'));
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

function closeChatModelChoices(){
  const choices=document.getElementById('chat-model-other-menu');
  if(choices)choices.hidden=true;
  document.getElementById('chat-effort-model-button')?.setAttribute('aria-expanded','false');
}

function toggleChatModelChoices(event){
  event.stopPropagation();
  const choices=document.getElementById('chat-model-other-menu');
  const button=document.getElementById('chat-effort-model-button');
  if(!choices||!button)return;
  const open=choices.hidden;
  choices.hidden=!open;button.setAttribute('aria-expanded',String(open));
  if(open){
    const panel=document.getElementById('page-chat-model-menu').getBoundingClientRect();
    choices.classList.toggle('opens-right',panel.left<choices.offsetWidth+12&&window.innerWidth-panel.right>choices.offsetWidth+12);
    choices.querySelector('.is-selected')?.focus({preventScroll:true});
  }
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

function getPageChatReasoningMode() {
  return localStorage.getItem('knowledgehub_chat_reasoning_mode') === 'fast' ? 'fast' : 'medium';
}

function selectPageChatReasoningMode(mode, keepOpen = false) {
  localStorage.setItem('knowledgehub_chat_reasoning_mode', mode === 'fast' ? 'fast' : 'medium');
  selectPageChatModel(document.getElementById('page-chat-model-selector')?.value, !keepOpen);
}

function toggleChatModelSubmenu(event, button) {
  event.stopPropagation();
  const open = button.getAttribute('aria-expanded') !== 'true';
  document.querySelectorAll('#page-chat-model-menu .chat-model-submenu-trigger').forEach(item => item.setAttribute('aria-expanded', 'false'));
  button.setAttribute('aria-expanded', String(open));
}

function selectPageChatModel(value, closeMenu = true) {
  const selector = document.getElementById('page-chat-model-selector');
  if (!selector) return;
  selector.value = value;
  const option = selector.options[selector.selectedIndex];
  const label = document.getElementById('page-chat-model-label');
  if (label && option) label.innerHTML = `<span class="chat-selected-model">${escapeChatMarkdown(option.dataset.shortLabel || option.textContent)}</span><span class="chat-selected-mode">${getPageChatReasoningMode() === 'fast' ? 'Nhanh' : 'Suy luận'}</span>`;
  const currentModel = document.getElementById('chat-menu-current-model');
  if (currentModel && option) currentModel.textContent = option.dataset.shortLabel || option.textContent;
  const currentMode = document.getElementById('chat-menu-current-mode');
  if (currentMode) currentMode.textContent = getPageChatReasoningMode() === 'fast' ? 'Nhanh' : 'Suy luận';
  const effortSlider=document.getElementById('chat-effort-slider');
  const effortLabel=document.getElementById('chat-effort-label');
  const effortModel=document.getElementById('chat-effort-model');
  const effortDescription=document.getElementById('chat-effort-description');
  const isFast=getPageChatReasoningMode()==='fast';
  if(effortSlider){effortSlider.value=isFast?'0':'1';effortSlider.setAttribute('aria-valuetext',isFast?'Nhanh':'Suy luận');effortSlider.style.setProperty('--effort-progress',isFast?'0%':'100%');}
  if(effortLabel)effortLabel.textContent=isFast?'Nhanh':'Suy luận';
  if(effortModel&&option){effortModel.textContent=option.dataset.shortLabel||option.textContent;effortModel.title=option.textContent;}
  if(effortDescription)effortDescription.textContent=isFast?'Ẩn phần suy nghĩ khi xử lý':'Hiện phần suy nghĩ khi xử lý';
  document.querySelectorAll('.chat-reasoning-mode-option').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.mode === getPageChatReasoningMode()));
  });
  document.querySelectorAll('.page-chat-model-option').forEach(button => {
    button.classList.toggle('is-selected', button.dataset.value === value);
    button.setAttribute('aria-selected',String(button.dataset.value === value));
  });
  localStorage.setItem('knowledgehub_selected_chat_model', value);
  if(closeMenu)closePageChatMenus();
}

function openChatFilePicker(type = 'all') {
  closePageChatMenus();
  const picker=document.getElementById('page-chat-file-input');
  if(picker)picker.accept=window.ChatAttachments.accept;
  document.getElementById(type === 'camera' ? 'page-chat-camera-input' : 'page-chat-file-input')?.click();
}

function handlePageChatFiles(event) {
  const incoming = Array.from(event?.target?.files || []);
  window.pageChatAttachments=window.ChatAttachments.add(window.pageChatAttachments,incoming,message=>showToast(message,'warning'));
  if (event?.target) event.target.value = '';
  renderPageChatAttachments();
}

function removePageChatAttachment(index) {
  window.ChatAttachments.release(window.pageChatAttachments.slice(index,index+1));
  window.pageChatAttachments.splice(index, 1);
  renderPageChatAttachments();
}

function renderPageChatAttachments() {
  const preview = document.getElementById('page-chat-attachment-preview');
  if (!preview) return;
  preview.classList.toggle('has-files', window.pageChatAttachments.length > 0);
  window.ChatAttachments.render(preview,window.pageChatAttachments,{onRemove:removePageChatAttachment});
  if (window.pageChatAttachments.some(file => file.carried)) {
    const note = document.createElement('p');
    note.className = 'page-chat-carry-note';
    // The file row scrolls sideways, so the note sits first in the row as a compact label.
    note.title = 'Các tệp này được giữ từ câu hỏi trước. Bấm × trên từng tệp hoặc “Bỏ” để không dùng nữa.';
    note.innerHTML = '<i class="fa-solid fa-link" aria-hidden="true"></i><span>Tệp câu trước</span>';
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Bỏ';
    clear.setAttribute('aria-label', 'Bỏ các tệp giữ từ câu trước');
    clear.onclick = () => dropCarriedPageChatAttachments();
    note.append(clear);
    preview.append(note);
  }
  renderChatKnowledgeChip();
  if (typeof renderPageChatSessionFiles === 'function') renderPageChatSessionFiles();
}

// After a question about files, the same files stay in the composer for the next question in that
// conversation, as server references. Nothing is carried when the user already staged other files.
function carryPageChatAttachments(sessionId, attachments) {
  if (window.currentChatSessionId !== sessionId || window.pageChatAttachments.length) return false;
  const stored = (attachments || []).filter(file => file.batchId && file.id && ['ready', 'partial', undefined].includes(file.processingStatus)).slice(0, 5);
  if (!stored.length) return false;
  window.pageChatAttachments = stored.map(file => ({ id: file.id, batchId: file.batchId, name: file.name, size: file.size, type: file.type, carried: true }));
  renderPageChatAttachments();
  return true;
}

function dropCarriedPageChatAttachments() {
  const kept = window.pageChatAttachments.filter(file => !file.carried);
  if (kept.length === window.pageChatAttachments.length) return;
  window.pageChatAttachments = kept;
  renderPageChatAttachments();
}

// Files uploaded earlier in this conversation; picking one adds a server reference to the composer.
window.pageChatSessionFiles = [];
let pageChatSessionFilesFor = null;
async function loadPageChatSessionFiles(force = false) {
  const sessionId = getCurrentChatSession()?.id || null;
  if (!force && sessionId === pageChatSessionFilesFor) return;
  // Files carried from a question belong to that conversation only.
  if (sessionId !== pageChatSessionFilesFor) dropCarriedPageChatAttachments();
  pageChatSessionFilesFor = sessionId;
  window.pageChatSessionFiles = [];
  if (typeof renderPageChatSessionFiles === 'function') renderPageChatSessionFiles();
  if (!sessionId) return;
  try {
    const response = await fetch('/api/chat/attachments?' + new URLSearchParams({ sessionId }), { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message);
    if (pageChatSessionFilesFor !== sessionId) return;
    window.pageChatSessionFiles = Array.isArray(data.files) ? data.files : [];
  } catch (_) { window.pageChatSessionFiles = []; }
  if (typeof renderPageChatSessionFiles === 'function') renderPageChatSessionFiles();
}

function togglePageChatSessionFiles(event, open) {
  event?.stopPropagation?.();
  const panel = document.getElementById('page-chat-session-files-panel');
  const trigger = document.getElementById('page-chat-session-files-trigger');
  if (!panel) return;
  const show = open ?? !panel.classList.contains('is-open');
  if (show && !window.pageChatSessionFiles.length) {
    if (open) showToast('Cuộc trò chuyện này chưa có tệp nào được tải lên.', 'info');
    return;
  }
  // The column stays in the DOM so it can slide; inert keeps it out of focus order while closed.
  panel.classList.toggle('is-open', show);
  panel.inert = !show;
  panel.setAttribute('aria-hidden', String(!show));
  trigger?.setAttribute('aria-expanded', String(show));
  if (show) renderPageChatSessionFiles();
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.getElementById('page-chat-session-files-panel')?.classList.contains('is-open')) togglePageChatSessionFiles(event, false);
});

function isPageChatSessionFileSelected(file) {
  return window.pageChatAttachments.some(item => item.id === file.id && item.batchId === file.batchId);
}

function togglePageChatSessionFile(index) {
  const file = window.pageChatSessionFiles[index];
  if (!file) return;
  if (isPageChatSessionFileSelected(file)) {
    window.pageChatAttachments = window.pageChatAttachments.filter(item => !(item.id === file.id && item.batchId === file.batchId));
  } else if (window.pageChatAttachments.length >= 5) {
    return showToast('Mỗi lần hỏi tối đa 5 tệp.', 'warning');
  } else {
    window.pageChatAttachments = [...window.pageChatAttachments, { id: file.id, batchId: file.batchId, name: file.name, size: file.size, type: file.type }];
  }
  renderPageChatAttachments();
  document.getElementById('page-chat-user-input')?.focus();
}

function renderPageChatSessionFiles() {
  const fileSessionId=window.currentChatSessionId;
  const files = window.pageChatSessionFiles || [];
  const trigger = document.getElementById('page-chat-session-files-trigger');
  const count = document.getElementById('page-chat-session-files-count');
  const panel = document.getElementById('page-chat-session-files-panel');
  const list = document.getElementById('page-chat-session-files-list');
  if (trigger) trigger.hidden = files.length === 0;
  if (count) count.textContent = String(files.length);
  if (panel && !files.length) togglePageChatSessionFiles(null, false);
  if (!list || !panel?.classList.contains('is-open')) return;
  // Same search folding and card layout as the conversation history column.
  const searchable = value => String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[đĐ]/g, 'd').toLocaleLowerCase('vi');
  const query = searchable((document.getElementById('page-chat-session-files-search')?.value || '').trim());
  const icons = { png: 'fa-file-image', jpg: 'fa-file-image', jpeg: 'fa-file-image', webp: 'fa-file-image', pdf: 'fa-file-pdf', docx: 'fa-file-word', xlsx: 'fa-file-excel', csv: 'fa-file-excel' };
  const startToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const groupFor = time => time >= startToday ? 'Hôm nay' : time >= startToday - 86400000 ? 'Hôm qua' : 'Trước đó';
  const shown = files.map((file, index) => ({ file, index })).filter(({ file }) => !query || searchable(file.name).includes(query));
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'chat-files-empty';
    empty.textContent = 'Không tìm thấy tệp phù hợp.';
    return list.replaceChildren(empty);
  }
  const nodes = [];
  let group = null;
  for (const { file, index } of shown) {
    const created = new Date(file.createdAt).getTime();
    if (groupFor(created) !== group) {
      group = groupFor(created);
      const title = document.createElement('div');
      title.className = 'chat-session-group-title';
      title.innerHTML = `<span>${group}</span><span class="chat-session-group-count">${shown.filter(item => groupFor(new Date(item.file.createdAt).getTime()) === group).length}</span>`;
      nodes.push(title);
    }
    const selected = isPageChatSessionFileSelected(file);
    const extension = String(file.name || '').split('.').pop().toLowerCase();
    const size = file.size >= 1048576 ? (file.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.ceil((file.size || 0) / 1024)) + ' KB';
    const time = created >= startToday - 86400000 ? new Date(created).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : new Date(created).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    const item = document.createElement('div');
    item.className = `chat-session-item chat-file-item${selected ? ' is-current' : ''}`;
    item.innerHTML = `
      <button type="button" class="chat-session-main" aria-pressed="${selected}" title="${selected ? 'Bỏ chọn tệp' : 'Chọn tệp để hỏi tiếp'}">
        <i aria-hidden="true" class="${selected ? 'fa-solid fa-check' : `fa-regular ${icons[extension] || 'fa-file-lines'}`}"></i>
        <span class="chat-session-copy"><span class="chat-session-title-line"><span class="chat-session-title"></span></span></span>
        <span class="chat-session-meta"><time>${escapeChatMarkdown(time)}</time></span>
        <span class="chat-session-preview">${escapeChatMarkdown([size, extension.toUpperCase(), file.uploads > 1 ? `đã tải ${file.uploads} lần` : '', selected ? 'đã chọn' : ''].filter(Boolean).join(' · '))}</span>
      </button>
      <button type="button" class="chat-session-more" title="Xem tệp" aria-label="Xem tệp"><i class="fa-regular fa-eye" aria-hidden="true"></i></button>`;
    item.querySelector('.chat-session-title').textContent = file.name;
    item.querySelector('.chat-session-copy').title = file.name;
    item.querySelector('.chat-session-main').onclick = () => togglePageChatSessionFile(index);
    item.querySelector('.chat-session-more').onclick = () => window.ChatAttachments.preview(file);
    const surface=document.createElement('div');surface.className='chat-file-swipe-content';
    surface.append(...item.childNodes);item.append(surface);
    const remove=document.createElement('button');remove.type='button';remove.className='chat-file-list-delete';
    remove.innerHTML='<i class="fa-regular fa-trash-can" aria-hidden="true"></i><span>Xóa</span>';
    remove.setAttribute('aria-label','Xóa '+file.name+' khỏi danh sách');item.append(remove);
    remove.onclick=async()=>{
      remove.disabled=true;
      try {
        const response=await fetch('/api/chat/attachments',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:fileSessionId,batchId:file.batchId,fileId:file.id})});
        if(!response.ok)throw new Error('Không xóa được tệp khỏi danh sách.');
        if(window.currentChatSessionId!==fileSessionId)return;
        window.pageChatSessionFiles=(window.pageChatSessionFiles||[]).filter(entry=>entry!==file);
        window.pageChatAttachments=(window.pageChatAttachments||[]).filter(entry=>entry.id!==file.id||entry.batchId!==file.batchId);
        renderPageChatAttachments();renderPageChatSessionFiles();
      }catch(error){showToast(error.message,'error');remove.disabled=false;}
    };
    let startX=0,startY=0,dragging=false,moved=false;
    surface.addEventListener('pointerdown',event=>{if(event.button!==0)return;startX=event.clientX;startY=event.clientY;dragging=true;moved=false;});
    surface.addEventListener('pointermove',event=>{
      if(!dragging)return;
      const dx=event.clientX-startX,dy=event.clientY-startY;
      if(!moved&&Math.abs(dy)>Math.abs(dx)){dragging=false;return;}
      if(Math.abs(dx)>8){moved=true;item.classList.add('is-swiping');surface.setPointerCapture(event.pointerId);item.style.setProperty('--file-delete-width',`${Math.max(0,Math.min(64,(item.classList.contains('is-swiped')?64:0)-dx))}px`);}
    });
    const endSwipe=event=>{if(!dragging)return;dragging=false;item.classList.remove('is-swiping');if(moved){const dx=event.clientX-startX;item.classList.toggle('is-swiped',dx < -24 || (item.classList.contains('is-swiped')&&dx<24));item.style.removeProperty('--file-delete-width');}};
    surface.addEventListener('pointerup',endSwipe);
    surface.addEventListener('pointercancel',()=>{dragging=false;item.classList.remove('is-swiping');item.style.removeProperty('--file-delete-width');});
    surface.addEventListener('click',event=>{if(moved){event.preventDefault();event.stopImmediatePropagation();moved=false;}},true);
    nodes.push(item);
  }
  list.replaceChildren(...nodes);
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
  document.getElementById('page-chat-web-toggle')?.setAttribute('aria-checked', String(window.pageChatWebSearchEnabled));
  renderChatKnowledgeChip();
}

function showChatAddNotice(type) {
  closePageChatMenus();
  const labels = { project: 'Dự án', skills: 'Skills', connector: 'Connector', plugins: 'Plugins' };
  if (typeof showToast === 'function') showToast(`${labels[type] || type} sẽ được cấu hình tại trang quản trị tương ứng.`, 'info');
}

document.addEventListener('click', closePageChatMenus);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closePageChatMenus();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'u') {
    if (document.getElementById('copilot-modal')?.classList.contains('show')) return;
    event.preventDefault(); openChatFilePicker('all');
  }
});

let chatHistoryLoaded = false;
let chatHistoryFailed = false;
let chatHistoryConflict = false;
const chatPinSaves = new Set();
let chatHistorySaveQueue = Promise.resolve();
const persistedChatSessions = new Map();

const chatPageLoads = new Set();
const chatContinuations = new Set();
const dismissedChatLimitWarnings = new Set();
function chatPayloadBytes(session) {
  return new TextEncoder().encode(JSON.stringify({messages:session.messages,history:session.history})).length;
}
function chatSessionUsage(session) {
  return {count:(session._page?.start || 0)+session.messages.length,
    bytes:session._page ? session._page.bytes + chatPayloadBytes(session) - session._page.loadedBytes : new TextEncoder().encode(JSON.stringify(session)).length};
}
function chatSessionIsFull(session) {
  const usage=chatSessionUsage(session);
  return usage.count >= 80 || usage.bytes >= 2*1024*1024;
}
function renderChatLimitNotice(session) {
  let notice=document.getElementById('chat-session-limit-notice');
  if (!notice) {
    notice=document.createElement('div'); notice.id='chat-session-limit-notice';
  }
  // Keep the warning in the measured floating stack. A sibling at the bottom
  // of chat-main would sit underneath the absolutely positioned composer.
  const composerArea=document.querySelector?.('#view-page_chat .page-chat-composer-area');
  if (composerArea && notice.parentElement!==composerArea) composerArea.prepend(notice);
  else if (!composerArea && !notice.isConnected) document.getElementById('page-chat-messages-container')?.after(notice);
  notice.replaceChildren(); notice.hidden=true;
  if (!session) return;
  const usage=chatSessionUsage(session);
  const isFull=chatSessionIsFull(session);
  const canContinue=usage.count>=60 || isFull;
  const nextSession=session.continuedTo && window.chatSessions?.find(item=>item.id===session.continuedTo);
  if (!canContinue && !nextSession) return;
  if (!isFull && dismissedChatLimitWarnings.has(session.id)) return;
  notice.hidden=false;
  notice.className=chatSessionIsFull(session) ? 'chat-limit-card is-full' : canContinue || nextSession ? 'chat-limit-card' : 'chat-limit-card is-context';
  notice.role='status'; notice.ariaLive='polite';
  const text=document.createElement('span');
  text.className='chat-limit-copy';
  text.textContent=chatSessionIsFull(session) ? 'Hội thoại đã đạt giới hạn' :
    usage.count>=60 ? 'Hội thoại sắp đầy · '+usage.count+'/80 tin' : 'Đã tiếp nối ngữ cảnh hội thoại';
  const detail=document.createElement('small'); detail.className='chat-limit-description';
  detail.textContent=nextSession ? 'Bản tóm tắt đã sẵn sàng trong hội thoại tiếp theo. Bạn vẫn có thể xem lại lịch sử tại đây.' :
    session.continuedFrom && usage.count<60 && !chatSessionIsFull(session) ? 'Bạn có thể xem bản tóm tắt hoặc quay lại hội thoại trước bất cứ lúc nào.' :
    'Tiếp tục trong hội thoại mới kèm bản tóm tắt ngữ cảnh. Lịch sử cũ vẫn được giữ lại.';
  text.append(detail);
  notice.append(text);
  if (canContinue || nextSession) {
    const button=document.createElement('button'); button.type='button';
    button.className='chat-limit-primary';
    button.textContent=nextSession ? 'Mở hội thoại tiếp' : chatContinuations.has(session.id) ? 'Đang tóm tắt…' : 'Tiếp tục với ngữ cảnh';
    button.disabled=chatContinuations.has(session.id);
    button.onclick=()=>nextSession ? selectChatSession(nextSession.id) : continueChatSession(session.id);
    notice.append(button);
    const fresh=document.createElement('button'); fresh.type='button'; fresh.className='chat-limit-fresh';
    fresh.textContent='Chat mới trống';
    fresh.title='Bắt đầu hội thoại trống, không mang theo ngữ cảnh cũ';
    fresh.disabled=chatContinuations.has(session.id);
    fresh.onclick=()=>createNewChatSession(); notice.append(fresh);
  }
  if (!isFull && usage.count>=60) {
    const close=document.createElement('button'); close.type='button';
    close.className='chat-limit-dismiss'; close.textContent='×';
    close.title='Ẩn cảnh báo sắp đầy';
    close.setAttribute('aria-label','Ẩn cảnh báo hội thoại sắp đầy');
    close.onclick=()=>{
      dismissedChatLimitWarnings.add(session.id);
      notice.hidden=true;
    };
    notice.append(close);
  }
}
async function loadOlderChatMessages(session=getCurrentChatSession()) {
  if (!session?._page?.start || chatPageLoads.has(session.id) || window.pageChatIsResponding) return;
  chatPageLoads.add(session.id);
  try {
    if (!await saveChatSessions()) return;
    const version=persistedChatSessions.get(session.id)?.version;
    const before=session._page.start;
    const response=await fetch('/api/page-chat/sessions?'+new URLSearchParams({sessionId:session.id,before,version}));
    if (!response.ok) throw new Error(response.status===409 ? 'Lịch sử đã thay đổi. Hãy tải lại trang.' : 'Không tải được tin cũ. Cuộn lên hoặc bấm để thử lại.');
    const {session:older}=await response.json();
    if (!window.chatSessions.includes(session) || session._page.start!==before) return;
    const baseline=chatPayloadBytes(session);
    session.messages.unshift(...older.messages);
    session._page.start=older._page.start;
    session._page.loadedBytes+=chatPayloadBytes(session)-baseline;
    // Loading old messages is not a user edit.
    const saved=persistedChatSessions.get(session.id);
    if (saved) {
      const snapshot=JSON.parse(saved.snapshot);
      snapshot.messages.unshift(...older.messages); snapshot._page={...session._page};
      saved.snapshot=sessionSnapshot(snapshot);
    }
    if (window.currentChatSessionId===session.id) renderCurrentChatMessages(true);
  } catch(error) { showToast(error.message,'error'); }
  finally { chatPageLoads.delete(session.id); }
}
async function continueChatSession(id) {
  if (window.pageChatIsResponding || chatContinuations.has(id)) return;
  const source=window.chatSessions.find(item=>item.id===id);
  if (!source) return;
  if (source.continuedTo && window.chatSessions.some(item=>item.id===source.continuedTo)) {
    if (await saveChatSessions()) selectChatSession(source.continuedTo);
    return;
  }
  if (chatSessionUsage(source).count<60 && !chatSessionIsFull(source)) return;
  chatContinuations.add(id); renderChatLimitNotice(source);
  try {
    if (!await saveChatSessions()) throw new Error('Hãy lưu lại lịch sử trước khi tiếp tục.');
    const response=await fetch('/api/page-chat/sessions',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({action:'summarize',sessionId:id,version:persistedChatSessions.get(id).version,
        providerId:document.getElementById('page-chat-model-selector')?.value || null}),signal:AbortSignal.timeout(18000)});
    if (!response.ok) {
      const error=await response.json().catch(()=>({}));
      const message=error.message==='CHAT_HISTORY_CONFLICT' ? 'Hội thoại đã thay đổi trên tab khác. Hãy tải lại trang trước khi tiếp tục.' :
        error.message==='CHAT_NOT_FOUND' ? 'Không tìm thấy hội thoại gốc. Hãy tải lại danh sách hội thoại.' :
        response.status===401 ? 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.' :
        'Chưa chuyển được ngữ cảnh (HTTP '+response.status+'). Hãy thử lại.';
      throw new Error(message);
    }
    const {summary:summaryText,mode}=await response.json();
    const newId='session-'+crypto.randomUUID();
    const summary=typeof summaryText==='string' ? summaryText.trim() : '';
    if (!summary) throw new Error('Chưa tạo được ngữ cảnh chuyển tiếp. Hãy thử lại.');
    const now=Date.now();
    if (!window.chatSessions.includes(source)) throw new Error('Hội thoại gốc đã bị xóa.');
    const next={id:newId,title:('Tiếp tục: '+source.title).slice(0,200),createdAt:now,updatedAt:now,continuedFrom:id,
      continuationSummary:summary,history:[],messages:[]};
    window.chatSessions.unshift(next);
    source.continuedTo=newId;
    renderChatSessionsList();
    if (!await saveChatSessions()) { throw new Error('Chưa lưu được hội thoại mới. Hãy bấm lưu lại lịch sử; bản tóm tắt vẫn được giữ trên trang.'); }
    selectChatSession(newId);
    if (mode==='excerpt') showToast('Model phản hồi chậm hoặc chưa khả dụng. Đã chuyển tiếp bằng trích đoạn ngữ cảnh; bạn có thể xem lại trong hội thoại mới.','info');
  } catch(error) { showToast(error.message,'error'); }
  finally { chatContinuations.delete(id); renderChatLimitNotice(getCurrentChatSession()); }
}

function sessionSnapshot(session) { const {version,...data}=session; return JSON.stringify(data); }
function saveChatSessions() {
  try { localStorage.setItem(CHAT_ACTIVE_SESSION_KEY, window.currentChatSessionId || ''); } catch (_) {}
  if (!chatHistoryLoaded || chatHistoryFailed) return Promise.resolve(false);
  chatHistorySaveQueue = chatHistorySaveQueue.then(async () => {
    if (chatHistoryFailed) return false;
    const current = (window.chatSessions || []).map(session => JSON.parse(JSON.stringify(session)));
    const ids = new Set(current.map(session=>session.id));
    const changes = current.filter(session=>persistedChatSessions.get(session.id)?.snapshot!==sessionSnapshot(session))
      .map(session=>({...session,version:persistedChatSessions.get(session.id)?.version || 0}));
    const deleted = [...persistedChatSessions].filter(([id])=>!ids.has(id)).map(([id,value])=>({id,version:value.version}));
    if (!changes.length && !deleted.length) return true;
    const response=await fetch('/api/page-chat/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({changes,deleted})});
    if (!response.ok) throw new Error(response.status===409?'Lịch sử đã thay đổi trên thiết bị khác. Tải lại trang trước khi sửa tiếp.':'Không lưu được lịch sử chat. Nội dung hiện vẫn còn trên trang; hãy thử lưu lại.');
    const result=await response.json();
    deleted.forEach(item=>persistedChatSessions.delete(item.id));
    changes.forEach(session=>persistedChatSessions.set(session.id,{version:result.versions[session.id],snapshot:sessionSnapshot(session)}));
    document.getElementById('chat-history-save-notice')?.setAttribute('hidden', '');
    return true;
  }).catch(error=>{
    chatHistoryFailed=true;
    const networkFailure=error?.name==='TypeError';
    showToast(networkFailure
      ? 'Mất kết nối khi lưu lịch sử. Nội dung vẫn còn trên trang; hãy bấm Lưu lại khi kết nối ổn định.'
      : error.message,'error','Chưa lưu được lịch sử');
    chatHistoryConflict = error.message.includes('thiết bị khác');
    const notice = document.getElementById('chat-history-save-notice');
    const message = document.getElementById('chat-history-save-message');
    const retry = document.getElementById('chat-history-save-retry');
    if (notice) notice.hidden = false;
    if (message) message.textContent = chatHistoryConflict ? 'Lịch sử đã thay đổi trên thiết bị khác. Tải lại trang trước khi sửa tiếp.' : 'Chưa lưu được thay đổi. Nội dung vẫn còn trên trang.';
    if (retry) retry.hidden = chatHistoryConflict;
    console.error('Chat history save failed', {operation:'save_sessions',errorName:error?.name,message:error?.message});
    return false;
  });
  return chatHistorySaveQueue;
}

async function retrySaveChatSessions() {
  if (chatHistoryConflict) return;
  const button = document.getElementById('chat-history-save-retry');
  if (button?.disabled) return;
  if (button) button.disabled = true;
  chatHistoryFailed = false;
  try {
    if (await saveChatSessions()) {
      document.getElementById('chat-history-save-notice')?.setAttribute('hidden', '');
      showToast('Đã lưu lịch sử chat.', 'success');
    }
  } finally { if (button) button.disabled = false; }
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
      html: sanitizeSystemPaths(fixStoredMojibake(message.html || ''))
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

async function loadChatSessions() {
  try {
    const response=await fetch('/api/page-chat/sessions');
    if (!response.ok) throw new Error('Không tải được lịch sử chat từ máy chủ. Hãy tải lại trang.');
    const data=await response.json();
    window.chatSessions=data.sessions.map(normalizeStoredChatSession);
    window.chatSessions.forEach(session=>{ if(session._page) session._page.loadedBytes=chatPayloadBytes(session); });
    window.chatSessions.forEach(session=>persistedChatSessions.set(session.id,{version:session.version,snapshot:sessionSnapshot(session)}));
    try { window.currentChatSessionId=localStorage.getItem(CHAT_ACTIVE_SESSION_KEY); } catch (_) {}
    if (!window.chatSessions.some(session=>session.id===window.currentChatSessionId)) window.currentChatSessionId=window.chatSessions[0]?.id || null;
    chatHistoryLoaded=true;
    // Legacy browser history has no reliable account owner. Import only after
    // the signed-in user explicitly confirms that it belongs to them.
    let legacy; try { legacy=JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY)||'null'); } catch (_) {}
    if (legacy?.chatSessions?.length && await showUiConfirm('Trình duyệt còn lịch sử chat cũ. Bạn xác nhận đây là dữ liệu của mình và muốn lưu vào tài khoản đang đăng nhập?',{title:'Nhập lịch sử chat cũ',confirmText:'Nhập vào tài khoản'})) {
      const ids=new Set(window.chatSessions.map(session=>session.id));
      for(const session of legacy.chatSessions) {
        const imported=normalizeStoredChatSession(session); delete imported.version;
        if(ids.has(imported.id)) imported.id=`session-${crypto.randomUUID()}`;
        window.chatSessions.push(imported); ids.add(imported.id);
      }
      if(await saveChatSessions()) localStorage.removeItem(CHAT_STORAGE_KEY);
    }
    renderChatSessionsList(); renderCurrentChatMessages();
  } catch (err) {
    chatHistoryFailed=true;
    showToast(err.message,'error');
  }
}

// Both clients use account-scoped server history. Refresh only a clean, idle view;
// version checks retain locally expanded message pages when nothing changed remotely.
let chatHistorySyncing = false;
function chatHistoryIsClean() {
  const sessions = window.chatSessions || [];
  return sessions.length === persistedChatSessions.size && sessions.every(session =>
    persistedChatSessions.get(session.id)?.snapshot === sessionSnapshot(session));
}
async function syncChatSessions() {
  if (chatHistorySyncing || !chatHistoryLoaded || chatHistoryFailed || document.hidden || window.pageChatIsResponding || chatPageLoads.size || !chatHistoryIsClean()) return;
  chatHistorySyncing = true;
  const before = JSON.stringify([...persistedChatSessions].map(([id, value]) => [id, value.version]));
  try {
    const response = await fetch('/api/page-chat/sessions', {cache:'no-store'});
    if (!response.ok) return;
    const data = await response.json();
    if (!Array.isArray(data.sessions) || window.pageChatIsResponding || chatPageLoads.size || !chatHistoryIsClean() || before !== JSON.stringify([...persistedChatSessions].map(([id, value]) => [id, value.version]))) return;
    const local = new Map(window.chatSessions.map(session => [session.id, session]));
    const selectedId = window.currentChatSessionId;
    const selectedVersion = persistedChatSessions.get(selectedId)?.version;
    const changed = data.sessions.length !== local.size || data.sessions.some(session => persistedChatSessions.get(session.id)?.version !== session.version);
    if (!changed) return;
    window.chatSessions = data.sessions.map(remote => {
      if (persistedChatSessions.get(remote.id)?.version === remote.version) { const kept = local.get(remote.id); kept.version = remote.version; return kept; }
      const session = normalizeStoredChatSession(remote);
      if (session._page) session._page.loadedBytes = chatPayloadBytes(session);
      return session;
    });
    persistedChatSessions.clear();
    window.chatSessions.forEach(session => persistedChatSessions.set(session.id, {version:session.version, snapshot:sessionSnapshot(session)}));
    // Retained local sessions can have an older version property after a save.
    data.sessions.forEach(remote => { persistedChatSessions.get(remote.id).version = remote.version; });
    if (!window.chatSessions.some(session => session.id === selectedId)) window.currentChatSessionId = window.chatSessions[0]?.id || null;
    renderChatSessionsList();
    if (selectedId !== window.currentChatSessionId || selectedVersion !== persistedChatSessions.get(window.currentChatSessionId)?.version) {
      renderCurrentChatMessages();
      loadPageChatSessionFiles(true);
    }
  } catch (_) { /* A temporary connection failure must preserve the current conversation. */ }
  finally { chatHistorySyncing = false; }
}
window.addEventListener('focus', syncChatSessions);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncChatSessions(); });
setInterval(syncChatSessions, 5000);

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
  if (!chatHistoryLoaded || chatHistoryFailed) return;
  if (window.chatSessions.length === 0) {
    const newId = `session-${crypto.randomUUID()}`;
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

const chatHistoryReady = loadChatSessions();

// Markdown + link + JSON-block cleaner
function cleanReplyText(text) {
  if (!text) return '';
  text = String(text)
    .replace(/\{\s*(?:render[_-]?)?chart\s*\}/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Preserve API request/response examples, including mislabeled curl blocks.
  // Only suppress a complete Chart.js payload, never arbitrary JSON by language.
  text = text.replace(/```json\s*([\s\S]*?)```/gi, (block, content) => {
    try {
      const spec = JSON.parse(content);
      const isChart = ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea', 'bubble', 'scatter'].includes(spec?.type)
        && Array.isArray(spec.data?.labels) && Array.isArray(spec.data?.datasets);
      return isChart ? '' : block;
    } catch { return block; }
  }).trim();
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

function sanitizeSystemPaths(value) {
  return String(value ?? '')
    .replace(/\[[^\]]*\]\(\s*\[SYSTEM_PATH_HIDDEN\]\s*\)/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']\s*file:[\s\S]*?<\/a>/gi, '[SYSTEM_PATH_HIDDEN]')
    .replace(/file:\/{2,3}[^\s<>"'`)]+/gi, '[SYSTEM_PATH_HIDDEN]')
    .replace(/(^|[\s(`"'=])(?:[a-z]:[\\/]|\\\\[^\s\\/]+[\\/])[^\s<>"'`)]+/gim, '$1[SYSTEM_PATH_HIDDEN]')
    .replace(/(^|[\s(`"'=])\/(?:home|root|etc|var|tmp|srv|opt|Users)\/[^\s<>"'`)]+/g, '$1[SYSTEM_PATH_HIDDEN]')
    .replace(/\[[^\]]*\]\(\s*\[SYSTEM_PATH_HIDDEN\]\s*\)/gi, '')
    .replace(/\[SYSTEM_PATH_HIDDEN\]/g, '')
    .replace(/^[\s>*•-]*(?:🔽\s*)?(?:Tải (?:về|xuống)(?: tại)?|Download)\s*:?\s*(?:\(\s*\))?\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripInlineDownloadLink(value, downloadUrl) {
  const text = String(value ?? '');
  const url = String(downloadUrl || '').trim();
  if (!/^\/api\/exports\/[^\s<>"']+$/i.test(url)) return text;
  const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Multiple export links carry group labels and row counts in their list items.
  // Keep them in place so the card upgrader can preserve that association.
  if ((text.match(/\]\(\s*\/api\/exports\//g) || []).length > 1) return text;
  return text
    .replace(new RegExp(`\\[[^\\]]*\\]\\(\\s*${escapedUrl}\\s*\\)`, 'gi'), '')
    .replace(new RegExp(escapedUrl, 'gi'), '')
    .replace(/^[\s>*•-]*(?:🔽\s*)?(?:Tải (?:về|xuống|file)(?: tại| kết quả)?|Download)\s*:?\s*[.,]*\s*$/gim, '')
    .replace(/:\s*\.(?=\s|$)/g, '.')
    .replace(/^\s*[.,]\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseMarkdownInline(value) {
  let html = escapeChatMarkdown(sanitizeSystemPaths(value));
  html = html.replace(/(^|[\s:])(\/(?:api\/)?exports\/[^\s<>()`]+\.(?:xlsx?|csv|pdf))(?=$|[\s,.!?<])/gi,
    '$1<a class="chat-download-link" href="$2" download><i class="fa-solid fa-download"></i>Tải file tại đây</a>');
  html = html.replace(/\[([^\]]+)\]\s*\(\s*(\/(?:api\/)?exports\/[^)\s]+)\s*\)/g,
    '<a class="chat-download-link" href="$2" download><i class="fa-solid fa-download"></i>$1</a>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a class="chat-answer-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  html = html.replace(/(^|[\s:(])(https?:\/\/[^\s<>()`]+)(?=$|[\s,.!?<])/gi, (_, prefix, rawUrl) => {
    const trailing = rawUrl.match(/[.,!?;:]+$/)?.[0] || '';
    const url = rawUrl.slice(0, rawUrl.length - trailing.length);
    const decodedUrl = url.replace(/&amp;/g, '&');
    try {
      const parsed = new URL(decodedUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) return `${prefix}${rawUrl}`;
    } catch (_) { return `${prefix}${rawUrl}`; }
    return `${prefix}<a class="chat-answer-link" href="${escapeChatMarkdown(decodedUrl)}" target="_blank" rel="noopener noreferrer">${url}</a>${trailing}`;
  });
  return html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code class="chat-inline-code">$1</code>');
}

function splitMarkdownTableRow(line) {
  const text = String(line || '').trim();
  const cells = []; let cell = '', delimiter = false;
  for (let index = text.startsWith('|') ? 1 : 0; index < text.length; index++) {
    if (text[index] === '\\' && text[index + 1] === '|') { cell += '|'; index++; delimiter = false; }
    else if (text[index] === '|') { cells.push(cell.trim()); cell = ''; delimiter = true; }
    else { cell += text[index]; delimiter = false; }
  }
  if (!delimiter) cells.push(cell.trim());
  return cells;
}

function isMarkdownTableDivider(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function isBooleanDisplayColumn(columnName = '') {
  const normalized = String(columnName).trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return /^(?:is|has|can|should|allow|enable|active|inactive|deleted|locked|verified|approved|visible)/.test(normalized)
    || /^(?:co|da|duoc|kichhoat|hieuluc)/.test(normalized);
}

function formatMoneyDisplayValue(value, label = '', unit = '') {
  const text = String(label) + ' ' + String(unit || '');
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').replace(/\bhop dong\b/gi, '');
  // "hợp đồng" means contract, not the currency; identifier columns are never money.
  if (/\bid\b|^\s*ma\b/i.test(normalized) || /[a-z]ID\b/.test(text)) return value;
  const currency = /\b(?:VND|VNd|dong)\b|₫/i.test(normalized) ? 'VND'
    : /\b(USD|EUR|GBP|JPY)\b/i.exec(text)?.[1]?.toUpperCase();
  const monetary = currency || /amount|money|price|balance|\b(?:tien|gia|cong no|doanh thu|chi phi)\b/i.test(normalized);
  if (!monetary || value === null || value === undefined || value === ''
    || !(typeof value === 'number' || typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))
    || !Number.isFinite(Number(value))) return value;
  return new Intl.NumberFormat('vi-VN', { ...(currency ? { style: 'currency', currency } : {}),
    minimumFractionDigits: 0, maximumFractionDigits: 20 }).format(value);
}

function formatChatDisplayValue(value, columnName = '') {
  const money = formatMoneyDisplayValue(value, columnName);
  if (money !== value) return String(money);
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
}

function renderMarkdownTable(headerLine, bodyLines) {
  const headers = splitMarkdownTableRow(headerLine);
  const rows = bodyLines.map(splitMarkdownTableRow);
  const widths = headers.map((header, index) => Math.max(100, Math.min(320,
    Math.max(String(header).length, ...rows.map(row => String(row[index] ?? '').length)) * 7 + 24)));
  const columnsHtml = widths.map(width => `<col style="width:${width}px">`).join('');
  const headerHtml = headers.map(cell => `<th>${parseMarkdownInline(cell)}</th>`).join('');
  const bodyHtml = rows.map(row => `<tr>${headers.map((header, index) => {
    const value = formatChatDisplayValue(row[index] ?? '', header);
    const empty = !value || value === '-';
    return `<td${empty ? ' class="is-empty"' : ''}>${empty ? '&mdash;' : parseMarkdownInline(value)}</td>`;
  }).join('')}</tr>`).join('');

  return `<div class="chat-markdown-table-wrap"><table class="chat-markdown-table" style="--chat-table-width:${widths.reduce((sum, width) => sum + width, 0)}px"><colgroup>${columnsHtml}</colgroup><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`;
}

function renderChatCodeBlock(content, language = '') {
  let code = content;
  let label = language.toLowerCase();
  if (/^\s*curl\b/.test(code)) label = 'bash';
  else if (label === 'json') {
    try { code = JSON.stringify(JSON.parse(code), null, 2); } catch { /* Preserve incomplete examples. */ }
  }
  return `<div class="chat-code-block"><div class="chat-code-toolbar"><span>${escapeChatMarkdown(label || 'code')}</span><button type="button" onclick="copyChatCodeBlock(this)" aria-label="Sao chép mã"><i class="fa-regular fa-copy"></i> Sao chép</button></div><pre tabindex="0"><code>${escapeChatMarkdown(code)}</code></pre></div>`;
}

async function copyChatCodeBlock(button) {
  const code = button.closest('.chat-code-block')?.querySelector('code');
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code.textContent);
    button.textContent = 'Đã sao chép';
    setTimeout(() => { button.textContent = 'Sao chép'; }, 1800);
  } catch { button.textContent = 'Không thể sao chép'; }
}

function parseMarkdown(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];

  for (let index = 0; index < lines.length;) {
    const fence = lines[index].match(/^\s*(`{3,}|`)([a-zA-Z0-9_+-]*)\s*$/);
    // Single-backtick blocks must name a language; ordinary inline code stays inline.
    if (fence && (fence[1].length >= 3 || fence[2])) {
      const delimiter = fence[1];
      const code = [];
      let citation = '';
      index++;
      while (index < lines.length) {
        const closing = lines[index].match(/^\s*(`+)\s*(\[\d+(?:\s*,\s*\d+)*\])?\s*$/);
        if (closing && closing[1] === delimiter) {
          citation = closing[2] || '';
          index++;
          break;
        }
        code.push(lines[index++]);
      }
      blocks.push(renderChatCodeBlock(code.join('\n'), fence[2]));
      if (citation) blocks.push(parseMarkdownInline(citation));
      continue;
    }
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
    const readableFont = (font = {}, size = 13, weight = '600') => ({
      ...font,
      family: 'Inter, system-ui, sans-serif',
      size: Math.max(size, Number(font.size) || 0),
      weight: font.weight || weight
    });

    // Normalize chartSpec
    const config = {
      type: chartSpec.type || 'bar',
      data: chartSpec.data || {},
      options: {
        responsive: true,
        ...specOptions,
        maintainAspectRatio: false,
        devicePixelRatio: Math.min(3, Math.max(2, window.devicePixelRatio || 1)),
        plugins: {
          ...specPlugins,
          legend: {
            position: 'top',
            ...(specPlugins.legend || {}),
            labels: {
              ...(specPlugins.legend?.labels || {}),
              font: readableFont(specPlugins.legend?.labels?.font, 13, '600'),
              color: themeColors.text
            }
          },
          title: {
            display: !!chartSpec.title,
            text: chartSpec.title || '',
            ...(specPlugins.title || {}),
            font: readableFont(specPlugins.title?.font, 15, '700'),
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
            ticks: { ...(specScales.x?.ticks || {}), font: readableFont(specScales.x?.ticks?.font), color: themeColors.text,
              padding: Math.max(8, Number(specScales.x?.ticks?.padding) || 0) }
          },
          y: {
            ...(specScales.y || {}),
            grid: { ...(specScales.y?.grid || {}), color: themeColors.grid },
            border: { ...(specScales.y?.border || {}), color: themeColors.grid },
            ticks: { ...(specScales.y?.ticks || {}), font: readableFont(specScales.y?.ticks?.font), color: themeColors.text,
              padding: Math.max(8, Number(specScales.y?.ticks?.padding) || 0) }
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
          ds.maxBarThickness = Math.min(Number(ds.maxBarThickness) || 56, 56);
          if (Number.isFinite(Number(ds.barThickness))) ds.barThickness = Math.min(Number(ds.barThickness), 56);
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
  const root = window.ChatReasoningUI.create(containerId);
  root._hideReasoning = getPageChatReasoningMode() === 'fast';
  if (root._hideReasoning) root.querySelector('.chat-thinking-copy strong').textContent = 'Đang xử lý';
  return root;
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
  if (root) window.ChatReasoningUI?.stopStatusTyping(root);
  if (root?._elapsedTimer) clearInterval(root._elapsedTimer);
  const current = root?.querySelector('.chat-thinking-copy span');
  if (current?._typingTimer) clearInterval(current._typingTimer);
  root._elapsedTimer = null;
}

function renderPageChatDownloadAction(downloadUrl, renderedAnswer = '', details = {}) {
  const url = String(downloadUrl || '').trim();
  if (!/^\/api\/exports\/[^\s<>"']+$/i.test(url)) return '';
  if (renderedAnswer.includes(`href="${escapeChatMarkdown(url)}"`)) return '';
  let filename = url.split('/').pop().split(/[?#]/)[0];
  try { filename = decodeURIComponent(filename); } catch (_) { /* Retain malformed encoded names as text. */ }
  const extension = filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toUpperCase() || 'FILE';
  const spreadsheet = ['XLSX','XLS','CSV','TSV'].includes(extension);
  const html = ['HTML','HTM'].includes(extension);
  const icon = spreadsheet ? 'fa-file-excel' : html ? 'fa-globe' : extension === 'PDF' ? 'fa-file-pdf' : 'fa-file-lines';
  const kind = spreadsheet ? 'Bảng tính' : html ? 'Mã' : 'Tài liệu';
  return `<div class="page-chat-download-card"><span class="page-chat-download-icon" aria-hidden="true"><i class="fa-solid ${icon}"></i></span><span class="page-chat-download-info"><span class="page-chat-download-name" title="${escapeChatMarkdown(filename)}">${escapeChatMarkdown(details.label || filename)}</span><span class="page-chat-download-meta">${details.summary ? escapeChatMarkdown(details.summary) + ' · ' : ''}${kind} · ${extension}</span></span><a class="page-chat-download-button" href="${escapeChatMarkdown(url)}" download aria-label="Tải xuống ${escapeChatMarkdown(filename)}">Tải xuống</a></div>`;
}

function typeThinkingText(element, value, streamKey = null) {
  if (!element) return;
  const streaming = streamKey !== null;
  const target = String(value || '').replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim();
  const continuing = streaming && element._streamKey === streamKey && target.startsWith(element._typingTarget || '');
  if (!continuing) {
    if (element._typingTimer) clearInterval(element._typingTimer);
    element._typingTimer = null;
    element._typingIndex = 0;
    element.textContent = '';
  }
  element._streamKey = streamKey;
  element._typingTarget = target;
  if (element._typingTimer || !target) return;
  element._typingTimer = setInterval(() => {
    // Keep a readable pace even when the provider sends a large burst.
    element._typingIndex += 1;
    const visible = element._typingTarget.slice(0, element._typingIndex);
    element.textContent = visible;
    if (streaming) element.scrollLeft = element.scrollWidth;
    if (element._typingIndex >= element._typingTarget.length) {
      clearInterval(element._typingTimer);
      element._typingTimer = null;
    }
  }, streaming ? 1000 / 120 : 14);
}

function addThinkingStep(containerId, icon, label, status = 'running', event = {}) {
  const pending = window.pageChatPendingThinking;
  const root = pending?.node?.id === containerId ? pending.node : document.getElementById(containerId);
  window.ChatReasoningUI.update(root, event, label);
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

async function fetchStreamingChat(payload, onProgress, signal = null, onAnswer = null) {
  const response = await fetch('/api/intelligent-core/chat/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
    body: JSON.stringify(payload), signal
  });
  return window.ChatStream.read(response, { onProgress, onAnswer });
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

function renderPageChatQuestionActions() {
  return `<button type="button" onclick="copyPageChatQuestion(this)" title="Sao chép" aria-label="Sao chép câu hỏi">${renderPageChatActionIcon('copy')}</button><button type="button" onclick="editPageChatQuestion(this)" title="Chỉnh sửa và gửi lại" aria-label="Chỉnh sửa câu hỏi">${renderPageChatActionIcon('edit')}</button>`;
}

function enhanceUserMessageNode(node, question) {
  if (!node || !question) return;
  const existingGroup = node.querySelector('.chat-user-message-group');
  if (existingGroup) {
    const actions = existingGroup.querySelector('.chat-user-message-actions');
    if (actions) actions.innerHTML = renderPageChatQuestionActions();
    return;
  }
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
  actions.innerHTML = renderPageChatQuestionActions();
  group.appendChild(actions);
}

function enhanceAssistantMessageNode(node) {
  const bubble = node?.children?.[1];
  if (!bubble) return;
  bubble.classList.add('chat-ai-message-bubble');
  // Upgrade saved page-chat answers as they are mounted, without changing history.
  bubble.querySelectorAll('a.chat-download-link').forEach(link => {
    const item = link.closest('li');
    const standalone = item && item.querySelectorAll('a').length === 1 && !item.querySelector('ul,ol,table');
    const label = link.textContent.trim();
    const summary = standalone ? item.textContent.replace(link.textContent, '').replace(/^\s*[—–-]\s*/, '').trim() : '';
    const card = renderPageChatDownloadAction(link.getAttribute('href'), '', { label, summary });
    if (!card) return;
    const wrapper = document.createElement('div');
    wrapper.innerHTML = card;
    if (standalone) {
      item.classList.add('page-chat-download-item');
      item.replaceChildren(wrapper.firstElementChild);
      item.parentElement.classList.add('page-chat-download-list');
    } else link.replaceWith(wrapper.firstElementChild);
  });
  bubble.querySelectorAll('.chat-citation-heading a[href*="/api/library/"][href$="/file"]').forEach(link => {
    const match = link.getAttribute('href')?.match(/\/api\/library\/([^/]+)\/file$/);
    const item = link.closest('.chat-citation-item');
    if (!match || !item) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-citation-open';
    button.dataset.documentId = decodeURIComponent(match[1]);
    button.dataset.title = item.querySelector('.chat-citation-heading strong')?.textContent || '';
    button.dataset.chunk = item.querySelector('.chat-citation-heading > span:not(.chat-citation-marker)')?.textContent?.match(/\d+/)?.[0] || '1';
    button.dataset.excerpt = encodeURIComponent(item.querySelector('blockquote')?.textContent || '');
    button.dataset.sourceUrl = link.getAttribute('href') || '';
    button.setAttribute('onclick', 'openKnowledgeCitation(this)');
    button.innerHTML = '<i class="fa-solid fa-expand"></i><span>Xem nguồn</span>';
    link.replaceWith(button);
  });
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
  node.dataset.messageTimestamp = String(timestamp);
  const messageBubble = node.querySelector(role === 'user' ? '.chat-user-message-bubble' : '.chat-ai-message-bubble');
  if (messageBubble) messageBubble.title = time.toLocaleString('vi-VN', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  if (role === 'user') {
    const bubble = node.querySelector('.chat-user-message-bubble');
    if (!bubble) return;
    bubble.querySelector('.chat-user-message-meta')?.remove();
    if (!bubble.querySelector('.chat-user-message-content')) {
      const content = document.createElement('div');
      content.className = 'chat-user-message-content';
      content.append(...bubble.childNodes);
      bubble.append(content);
    }
    if (!bubble.querySelector('.chat-user-message-stamp')) bubble.insertAdjacentHTML('beforeend', `<span class="chat-user-message-stamp"><time class="chat-message-time">${label}</time><i class="fa-solid fa-check-double" aria-hidden="true"></i></span>`);
    return;
  }
  const bubble = node.querySelector('.chat-ai-message-bubble');
  if (!bubble) return;
  const existingHead = bubble.firstElementChild;
  if (existingHead?.querySelector('.fa-robot') || existingHead?.classList.contains('chat-ai-message-meta')) {
    existingHead.classList.add('chat-ai-message-meta');
    existingHead.removeAttribute('style');
    existingHead.querySelector('.fa-robot')?.parentElement.remove();
    const labels = [...existingHead.children].filter(child => !child.matches('.chat-message-time,.chat-ai-time-separator'));
    labels[0]?.classList.add('chat-ai-author');
    labels[1]?.classList.add('chat-ai-role');
    existingHead.querySelector('.chat-message-time')?.remove();
    existingHead.querySelector('.chat-ai-time-separator')?.remove();
    existingHead.insertAdjacentHTML('beforeend', `<span class="chat-ai-time-separator" aria-hidden="true">·</span><time class="chat-message-time"><i class="fa-regular fa-clock" aria-hidden="true"></i> ${label}</time>`);
  } else {
    bubble.insertAdjacentHTML('afterbegin', `<div class="chat-ai-message-meta"><strong>Trợ lý AI</strong><time class="chat-message-time">${label}</time></div>`);
  }
}

function shouldShowChatTimeMarker(previousTimestamp, timestamp) {
  if (!previousTimestamp) return true;
  const previous = new Date(Number(previousTimestamp)), current = new Date(Number(timestamp));
  return current.toDateString() !== previous.toDateString() || current - previous >= 15 * 60 * 1000;
}

function formatChatTimeMarker(timestamp) {
  const date = new Date(Number(timestamp));
  const weekday = date.getDay() === 0 ? 'Chủ nhật' : `Thứ ${date.getDay() + 1}`;
  const year = date.getFullYear() === new Date().getFullYear() ? '' : ` ${date.getFullYear()}`;
  const time = date.toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit', hour12:false });
  return `${weekday}, ${date.getDate()} tháng ${date.getMonth() + 1}${year} lúc ${time}`;
}

function renderPageChatActionIcon(name) {
  const paths = {
    copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    retry: '<path d="M20 7v5h-5"/><path d="M20 12a8 8 0 1 0-2.34 5.66"/>',
    edit: '<path d="m15 5 4 4M4 16l-1 5 5-1L20 8a2.8 2.8 0 0 0-4-4Z"/>',
    more: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    speak: '<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.3 6.3a8 8 0 0 1 0 11.4"/>'
  };
  return `<svg class="chat-answer-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name] || ''}</svg>`;
}

function appendChatMessage(record, shouldPersist = true, shouldScroll = true, targetSession = null, replacementRecord = null) {
  if (replacementRecord) {
    if (!targetSession?.messages.includes(replacementRecord)) return false;
    Object.assign(replacementRecord,{...record,createdAt:replacementRecord.createdAt});
    record=replacementRecord;
  }
  // A response belongs to the session that started it, even after navigation.
  if (targetSession && window.currentChatSessionId !== targetSession.id) {
    if (shouldPersist && window.chatSessions.includes(targetSession)) {
      record.createdAt = Number(record.createdAt) || Date.now();
      if (!replacementRecord) targetSession.messages.push(record);
      targetSession.updatedAt = Date.now();
      saveChatSessions();
    }
    return false;
  }
  const container = document.getElementById('page-chat-messages-container');
  if (!container || !record) return;
  const content=document.getElementById('page-chat-thread') || container;
  if (replacementRecord && ![...container.querySelectorAll('.chat-assistant-message-row')].some(item=>item._chatRecord===replacementRecord)) {
    renderCurrentChatMessages(true); return false;
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = record.html || '';
  const node = wrapper.firstElementChild;
  if (!node) return;
  node._chatRecord=record;
  if(record.role==='user'&&record.attachments?.length&&window.ChatAttachments?.render){
    const bubble=node.querySelector('.chat-user-message-bubble');
    if(bubble){
      let gallery=node.querySelector('.chat-file-cards');
      if(!gallery){gallery=document.createElement('div');bubble.append(gallery);}
      window.ChatAttachments.render(gallery,record.attachments.map(file=>({...(record.attachmentBatchId?{batchId:record.attachmentBatchId}:{}),...file})));
    }
  }
  let repairedStoredMarkup = repairStoredSummaryMarkup(node);
  if (record.role === 'assistant' && window.ChatReasoningUI?.stripCompleted(node)) repairedStoredMarkup = true;
  if (repairedStoredMarkup) record.html = node.outerHTML;
  record.createdAt = Number(record.createdAt) || Date.now();
  if (record.role === 'user') enhanceUserMessageNode(node, record.content || '');
  if (record.role === 'user') {
    const group = node.querySelector('.chat-user-message-group');
    const bubble = group?.querySelector('.chat-user-message-bubble');
    const gallery = node.querySelector('.chat-file-cards');
    if (bubble && gallery) group.insertBefore(gallery, bubble);
  }
  if (record.role === 'assistant') enhanceAssistantMessageNode(node);
  addChatMessageTime(node, record.role, record.createdAt);

  const previousMessages = container.querySelectorAll('[data-message-timestamp]');
  const previousTimestamp = previousMessages[previousMessages.length - 1]?.dataset.messageTimestamp;
  if (!replacementRecord && shouldShowChatTimeMarker(previousTimestamp, record.createdAt)) {
    const marker = document.createElement('time');
    marker.className = 'chat-conversation-time-marker';
    const date = new Date(record.createdAt);
    marker.dateTime = date.toISOString();
    marker.textContent = formatChatTimeMarker(record.createdAt);
    content.appendChild(marker);
  }
  const oldNode=replacementRecord && [...container.querySelectorAll('.chat-assistant-message-row')].find(item=>item._chatRecord===replacementRecord);
  if (oldNode) oldNode.replaceWith(node); else content.appendChild(node);
  if (record.role === 'assistant') {
    node.classList.add('chat-assistant-message-row');
    const bubble = node.querySelector('.chat-ai-message-bubble');
    if (bubble) {
      const actions = node.querySelector('.chat-answer-actions') || document.createElement('div');
      actions.className = 'chat-answer-actions';
      actions.setAttribute('aria-label', 'Thao tác với câu trả lời');
      actions.innerHTML = `<button type="button" onclick="copyPageChatAnswer(this)" title="Sao chép" aria-label="Sao chép câu trả lời">${renderPageChatActionIcon('copy')}</button><button type="button" onclick="retryPageChatAnswer(this)" title="Thử lại" aria-label="Yêu cầu AI trả lời lại câu hỏi này">${renderPageChatActionIcon('retry')}</button><button type="button" class="chat-speak-btn" onclick="toggleAnswerSpeech(this)" title="Đọc to" aria-label="Đọc to câu trả lời" aria-pressed="false">${renderPageChatActionIcon('speak')}</button>`;
      const answeredAt = new Date(record.createdAt);
      const answerTime = answeredAt.toLocaleString('vi-VN', {
        day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit'
      });
      actions.insertAdjacentHTML('beforeend', `<details class="chat-answer-more">
        <summary title="Thông tin câu trả lời" aria-label="Thông tin câu trả lời">${renderPageChatActionIcon('more')}</summary>
        <div class="chat-answer-time-menu"><span>Thời gian trả lời</span><time datetime="${answeredAt.toISOString()}">${answerTime}</time></div>
      </details>`);
      node.append(actions);
    }
  }
  node.addEventListener('workflow-execution-updated', event => {
    const execution = event.detail.execution;
    if (execution.tokenUsage?.available) { const feedback = node.querySelector('.chat-feedback'); if (feedback) { feedback.querySelector('.chat-token-usage')?.remove(); feedback.querySelector('.chat-routing-usage')?.remove(); feedback.insertAdjacentHTML('beforeend', renderChatTokenUsage(execution.tokenUsage, execution.routing)); } }
    const answer = node.querySelector('.chat-ai-answer');
    if (answer && execution.status === 'SUCCEEDED') answer.textContent = `${execution.name} đã hoàn thành.`;
    if (answer && execution.status === 'CANCELLED') answer.textContent = `Đã hủy ${execution.name}.`;
    const html = node.outerHTML;
    if (record.html === html) return;
    record.html = html;
    const session = window.chatSessions?.find(item => item.messages.includes(record));
    // Restoring or refreshing a workflow card is a presentation update. It
    // must not move a conversation to the top merely because it was opened.
    if (session) saveChatSessions();
  });
  window.restoreWorkflowExecutions?.(node);
  if (shouldScroll) container.scrollTop = container.scrollHeight;

  if (record.chartSpec && record.chartId) {
    requestAnimationFrame(() => {
      setTimeout(() => renderChartSpec(record.chartId, record.chartSpec), 100);
    });
  }

  if (shouldPersist) {
    const session = targetSession || getCurrentChatSession();
    if (session) {
      if (!replacementRecord) session.messages.push(record);
      session.updatedAt = Date.now();
      renderChatLimitNotice(session);
      saveChatSessions();
    }
  }
  return repairedStoredMarkup;
}

function renderCurrentChatMessages(preserveScroll = false) {
  const container = document.getElementById('page-chat-messages-container');
  if (!container) return;
  const content=document.getElementById('page-chat-thread') || container;
  const session = getCurrentChatSession();
  const oldHeight=container.scrollHeight, oldTop=container.scrollTop;
  content.innerHTML = '';
  renderChatLimitNotice(session);
  if (session?._page?.start) {
    const more=document.createElement('button'); more.type='button'; more.className='chat-load-older';
    more.textContent='Tải tin nhắn cũ hơn'; more.onclick=()=>loadOlderChatMessages(session); content.append(more);
  }
  if (session?.continuationSummary && !session._page?.start) {
    const summary=document.createElement('section'); summary.className='chat-continuation-summary';
    const header=document.createElement('div'); header.className='chat-context-header';
    const title=document.createElement('button'); title.type='button'; title.className='chat-context-toggle';
    title.innerHTML='<span class="chat-context-icon" aria-hidden="true"><i class="fa-regular fa-file-lines"></i></span><span class="chat-context-heading"><strong>Ngữ cảnh từ hội thoại trước</strong><small>Đã sẵn sàng để tiếp tục · Mở để xem nội dung</small></span><span class="chat-context-chevron" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>';
    const label=document.createElement('div'); label.className='chat-context-label';
    const heading=document.createElement('div'); heading.innerHTML=title.innerHTML;
    const chevron=heading.lastElementChild;
    label.append(...Array.from(heading.children).filter(item=>item!==chevron));
    title.replaceChildren(chevron);
    title.setAttribute('aria-label','Mở rộng ngữ cảnh');
    const text=document.createElement('div'); text.className='chat-context-body';
    text.id='chat-context-body-'+session.id; text.hidden=true;
    title.setAttribute('aria-controls',text.id); title.setAttribute('aria-expanded','false');
    title.onclick=()=>{
      text.hidden=!text.hidden;
      title.setAttribute('aria-expanded',String(!text.hidden));
      title.setAttribute('aria-label',text.hidden ? 'Mở rộng ngữ cảnh' : 'Thu gọn ngữ cảnh');
      summary.classList.toggle('is-open',!text.hidden);
    };
    text.innerHTML=parseMarkdown(session.continuationSummary);
    const back=document.createElement('button'); back.type='button'; back.textContent='Xem hội thoại gốc ↗';
    back.className='chat-context-source';
    back.onclick=()=>selectChatSession(session.continuedFrom);
    header.append(label,back,title);
    summary.append(header,text); content.append(summary);
  }
  container.onscroll=()=>{ if(container.scrollTop<=40) loadOlderChatMessages(getCurrentChatSession()); };
  const userHistory = (session?.history || []).filter(item => item.role === 'user');
  let userIndex = 0;
  let repairedStoredMarkup = false;
  const pending = window.pageChatPendingThinking;
  (session?.messages || []).forEach(record => {
    if (pending && pending.sessionId===session.id && pending.retryRecord===record) { content.appendChild(pending.node); return; }
    const hydrated = record.role === 'user' && !record.content
      ? { ...record, content: userHistory[userIndex]?.content || '' }
      : record;
    if (record.role === 'user') userIndex += 1;
    repairedStoredMarkup = appendChatMessage(hydrated, false, false) || repairedStoredMarkup;
  });
  if (repairedStoredMarkup) saveChatSessions();
  if (pending && !pending.retryRecord && pending.sessionId === session?.id) {
    content.appendChild(pending.node);
  }
  renderQuickPrompts();
  container.scrollTop = preserveScroll ? oldTop + container.scrollHeight - oldHeight : container.scrollHeight;
  window.ChatReasoningUI?.resumeAtEnd(container);
  window.syncPageChatScrollActivity?.();
  if (typeof loadPageChatSessionFiles === 'function') loadPageChatSessionFiles();
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

function renderChatFeedback(data = {}, tokenUsage = null, options = {}) {
  return `<div class="chat-feedback" data-audit-id="${escapeChatMarkdown(data.auditId || '')}" data-provider-id="${escapeChatMarkdown(data.provider?.id || '')}" data-model="${escapeChatMarkdown(data.provider?.model || '')}">
    <div class="chat-feedback-actions">
      <span class="chat-feedback-label">Câu trả lời này có hữu ích không?</span>
      <button type="button" data-rating="like" onclick="submitChatFeedback(this)" title="Hữu ích" aria-label="Thích câu trả lời"><i class="fa-regular fa-thumbs-up"></i></button>
      <button type="button" data-rating="dislike" onclick="submitChatFeedback(this)" title="Chưa hữu ích" aria-label="Không thích câu trả lời"><i class="fa-regular fa-thumbs-down"></i></button>
      ${options.speak ? '<button type="button" class="chat-speak-btn" onclick="toggleAnswerSpeech(this)" title="Đọc to" aria-label="Đọc to câu trả lời" aria-pressed="false"><i class="fa-solid fa-volume-high"></i></button>' : ''}
    </div>
    ${renderChatTokenUsage(tokenUsage, data.routing)}
  </div>`;
}

function renderChatTokenUsage(usage, routing = null) {
  if (!usage || usage.available === false) return '';
  const input = Number(usage.inputTokens) || 0;
  const output = Number(usage.outputTokens) || 0;
  const total = Number(usage.totalTokens) || input + output;
  return `<div class="chat-token-usage" title="Tổng token của toàn bộ các lượt gọi model trong yêu cầu này">
    <span><i class="fa-solid fa-arrow-up-right-from-square"></i> Đầu vào: <strong>${input.toLocaleString('vi-VN')}</strong></span>
    <span title="Tổng token đầu ra của các lần gọi model trong yêu cầu, bao gồm định tuyến"><i class="fa-solid fa-arrow-down"></i> Trả lời: <strong>${output.toLocaleString('vi-VN')}</strong></span>
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
async function copyPageChatAnswer(button) {
  const answer = button.closest('.chat-assistant-message-row')?.querySelector('.chat-ai-answer');
  if (!answer) return;
  try {
    await navigator.clipboard.writeText(answer.innerText || answer.textContent || '');
    button.innerHTML = renderPageChatActionIcon('check');
    setTimeout(() => { if (button.isConnected) button.innerHTML = renderPageChatActionIcon('copy'); }, 1500);
  } catch (_) { showToast('Không thể sao chép câu trả lời.', 'error'); }
}

function isPageChatRetryResultUsable(data) {
  if (!data || data.status==='error' || ['ERROR','CANCELLED'].includes(data.completionStatus)) return false;
  if (data.execution) return Boolean(data.execution.id) &&
    ['CREATED','WAITING_INPUT','READY','RUNNING','NEEDS_REVIEW','SUCCEEDED'].includes(data.execution.status);
  if (data.completionStatus==='PARTIAL' && data.retryDisposition==='verified_partial') {
    return typeof data.reply==='string' && Boolean(data.reply.trim()) &&
      Boolean(data.toolCalls?.some(call=>call.success && ['execute_sql_query','query_sql_metric'].includes(call.name)));
  }
  return data.completionStatus==='SUCCESS';
}

async function retryPageChatAnswer(button) {
  if (window.pageChatIsResponding) return;
  const session=getCurrentChatSession();
  const node=button.closest('.chat-assistant-message-row');
  const record=node?._chatRecord;
  const index=session?.messages.indexOf(record) ?? -1;
  let questionIndex=index-1;
  while (questionIndex>=0 && session.messages[questionIndex].role!=='user') questionIndex--;
  const questionRecord=session?.messages[questionIndex];
  const question=questionRecord?.requestMessage || questionRecord?.content;
  if (!question) return showToast('Không tìm thấy câu hỏi để thử lại.', 'error');
  button.disabled = true;
  const historyIndex=session.history.findIndex((item,i)=>item.role==='user' && item.content===question &&
    session.history[i+1]?.role==='assistant' && session.history[i+1]?.content===record.content);
  button.disabled = true;
  try { await sendPageChatMessage(question,{session,record,questionRecord,node,historyIndex,index}); } finally { button.disabled = false; }
}

async function replacePageChatAnswer(session,retryContext,answer) {
  if (!window.chatSessions.includes(session)) throw new Error('Hội thoại đã bị xóa.');
  if (!await saveChatSessions()) throw new Error('Chưa lưu được lịch sử. Câu trả lời cũ vẫn được giữ.');
  const baseline=JSON.parse(sessionSnapshot(session));
  const answerIndex=session.messages.indexOf(retryContext.record);
  const response=await fetch('/api/page-chat/sessions',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action:'replaceAnswer',sessionId:session.id,version:persistedChatSessions.get(session.id)?.version,
      messageIndex:(session._page?.start || 0)+session.messages.indexOf(retryContext.record),answer,paged:Boolean(session._page)})});
  if (!response.ok) throw new Error(response.status===409 ? 'Hội thoại đã thay đổi trên tab khác. Hãy tải lại trang; câu trả lời cũ vẫn được giữ.' : 'Chưa lưu được câu trả lời mới. Câu trả lời cũ vẫn được giữ.');
  const result=await response.json();
  baseline.messages[answerIndex]={...answer,createdAt:retryContext.record.createdAt};
  baseline.history=result.history; baseline.updatedAt=result.updatedAt;
  session.history=result.history; session.updatedAt=result.updatedAt; session.version=result.version;
  appendChatMessage(answer,false,false,session,retryContext.record);
  if (session._page) {
    baseline._page.historyStart=result.historyStart; baseline._page.bytes=result.bytes;
    baseline._page.loadedBytes=chatPayloadBytes(baseline);
    session._page={...baseline._page};
  }
  persistedChatSessions.set(session.id,{version:result.version,snapshot:sessionSnapshot(baseline)});
}

async function sendPageChatMessage(retryQuestion, retryContext = null) {
  await chatHistoryReady;
  if (chatHistoryFailed) return showToast('Lịch sử chat chưa được lưu hoặc tải thành công. Hãy thử lưu lại hoặc tải lại trang trước khi gửi tiếp.','error');
  if (window.pageChatIsResponding) return;
  const input = document.getElementById('page-chat-user-input');
  if (!input) return;
  const isRetry = Boolean(retryContext);
  const msg = isRetry ? retryQuestion : input.value.trim();
  const attachedFiles = isRetry ? [] : [...window.pageChatAttachments];
  if (!msg && attachedFiles.length === 0) return;

  const container = document.getElementById('page-chat-messages-container');
  if (!container) return;
  const content=document.getElementById('page-chat-thread') || container;

  // Get current session
  let session = retryContext?.session || getCurrentChatSession();
  if (!session) return;
  if (chatPageLoads.has(session.id) || chatContinuations.has(session.id)) return;
  if (!isRetry && (chatSessionIsFull(session) || chatSessionUsage(session).count+2>80)) { renderChatLimitNotice(session); return showToast('Hội thoại không còn đủ chỗ cho một lượt hỏi đáp. Hãy tiếp tục trong hội thoại mới.', 'info'); }

  if (!isRetry) {
  input.value = '';
  updatePageChatCharacterCount('');
  window.resizeChatComposerInput?.(input);
  window.pageChatAttachments = [];
  renderPageChatAttachments();
  }

  // Render User Message
  let userRecord=retryContext?.questionRecord;
  if (!isRetry) {
  const userDiv = document.createElement('div');
  userDiv.className = 'chat-user-message-row';
  userDiv.innerHTML = `
    <div class="chat-user-message-group" data-question="${encodeURIComponent(msg || '')}">
      <div class="chat-user-message-bubble">
        ${escapeChatMarkdown(msg || 'Đã gửi tệp đính kèm')}
      </div>
      <div class="chat-user-message-actions" aria-label="Thao tác với câu hỏi">
        ${renderPageChatQuestionActions()}
      </div>
    </div>
    <div class="chat-user-message-avatar">
      <i class="fa-solid fa-user"></i>
    </div>
  `;
  userRecord={ role: 'user', content: msg, html: userDiv.outerHTML,
    ...(attachedFiles.length?{attachments:window.ChatAttachments.describe(attachedFiles)}:{}) };
  appendChatMessage(userRecord);
  renderQuickPrompts();
  }

  // Thinking Bubble
  const thinkingId = `thinking-${Date.now()}`;
  const thinkingDiv = createThinkingBubble(thinkingId);
  const answerPreview=window.ChatStream?.createPreview(thinkingDiv,{renderMarkdown:parseMarkdown,charactersPerSecond:400,finishDurationMs:4000});
  const progressEvents = [];
  window.pageChatPendingThinking = { sessionId: session.id, node: thinkingDiv, retryRecord:retryContext?.record };
  if (isRetry) { retryContext.node.before(thinkingDiv); retryContext.node.style.setProperty('display','none','important'); }
  else { content.appendChild(thinkingDiv); container.scrollTop = container.scrollHeight; }
  const responseScroll=window.ChatStream?.followResponse(container);
  const requestController = new AbortController();
  window.pageChatRequestController = requestController;
  const persona = window.aiPersona || {};
  const aiName = persona.name || 'KAI';
  const aiRole = persona.role || 'Intelligent Copilot';
  setPageChatResponding(true);
  window.updatePageChatMiniPanel({
    status: 'running',
    label: isRetry ? 'Đang thử lại câu trả lời…' : 'Đang bắt đầu xử lý…',
    question: msg || attachedFiles.map(file => file.name).join(', ')
  });

  try {
    if (!await saveChatSessions()) throw new Error('Chưa lưu được câu hỏi. Hãy lưu lại lịch sử trước khi gửi tiếp.');
    const selectedProviderId = document.getElementById('page-chat-model-selector')?.value || null;
    const knowledgeSources = getChatKnowledgeValues();
    const requestMessage = msg || 'Đã gửi tệp đính kèm';
    if (!isRetry) userRecord.requestMessage=requestMessage;
    const requestPayload = {
      question: requestMessage,
      message: requestMessage,
      continuationContext:session.continuationSummary || '',
      history: (isRetry ? session.history.slice(0,retryContext.historyIndex>=0 ? retryContext.historyIndex : 0) : session.history).slice(-20),
      ...(isRetry ? {retryMessageIndex:(session._page?.start || 0)+retryContext.index} : {}),
      sessionId: session.id,
      providerId: selectedProviderId,
      knowledgeSearchEnabled: !window.pageChatWebSearchEnabled && !knowledgeSources.includes('none'),
      knowledgeSourceIds: !window.pageChatWebSearchEnabled ? knowledgeSources.filter(value => !['auto', 'none'].includes(value)) : [],
      webSearch: window.pageChatWebSearchEnabled,
      attachments: attachedFiles.map(file => ({ name: file.name, type: file.type, size: file.size }))
    };
    const hasAttachments=attachedFiles.length>0 || userRecord.attachmentBatchId || userRecord.attachments?.length>0;
    // A retry re-asks the stored files by reference, whichever uploads they came from.
    const storedFiles=isRetry?(userRecord.attachments||[]).filter(file=>file.batchId&&file.id):[];
    if(hasAttachments&&!attachedFiles.length&&!storedFiles.length&&!userRecord.attachmentBatchId)throw new Error('Tệp chưa được tải lên. Vui lòng đính kèm và gửi lại.');
    const data = hasAttachments ? await window.ChatAttachments.submit(attachedFiles.length?attachedFiles:storedFiles,{
      sessionId:session.id,...(storedFiles.length?{}:{batchId:userRecord.attachmentBatchId}),question:requestMessage,
      providerId:selectedProviderId,history:requestPayload.history,
      ...(isRetry?{retryMessageIndex:requestPayload.retryMessageIndex}:{})
    },requestController.signal) : await fetchStreamingChat(requestPayload, event => {
      if (event.type === 'reasoning_delta') {
        const previous = progressEvents.find(item => item.type === 'reasoning_delta' && item.reasoningId === event.reasoningId && item.iteration === event.iteration);
        if (previous) previous.delta = (previous.delta + (event.delta || '')).slice(0, 32000);
        else progressEvents.push({ ...event });
      } else progressEvents.push(event);
      addThinkingStep(thinkingId, event.icon || 'circle-notch', event.label || 'Đang xử lý', event.status || 'running', event);
      window.updatePageChatMiniPanel({ status: 'running', label: event.label || 'Đang xử lý yêu cầu…' });
    }, requestController.signal,event=>answerPreview?.update(event));
    if(hasAttachments&&Array.isArray(data.attachments)) {
      userRecord.attachmentBatchId=data.batchId||null;userRecord.attachments=data.attachments;
      const userNode=[...container.querySelectorAll('.chat-user-message-row')].find(node=>node._chatRecord===userRecord);
      const gallery=userNode?.querySelector('.chat-file-cards');
      if(gallery){window.ChatAttachments.render(gallery,window.ChatAttachments.describe(data.attachments,data.batchId));userRecord.html=userNode.outerHTML;}
      window.ChatAttachments.release(attachedFiles);
      await saveChatSessions();
      if(data.batchId&&window.currentChatSessionId===session.id)loadPageChatSessionFiles(true);
      if(!isRetry&&data.completionStatus==='SUCCESS')carryPageChatAttachments(session.id,data.attachments);
    }
    answerPreview?.dispose();
    const workflowHandoff = Boolean(thinkingDiv.querySelector('.chat-workflow-pending:not(.is-leaving)'));
    disposeThinkingBubble(thinkingDiv);
    thinkingDiv.remove();
    if (window.pageChatPendingThinking?.node === thinkingDiv) window.pageChatPendingThinking = null;
    if (isRetry && !isPageChatRetryResultUsable(data)) throw new Error('Lần thử lại chưa hoàn tất. Câu trả lời trước vẫn được giữ.');

    // Build AI Response
    const aiResponseText = cleanReplyText(data.reply || data.replyText || 'Không tìm thấy thông tin tương ứng.');
    const sqlQuery = data.generatedSql || data.sql || null;
    const toolResult = data.toolResult || null;
    const sqlExecutions = Array.isArray(data.sqlExecutions) && data.sqlExecutions.length > 0
      ? data.sqlExecutions
      : (sqlQuery ? [{ index: 1, sql: sqlQuery, columns: toolResult?.columns || [], rows: toolResult?.rows || [], rowCount: toolResult?.rows?.length || 0 }] : []);
    const chartSpec = data.chartSpec || null;

    // Save to history for next turn
    if (!isRetry && data.completionStatus === 'SUCCESS') {
      session.history.push({ role: 'user', content: requestMessage }); session.history.push({ role: 'assistant', content: aiResponseText });
    }

    // Auto-update session title from first message
    if (session.history.length === 2 && session.title.startsWith('Cuộc trò chuyện mới')) {
      session.title = (msg || attachedFiles.map(file=>file.name).join(', ') || 'Tệp đính kèm').slice(0, 200);
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

    const toolStepsHtml = window.ChatToolUI?.render(data.toolCalls || []) || '';

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
          `<tr style="border-bottom:1px solid #f1f5f9;">${r.map((cell, cellIndex) =>
            `<td style="padding:8px 12px;font-size:12.5px;color:#1e293b;">${escapeChatMarkdown(formatChatDisplayValue(cell ?? '', execution.columns[cellIndex]))}</td>`
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
          <div class="chat-chart-stage"><canvas id="${chartId}" class="chat-chart-canvas"></canvas></div>
        </div>
      `;
    }

    const reasoningHtml = window.ChatReasoningUI.render(progressEvents, formatExecutionTime(data.executionTime));

    const technicalHtml = (sqlHtml || toolStepsHtml || toolResultHtml) ? `
      <details class="chat-technical-details">
        <summary>
          <span><i class="fa-solid fa-code"></i> Chi tiết truy vấn</span>
          <time class="chat-process-total"><i class="fa-regular fa-clock"></i>${escapeChatMarkdown(formatExecutionTime(data.executionTime))}</time>
          <i class="fa-solid fa-chevron-down chat-technical-chevron"></i>
        </summary>
        <div class="chat-technical-content">
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
    const renderedAnswerHtml = renderVerifiedCitationMarkers(parseMarkdown(stripInlineDownloadLink(aiResponseText, data.downloadUrl)), data.citations);
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
        ${reasoningHtml}
        <div class="chat-ai-answer">${data.execution?.status === 'WAITING_INPUT' ? 'Bổ sung thông tin bên dưới để tiếp tục.' : renderedAnswerHtml}</div>
        ${downloadActionHtml}
        ${typeof window.renderWorkflowExecution === 'function' ? window.renderWorkflowExecution(data.execution) : ''}
        ${renderCopilotRetrievalContext(data.contextSelection, data.citations, data.citationValidation, data.supportingEvidence)}
        ${chartHtml}
        ${technicalHtml}
        ${window.AnswerUI?.render(data.answerEnvelope, data.execution) || ''}
        ${renderChatFeedback(data, data.tokenUsage)}
      </div>
    `;
    const answerRecord={
      role: 'assistant',
      content: aiResponseText,
      executionId:data.execution?.id || null,
      followUpSuggestions:[],
      html: aiDiv.outerHTML,
      chartSpec: chartSpec && typeof chartSpec === 'object' ? chartSpec : null,
      chartId: chartSpec && typeof chartSpec === 'object' ? chartId : null
    };
    if (isRetry) await replacePageChatAnswer(session,retryContext,answerRecord);
    else appendChatMessage(answerRecord,true,responseScroll?.following ?? true,session);
    // The pending workflow card just left; let the real one fade in where it stood.
    if (workflowHandoff && data.execution?.id) container.querySelectorAll(`[data-automation-run="${CSS.escape(data.execution.id)}"]`).forEach(node => {
      node.classList.add('wp-handoff'); node.addEventListener('animationend', () => node.classList.remove('wp-handoff'), { once: true });
    });
    if(!hasAttachments)requestPageChatSuggestions(session,isRetry ? retryContext.record : answerRecord,data.provider?.id);
    window.updatePageChatMiniPanel({ status: data.execution ? 'complete' : data.completionStatus === 'PARTIAL' ? 'error' : 'complete',
      label: data.execution ? 'Theo dõi tác vụ trong hội thoại' : data.completionStatus === 'PARTIAL' ? 'Một phần yêu cầu chưa hoàn tất' : 'Đã hoàn thành câu trả lời' });
    if (typeof fetchChatHistory === 'function') fetchChatHistory();

    // Render chart after DOM insert (Chart.js needs canvas in DOM)
    if (chartSpec && typeof chartSpec === 'object' && window.currentChatSessionId === session.id) {
      requestAnimationFrame(() => {
        setTimeout(() => renderChartSpec(chartId, chartSpec), 100);
      });
    }

  } catch (err) {
    answerPreview?.dispose();
    if(!isRetry&&attachedFiles.length&&window.currentChatSessionId===session.id) {
      window.pageChatAttachments=attachedFiles;renderPageChatAttachments();
    }
    disposeThinkingBubble(thinkingDiv);
    thinkingDiv.remove();
    if (window.pageChatPendingThinking?.node === thinkingDiv) window.pageChatPendingThinking = null;
    if (isRetry) {
      if (window.currentChatSessionId===session.id) renderCurrentChatMessages(true);
      window.updatePageChatMiniPanel({status:err?.name==='AbortError' ? 'stopped' : 'error',label:'Đã giữ câu trả lời trước'});
      showToast(err?.name==='AbortError' ? 'Đã dừng thử lại. Câu trả lời trước vẫn được giữ.' : (err.message || 'Thử lại thất bại. Câu trả lời trước vẫn được giữ.'),'info');
      return;
    }
    if (err?.name === 'AbortError') {
      window.updatePageChatMiniPanel({ status: 'stopped', label: 'Đã dừng trả lời' });
      if (typeof showToast === 'function') showToast('Đã dừng tiến trình trả lời.', 'info');
      return;
    }
    const noAnswer = /local model returned an empty response|stream kết thúc mà không có câu trả lời cuối/i.test(String(err?.message || ''));
    const errorContent = noAnswer
      ? 'Chưa có câu trả lời phù hợp. Vui lòng thử lại.'
      : `Không thể hoàn thành câu trả lời: ${escapeChatMarkdown(err?.message || 'Không thể kết nối tới mô hình AI.')}`;
    const errDiv = document.createElement('div');
    errDiv.style.cssText = 'display:flex;gap:12px;align-items:flex-start;margin-bottom:16px;';
    errDiv.innerHTML = `
      <div class="chat-ai-avatar" style="width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#6366f1 0%,#a855f7 100%);color:#fff;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;">
        <svg class="chat-ai-sparkle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.75c.55 4.95 2.3 6.7 7.25 7.25-4.95.55-6.7 2.3-7.25 7.25C11.45 12.3 9.7 10.55 4.75 10 9.7 9.45 11.45 7.7 12 2.75Z"/><path d="M19 15.75c.22 1.97.91 2.66 2.88 2.88-1.97.22-2.66.91-2.88 2.87-.22-1.96-.91-2.65-2.88-2.87 1.97-.22 2.66-.91 2.88-2.88Z"/></svg>
      </div>
      <div class="chat-ai-message-bubble" style="background:#fff;border:1px solid #e2e8f0;padding:14px 18px;border-radius:14px;max-width:85%;font-size:13.5px;box-shadow:0 4px 14px rgba(0,0,0,.03);line-height:1.6;flex:1;">
        <div style="font-weight:700;color:#4338ca;margin-bottom:8px;display:flex;align-items:center;gap:8px;">
          <span style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:linear-gradient(135deg,#6366f1,#a855f7);"><i class="fa-solid fa-robot" style="font-size:9px;color:#fff;"></i></span>
          <span>${aiName}</span>
          <span style="font-size:10.5px;font-weight:500;color:#94a3b8;">${aiRole}</span>
        </div>
        <div class="chat-ai-answer">${errorContent}</div>
      </div>
    `;
    appendChatMessage({ role: 'assistant', html: errDiv.outerHTML }, true, true, session);
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
  const inlineWeb = document.getElementById('page-chat-web-inline');
  if (inlineWeb) inlineWeb.hidden = !window.pageChatWebSearchEnabled;
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

function chatSessionPreview(session) {
  const history=session.history || [];
  const recent=[...history].reverse().find(item=>item.role==='assistant' && item.content)
    || [...(session.messages || [])].reverse().find(item=>item.content);
  return String(recent?.content || session.continuationSummary || 'Bắt đầu cuộc trò chuyện mới')
    .replace(/```[\s\S]*?```/g,' [Mã] ').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/[#*_>`~]/g,'').replace(/\s+/g,' ').trim().slice(0,200);
}

function chatSessionAge(timestamp, now=new Date()) {
  const date=new Date(Number(timestamp));
  return Math.max(0,Math.round((new Date(now.getFullYear(),now.getMonth(),now.getDate())-
    new Date(date.getFullYear(),date.getMonth(),date.getDate()))/86400000));
}

function renderChatSessionsList() {
  ensureChatSession();
  const container = document.getElementById('chat-sessions-list');
  if (!container) return;
  container.innerHTML = '';
  const sessions = (window.chatSessions || []).map(normalizeStoredChatSession)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  window.chatSessions = sessions;
  const query=(document.getElementById('chat-history-search')?.value || '').trim();
  const searchable=value=>String(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLocaleLowerCase('vi');
  const filtered=sessions.filter(session=>!query || searchable(session.title+' '+chatSessionPreview(session)).includes(searchable(query)));
  const formatSessionTime = timestamp => {
    const date = new Date(Number(timestamp));
    if (Number.isNaN(date.getTime())) return '';
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const daysAgo = Math.round((startToday - startDate) / 86400000);
    if (daysAgo <= 0) return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    if (daysAgo === 1) return 'Hôm qua';
    if (daysAgo < 7) return `${daysAgo} ngày trước`;
    return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  };
  const renderSession = session => {
    const isCurrent = session.id === window.currentChatSessionId;
    const isResponding = window.pageChatIsResponding && window.pageChatPendingThinking?.sessionId === session.id;
    const div = document.createElement('div');
    div.className = `chat-session-item${isCurrent ? ' is-current' : ''}${session.pinned ? ' is-pinned' : ''}`;
    div.dataset.sessionId = session.id;
    div.innerHTML = `
      <button type="button" class="chat-session-main" ${isCurrent ? 'aria-current="true"' : ''} onclick="selectChatSession('${session.id}')">
        <i aria-hidden="true" class="fa-regular fa-comment-dots"></i>
        <span class="chat-session-copy" title="${escapeChatMarkdown(session.title)}"><span class="chat-session-title-line"><span class="chat-session-title">${escapeChatMarkdown(session.title)}</span></span></span>
        <span class="chat-session-meta">${isResponding ? '<small class="chat-session-responding" role="status"><i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i> Đang trả lời</small>' : `<time>${formatSessionTime(session.updatedAt)}</time>`}</span>
      <span class="chat-session-preview">${escapeChatMarkdown(chatSessionPreview(session))}</span>
      </button>
      <button class="chat-session-more" onclick="toggleChatSessionMenu('${session.id}',event)" title="Tùy chọn hội thoại" aria-label="Tùy chọn: ${escapeChatMarkdown(session.title)}" aria-expanded="false">
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
  if (document.documentElement?.dataset.page === 'chat') {
    container.insertAdjacentHTML('beforeend', '<div class="kh-history-heading">Gần đây</div>');
    const visible = window.khChatShowAllHistory || query ? filtered : filtered.slice(0, 20);
    visible.forEach(renderSession);
    if (!query && filtered.length > 20) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'kh-history-more';
      more.dataset.khAction = 'history-all';
      more.setAttribute('aria-expanded', String(Boolean(window.khChatShowAllHistory)));
      more.textContent = window.khChatShowAllHistory ? 'Thu gọn' : 'Xem tất cả';
      container.appendChild(more);
    }
  } else {
  const recentSessions = filtered.filter(session => !session.pinned);
  const pinnedSessions = filtered.filter(session => session.pinned)
    .sort((a, b) => Number(b.pinnedAt || 0) - Number(a.pinnedAt || 0));
  if (pinnedSessions.length) {
    container.insertAdjacentHTML('beforeend', `<div class="chat-session-group-title is-pinned"><span>Đã ghim</span><span class="chat-session-group-count">${pinnedSessions.length}</span></div>`);
    pinnedSessions.forEach(renderSession);
  }
  const now=new Date();
  const thisMonth=new Date(now.getFullYear(),now.getMonth(),1).getTime();
  const lastMonth=new Date(now.getFullYear(),now.getMonth()-1,1).getTime();
  const groupFor=session=>{
    const age=chatSessionAge(session.updatedAt,now), time=Number(session.updatedAt);
    if (age===0) return 'Hôm nay';
    if (age<7) return '7 ngày qua';
    if (time>=thisMonth) return 'Tháng này';
    if (time>=lastMonth) return 'Tháng trước';
    return 'Trước đó';
  };
  for (const label of ['Hôm nay','7 ngày qua','Tháng này','Tháng trước','Trước đó']) {
    const items=recentSessions.filter(session=>groupFor(session)===label);
    if (!items.length) continue;
    container.insertAdjacentHTML('beforeend',`<div class="chat-session-group-title"><span>${label}</span></div>`);
    items.forEach(renderSession);
  }
  }
  if (!filtered.length) container.insertAdjacentHTML('beforeend','<div class="chat-sessions-empty" role="status">'+(query?'Không tìm thấy cuộc trò chuyện.':'Chưa có cuộc trò chuyện.')+'</div>');

  // Sync title in header
  const currentSession = sessions.find(s => s.id === window.currentChatSessionId);
  const titleEl = document.getElementById('current-session-title');
  if (titleEl && currentSession) titleEl.textContent = currentSession.title;
  const standaloneTitle = document.querySelector?.('.kh-chat-topbar-title');
  if (standaloneTitle) {
    standaloneTitle.textContent = currentSession?.title || 'Cuộc trò chuyện mới';
    standaloneTitle.title = standaloneTitle.textContent;
  }
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

async function togglePinChatSession(id, event) {
  event?.stopPropagation();
  if (!chatHistoryLoaded || chatHistoryFailed) return;
  if (chatPinSaves.has(id)) return;
  const session = window.chatSessions.find(item => item.id === id);
  if (!session) return;
  const previous = { pinned: session.pinned, pinnedAt: session.pinnedAt };
  chatPinSaves.add(id);
  session.pinned = !session.pinned;
  session.pinnedAt = session.pinned ? Date.now() : null;
  const pinned = session.pinned;
  renderChatSessionsList();
  try {
    if (await saveChatSessions()) showToast(pinned ? 'Đã ghim đoạn chat.' : 'Đã bỏ ghim đoạn chat.', 'success');
    else {
      const current = window.chatSessions.find(item => item.id === id);
      if (current) {
        for (const key of ['pinned', 'pinnedAt']) {
          if (previous[key] === undefined) delete current[key]; else current[key] = previous[key];
        }
      }
      renderChatSessionsList();
    }
  } finally { chatPinSaves.delete(id); }
}

async function renameChatSession(id, event) {
  if (!chatHistoryLoaded || chatHistoryFailed) return;
  event?.stopPropagation();
  const session = window.chatSessions.find(item => item.id === id);
  if (!session) return;
  const nextTitle = await showUiPrompt('Nhập tên mới cho cuộc trò chuyện.', session.title, { title: 'Đổi tên cuộc trò chuyện', confirmText: 'Lưu tên', icon: 'fa-pen' });
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
  if (!chatHistoryLoaded || chatHistoryFailed) return;
  const newId = `session-${crypto.randomUUID()}`;
  const count = window.chatSessions.length + 1;
  const now = Date.now();
  const newSession = { id: newId, title: `Cuộc trò chuyện mới ${count}`, messages: [], history: [], createdAt: now, updatedAt: now };
  window.chatSessions.unshift(newSession);
  window.currentChatSessionId = newId;
  saveChatSessions();
  const titleEl = document.getElementById('current-session-title');
  if (titleEl) titleEl.textContent = newSession.title;
  const msgContainer = document.getElementById('page-chat-messages-container');
  if (msgContainer) (document.getElementById('page-chat-thread') || msgContainer).innerHTML = '';
  renderChatSessionsList();
  renderCurrentChatMessages();
}

async function deleteSingleChatSession(id, event) {
  if (!chatHistoryLoaded || chatHistoryFailed) return;
  event?.stopPropagation();
  const session = window.chatSessions.find(s => s.id === id);
  const title = session ? session.title : 'đoạn chat';
  if (!await showUiConfirm(`Xóa "${title}"? Hành động này không thể hoàn tác.`, { title: 'Xóa cuộc trò chuyện', confirmText: 'Xóa cuộc trò chuyện', tone: 'danger' })) return;
  window.chatSessions = window.chatSessions.filter(s => s.id !== id);
  clearBackendConversationMemory(id);
  if (window.currentChatSessionId === id) {
    if (window.chatSessions.length > 0) {
      selectChatSession(window.chatSessions[0].id);
    } else {
      window.currentChatSessionId = null;
      const msgContainer = document.getElementById('page-chat-messages-container');
      if (msgContainer) (document.getElementById('page-chat-thread') || msgContainer).innerHTML = '';
    }
  }
  saveChatSessions();
  renderChatSessionsList();
  showToast(`Đã xóa "${title}"!`, 'info');
}

function selectChatSession(id) {
  if (!window.chatSessions.some(session => session.id === id)) return;
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

async function clearAllChatSessions() {
  if (!chatHistoryLoaded || chatHistoryFailed) return;
  if (await showUiConfirm('Bạn có chắc muốn xóa tất cả các cuộc trò chuyện?', { title: 'Xóa toàn bộ cuộc trò chuyện', confirmText: 'Xóa tất cả', tone: 'danger' })) {
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
    if (!providers?.length) providers = await window.loadChatProviders();
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

  const modelOptions = Array.from(selector.options).map((option, index) => {
    const provider = (providers || [])[index] || {};
    const description = provider.name || provider.type || 'Trợ giúp toàn diện';
    return `<button type="button" class="page-chat-model-option" data-value="${escapeChatMarkdown(option.value)}" onclick="selectPageChatModel(this.dataset.value,false);closeChatModelChoices();document.getElementById('chat-effort-model-button').focus()" role="option">
      <i class="fa-solid fa-check model-check"></i>
      <span class="page-chat-model-copy"><strong>${escapeChatMarkdown(option.dataset.shortLabel || option.textContent)}</strong><span class="page-chat-model-details"><small>${escapeChatMarkdown(description)}</small>${provider.isActive ? '<span class="page-chat-model-badge">Mặc định</span>' : ''}</span></span>
    </button>`;
  }).join('');
  menu.setAttribute('role', 'dialog');menu.setAttribute('aria-label','Chọn mức độ và mô hình AI');
  menu.classList.add('chat-effort-panel');menu.onclick=event=>event.stopPropagation();
  menu.innerHTML = `<div id="chat-model-effort-menu">
        <div class="chat-effort-heading"><i class="fa-solid fa-bolt" aria-hidden="true"></i><div><strong id="chat-effort-label"></strong><button type="button" id="chat-effort-model-button" class="chat-effort-model-picker" aria-label="Chọn mô hình AI" aria-haspopup="listbox" aria-expanded="false" aria-controls="chat-model-other-menu" onclick="toggleChatModelChoices(event)"><span id="chat-effort-model"></span><i class="fa-solid fa-chevron-right" aria-hidden="true"></i></button></div><button type="button" class="chat-effort-reset" onclick="selectPageChatReasoningMode('medium',true)" title="Đặt lại Suy luận" aria-label="Đặt lại mức Suy luận"><i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i></button></div>
        <div class="chat-effort-track"><input id="chat-effort-slider" type="range" min="0" max="1" step="1" value="1" aria-label="Mức độ" aria-describedby="chat-effort-description" oninput="selectPageChatReasoningMode(this.value==='0'?'fast':'medium',true)"><span class="chat-effort-stops" aria-hidden="true"><i></i><i></i></span></div>
        <div class="chat-effort-endpoints" aria-hidden="true"><span>Nhanh</span><span>Suy luận</span></div>
        <p id="chat-effort-description"></p>
      </div>
      <div id="chat-model-other-menu" class="chat-model-choice-panel" role="listbox" aria-label="Chọn mô hình AI" hidden>${modelOptions}</div>`;
  selectPageChatModel(selectedValue);
}

let quickPromptsRequest = null;
function renderQuickPrompts() {
  const session=window.chatSessions?.find(item=>item.id===window.currentChatSessionId);
  const latest=session?.messages?.at(-1);
  const userReplies=latest?.role==='assistant' && Array.isArray(latest.followUpSuggestions)
    ? latest.followUpSuggestions.filter(item=>item?.speaker==='user' && typeof item.label==='string'
      && item.label.trim() && typeof item.prompt==='string' && item.prompt.trim()) : [];
  const contextual=userReplies.length>0;
  const container = document.getElementById('quick-prompts-bar');
  if (!container) return;
  const signature=JSON.stringify([session?.id,session?.messages?.length,userReplies]);
  if(container._suggestionSignature===signature) return;
  container._suggestionSignature=signature;
  container.hidden=!contextual;
  container.ariaLabel='Gợi ý trả lời để làm rõ hoặc xác nhận';
  container.className=contextual ? 'has-contextual-suggestions' : '';
  container.replaceChildren();
  for (const [index,prompt] of userReplies.entries()) {
    const button = document.createElement('button'); button.type = 'button';
    button.style.setProperty('--suggestion-order',index);
    const icon = document.createElement('i');
    icon.className = `fa-solid ${/^fa-[a-z0-9-]+$/.test(prompt.icon || '') ? prompt.icon : 'fa-lightbulb'}`;
    icon.setAttribute('aria-hidden', 'true');
    button.append(icon, document.createTextNode(prompt.label));
    button.onclick = () => useQuickPrompt(prompt.prompt);
    container.appendChild(button);
  }
}
async function requestPageChatSuggestions(session,record,providerId) {
  if(record.executionId || /data-automation-run/.test(record.html || '') || !record.content || !/[?？]|bạn (?:muốn|chọn)|xác nhận|bổ sung thông tin|chưa rõ|làm rõ|phân vân|không chắc|chưa xác định/i.test(record.content)) return;
  const originalContent=record.content;
  try {
    if(!await saveChatSessions() || !window.chatSessions.includes(session) || session.messages.at(-1)!==record) return;
    const response=await fetch('/api/page-chat/sessions',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(8000),
      body:JSON.stringify({action:'suggestReplies',sessionId:session.id,version:persistedChatSessions.get(session.id)?.version,
        messageIndex:(session._page?.start || 0)+session.messages.indexOf(record),providerId:providerId || null})});
    if(!response.ok) return;
    const {suggestions}=await response.json();
    if(!window.chatSessions.includes(session) || session.messages.at(-1)!==record || record.content!==originalContent || !Array.isArray(suggestions)) return;
    record.followUpSuggestions=suggestions;
    if(window.currentChatSessionId===session.id) renderQuickPrompts();
    if(suggestions.length) saveChatSessions();
  } catch(_) { /* Suggestions are optional; the answer remains available. */ }
}
async function fetchAndRenderQuickPrompts() {
  renderQuickPrompts();
  if (!quickPromptsRequest) {
    quickPromptsRequest = (async () => {
      const response = await fetch('/api/persona');
      if (!response.ok) throw new Error('Unable to load quick prompts');
      const data = await response.json(); window.aiPersona = data;
      renderQuickPrompts();
    })().catch(() => {}).finally(() => { quickPromptsRequest = null; });
  }
  await quickPromptsRequest;
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
  window.syncPageChatComposerLayout?.();
  fetchAndRenderQuickPrompts();
  document.getElementById('page-chat-web-toggle')?.classList.toggle('is-active', window.pageChatWebSearchEnabled);
  document.getElementById('page-chat-web-toggle')?.setAttribute('aria-pressed', String(window.pageChatWebSearchEnabled));
});
