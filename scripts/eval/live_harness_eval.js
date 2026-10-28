'use strict';

// Live harness evaluation against the configured provider and SQL source.
// Runs in-process with the same scopes the HTTP router builds (storage ->
// governance -> admin principal -> memory request view -> core.chat -> memory
// persistence). SQL sources are only read. Each case uses its own "eval-"
// chat session, so cases never share memory.
//
//   node scripts/eval/live_harness_eval.js --label v1 [--only id1,id2 | --set local] [--repeat 1] [--provider <providerId> | --provider local]
//
// --set names a case list in the fixture's "sets"; --provider local picks the
// active local (Ollama) provider, else the first configured one.
//
// The harness pipeline is chosen by HARNESS_PIPELINE (unset = current loop).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '../..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, list) =>
  value.startsWith('--') ? [...pairs, [value.slice(2), list[index + 1]?.startsWith('--') ? true : list[index + 1] ?? true]] : pairs, []));
const label = String(args.label || process.env.HARNESS_PIPELINE || 'v1');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/live_eval_cases.json'), 'utf8'));
if (args.set && !fixture.sets?.[args.set]) throw new Error(`Unknown case set: ${args.set}`);
const only = args.only ? new Set(String(args.only).split(',')) : args.set ? new Set(fixture.sets[args.set]) : null;
const cases = fixture.cases.filter(item => !only || only.has(item.id));

const digits = text => String(text).replace(/(\d)[.,\s](?=\d)/g, '$1');
const fold = text => String(text).normalize('NFC').toLocaleLowerCase('vi');
function matches(reply, item) {
  if (typeof item === 'string') return fold(reply).includes(fold(item));
  if (item.num !== undefined) return new RegExp(`(^|\\D)${item.num}(\\D|$)`).test(digits(reply));
  if (item.re) return new RegExp(item.re, 'iu').test(reply);
  if (item.today) {
    // The run date in the server's local time, in the forms answers use.
    const now = new Date(), day = now.getDate(), month = now.getMonth() + 1, year = now.getFullYear(), pad = value => String(value).padStart(2, '0');
    return new RegExp(`${pad(day)}/${pad(month)}/${year}|${day}/${month}/${year}|${year}-${pad(month)}-${pad(day)}|${day}\\s+tháng\\s+${month}(?!\\d)`, 'iu').test(reply);
  }
  return false;
}
function score(reply, testCase, tools = []) {
  const missing = (testCase.must || []).filter(item => !matches(reply, item));
  const forbidden = (testCase.mustNot || []).filter(item => matches(reply, item));
  const missingTools = (testCase.mustTools || []).filter(name => !(tools || []).includes(name));
  return { passed: !missing.length && !forbidden.length && !missingTools.length, missing, forbidden, ...(missingTools.length ? { missingTools } : {}) };
}

