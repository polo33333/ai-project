// Read AI answers aloud with the browser's own voices (speechSynthesis, Vietnamese).
// Buttons call toggleAnswerSpeech(this) from inside an assistant message.
(function initAnswerSpeech() {
  const synth = window.speechSynthesis;
  const STOP_ICON = '<svg class="chat-answer-action-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>';
  // Parts of an answer that sound like noise when read out.
  const SKIP = 'pre, code, table, svg, canvas, img, button, details, script, style, [aria-hidden="true"], [hidden], .chat-feedback, .chat-code-block, .chat-answer-actions, .chat-reasoning, .chat-tool-panel';
  let active = null; // { button, idleHtml, chunks, index }

  function notify(message, type = 'info') {
    if (typeof showToast === 'function') showToast(message, type);
  }

  function findAnswer(button) {
    return button.closest('.chat-assistant-message-row')?.querySelector('.chat-ai-answer')
      || button.closest('.chat-bubble.ai')?.querySelector('.copilot-answer-text');
  }

  function answerText(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll(SKIP).forEach(node => node.remove());
    clone.querySelectorAll('br').forEach(node => node.replaceWith('\n'));
    clone.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, div, blockquote').forEach(node => node.append('\n'));
    return clone.textContent
      .replace(/https?:\/\/\S+/g, '')
      .split('\n')
      .map(line => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map(line => (/[.!?…:;]$/.test(line) ? line : `${line}.`))
      .join(' ');
  }

  // Chrome cuts off long utterances, so read sentence-sized pieces one after another.
  function splitChunks(text, max = 220) {
    const chunks = [];
    let current = '';
    for (const sentence of text.match(/[^.!?…]+[.!?…]*\s*/g) || []) {
      if (current && (current + sentence).length > max) { chunks.push(current.trim()); current = ''; }
      if (sentence.length > max) {
        sentence.split(/(?<=,)\s+/).forEach(part => {
          if (current && (current + part).length > max) { chunks.push(current.trim()); current = ''; }
          current += `${part} `;
        });
      } else {
        current += sentence;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
  }

  function loadVoices() {
    const voices = synth.getVoices();
    if (voices.length) return Promise.resolve(voices);
    return new Promise(resolve => {
      const done = () => resolve(synth.getVoices());
      synth.addEventListener('voiceschanged', done, { once: true });
      setTimeout(done, 1500);
    });
  }

  function pickVietnameseVoice(voices) {
    const vietnamese = voices.filter(voice => /^vi([-_]|$)/i.test(voice.lang));
    return vietnamese.find(voice => /natural|online/i.test(voice.name))
      || vietnamese.find(voice => /google/i.test(voice.name))
      || vietnamese[0]
      || null;
  }

  function setButtonState(button, speaking, idleHtml) {
    button.classList.toggle('is-speaking', speaking);
    button.setAttribute('aria-pressed', String(speaking));
    button.title = speaking ? 'Dừng đọc' : 'Đọc to';
    button.setAttribute('aria-label', speaking ? 'Dừng đọc câu trả lời' : 'Đọc to câu trả lời');
    button.innerHTML = speaking ? STOP_ICON : idleHtml;
  }

  function stop() {
    if (!active) return;
    const { button, idleHtml } = active;
    active = null;
    synth.cancel();
    if (button.isConnected) setButtonState(button, false, idleHtml);
  }

  function speakNext(session, voice) {
    if (active !== session) return;
    if (session.index >= session.chunks.length || !session.button.isConnected) { stop(); return; }
    const utterance = new SpeechSynthesisUtterance(session.chunks[session.index]);
    session.index += 1;
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = 1;
    utterance.onend = () => speakNext(session, voice);
    utterance.onerror = event => {
      if (active !== session) return;
      if (event.error !== 'interrupted' && event.error !== 'canceled') notify('Không đọc được câu trả lời, vui lòng thử lại.', 'error');
      stop();
    };
    synth.speak(utterance);
  }

  async function start(button) {
    if (!synth || typeof SpeechSynthesisUtterance === 'undefined') {
      notify('Trình duyệt này chưa hỗ trợ đọc to. Hãy dùng Chrome hoặc Edge.', 'warning');
      return;
    }
    const answer = findAnswer(button);
    const chunks = answer ? splitChunks(answerText(answer)) : [];
    if (!chunks.length) {
      notify('Câu trả lời này không có nội dung chữ để đọc.', 'info');
      return;
    }
    const session = { button, idleHtml: button.innerHTML, chunks, index: 0 };
    active = session;
    setButtonState(button, true, session.idleHtml);

    const voice = pickVietnameseVoice(await loadVoices());
    if (active !== session) return;
    if (!voice) {
      stop();
      // Chrome ships no Vietnamese voice; it only sees voices installed in Windows.
      console.info('[answer_speech] Giọng đọc hiện có:', synth.getVoices().map(item => `${item.name} (${item.lang})`));
      notify('Trình duyệt chưa có giọng đọc tiếng Việt. Hãy mở bằng Edge, hoặc cài giọng tiếng Việt cho Windows (Cài đặt → Thời gian và ngôn ngữ → Giọng nói → Thêm giọng nói) rồi mở lại trình duyệt.', 'warning');
      return;
    }
    synth.cancel();
    speakNext(session, voice);
  }

  window.toggleAnswerSpeech = function toggleAnswerSpeech(button) {
    const sameButton = active?.button === button;
    stop();
    if (!sameButton) start(button);
  };
  window.stopAnswerSpeech = stop;

  // Stop reading when the user starts something new: dictation, sending, or Esc.
  document.addEventListener('click', event => {
    if (active && event.target.closest?.('[data-voice-target], #page-chat-send-button, #copilot-send-button')) stop();
  }, true);
  document.addEventListener('keydown', event => {
    if (!active) return;
    if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey && event.target.matches?.('#page-chat-user-input, #chat-user-input'))) stop();
  }, true);
  window.addEventListener('pagehide', () => synth?.cancel());
})();
