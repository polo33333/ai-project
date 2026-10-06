'use strict';
// Read real routing metadata; inference only, never execute SQL or workflows.
if (process.env.KNOWLEDGEHUB_TEST_ISOLATED !== '1') throw new Error('Preload tests/helpers/setup_isolated_data.js to isolate application services.');
const fs = require('node:fs');
const path = require('node:path');
const storage = require('../src/backend/storage');
storage.loadEnvironment();
const { createPool } = require('../src/backend/storage/postgres/pool');
const { PostgresRepository } = require('../src/backend/storage/postgres/repository');
const router = require('../src/backend/automation/chat_router'); const adapters=require('../src/backend/intelligent_core/adapters'); const original=adapters.dispatchToProvider; adapters.dispatchToProvider=async(...a)=>{const r=await original(...a); if(a[0].model.includes('gemini'))console.log('MODEL_OUTPUT',r.content); return r;};

async function main() {
  const pool = createPool({ runtime: true });
  let definitions, chatProvider;
  try {
    const records = (await pool.query('SELECT document FROM app.workflow_catalog')).rows.map(row => row.document);
    definitions = records.filter(record => record.enabled && record.published).flatMap(record => record.published.templates
      .filter(template => template.enabled !== false && !record.deletedTemplates?.[template.id])
      .map(template => ({ ...template, id: `${record.id}/${template.id}` })));
    const snapshot = await new PostgresRepository(pool).snapshot(['ai_providers.json']);
    chatProvider = snapshot.documents.get('ai_providers.json').find(provider => process.env.CHAT_ROUTING_EVAL_CHAT_MODEL
      ? provider.model === process.env.CHAT_ROUTING_EVAL_CHAT_MODEL : provider.isActive);
    if (!chatProvider) throw new Error('No active chat provider.');
  } finally { await pool.end(); }
  const localOnly = process.argv.includes('--local-only');
  process.env.CHAT_ROUTING_MODE = localOnly ? 'local_tev1' : 'auto';
  const contract = definitions.find(item => item.id === 'contract_lookup/contract_details');
  const employee = definitions.find(item => item.id === 'employee_lookup/employee_details');
  if (!contract || !employee) throw new Error('Both live lookup definitions are required.');
  const pending = { id: 'evaluation-pending', templateId: contract.id, definition: contract, status: 'WAITING_INPUT',
    input: {}, missing: [{ key: 'query', ask: contract.inputs.query.ask }], invalid: [] };
  const electricity=definitions.find(d=>d.id.startsWith('electricity_sales')); const electricityPending={...pending,templateId:electricity.id,definition:electricity,missing:Object.entries(electricity.inputs).map(([key,v])=>({key,ask:v.ask})),input:{}}; const cases=[['chi tiết kh',electricityPending,'chat',null,{}]];
  const results = [];
  for (const [question, current, route, workflowId, inputs] of cases) {
    const context = router.createRoutingContext({ chatProviderSnapshot: chatProvider });
    const history = [{ role: 'user', content: 'ds hđ' }, { role: 'assistant', content: 'old result table '.repeat(4000) }];
    try {
      const decision = await router.decide(question, definitions, current, { routingContext: context, history });
      const passed = decision.route === route && decision.workflowId === workflowId && JSON.stringify(decision.inputs) === JSON.stringify(inputs)
        && (!current || question !== 'HD001' || decision.inputDisposition === 'slot_answer');
      results.push({ question, pending: Boolean(current), passed, decision, trace: context.trace });
      console.log(JSON.stringify({ question, pending: Boolean(current), passed, route: decision.route,
        workflowId: decision.workflowId, decisionSource: context.trace.decisionSource, escalationReason: context.trace.escalationReason }));
    } catch (error) {
      results.push({ question, pending: Boolean(current), passed: false, errorCode: error.code, message: error.message, trace: context.trace });
      console.log(JSON.stringify({ question, errorCode: error.code, message: error.message }));
    }
  }
  const report = { mode: process.env.CHAT_ROUTING_MODE, chatModel: chatProvider.model,
    passed: results.filter(item => item.passed).length, total: results.length,
    directTev1: results.filter(item => item.passed && item.trace.decisionSource === 'local_tev1').length, results };
  const destination = path.resolve(__dirname, `../artifacts/customer-routing-repro-${localOnly ? 'local' : 'auto'}.json`);
  fs.writeFileSync(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, total: report.total, directTev1: report.directTev1, chatModel: report.chatModel }));
  if (report.passed !== report.total) process.exitCode = 1;
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