async function ask(storage, account, sessionId, question, history) {
  const governance = require(path.join(root, 'src/backend/governance/context'));
  return storage.run(() => governance.run(async () => {
    governance.setPrincipal({ subject: `account:${account.id}`, role: account.role, permissions: account.permissions,
      dataAccess: account.dataAccess, tenantId: account.tenantId, channel: 'chat' });
    governance.current().requestId = crypto.randomUUID();
    const { memoryService } = require(path.join(root, 'src/backend/memory'));
    const { core } = require(path.join(root, 'src/backend/assistant'));
    const session = memoryService.normalizeSessionId(sessionId);
    const requestMemory = memoryService.requestView({ sessionId: session, accountId: account.id, question, history });
    const started = Date.now();
    const result = await core.chat(question, { ...(args.provider ? { providerId: String(args.provider) } : {}), history, memoryService: requestMemory, useTools: true,
      knowledgeSearchEnabled: true, knowledgeSourceIds: [], permissions: account.role === 'admin' ? ['admin'] : account.permissions,
      session: { id: session, accountId: account.id, tenantId: account.tenantId } });
    const latencyMs = Date.now() - started;
    const persisted = requestMemory.persistSuccessfulExchange({ sessionId: session, accountId: account.id, question,
      reply: result.replyText, currentPlan: result.trace?.training?.plan, toolCalls: result.toolCalls || [],
      completionStatus: result.trace?.completionStatus, responseEvaluation: result.trace?.training?.responseEvaluation });
    if (persisted.persisted) requestMemory.commitRetry?.();
    else requestMemory.recordPendingTurn?.({ sessionId: session, accountId: account.id, question, currentPlan: result.trace?.training?.plan,
      completionStatus: result.trace?.completionStatus, responseEvaluation: result.trace?.training?.responseEvaluation });
    const steps = result.trace?.steps || [];
    const usage = steps.filter(step => step.type === 'MODEL_USAGE');
    return { reply: String(result.replyText || ''), latencyMs, status: result.trace?.completionStatus || (result.success === false ? 'ERROR' : null),
      ...(result.success === false ? { error: result.errorCode || result.error || 'ERROR' } : {}),
      stopReason: result.trace?.stopReason || null, modelCalls: result.trace?.executionBudget?.modelCalls ?? usage.length,
      inputTokens: usage.reduce((sum, step) => sum + (step.inputTokens || step.inputTokensEstimated || 0), 0),
      stages: usage.map(step => step.stage), sql: (result.toolCalls || []).filter(call => call.toolName === 'execute_sql_query').map(call => ({ ok: call.success, sql: call.args?.sql, error: call.error })),
      failures: result.trace?.training?.responseEvaluation?.failures || [],
      structuredCalls: usage.filter(step => step.structuredOutput).length,
      pipeline: result.trace?.pipeline || 'v1', tools: (result.toolCalls || []).filter(call => call.success).map(call => call.toolName),
      steps: steps.filter(step => /^V2_|^LOCAL_STRUCTURED_OUTPUT_FAILED$/.test(step.type)) };
  }), { independent: true });
}

