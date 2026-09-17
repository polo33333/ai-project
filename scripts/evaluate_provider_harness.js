'use strict';

// Use synthetic rows only. Never execute SQL against an instance database.
require('../tests/helpers/setup_isolated_data');
const fs = require('node:fs');
const path = require('node:path');
const AgentHarness = require('../src/backend/agent_core/harness/agent_harness');
const BaseTool = require('../src/backend/agent_core/tools/base_tool');
const ToolManager = require('../src/backend/agent_core/tools/tool_manager');
const providers = require('../src/backend/services/ai_provider_manager');
const { dispatchToProvider } = require('../src/backend/intelligent_core/adapters');
const security = require('../src/backend/intelligent_core/security_guard');
const fixture = require('../tests/fixtures/provider_raw_contract_chat.json');

async function main() {
  const liveIndex = process.argv.indexOf('--live');
  const liveId = liveIndex >= 0 ? process.argv[liveIndex + 1] : null;
  if (liveIndex >= 0 && !liveId) throw new Error('--live requires a provider id.');
  const provider = liveId
    ? JSON.parse(fs.readFileSync(path.join(__dirname, '../data/ai_providers.json'), 'utf8')).find(item => item.id === liveId)
    : { id: 'fixture-provider', name: 'Fixture', model: 'fixture', supportsToolCalling: true, executionClass: 'remote' };
  if (!provider) throw new Error('Provider not found.');
  providers.getProvidersForExecution = () => []; // No fallback to another live provider.
  const manager = new ToolManager();
  class FixtureSql extends BaseTool {
    constructor() { super({ name: 'execute_sql_query', description: 'Execute a SELECT against the synthetic contract dataset.',
      parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } }); }
    async run(args) {
      const validation = security.validateSqlQuery(args.sql);
      if (!validation.safe) throw new Error('Unsafe fixture SQL rejected.');
      return { sql: args.sql, rows: fixture.rows, rowCount: fixture.rows.length };
    }
  }
  manager.registerTool(new FixtureSql());
  const responses = [fixture.response,
    { tool_calls: [{ id: 'fixture-sql', type: 'function', function: { name: 'execute_sql_query', arguments: '{"sql":"SELECT ContractID, ContractNo FROM T_Contract"}' } }] },
    { content: 'Danh sách hợp đồng.' }];
  const errors = [];
  let replayed = false;
  const harness = new AgentHarness({ toolManager: manager, maxIterations: 4, maxRepairs: 2,
    dispatch: liveId ? async (...args) => {
      if (process.argv.includes('--replay-raw') && !replayed) { replayed = true; return fixture.response; }
      try { return await dispatchToProvider(...args); }
      catch (error) { errors.push({ status: error.status || null, type: error.name }); throw error; }
    } : async () => responses.shift() || fixture.response });
  const result = await harness.run({ userMessage: fixture.question, provider, enabledToolNames: ['execute_sql_query'],
    messages: [{ role: 'system', content: 'This is a synthetic test. Schema: T_Contract(ContractID int, ContractNo varchar). To list records use execute_sql_query. Do not invent records.' },
      { role: 'user', content: fixture.question }], context: { mode: 'data', requestPlan: fixture.plan } });
  const passed = result.trace.completionStatus === 'SUCCESS' && result.toolCalls.some(call => call.toolName === 'execute_sql_query' && call.success)
    && result.replyText.includes('HD-TEST-001') && !result.replyText.includes('```sql');
  console.log(JSON.stringify({ live: Boolean(liveId), replayedRawResponse: replayed, model: provider.model, passed, completionStatus: result.trace.completionStatus,
    durationMs: result.trace.durationMs, budget: result.trace.executionBudget, failures: result.trace.training.responseEvaluation.failures,
    providerErrors: errors, steps: result.trace.steps.map(step => step.type) }, null, 2));
  if (!passed) process.exitCode = 1;
}
main().catch(error => { console.error(error.name === 'Error' ? 'Provider evaluation failed; check configuration.' : error.name); process.exitCode = 1; });
