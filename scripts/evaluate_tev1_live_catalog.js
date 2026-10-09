'use strict';
// Read real routing metadata; inference only, never execute SQL or workflows.
if (process.env.KNOWLEDGEHUB_TEST_ISOLATED !== '1') throw new Error('Preload tests/helpers/setup_isolated_data.js to isolate application services.');
const fs = require('node:fs');
const path = require('node:path');
const storage = require('../src/backend/storage');
storage.loadEnvironment();
const { createPool } = require('../src/backend/storage/postgres/pool');
const { PostgresRepository } = require('../src/backend/storage/postgres/repository');
const router = require('../src/backend/automation/chat_router');

async function main() {
  const pool = createPool({ runtime: true });
  let definitions, chatProvider;
  try {
    const records = (await pool.query('SELECT document FROM app.workflow_catalog')).rows.map(row => row.document);
    definitions = records.filter(record => record.enabled && record.published).flatMap(record => record.published.templates
      .filter(template => template.enabled !== false && !record.deletedTemplates?.[template.id])
      .map(template => ({ ...template, id: `${record.id}/${template.id}`, packageVersion: record.published.manifest.version,
        definitionHash: require('../src/backend/automation/contract').hash(template), domain: template.domain || record.published.manifest.domain || '' })));
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
  const electricity = definitions.find(item => item.id === 'electricity_sales/last_seven_months');
  if (!electricity) throw new Error('Live electricity report definition is required.');
  const cases = process.argv.includes('--greetings') ? [
    ['hi', null, 'chat', null, {}, true],
    ['hello', null, 'chat', null, {}, true],
    ['xin chào', null, 'chat', null, {}, true],
    ['chào bạn', pending, 'chat', null, {}, true],
    ['hello, thông tin chi tiết nhân viên', null, 'workflow', employee.id, {}, false],
    ['xin chào, chi tiết sản lượng điện', null, 'workflow', electricity.id, {}, false],
    ['hợp đồng là gì?', null, 'chat', null, {}, false]
  ] : [
    ['chi tiết sản lượng điện', null, 'workflow', electricity.id, {}],
    ['sản lượng điện', null, 'workflow', electricity.id, {}],
    ['chi tiết sản lượng điện', pending, 'workflow', electricity.id, {}],
    ['chi tiết hđ', null, 'workflow', contract.id, {}],
    ['thông tin chi tiết nv', null, 'workflow', employee.id, {}],
    ['thông tin chi tiết hợp đồng', null, 'workflow', contract.id, {}],
    ['chi tiết hđ', pending, 'workflow', contract.id, {}],
    ['thông tin chi tiết nv', pending, 'workflow', employee.id, {}],
    ['HD001', pending, 'workflow', contract.id, { query: 'HD001' }],
    ['ds tất cả nv', null, 'chat', null, {}],
    ['danh sách toàn bộ hợp đồng', null, 'chat', null, {}]
  ];
  const results = [];
  for (const [question, current, route, workflowId, inputs, quickGreeting] of cases) {
    const context = router.createRoutingContext({ chatProviderSnapshot: chatProvider });
    const history = [{ role: 'user', content: 'ds hđ' }, { role: 'assistant', content: 'old result table '.repeat(4000) }];
    try {
      const decision = await router.decide(question, definitions, current, { routingContext: context, history });
      const passed = decision.route === route && decision.workflowId === workflowId && JSON.stringify(decision.inputs) === JSON.stringify(inputs)
        && (!current || question !== 'HD001' || decision.inputDisposition === 'slot_answer')
        && (quickGreeting === undefined || Boolean(decision.quickGreeting) === quickGreeting);
      results.push({ question, pending: Boolean(current), passed, decision, trace: context.trace });
      console.log(JSON.stringify({ question, pending: Boolean(current), passed, route: decision.route,
        workflowId: decision.workflowId, quickGreeting: Boolean(decision.quickGreeting), decisionSource: context.trace.decisionSource, escalationReason: context.trace.escalationReason }));
    } catch (error) {
      results.push({ question, pending: Boolean(current), passed: false, errorCode: error.code, message: error.message, trace: context.trace });
      console.log(JSON.stringify({ question, errorCode: error.code, message: error.message }));
    }
  }
  const report = { mode: process.env.CHAT_ROUTING_MODE, chatModel: chatProvider.model,
    passed: results.filter(item => item.passed).length, total: results.length,
    directTev1: results.filter(item => item.passed && item.trace.decisionSource === 'local_tev1').length, results };
  const destination = path.resolve(__dirname, `../artifacts/tev1-live-catalog-${process.env.CHAT_ROUTING_RETRIEVAL_MODE === 'on' ? 'retrieval-' : ''}${process.argv.includes('--greetings') ? 'greetings-' : ''}${localOnly ? 'local' : 'auto'}.json`);
  fs.writeFileSync(destination, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, total: report.total, directTev1: report.directTev1, chatModel: report.chatModel }));
  if (report.passed !== report.total) process.exitCode = 1;
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
