(() => {
  const region = document.getElementById('illustration');
  if (!region) return;
  const track = region.querySelector('.carousel-track');
  const panels = [...region.querySelectorAll('.art-slide')];
  const buttons = [...document.querySelectorAll('[data-slide]')];
  const motion = document.getElementById('carousel-motion');
  const story = region.closest('.story');
  const caption = story.querySelector('.storyfoot > span');
  const captions = [caption.innerHTML,
    'Tra cứu tài liệu, kết nối tri thức trong tổ chức',
    'Khám phá dữ liệu và trình bày kết quả trực quan'];
  const titles = ['Hỏi đáp AI', 'Tra cứu tri thức', 'Phân tích dữ liệu'];
  const paragraph = story.querySelector('.intro > p');
  const original = document.createElement('span');
  original.append(...[...(paragraph?.childNodes || [])].map(node => node.cloneNode(true)));
  const phrases = [original];
  for (const text of [
    'Tìm đúng tri thức từ tài liệu nội bộ, kết nối kiến thức của đội ngũ và đưa thông tin hữu ích vào công việc mỗi ngày.',
    'Từ dữ liệu đến câu trả lời, từ thông tin đến góc nhìn. Cùng AI khám phá số liệu và đưa ra quyết định có cơ sở.'
  ]) {
    const phrase = document.createElement('span');
    phrase.textContent = text;
    phrases.push(phrase);
  }
  const reduced = matchMedia('(prefers-reduced-motion:reduce)');
  const desktop = matchMedia('(min-width:761px)');
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('vi', { granularity: 'grapheme' }) : null;
  const tokenSets = phrases.map(phrase => [...phrase.childNodes].flatMap(node => {
    if (node.nodeName === 'BR') return [{ lineBreak: node }];
    const chars = segmenter
      ? [...segmenter.segment(node.textContent)].map(item => item.segment)
      : Array.from(node.textContent);
    return chars.map(text => ({ text }));
  }));
  let current = 0, position = 0, timer = 0, dueAt = 0, remaining = 0;
  let paused = false, hover = false, focused = false, startX = null;
  let pendingAction, animated, textNode;

  const canRun = () => !paused && !hover && !focused && !document.hidden
    && !reduced.matches && desktop.matches;

  function pauseClock() {
    if (timer) remaining = Math.max(0, dueAt - performance.now());
    clearTimeout(timer);
    timer = 0;
  }

  function schedule(action, delay) {
    clearTimeout(timer);
    timer = 0;
    pendingAction = action;
    remaining = delay;
    if (canRun()) {
      dueAt = performance.now() + delay;
      timer = setTimeout(() => { timer = 0; action(); }, delay);
    }
  }

  function phase(value) {
    region.dataset.presentationPhase = value;
    if (paragraph) paragraph.dataset.introPhase = value;
  }

  function prepareCopy() {
    if (!paragraph || paragraph.classList.contains('intro-copy-typing')) return;
    const layout = document.createElement('span');
    layout.className = 'intro-copy-layout';
    layout.setAttribute('aria-hidden', 'true');
    for (const phrase of phrases) layout.appendChild(phrase.cloneNode(true));
    const accessible = document.createElement('span');
    accessible.className = 'intro-copy-accessible';
    accessible.textContent = original.textContent.replace(/\s+/g, ' ').trim();
    animated = document.createElement('span');
    animated.className = 'intro-copy-animated';
    animated.setAttribute('aria-hidden', 'true');
    paragraph.replaceChildren(layout, accessible, animated);
    paragraph.classList.add('intro-copy-typing');
  }

  function hold() {
    phase('holding');
    schedule(advance, 2200);
  }

  function fullCopy() {
    if (paragraph) {
      prepareCopy();
      animated.replaceChildren(...[...phrases[current].childNodes].map(node => node.cloneNode(true)));
      animated.classList.remove('is-clearing');
    }
    hold();
  }

  function typeNext() {
    if (reduced.matches || !desktop.matches) return updateEnvironment();
    if (!canRun()) return schedule(typeNext, 12);
    const token = tokenSets[current][position++];
    if (!token) return hold();
    if (token.lineBreak) {
      animated.appendChild(token.lineBreak.cloneNode(false));
      textNode = document.createTextNode('');
      animated.appendChild(textNode);
    } else textNode.appendData(token.text);
    if (position === tokenSets[current].length) hold();
    else schedule(typeNext, token.text && /[,.;:!?]/.test(token.text) ? 55 : 12);
  }

  function show(index, initial = false) {
    pauseClock();
    current = (index + panels.length) % panels.length;
    region.dataset.activeSlide = String(current);
    track.style.transform = 'translateX(-' + (current * 100 / panels.length) + '%)';
    panels.forEach((panel, i) => {
      panel.setAttribute('aria-hidden', String(i !== current));
      panel.inert = i !== current;
    });
    buttons.forEach((button, i) => {
      button.setAttribute('aria-pressed', String(i === current));
      button.setAttribute('aria-label', titles[i] + ' · ' + (i + 1) + ' / ' + panels.length);
    });
    caption.innerHTML = captions[current];
    if (paragraph) paragraph.dataset.introPhrase = String(current);
    if (!paragraph || !desktop.matches || reduced.matches || !canRun()) {
      fullCopy();
    } else {
      prepareCopy();
      position = 0;
      textNode = document.createTextNode('');
      animated.replaceChildren(textNode);
      animated.classList.remove('is-clearing');
      phase('typing');
      // Let the incoming picture settle before starting its matching text.
      schedule(typeNext, initial ? 180 : 720);
    }
  }

  function advance() {
    if (reduced.matches || !desktop.matches) return updateEnvironment();
    if (!canRun()) return schedule(advance, 0);
    phase('clearing');
    animated?.classList.add('is-clearing');
    schedule(() => show(current + 1), 180);
  }

  function updateClock() {
    region.classList.toggle('motion-paused', !canRun());
    paragraph?.classList.toggle('intro-copy-paused', !canRun());
    if (!canRun()) pauseClock();
    else if (pendingAction && !timer) schedule(pendingAction, remaining);
  }

  function updateEnvironment() {
    if (reduced.matches || !desktop.matches) {
      pauseClock();
      if (paragraph) paragraph.dataset.introPhrase = String(current);
      fullCopy();
    }
    updateClock();
  }

  buttons.forEach((button, i) => button.addEventListener('click', () => show(i)));
  motion.addEventListener('click', () => {
    paused = !paused;
    motion.setAttribute('aria-pressed', String(paused));
    motion.setAttribute('aria-label', paused ? 'Tiếp tục trình chiếu' : 'Tạm dừng trình chiếu');
    if (!paused) { hover = false; focused = false; }
    updateClock();
  });
  region.addEventListener('pointerenter', () => { hover = true; updateClock(); });
  region.addEventListener('pointerleave', () => { hover = false; updateClock(); });
  story.addEventListener('focusin', () => { focused = true; updateClock(); });
  story.addEventListener('focusout', () => queueMicrotask(() => {
    focused = story.contains(document.activeElement);
    updateClock();
  }));
  story.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      show(current + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
  region.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'mouse') startX = event.clientX;
  });
  region.addEventListener('pointerup', event => {
    if (startX !== null && Math.abs(event.clientX - startX) > 45) {
      show(current + (event.clientX < startX ? 1 : -1));
    }
    startX = null;
  });
  region.addEventListener('pointercancel', () => { startX = null; });
  document.addEventListener('visibilitychange', updateClock);
  reduced.addEventListener('change', updateEnvironment);
  desktop.addEventListener('change', updateEnvironment);
  window.addEventListener('resize', updateEnvironment);
  window.addEventListener('pagehide', pauseClock);
  show(0, true);
  updateClock();
})();
