/* Shared, text-first reasoning presentation for page chat and popup chat. */
(() => {
  const escape = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
  const keyOf = event => JSON.stringify([event.reasoningId || '', event.iteration || 0]);
  const nearBottom = node => node && node.scrollHeight - node.clientHeight - node.scrollTop <= 48;
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
    return root;
  }
  function update(root, event = {}, label = '') {
    if (!root) return;
    if (root._hideReasoning && event.type === 'reasoning_delta') return;
    const current = root.querySelector('.chat-thinking-copy span');
    if (event.type !== 'reasoning_delta') {
      if (!root._reasoningRecords?.size && current) current.textContent = label || 'Đang chuẩn bị câu trả lời…';
      return;
    }
    if (!event.delta) return;
    const content = root.querySelector('.chat-thinking-steps');
    if (!content) return;
    root._reasoningRecords ||= new Map();
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
    if (current) current.textContent = '';
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
  window.ChatReasoningUI = { create, update, render, stripCompleted, watchActivity };
})();
