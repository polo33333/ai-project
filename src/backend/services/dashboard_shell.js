'use strict';
const fs = require('node:fs');
const path = require('node:path');
const views = path.join(__dirname, '../../frontend/views');
// Reuse the actual views so the initial layout cannot drift from the dashboard.
const dashboard = fs.readFileSync(path.join(views, 'dashboard.html'), 'utf8');
const logs = fs.readFileSync(path.join(views, 'dashboard_logs.html'), 'utf8')
  .replace('id="view-dashboard-logs"', 'id="view-dashboard-logs" data-view-file="dashboard_logs.html"')
  .replace('display: none;', 'display: block;');
const OVERVIEW = new Set(['/', '/overview', '/index.html']);

// The dashboard is painted server-side only when it is the page being opened. Any other route
// (e.g. reloading /chat-history) starts neutral, so the overview never flashes before the real tab.
exports.render = (html, pathname = '/') => {
  if (OVERVIEW.has(pathname.replace(/\/+$/, '') || '/')) return html
    .replace('id="dashboard-view-container"', 'id="dashboard-view-container" data-loaded="true"')
    .replace('<!-- dashboard-shell -->', dashboard)
    .replace('<!-- dashboard-logs-shell -->', logs);
  const tab = pathname.replace(/^\/+|\/+$/g, '');
  return html
    .replace('<h1 id="page-heading">Tổng quan hệ thống</h1>', '<h1 id="page-heading"></h1>')
    .replace('id="dashboard-heading-subtitle">Tổng hợp hoạt động và hiệu suất của hệ thống AI</p>', 'id="dashboard-heading-subtitle"></p>')
    .replace('id="dashboard-heading-icon" aria-hidden="true"><i></i><i></i><i></i></span>', 'id="dashboard-heading-icon" aria-hidden="true" hidden></span>')
    .replace('<li class="nav-item active" id="nav-dashboard">', '<li class="nav-item" id="nav-dashboard">')
    .replace('<div class="dashboard-overview-lower is-dashboard">', '<div class="dashboard-overview-lower">')
    .replace(new RegExp(`<li class="nav-item"((?: [a-z-]+(?:="[^"]*")?)*)>(\\s*<a href="#" onclick="switchMainTab\\('${tab.replace(/[^a-z0-9-]/gi, '')}'\\))`),
      '<li class="nav-item active"$1>$2');
};