// Remove everything this run created (--keep retains it). The server's
// automation worker finishes workflow runs started by the evaluation and then
// writes their result into the conversation memory, so wait for those runs
// first; deleting a session under a running worker causes DATA_CONFLICT.
async function cleanup(storage, runId) {
  const prefix = `eval-${runId}-`;
  const pool = storage.getPool();
  for (let waited = 0; waited < 120000; waited += 2000) {
    const active = (await pool.query(`SELECT count(*)::int AS n FROM app.automation_runs WHERE document->>'conversationId' LIKE $1
      AND document->>'status' IN ('READY', 'RUNNING')`, [`${prefix}%`])).rows[0].n;
    if (!active) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  await new Promise(resolve => setTimeout(resolve, 1500)); // deferred memory writes after a run commits
  await pool.query(`DELETE FROM app.automation_runs WHERE document->>'conversationId' LIKE $1`, [`${prefix}%`]);
  await storage.run(() => {
    const memory = storage.read('conversation_memory.json', { sessions: {} });
    storage.write('conversation_memory.json', { ...memory, sessions: Object.fromEntries(Object.entries(memory.sessions || {}).filter(([, session]) => !String(session.id).startsWith(prefix))) });
    storage.write('episodic_memory.json', storage.read('episodic_memory.json', []).filter(record => !String(record.sessionId || '').startsWith(prefix)));
  }, { files: ['conversation_memory.json', 'episodic_memory.json'] });
}

// A started workflow finishes before the next question, as it would for a
// user watching the chat. This process runs it (right after the turn, ahead of
// the server's one-second poll) so the code under evaluation also writes the
// workflow result into memory.
async function settleWorkflows(storage, sessionId) {
  const automation = require(path.join(root, 'src/backend/automation'));
  const pool = storage.getPool();
  for (let waited = 0; waited < 180000; waited += 1000) {
    await automation.runtime.tick();
    await Promise.all([...automation.runtime.jobs]);
    const active = (await pool.query(`SELECT count(*)::int AS n FROM app.automation_runs WHERE document->>'conversationId' = $1
      AND document->>'status' IN ('READY', 'RUNNING')`, [sessionId])).rows[0].n;
    if (!active) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  await new Promise(resolve => setTimeout(resolve, 1500)); // deferred memory write after the run commits
}

const quantile = (values, q) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null; };

(async () => {
  process.chdir(root);
  const storage = require(path.join(root, 'src/backend/storage'));
  storage.loadEnvironment();
  await storage.bootstrapStorage();
  const account = await storage.run(() => structuredClone(storage.read('accounts.json', []).find(item => item.role === 'admin' && item.isActive !== false)), { files: ['accounts.json'] });
  if (!account) throw new Error('No active admin account for evaluation.');
  if (args.provider === 'local') {
    const { isLocalProvider } = require(path.join(root, 'src/backend/agent/harness/provider_classifier'));
    const local = (await storage.run(() => storage.read('ai_providers.json', []), { files: ['ai_providers.json'] }))
      .filter(item => isLocalProvider(item) && item.status !== 'unconfigured').sort((a, b) => Number(Boolean(b.isActive)) - Number(Boolean(a.isActive)))[0];
    if (!local) throw new Error('No local provider configured.');
    args.provider = local.id;
    console.log(`Local provider: ${local.name} (${local.model})`);
  }
  const runId = `${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const results = [];
  for (const testCase of cases) {
    const sessionId = `eval-${runId}-${testCase.id}`;
    const history = [], turns = [];
    for (const question of testCase.turns) {
      let turn;
      try { turn = await ask(storage, account, sessionId, question, structuredClone(history)); }
      catch (error) { turn = { reply: '', error: error.code || error.message, stack: String(error.stack || '').split(/\r?\n/).slice(0, 6).join(' | '), latencyMs: null, modelCalls: null, inputTokens: null, status: 'EXCEPTION', failures: [] }; }
      turns.push({ question, ...turn });
      if ((turn.tools || []).some(name => ['run_workflow', 'resume_workflow'].includes(name))) await settleWorkflows(storage, sessionId);
      history.push({ role: 'user', content: question }, { role: 'assistant', content: turn.reply });
    }
    const final = turns.at(-1);
    const verdict = score(final.reply, testCase, final.tools);
    results.push({ id: testCase.id, group: testCase.group, ...verdict, turns });
    console.log(`${verdict.passed ? 'PASS' : 'FAIL'} ${testCase.id} | ${final.status} | calls ${turns.map(t => t.modelCalls).join('+')} | ${turns.map(t => t.latencyMs).join('+')}ms`
      + (verdict.passed ? '' : ` | missing ${JSON.stringify(verdict.missing)} forbidden ${JSON.stringify(verdict.forbidden)} tools ${JSON.stringify(verdict.missingTools || [])} | ${final.reply.replace(/\s+/g, ' ').slice(0, 140)}`));
  }
  const allTurns = results.flatMap(item => item.turns);
  const summary = { label, runId, providerId: args.provider || null, cases: results.length, passed: results.filter(item => item.passed).length,
    accuracy: results.length ? +(results.filter(item => item.passed).length / results.length).toFixed(3) : null,
    genericFailure: allTurns.filter(turn => /^Chưa thể hoàn tất/.test(turn.reply)).length,
    partial: allTurns.filter(turn => turn.status !== 'SUCCESS').length, turns: allTurns.length,
    modelCalls: { p50: quantile(allTurns.map(t => t.modelCalls), 0.5), p90: quantile(allTurns.map(t => t.modelCalls), 0.9), total: allTurns.reduce((s, t) => s + (t.modelCalls || 0), 0) },
    latencyMs: { p50: quantile(allTurns.map(t => t.latencyMs), 0.5), p90: quantile(allTurns.map(t => t.latencyMs), 0.9) },
    inputTokens: { p50: quantile(allTurns.map(t => t.inputTokens), 0.5), p90: quantile(allTurns.map(t => t.inputTokens), 0.9) },
    byGroup: Object.fromEntries([...new Set(results.map(item => item.group))].map(group => {
      const list = results.filter(item => item.group === group);
      return [group, `${list.filter(item => item.passed).length}/${list.length}`];
    })) };
  const outDir = path.join(root, 'artifacts', 'live-eval');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${runId}.json`), JSON.stringify({ summary, results }, null, 2));
  if (!args.keep) await cleanup(storage, runId);
  console.log(JSON.stringify(summary, null, 2));
  await storage.close();
})().catch(error => { console.error('EVAL_FAILED', error.code || '', error.message); process.exitCode = 1; });
