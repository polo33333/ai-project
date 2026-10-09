'use strict';
const fs = require('node:fs');
const path = require('node:path');
require('../src/backend/storage/postgres/config').loadEnvironment();
const { createPool } = require('../src/backend/storage/postgres/pool');
const { PostgresRepository } = require('../src/backend/storage/postgres/repository');
const { decrypt } = require('../src/backend/storage/postgres/crypto');
const { PluginRegistry } = require('../src/backend/automation/registry');
const { AutomationRepository } = require('../src/backend/automation/repository');
function plainText(message) {
  if (message.content) return String(message.content);
  const answer = String(message.html || '').match(/class="chat-ai-answer"[^>]*>([\s\S]*?)<\/div>/)?.[1] || '';
  return answer.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
}
async function main() {
  const pool = createPool({ runtime: true });
  try {
    const owners = (await pool.query('SELECT account_id,count(*)::int AS sessions FROM app.ui_chat_sessions GROUP BY account_id ORDER BY count(*) DESC')).rows;
    const snapshot = await new PostgresRepository(pool).snapshot(['accounts.json', 'chat_history.json', 'ai_providers.json']);
    const accounts = snapshot.documents.get('accounts.json');
    console.log(JSON.stringify({ owners: owners.map(item => ({ ...item, username: accounts.find(account => account.id === item.account_id)?.username })) }));
    const owner = process.env.HISTORY_EVAL_ACCOUNT_ID || (owners.length === 1 ? owners[0].account_id : null);
    if (!owner) return;
    const account = accounts.find(item => item.id === owner);
    if (!account) throw new Error('History account not found');
    const rows = (await pool.query('SELECT id,payload FROM app.ui_chat_sessions WHERE account_id=$1 ORDER BY updated_at DESC', [owner])).rows;
    const sessions = rows.map(row => decrypt(row.payload, `ui-chat/${owner}/${row.id}`));
    const audit = snapshot.documents.get('chat_history.json');
    const registry = new PluginRegistry(new AutomationRepository({ pool }));
    const definitions = await registry.list({ accountId: owner, tenantId: account.tenantId, permissions: account.role === 'admin' ? ['admin'] : ['sql:read', 'knowledge:read'] });
    const runs = (await pool.query("SELECT id,conversation_id,document->>'templateId' AS template_id,document->>'status' AS status,document->'input' AS inputs,document->'definition'->>'name' AS name FROM app.automation_runs WHERE owner_id=$1", [owner])).rows;
    const cases = [];
    for (const session of sessions) {
      const history = [];
      let workflowMemory = null;
      for (const message of session.messages || []) {
        if (message.role === 'user' && String(message.content || '').trim()) {
          const question = String(message.content).trim();
          const matches = audit.filter(item => item.question === question && (!item.requestPayload?.sessionId || item.requestPayload.sessionId === session.id));
          const prior = matches[0];
          cases.push({ id: `history-${cases.length + 1}`, sessionId: session.id, question, history: history.slice(-6),
            workflowMemory,
            historicalRouting: prior?.requestPayload?.diagnostics?.workflowRouting || null,
            historicalMode: prior?.requestPayload?.executionMode || null, historicalStatus: prior?.status,
            previousAssistant: history.filter(item => item.role === 'assistant').at(-1)?.content || null,
            followingAssistant: null, expected: null });
        }
        if (message.role === 'assistant' && cases.at(-1)?.sessionId === session.id && !cases.at(-1).followingAssistant) {
          cases.at(-1).followingAssistant = plainText(message).slice(0, 2000);
        }
        const runId = String(message.html || '').match(/data-automation-run="([^"]+)"/)?.[1];
        const run = runs.find(item => item.id === runId && item.conversation_id === session.id && item.status === 'SUCCEEDED'
          && definitions.some(definition => definition.id === item.template_id));
        if (run) workflowMemory = { runId: run.id, name: run.name, inputs: run.inputs, datasets: [] };
        const content = plainText(message);
        if (content && ['user', 'assistant'].includes(message.role)) history.push({ role: message.role, content: content.slice(0, 2000) });
      }
    }
    const provider = snapshot.documents.get('ai_providers.json').find(item => item.isActive);
    if (!provider) throw new Error('No active chat provider');
    const output = { createdAt: new Date().toISOString(), owner, tenantId: account.tenantId, definitions,
      cases, source: 'account-owned ui_chat_sessions; historical responses are evidence, not expected labels' };
    const destination = path.resolve(__dirname, '../artifacts/history-routing-corpus.private.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(output, null, 2));
    // Provider credentials are never written into the corpus.
    console.log(JSON.stringify({ sessions: sessions.length, turns: cases.length, uniqueQuestions: new Set(cases.map(item => item.question)).size,
      catalog: definitions.map(item => ({ id: item.id, name: item.name, description: item.description, scope: item.routingScope,
        slots: Object.keys(item.inputs) })), destination }));
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
