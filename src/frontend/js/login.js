async function checkExistingSession() {
  try {
    const res = await fetch('/api/auth/me', { cache: 'no-store' });
    const data = await res.json();
    if (data.authenticated) window.location.href = '/';
  } catch {
    // Keep the login form available when the session check fails.
  }
}

function toggleLoginPassword() {
  const input = document.getElementById('login-password');
  const button = document.getElementById('login-toggle-password');
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button?.setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  button?.setAttribute('title', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  button?.setAttribute('aria-pressed', String(show));
}

function loginFeedback(message, help = false) {
  const element = document.getElementById('login-error');
  if (!element) return;
  element.textContent = message;
  element.classList.toggle('is-help', help);
  element.setAttribute('role', help ? 'status' : 'alert');
}

document.getElementById('login-toggle-password')?.addEventListener('click', toggleLoginPassword);
document.getElementById('login-help')?.addEventListener('click', () => {
  window.location.href = 'mailto:tranducthai8@gmail.com?subject=' + encodeURIComponent('Hỗ trợ tài khoản KnowledgeHub AI');
});

const passwordInput = document.getElementById('login-password');
const capsHint = document.getElementById('login-caps');
passwordInput?.addEventListener('keyup', event => {
  if (capsHint) capsHint.style.display = event.getModifierState('CapsLock') ? 'block' : 'none';
});
passwordInput?.addEventListener('blur', () => {
  if (capsHint) capsHint.style.display = 'none';
});

// theme.js owns persistence and click handling. Reflect the resolved appearance
// here as well when the device theme is used without an explicit preference.
function syncLoginTheme() {
  const theme = document.documentElement.dataset.theme || 'light';
  document.querySelectorAll('.theme-switch [data-theme-choice]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === theme));
  });
}
new MutationObserver(syncLoginTheme).observe(document.documentElement, {
  attributes: true, attributeFilter: ['data-theme']
});
document.addEventListener('DOMContentLoaded', syncLoginTheme);
syncLoginTheme();

document.getElementById('login-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const submitBtn = document.querySelector('.login-submit');
  if (submitBtn?.disabled) return;
  const username = document.getElementById('login-username')?.value.trim();
  const password = passwordInput?.value;
  const originalContent = submitBtn?.innerHTML;
  loginFeedback('');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round"/></svg> Đang đăng nhập…';
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== 'success') throw new Error(data.message || 'Không thể đăng nhập. Vui lòng thử lại.');
    try {
      localStorage.removeItem('knowledgehub.activeMainTab');
    } catch {
      // A fresh login still continues when browser storage is unavailable.
    }
    window.location.href = '/';
  } catch (err) {
    loginFeedback(err.message || 'Không thể kết nối máy chủ. Vui lòng thử lại.');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.removeAttribute('aria-busy');
      submitBtn.innerHTML = originalContent;
    }
  }
});

checkExistingSession();

// Catch light at UI edges as the animated glass passes over them.
(() => {
  const glass = [...document.querySelectorAll('.glass-rain i')];
  const surfaces = [...document.querySelectorAll('.feature,.input,.submit,.dashboard,.knowledge-board,.analysis-board,.scene-note,.form-head img')];
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (!glass.length || !surfaces.length) return;
  let frame = 0;
  let lastSample = 0;
  function reflect(now) {
    if (now - lastSample >= 100) {
      lastSample = now;
      const edges = surfaces.map(surface => surface.getBoundingClientRect()).filter(rect => rect.width && rect.height);
      const highlights = glass.map(shard => {
        const rect = shard.getBoundingClientRect();
        if (!rect.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight) return false;
        return edges.some(edge => rect.right >= edge.left - 12 && rect.left <= edge.right + 12
          && rect.bottom >= edge.top - 12 && rect.top <= edge.bottom + 12
          && (Math.abs(rect.bottom - edge.top) < 24 || Math.abs(rect.top - edge.bottom) < 24
            || Math.abs(rect.right - edge.left) < 24 || Math.abs(rect.left - edge.right) < 24));
      });
      glass.forEach((shard, index) => shard.classList.toggle('is-reflecting', highlights[index]));
    }
    frame = requestAnimationFrame(reflect);
  }
  function sync() {
    cancelAnimationFrame(frame);
    if (!document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(reflect);
    else glass.forEach(shard => shard.classList.remove('is-reflecting'));
  }
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
  sync();
})();
