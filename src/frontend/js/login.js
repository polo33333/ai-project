async function checkExistingSession() {
  try {
    const res = await fetch('/api/auth/me');
    const data = await res.json();
    if (data.authenticated) window.location.href = '/';
  } catch {
    // stay on login
  }
}

function toggleLoginPassword() {
  const input = document.getElementById('login-password');
  const icon = document.querySelector('.login-password-wrap button i');
  if (!input) return;
  const hidden = input.type === 'password';
  input.type = hidden ? 'text' : 'password';
  if (icon) icon.className = `fa-solid ${hidden ? 'fa-eye-slash' : 'fa-eye'}`;
}

document.getElementById('login-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorEl = document.getElementById('login-error');
  const submitBtn = document.querySelector('.login-submit');
  const username = document.getElementById('login-username')?.value.trim();
  const password = document.getElementById('login-password')?.value;

  if (errorEl) errorEl.textContent = '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang đăng nhập...';
  }

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok || data.status !== 'success') throw new Error(data.message || 'Không thể đăng nhập.');
    try {
      localStorage.removeItem('knowledgehub.activeMainTab');
    } catch {
      // A fresh login still continues when browser storage is unavailable.
    }
    window.location.href = '/';
  } catch (err) {
    if (errorEl) errorEl.textContent = err.message;
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Đăng nhập';
    }
  }
});

checkExistingSession();
