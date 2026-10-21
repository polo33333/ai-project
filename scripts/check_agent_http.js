'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function main() {
  const base = new URL(process.argv[2] || 'http://localhost:5500/');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('HTTP_TARGET_INVALID');
  const assets = ['/', '/js/answer_ui.js', '/js/modules/page_chat.js', '/embed/knowledgehub-chat.js',
    '/js/modules/governance.js', '/views/data_governance.html', '/css/settings.css'];
  const results = [];
  for (const asset of assets) {
    try {
      const response = await fetch(new URL(asset, base), { cache: 'no-store', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const local = path.resolve(__dirname, '../src/frontend', asset === '/' ? 'index.html' : asset.slice(1));
      results.push({ path: asset, status: response.status, bytes: bytes.length,
        matchesWorkspaceAsset: response.status === 200 && fs.existsSync(local) ? hash(bytes) === hash(fs.readFileSync(local)) : null });
    } catch (error) { results.push({ path: asset, error: error.code || error.name }); }
  }
  const response = await fetch(new URL('/api/governance/operations', base), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  const report = { createdAt: new Date().toISOString(), base: base.origin, results,
    anonymousOperationsAccess: { status: response.status, denied: [401, 403].includes(response.status) },
    visualAcceptance: 'not_run_browser_control_unavailable', authenticatedChatAcceptance: 'not_run_no_authenticated_browser_session',
    limitations: ['Asset checks do not verify layout, mobile, dark mode or authenticated chat.', 'Anonymous denial does not prove a new backend handler is loaded.'] };
  fs.mkdirSync(path.resolve('artifacts/agent-acceptance'), { recursive: true });
  fs.writeFileSync(path.resolve('artifacts/agent-acceptance/http.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.code || 'HTTP_ACCEPTANCE_FAILED'); process.exitCode = 1; });
