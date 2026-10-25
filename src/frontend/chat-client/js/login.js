// Login page of the chat client (/chat/login). It signs in only the chat session; the admin
// app keeps its own login.
(function initChatLogin() {
  'use strict';
  const example = document.getElementById('kh-login-example-text');
  if (example) {
    const phrases = [
      'Liệt kê các hợp đồng sắp hết hạn trong 30 ngày tới.',
      'Tổng hợp doanh thu theo từng tháng trong năm nay.',
      'Tra cứu quy trình phê duyệt trong tài liệu nội bộ.'
    ];
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
    let phrase = 0, position = 0, deleting = false, timer;
    function tick() {
      if (document.hidden || reducedMotion.matches) return;
      const characters = Array.from(phrases[phrase]);
      position += deleting ? -1 : 1;
      example.textContent = characters.slice(0, position).join('');
      let delay = deleting ? 22 : 45;
      if (position === characters.length) { deleting = true; delay = 2600; }
      else if (position === 0) { deleting = false; phrase = (phrase + 1) % phrases.length; delay = 350; }
      timer = setTimeout(tick, delay);
    }
    function restart() {
      clearTimeout(timer);
      if (reducedMotion.matches) {
        example.textContent = phrases[0];
        return;
      }
      if (!document.hidden) timer = setTimeout(tick, 500);
    }
    document.addEventListener('visibilitychange', restart);
    reducedMotion.addEventListener('change', restart);
    // Keep the first example visible before starting the typing cycle.
    position = Array.from(phrases[0]).length;
    deleting = true;
    if (!reducedMotion.matches) timer = setTimeout(tick, 2600);
  }
  const embed = new URLSearchParams(window.location.search).get('embed');
  const chatUrl = '/chat' + (embed && /^[a-zA-Z0-9-]{1,64}$/.test(embed) ? '?embed=' + embed : '');
  const form = document.getElementById('kh-login-form');
  const error = document.getElementById('kh-login-error');
  const submit = document.getElementById('kh-login-submit');
  const password = document.getElementById('kh-login-password');
  const toggle = document.getElementById('kh-login-toggle');

  fetch('/chat/api/auth/me', { cache: 'no-store' }).then(response => response.json())
    .then(data => { if (data.authenticated) window.location.replace(chatUrl); })
    .catch(() => { /* keep the form available */ });

  toggle.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
    toggle.firstElementChild.className = show ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    const username = form.username.value.trim();
    if (!username || !password.value) { error.textContent = 'Nhập tên tài khoản và mật khẩu.'; return; }
    error.textContent = '';
    submit.disabled = true;
    submit.setAttribute('aria-busy', 'true');
    submit.innerHTML = '<span class="kh-login-spinner" aria-hidden="true"></span><span>Đang đăng nhập…</span>';
    try {
      const response = await fetch('/chat/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        // Inside a customer site's frame (embed "page" mode) the server keeps a separate partitioned cookie.
        body: JSON.stringify({ username, password: password.value, framed: window.top !== window.self })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status !== 'success') throw new Error(data.message || 'Không thể đăng nhập. Vui lòng thử lại.');
      window.location.replace(chatUrl);
    } catch (cause) {
      error.textContent = cause.message || 'Không thể kết nối máy chủ. Vui lòng thử lại.';
      submit.disabled = false;
      submit.removeAttribute('aria-busy');
      submit.textContent = 'Đăng nhập';
    }
  });
})();
