'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
async function main() {
  const credentials = JSON.parse(fs.readFileSync(0, 'utf8'));
  const base = 'http://localhost:5500';
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  if (!login.ok) throw new Error('LOGIN_FAILED');
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  const api = async (path, body) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return response.json();
  };
  const toolName = 'calculate_expression';
  let disabled = false;
  const evidence = {};
  try {
    const tool = (await api('/api/tools')).tools.find(tool => tool.name === toolName);
    assert.equal(tool.enabled, true, 'Verification requires an initially enabled tool.');
    await api('/api/tools/state', { toolName, enabled: false, expectedEnabled: true }); disabled = true;
    const rejected = await api('/api/tools/execute', { toolName, args: { expression: '1+1' } });
    assert.equal(rejected.code, 'TOOL_DISABLED');
    evidence.disabledCall = { success: rejected.success, code: rejected.code, status: rejected.envelope.status };
    const restarted = await fetch(base + '/api/settings/restart', { method: 'POST', headers });
    assert.equal(restarted.status, 202);
    await new Promise(resolve => setTimeout(resolve, 2000));
    let catalog;
    for (let i = 0; i < 20; i++) {
      try { catalog = await api('/api/tools'); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(catalog?.tools.find(tool => tool.name === toolName).enabled, false);
    evidence.disabledAfterRestart = true;
    await api('/api/tools/state', { toolName, enabled: true, expectedEnabled: false }); disabled = false;
    const execution = await api('/api/tools/execute', { toolName, args: { expression: '1+1' } });
    assert.equal(execution.result.value, 2);
    evidence.enabledCall = { success: execution.success, value: execution.result.value };
    fs.writeFileSync('artifacts/agent-acceptance/tool-toggle-live.json', JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  } finally {
    if (disabled) await api('/api/tools/state', { toolName, enabled: true, expectedEnabled: false });
    await fetch(base + '/api/auth/logout', { method: 'POST', headers });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
