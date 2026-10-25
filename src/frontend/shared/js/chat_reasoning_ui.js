/* Shared, text-first reasoning presentation for page chat and popup chat. */
(() => {
  const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const keyOf = event => JSON.stringify([event.reasoningId || '', event.iteration || 0]);
  const nearBottom = node => node && node.scrollHeight - node.clientHeight - node.scrollTop <= 48;
  function resumeAtEnd(container) {
    if (!container || document.hidden || container.clientHeight <= 0) return;
    // Wait for the restored conversation and its nested scroll box to lay out.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (document.hidden || container.clientHeight <= 0) return;
      const follower = window.ChatStream?.followResponse(container);
      if (follower && !follower.following && nearBottom(container)) follower.resume();
      follower?.sync();
      container.querySelectorAll('.chat-reasoning-stream .chat-thinking-steps').forEach(content => {
        const box = content.getBoundingClientRect?.(), viewport = container.getBoundingClientRect?.();
        const visible = box && viewport ? box.height > 0 && box.bottom > Math.max(0, viewport.top)
          && box.top < Math.min(window.innerHeight || Infinity, viewport.bottom) : nearBottom(container);
        // The active reasoning may be visible even when the outer conversation
        // is not at its bottom. Only move this inner scroller in that case.
        if (visible && !content.hidden && !content.closest('.chat-reasoning-stream')?._reasoningStopped)
          content.scrollTop = content.scrollHeight;
      });
    }));
  }
  const resumeVisible = () => document.querySelectorAll('#page-chat-messages-container,#chat-messages-container').forEach(resumeAtEnd);
  document.addEventListener?.('visibilitychange', resumeVisible);
  window.addEventListener?.('focus', resumeVisible);
  function stopStatusTyping(root) {
    clearInterval(root._statusTypingTimer);
    root._statusTypingTimer = null;
  }
  function typeStatus(root, element, value) {
    const target = String(value || '');
    if (!element || root._statusTypingTarget === target) return;
    stopStatusTyping(root);
    root._statusTypingTarget = target;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.hidden) {
      element.textContent = target;
      return;
    }
    const points = Array.from(target);
    let shown = 0;
    element.textContent = '';
    const paint = () => {
      shown = Math.min(points.length, shown + 2);
      element.textContent = points.slice(0, shown).join('');
      if (shown >= points.length) stopStatusTyping(root);
    };
    if (!points.length) return;
    paint();
    if (shown < points.length) root._statusTypingTimer = setInterval(paint, 24);
    if (root.remove && !root._statusRemoveWrapped) {
      const remove = root.remove.bind(root);
      root._statusRemoveWrapped = true;
      root.remove = () => { stopStatusTyping(root); remove(); };
    }
  }
  function animateOrb(root) {
    const canvas = root.querySelector('canvas.chat-thinking-spinner');
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let frame;
    const draw = () => {
      const now = reducedMotion ? 0 : Date.now() * .001;
      const cx = canvas.width / 2, cy = canvas.height / 2, radius = Math.min(cx, cy) - 2;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const points = [];
      for (let i = 0; i < 40; i++) {
        const phi = Math.acos(1 - 2 * (i + .5) / 40), theta = Math.PI * (1 + Math.sqrt(5)) * (i + .5);
        const r = radius * (1 + .18 * Math.sin(phi * 2.5 + now * 3.5) * Math.cos(theta * 1.5 + now * 2.5));
        const x = r * Math.sin(phi) * Math.cos(theta), y = r * Math.sin(phi) * Math.sin(theta), z = r * Math.cos(phi);
        const x1 = x * Math.cos(now * 1.2) - z * Math.sin(now * 1.2), z1 = x * Math.sin(now * 1.2) + z * Math.cos(now * 1.2);
        points.push({ x:x1, y:y * Math.cos(now * .7) - z1 * Math.sin(now * .7), z:y * Math.sin(now * .7) + z1 * Math.cos(now * .7) });
      }
      points.sort((a,b) => a.z - b.z).forEach(p => {
        const depth = (p.z + radius * 1.2) / (radius * 2.4);
        ctx.beginPath();
        ctx.arc(cx + p.x, cy + p.y, .7 + 1.3 * depth, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${Math.floor(139 - 40 * depth)},${Math.floor(92 + 10 * depth)},${Math.floor(246 - 5 * depth)},${.25 + .75 * depth})`;
        ctx.fill();
      });
      if (!reducedMotion) frame = requestAnimationFrame(draw);
    };
    draw();
    const remove = root.remove.bind(root);
    root.remove = () => { cancelAnimationFrame(frame); remove(); };
  }
  function create(id) {
    const root = document.createElement('div');
    root.id = id;
    root.className = 'chat-thinking-row chat-reasoning-stream';
    root.setAttribute('role','group');
    root.setAttribute('aria-label','Đang chuẩn bị câu trả lời');
    root.innerHTML = `<div class="chat-thinking-card"><div class="chat-thinking-head">
      <canvas class="chat-thinking-spinner chat-reasoning-orb" width="22" height="22" aria-hidden="true"></canvas>
      <div class="chat-thinking-copy"><strong class="chat-thinking-shimmer">Đang suy nghĩ...</strong><span id="${escape(id)}-current" role="status">Đang chuẩn bị câu trả lời…</span></div>
      <button type="button" class="chat-thinking-toggle" aria-label="Thu gọn nội dung suy nghĩ" aria-expanded="true" aria-controls="${escape(id)}-steps" hidden><i class="fa-solid fa-chevron-up" aria-hidden="true"></i></button>
      </div><div id="${escape(id)}-steps" class="chat-thinking-steps" hidden></div></div>`;
    root._reasoningRecords = new Map();
    const toggle = root.querySelector('.chat-thinking-toggle'), content = root.querySelector('.chat-thinking-steps');
    toggle.onclick = () => {
      content.hidden = !content.hidden;
      root._reasoningCollapsed = content.hidden;
      toggle.setAttribute('aria-expanded',String(!content.hidden));
      toggle.setAttribute('aria-label',content.hidden ? 'Mở nội dung suy nghĩ' : 'Thu gọn nội dung suy nghĩ');
    };
    animateOrb(root);
    const current = root.querySelector('.chat-thinking-copy span');
    if (current) typeStatus(root, current, current.textContent);
    return root;
  }
  // A chosen workflow gets a card shaped like the final one, so the result can take its place.
  function workflowCard(root, event) {
    const card = root.querySelector?.('.chat-thinking-card');
    if (!card) return;
    let panel = root.querySelector('.chat-workflow-pending');
    if (event.type === 'workflow_rejected') {
      if (panel) { panel.classList.add('is-leaving'); setTimeout(() => panel.remove(), 220); }
      return;
    }
    if (!panel || panel.classList.contains('is-leaving')) {
      panel?.remove();
      panel = document.createElement('div');
      panel.className = 'workflow-execution-panel chat-workflow-pending';
      panel.setAttribute('role', 'status');
      panel.innerHTML = `<div class="wp-execution-header"><span class="wp-execution-icon"><i class="fas fa-layer-group" aria-hidden="true"></i></span>
        <strong class="wp-execution-title"></strong><span class="wp-execution-status"></span></div>
        <div class="wp-execution-loading wp-processing"><div class="wp-processing-graphic" aria-hidden="true"><span class="wp-processing-source"><i class="fas fa-database"></i></span><span class="wp-processing-flow"><b></b><b></b><b></b></span><span class="wp-processing-core"><i class="fas fa-layer-group"></i></span><span class="wp-processing-flow"><b></b><b></b><b></b></span><span class="wp-processing-source"><i class="fas fa-file-alt"></i></span></div>
        <div class="wp-processing-copy"><strong></strong><span>Kết quả sẽ hiển thị khi hoàn tất.</span></div></div>`;
      card.after(panel);
      // The workflow card is now the focus; the model's notes stay one click away.
      const content = root.querySelector('.chat-thinking-steps'), toggle = root.querySelector('.chat-thinking-toggle');
      if (content && root._reasoningCollapsed === undefined) {
        root._reasoningCollapsed = true; content.hidden = true;
        toggle?.setAttribute('aria-expanded', 'false'); toggle?.setAttribute('aria-label', 'Mở nội dung suy nghĩ');
      }
    }
    const running = event.type === 'workflow_running';
    panel.querySelector('.wp-execution-title').textContent = event.workflowName || panel.querySelector('.wp-execution-title').textContent || 'Quy trình nghiệp vụ';
    panel.querySelector('.wp-execution-status').textContent = running ? 'Đang thực hiện' : 'Đang kiểm tra';
    panel.querySelector('.wp-processing-copy strong').textContent = running ? 'Đang xử lý thông tin' : 'Đang chuẩn bị quy trình';
  }
  function update(root, event = {}, label = '') {
    if (!root) return;
    if (root._hideReasoning && event.type === 'reasoning_delta') return;
    const current = root.querySelector('.chat-thinking-copy span');
    if (event.type !== 'reasoning_delta') {
      if (/^workflow_(pending|running|rejected)$/.test(event.type)) workflowCard(root, event);
      // Keep reporting after reasoning: later steps (SQL, workflow checks) can take seconds.
      if (current) typeStatus(root, current, String(label || 'Đang chuẩn bị câu trả lời…').replace(/\*\*|`/g, ''));
      return;
    }
    if (!event.delta) return;
    const content = root.querySelector('.chat-thinking-steps');
    if (!content) return;
    root._reasoningRecords ||= new Map();
    const firstReasoning = !root._reasoningRecords.size;
    const key = keyOf(event);
    let text = root._reasoningRecords.get(key);
    if (!text) {
      text = document.createElement('pre');
      text.className = 'chat-reasoning-text';
      content.appendChild(text);
      root._reasoningRecords.set(key,text);
    }
    // Queue only provider-supplied text; smooth out large network chunks.
    text._targetText = ((text._targetText || '') + String(event.delta)).slice(0,32000);
    if (!root._typingTimer) {
      root._typingTimer = setInterval(() => {
        let pending = false;
        for (const block of root._reasoningRecords.values()) {
          const target = block._targetText || '';
          const remaining = target.length - block.textContent.length;
          if (remaining > 0) {
            const messages = root.closest?.('#page-chat-messages-container,#chat-messages-container');
            const followContent = nearBottom(content);
            const followMessages = nearBottom(messages);
            block.textContent = target.slice(0, block.textContent.length + Math.max(2, Math.ceil(remaining / 18)));
            if (!content.hidden) {
              if (followContent) content.scrollTop = content.scrollHeight;
              if (followMessages) messages.scrollTop = messages.scrollHeight;
            }
            pending = true;
            break;
          }
        }
        if (!pending || root._reasoningStopped) {
          clearInterval(root._typingTimer);
          root._typingTimer = null;
        }
      }, 24);
      // The pending node may be detached when switching conversations.
      // Explicit removal, rather than isConnected, ends its animation.
      const remove = root.remove?.bind(root);
      if (remove && !root._typingRemoveWrapped) {
        root._typingRemoveWrapped = true;
        root.remove = () => { root._reasoningStopped = true; clearInterval(root._typingTimer); root._typingTimer = null; remove(); };
      }
    }
    if (firstReasoning) {
      stopStatusTyping(root);
      root._statusTypingTarget = null;
      if (current) current.textContent = '';
    }
    content.hidden = root._reasoningCollapsed === true;
    const toggle = root.querySelector('.chat-thinking-toggle');
    if (toggle) toggle.hidden = false;
  }
  function render() {
    // Reasoning is transient UI only. Finished replies retain the answer,
    // citations and results, without persisting a reasoning disclosure.
    return '';
  }
  function stripCompleted(root) {
    const nodes = root.querySelectorAll('.chat-reasoning-summary,.chat-embedded-thinking,.chat-reasoning-panel');
    nodes.forEach(node=>node.remove());
    root.querySelectorAll('.chat-technical-details>summary>span:first-child,.copilot-technical-details>summary>span:first-child')
      .forEach(label=>{ label.textContent='Chi tiết truy vấn'; });
    return nodes.length > 0;
  }
  const activityWatchers=new WeakMap();
  function watchActivity(container,anchor,isActive,options={}){
    if(!container||!anchor)return;
    let watcher=activityWatchers.get(container);
    if(watcher&&watcher.button.isConnected){watcher.isActive=isActive;watcher.update();return;}
    const button=document.createElement('button');button.type='button';button.className='chat-scroll-activity';button.hidden=true;
    button.title='AI đang trả lời · Về cuối hội thoại';button.setAttribute('aria-label',button.title);
    if(options.arrow)button.className+=' has-scroll-arrow';
    button.innerHTML=(options.arrow?'<i class="fa-solid fa-arrow-down chat-scroll-arrow" aria-hidden="true"></i>':'')+'<span aria-hidden="true"><i></i><i></i><i></i></span>';
    anchor.before(button);
    watcher={button,isActive,update(){
      const visible = !document.hidden && container.clientHeight > 0;
      if (visible && !watcher.visible) resumeAtEnd(container);
      watcher.visible = visible;
      const active=Boolean(watcher.isActive());
      button.hidden=(!options.showWhenIdle&&!active)||nearBottom(container);
      button.setAttribute('data-active',String(active));
      button.title=active?'AI đang trả lời · Về cuối hội thoại':'Về cuối hội thoại';
      button.setAttribute('aria-label',button.title);
    }};
    button.onclick=()=>{
      if(watcher.isActive())window.ChatStream?.followResponse(container)?.resume();
      container.scrollTo({top:container.scrollHeight,behavior:watcher.isActive()||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    };
    container.addEventListener('scroll',watcher.update,{passive:true});
    const resize=new ResizeObserver(watcher.update),observed=new Set();resize.observe(container);
    const observeContent=()=>{
      const current=new Set(container.children||[]);
      for(const node of observed)if(!current.has(node)){resize.unobserve(node);observed.delete(node);}
      for(const node of current)if(!observed.has(node)){resize.observe(node);observed.add(node);}
      watcher.update();
    };
    const mutations=new MutationObserver(observeContent);mutations.observe(container,{childList:true,subtree:true,characterData:true});
    observeContent();
    watcher.observers=[mutations,resize];activityWatchers.set(container,watcher);watcher.update();
  }
  window.ChatReasoningUI = { create, update, render, stripCompleted, watchActivity, stopStatusTyping, resumeAtEnd };
})();
