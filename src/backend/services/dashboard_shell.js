'use strict';
const fs = require('node:fs');
const path = require('node:path');
const views = path.join(__dirname, '../../frontend/views');
// Reuse the actual views so the initial layout cannot drift from the dashboard.
const dashboard = fs.readFileSync(path.join(views, 'dashboard.html'), 'utf8');
const logs = fs.readFileSync(path.join(views, 'dashboard_logs.html'), 'utf8')
  .replace('id="view-dashboard-logs"', 'id="view-dashboard-logs" data-view-file="dashboard_logs.html"')
  .replace('display: none;', 'display: block;');
exports.render = html => html
  .replace('id="dashboard-view-container"', 'id="dashboard-view-container" data-loaded="true"')
  .replace('<!-- dashboard-shell -->', dashboard)
  .replace('<!-- dashboard-logs-shell -->', logs);
