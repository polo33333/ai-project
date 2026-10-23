'use strict';
// Generate the approved visual design without preview auth/theme handlers.
const fs = require('node:fs');
const assets = require('./login_page_assets.cjs')();
let html = require('./login_preview_reference.cjs')(assets);
html = require('./login_preview_carousel.cjs')(html, assets);
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (scripts.length !== 2) throw Error('Expected demo handlers and carousel controller');
fs.writeFileSync('src/frontend/js/login_carousel.js', scripts[1][1].trim() + '\n');
const css = ([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n') + require('./login_theme_styles.cjs'))
  .replace(/\.theme-switch button\.active/g, '.theme-switch button[aria-pressed="true"]')
  + '\n.login-error{color:#a94369;background:#fff2f6;border:1px solid #f4dfe8}'
  + '\nhtml[data-theme=dark] .login-error{color:#f2b9ce;background:#362332;border-color:#59364a}'
  + '\n.login-error.is-help{color:#7861a5;background:#f4f0ff;border-color:#e9e0f7}'
  + '\nhtml[data-theme=dark] .login-error.is-help{color:#c0a8df;background:#31263f;border-color:#4c3b60}'
  + '\n.login-submit[disabled]{opacity:.7;cursor:wait;translate:none}'
  + '\n.login-submit[aria-busy=true] svg{animation:login-spin 1s linear infinite}'
  + '\n@keyframes login-spin{to{transform:rotate(360deg)}}\n';
fs.writeFileSync('src/frontend/css/login.css', css.replace(/}/g, '}\n').trim() + '\n');
html = html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<script>[\s\S]*?<\/script>/g, '');
html = html.replace('</head>', `
  <title>Đăng nhập - KnowledgeHub AI</title>
  <link rel="icon" href="${assets.logo}" type="image/svg+xml">
  <link rel="manifest" href="/manifest.webmanifest?v=20260906-desktop-icon">
  <meta name="theme-color" content="#7044ff">
  <meta name="mobile-web-app-capable" content="yes">
  <script src="js/theme.js?v=1"></script>
  <link rel="stylesheet" href="css/login.css?v=20261024-feature-align">
</head>`);
html = html.replace('<body>', '<body class="login-page">')
  .replace('class="login"', 'class="login" aria-labelledby="login-title"')
  .replace('id="demo-form"', 'id="login-form"')
  .replace(/\busername\b/g, 'login-username')
  .replace(/\bpassword\b/g, 'login-password')
  .replace('name="preview-login-username" autocomplete="off"', 'name="username" autocomplete="username"')
  .replace('name="preview-login-password" type="login-password" autocomplete="off"', 'name="password" type="password" autocomplete="current-password"')
  .replace('id="toggle-login-password"', 'id="login-toggle-password"')
  .replace(/(<button[^>]*id="login-toggle-password"[\s\S]*?)(<\/svg>)/,
    '$1<path data-eye-slash d="M3 3l18 18"/>$2')
  .replace('id="caps"', 'id="login-caps"')
  .replace('class="submit"', 'class="submit login-submit"')
  .replace('class="notice" id="notice" role="status"', 'class="notice login-error" id="login-error" role="alert"')
  .replace('id="help"', 'id="login-help"')
  .replace('class="active" type="button" data-set-theme=', 'type="button" data-set-theme=')
  .replace(/data-set-theme=/g, 'data-theme-choice=')
  .replace(/(data-theme-choice="light"[^>]*>)☼/,
    '$1<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>')
  .replace(/(data-theme-choice="dark"[^>]*>)☾/,
    '$1<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z"/></svg>')
  // No Google authentication endpoint exists in this application.
  .replace(/<div class="divider">Hoặc đăng nhập bằng<\/div><button class="google"[\s\S]*?<\/button>/, '')
  .replace('<form id="login-form">', '<form id="login-form" method="post" action="/api/auth/login">')
  .replace('</body>', `
  <script src="js/login.js?v=20261023-login-theme-v3"></script>
  <script src="js/login_carousel.js?v=20261023-login-sync-v7"></script>
</body>`);
if (html.includes('type="login-password"') || html.includes('id="google"') || !html.includes('autocomplete="current-password"')) {
  throw Error('Authentication markup conversion failed');
}
const formattedHtml = html.replace(/></g, '>\n<').replace(/(id="login-error"[^>]*>)\s+(<\/div>)/, '$1$2');
fs.writeFileSync('src/frontend/login.html', formattedHtml + '\n');
console.log('Generated production login HTML, CSS and carousel controller.');
