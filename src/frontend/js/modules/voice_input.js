// Voice-to-text for chat composers (Web Speech API, Vietnamese).
// Any button with data-voice-target="<textarea id>" becomes a mic toggle.
(function initVoiceInput() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let active = null; // { recognition, button, input, baseText, finalText }

  function notify(message, type = 'info') {
    if (typeof showToast === 'function') showToast(message, type);
  }

  function setButtonState(button, recording) {
    button.classList.toggle('is-recording', recording);
    button.setAttribute('aria-pressed', String(recording));
    button.title = recording ? 'Đang nghe… nhấn để dừng' : 'Nhập bằng giọng nói';
    button.setAttribute('aria-label', button.title);
    button.innerHTML = recording ? '<i class="fa-solid fa-stop"></i>' : '<i class="fa-solid fa-microphone"></i>';
  }

  function writeInput(input, text) {
    const max = Number(input.getAttribute('maxlength')) || Infinity;
    input.value = text.slice(0, max);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.scrollTop = input.scrollHeight;
  }

  function stop() {
    if (!active) return;
    const { recognition, button, input } = active;
    active = null;
    setButtonState(button, false);
    try { recognition.stop(); } catch (_) { }
    input.focus();
  }

  function start(button) {
    const input = document.getElementById(button.dataset.voiceTarget);
    if (!input) return;
    if (!Recognition) {
      notify('Trình duyệt này chưa hỗ trợ nhập bằng giọng nói. Hãy dùng Chrome hoặc Edge.', 'warning');
      return;
    }
    if (!window.isSecureContext) {
      notify('Nhập bằng giọng nói chỉ hoạt động trên HTTPS hoặc localhost.', 'warning');
      return;
    }

    const recognition = new Recognition();
    recognition.lang = 'vi-VN';
    recognition.continuous = true;
    recognition.interimResults = true;

    const existing = input.value.trimEnd();
    const session = { recognition, button, input, baseText: existing ? `${existing} ` : '', finalText: '' };
    active = session;

    recognition.onresult = event => {
      if (active !== session) return;
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) session.finalText += transcript;
        else interim += transcript;
      }
      writeInput(input, session.baseText + session.finalText + interim);
    };
    recognition.onerror = event => {
      const messages = {
        'not-allowed': 'Chưa được cấp quyền dùng micro. Hãy cho phép micro trong trình duyệt.',
        'service-not-allowed': 'Chưa được cấp quyền dùng micro. Hãy cho phép micro trong trình duyệt.',
        'audio-capture': 'Không tìm thấy micro trên thiết bị.',
        network: 'Mất kết nối tới dịch vụ nhận dạng giọng nói.',
      };
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        notify(messages[event.error] || 'Không nhận dạng được giọng nói, vui lòng thử lại.', 'error');
      }
      if (active === session) stop();
    };
    recognition.onend = () => {
      if (active !== session) return;
      // Chrome ends after a pause even in continuous mode; keep only the confirmed text.
      writeInput(input, session.baseText + session.finalText);
      stop();
    };

    try {
      recognition.start();
      setButtonState(button, true);
    } catch (_) {
      active = null;
      notify('Không bật được micro, vui lòng thử lại.', 'error');
    }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest?.('[data-voice-target]');
    if (!button || button.disabled) return;
    event.preventDefault();
    const sameButton = active?.button === button;
    stop();
    if (!sameButton) start(button);
  });

  // Sending (Enter) or closing a dialog ends dictation so text isn't re-filled afterwards.
  document.addEventListener('keydown', event => {
    if (!active) return;
    if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey && event.target === active.input)) stop();
  }, true);
  document.addEventListener('click', event => {
    if (active && event.target.closest?.('#page-chat-send-button, #copilot-send-button')) stop();
  }, true);

  window.stopVoiceInput = stop;
})();
