// Connection guard. The server inlines this into every page right after <head>, so it still
// runs when the server stops while the page is loading. When a page asset or an API request
// fails and /health/live confirms the server is unreachable, it covers the page with a
// self-contained notice (Shadow DOM, no external CSS or fonts) and retries until the server
// answers again: a half-loaded page reloads, a running page simply continues.
(() => {
  if (window.KHConnection) return;
  const HEALTH_URL = '/health/live';
  const RETRY_DELAYS = [3000, 5000, 10000, 15000];
  const nativeFetch = window.fetch.bind(window);
  let host = null, view = null, mode = 'load', attempt = 0, timer = 0, ticker = 0, verifying = false;

  const sameOrigin = url => { try { return new URL(url, location.href).origin === location.origin; } catch { return false; } };
  async function serverAnswers() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    try { return (await nativeFetch(HEALTH_URL, { cache: 'no-store', signal: controller.signal })).ok; }
    catch { return false; }
    finally { clearTimeout(timeout); }
  }
  function isDark() {
    const theme = document.documentElement.dataset.theme;
    if (theme) return theme === 'dark';
    let saved = null;
    try { saved = localStorage.getItem('knowledgehub.theme'); } catch { /* Follow the device. */ }
    return saved ? saved === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }

  const STYLE = `
    :host{all:initial}
    .screen{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;overflow:auto;box-sizing:border-box;
      font-family:'Be Vietnam Pro','Segoe UI',system-ui,-apple-system,Roboto,Arial,sans-serif;-webkit-font-smoothing:antialiased;
      --bg:#f4f5fa;--card:#fff;--line:#e3e5f0;--text:#11183f;--muted:#5d6488;--soft:#eef0fb;--brand:#4b3fd6;--brand-hover:#3f33c2;--warn:#c2410c;--ok:#0f8a5f;
      background:var(--bg);color:var(--text)}
    .screen.dark{--bg:#0d1422;--card:#131c2e;--line:#2c3950;--text:#e1e8f5;--muted:#a8b6cd;--soft:#1c283b;--brand:#5b4fe0;--brand-hover:#6a5ff0;--warn:#fb923c;--ok:#34d399}
    .card{width:min(100%,460px);padding:36px 32px 28px;border:1px solid var(--line);border-radius:18px;background:var(--card);box-shadow:0 18px 40px -24px rgb(17 24 63 / 25%);box-sizing:border-box}
    .icon{display:grid;place-items:center;width:52px;height:52px;margin-bottom:20px;border-radius:14px;background:var(--soft);color:var(--brand)}
    .icon svg{width:26px;height:26px}
    h1{margin:0;font-size:22px;font-weight:600;line-height:1.3;letter-spacing:-.01em}
    p{margin:10px 0 0;color:var(--muted);font-size:14.5px;line-height:1.6}
    .status{display:flex;align-items:center;gap:10px;margin-top:22px;padding:11px 14px;border-radius:10px;background:var(--soft);font-size:13.5px}
    .dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--warn);box-shadow:0 0 0 4px color-mix(in srgb,var(--warn) 18%,transparent)}
    .status[data-state=checking] .dot{background:var(--brand);box-shadow:0 0 0 4px color-mix(in srgb,var(--brand) 18%,transparent);animation:pulse 1s ease-in-out infinite alternate}
    .status[data-state=ok] .dot{background:var(--ok);box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 18%,transparent)}
    button{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;height:46px;margin-top:16px;border:0;border-radius:11px;background:var(--brand);color:#fff;font-family:inherit;font-size:14.5px;font-weight:600;cursor:pointer}
    button:hover{background:var(--brand-hover)}
    button:disabled{opacity:.65;cursor:progress}
    button:focus-visible{outline:3px solid color-mix(in srgb,var(--brand) 45%,transparent);outline-offset:3px}
    small{display:block;margin-top:18px;color:var(--muted);font-size:12.5px;line-height:1.55}
    code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:var(--text)}
    @keyframes pulse{to{opacity:.35}}
    @media(prefers-reduced-motion:reduce){.status[data-state=checking] .dot{animation:none}}
  `;
  const MESSAGES = {
    load: 'Trang chưa tải đầy đủ vì máy chủ KnowledgeHub AI không phản hồi. Máy chủ có thể đang khởi động lại hoặc kết nối mạng bị gián đoạn.',
    runtime: 'Máy chủ KnowledgeHub AI đang không phản hồi. Nội dung bạn đang nhập vẫn được giữ trên trang này.',
    offline: 'Máy chủ KnowledgeHub AI không phản hồi. Máy chủ có thể đang khởi động lại hoặc kết nối mạng bị gián đoạn.'
  };

  function render() {
    host = document.createElement('kh-connection-notice');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>${STYLE}</style>
      <div class="screen" role="alertdialog" aria-modal="true" aria-labelledby="t" aria-describedby="d">
        <div class="card">
          <div class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7V3m6 4V3M7 7h10v4a5 5 0 0 1-10 0V7Zm5 9v5"/><path d="m3 3 18 18"/></svg></div>
          <h1 id="t">Không kết nối được máy chủ</h1>
          <p id="d"></p>
          <div class="status" role="status" aria-live="polite"><span class="dot"></span><span class="label"></span></div>
          <button type="button">Thử lại ngay</button>
          <small>Nếu tình trạng kéo dài, hãy kiểm tra ứng dụng máy chủ tại <code></code> hoặc liên hệ quản trị viên.</small>
        </div>
      </div>`;
    view = {
      screen: root.querySelector('.screen'), message: root.querySelector('#d'), status: root.querySelector('.status'),
      label: root.querySelector('.label'), button: root.querySelector('button'), address: root.querySelector('code')
    };
    view.address.textContent = location.host;
    view.button.addEventListener('click', () => check());
    document.documentElement.append(host);
  }
  function setStatus(state, text) { view.status.dataset.state = state; view.label.textContent = text; }

  function schedule() {
    clearTimeout(timer); clearInterval(ticker);
    const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
    const due = Date.now() + delay;
    const tick = () => setStatus('waiting', `Tự thử lại sau ${Math.max(1, Math.ceil((due - Date.now()) / 1000))} giây.`);
    tick(); ticker = setInterval(tick, 1000);
    timer = setTimeout(check, delay);
  }
  async function check() {
    if (!host) return;
    clearTimeout(timer); clearInterval(ticker);
    view.button.disabled = true; setStatus('checking', 'Đang kiểm tra kết nối…');
    const ok = await serverAnswers();
    view.button.disabled = false;
    if (!ok) { attempt++; schedule(); return; }
    setStatus('ok', 'Đã kết nối lại.');
    if (mode === 'runtime') { setTimeout(hide, 600); return; }
    if (location.pathname.endsWith('/offline.html')) location.replace('/');
    else location.reload();
  }
  function show(nextMode = 'load') {
    // A half-loaded page outranks a running one: it must reload once the server is back.
    if (!host) { render(); mode = nextMode; }
    else if (nextMode !== 'runtime') mode = nextMode;
    view.screen.classList.toggle('dark', isDark());
    view.message.textContent = MESSAGES[mode] || MESSAGES.load;
    attempt = 0; schedule();
    view.button.focus({ preventScroll: true });
  }
  function hide() {
    clearTimeout(timer); clearInterval(ticker);
    host?.remove(); host = null; view = null;
  }
  async function verify(nextMode) {
    if (verifying) return;
    if (host) { if (nextMode !== 'runtime' && mode === 'runtime') show(nextMode); return; }
    verifying = true;
    const ok = await serverAnswers();
    verifying = false;
    if (!ok) show(nextMode);
  }

  // Styles or scripts of this site that fail while the page loads.
  addEventListener('error', event => {
    const node = event.target;
    const url = node instanceof HTMLLinkElement && /\bstylesheet\b/i.test(node.rel) ? node.href
      : node instanceof HTMLScriptElement ? node.src : '';
    if (url && sameOrigin(url)) verify(document.readyState === 'complete' ? 'runtime' : 'load');
  }, true);
  // Requests that fail at the network level once the page is running. The error is passed on unchanged.
  window.fetch = function (input, init) {
    return nativeFetch(input, init).catch(error => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
      if (error?.name !== 'AbortError' && sameOrigin(url || location.href)) verify(document.readyState === 'complete' ? 'runtime' : 'load');
      throw error;
    });
  };
  window.KHConnection = { show, hide, check };
})();
