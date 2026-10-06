'use strict';

// Uses synthetic routing requests only. No SQL, workflow execution or writes
// to application data. Run with tests/helpers/setup_isolated_data.js preloaded.
if (process.env.KNOWLEDGEHUB_TEST_ISOLATED !== '1') {
  throw new Error('Run: node --require ./tests/helpers/setup_isolated_data.js scripts/evaluate_chat_routing.js');
}
const fs = require('node:fs');
const path = require('node:path');
const router = require('../src/backend/automation/chat_router');
process.env.CHAT_ROUTING_MODE = process.env.CHAT_ROUTING_EVAL_MODE || 'local_tev1';
process.env.CHAT_ROUTING_LOCAL_MODEL ||= 'tev1:4b';
process.env.CHAT_ROUTING_LOCAL_BASE_URL ||= 'http://127.0.0.1:11434';
const slot = { required: true, label: 'Mã hợp đồng', ask: 'Bạn cần tra cứu mã hợp đồng nào?', schema: { type: 'string', minLength: 1, maxLength: 30 } };
const definitions = [
  { id: 'contracts/detail', name: 'Tra cứu hợp đồng', description: 'Tra cứu chi tiết một hợp đồng theo mã hợp đồng.', inputs: { code: slot }, examples: ['Tra cứu hợp đồng HD001'] },
  { id: 'employees/detail', name: 'Tra cứu nhân viên', description: 'Tra cứu chi tiết nhân viên theo mã nhân viên.', inputs: { code: { ...slot, label: 'Mã nhân viên', ask: 'Mã nhân viên nào?' } } },
  { id: 'contracts/revenue', name: 'Báo cáo doanh thu hợp đồng', description: 'Tổng hợp doanh thu hợp đồng theo tháng.', inputs: {}, examples: ['Báo cáo doanh thu hợp đồng'], instructions: 'Dùng tháng hiện tại nếu không chỉ định kỳ.' }
];
const pending = { id: 'eval-pending', templateId: definitions[0].id, definition: definitions[0], status: 'WAITING_INPUT',
  input: {}, missing: [{ key: 'code', label: slot.label, ask: slot.ask, schema: slot.schema }], invalid: [] };
const cases = [
  { question: 'Xin chào', route: 'chat' },
  { question: 'Hợp đồng là gì?', route: 'chat' },
  { question: 'Viết giúp tôi bài thơ về mùa thu', route: 'chat' },
  { question: 'Tra cứu hợp đồng', route: 'workflow', workflowId: 'contracts/detail', inputs: {} },
  { question: 'Tra cứu hợp đồng HD001', route: 'workflow', workflowId: 'contracts/detail', inputs: { code: 'HD001' } },
  { question: 'Danh sách tất cả hợp đồng', route: 'chat' },
  { question: 'ds nv', route: 'chat' },
  { question: 'Không tra cứu hợp đồng, giải thích giúp tôi hợp đồng là gì', route: 'chat' },
  { question: 'Báo cáo doanh thu hợp đồng', route: 'workflow', workflowId: 'contracts/revenue' },
  { question: 'HD002', current: pending, route: 'workflow', inputDisposition: 'slot_answer', inputs: { code: 'HD002' } },
  { question: 'Hướng dẫn sử dụng Excel', current: pending, route: 'chat' },
  { question: 'Tra cứu nhân viên NV003', current: pending, route: 'workflow', workflowId: 'employees/detail', inputDisposition: 'new_request', inputs: { code: 'NV003' } },
  { question: 'Hủy tác vụ đang chờ', current: pending, route: 'workflow', cancelPending: true },
  { question: 'Tra cứu hồ sơ', route: 'unclear' }
];

async function main() {
  const results = [];
  const selectedCases = process.env.CHAT_ROUTING_EVAL_CASES?.split(',').map(Number);
  for (const [index, item] of cases.entries()) {
    if (selectedCases && !selectedCases.includes(index)) continue;
    const context = router.createRoutingContext({ chatProviderSnapshot: {
      id: 'eval-chat', name: 'Evaluation only', model: process.env.CHAT_ROUTING_EVAL_CHAT_MODEL || process.env.CHAT_ROUTING_LOCAL_MODEL,
      type: 'local', apiFormat: 'ollama', executionClass: 'local', baseUrl: process.env.CHAT_ROUTING_LOCAL_BASE_URL
    } });
    const started = Date.now();
    try {
      const output = await router.decide(item.question, definitions, item.current || null, { routingContext: context });
      const mismatches = ['route', 'workflowId', 'inputDisposition', 'cancelPending'].filter(key => Object.hasOwn(item, key) && item[key] !== output[key]);
      if (item.inputs && JSON.stringify(item.inputs) !== JSON.stringify(output.inputs)) mismatches.push('inputs');
      const record = { question: item.question, passed: !mismatches.length, mismatches, output, trace: context.trace };
      results.push(record);
      console.log(`${record.passed ? 'PASS' : 'FAIL'} ${item.question} (${Date.now() - started}ms)${mismatches.length ? `: ${mismatches.join(', ')}` : ''}`);
    } catch (error) {
      results.push({ question: item.question, passed: false, errorCode: error.code, error: error.message, trace: context.trace });
      console.log(`FAIL ${item.question}: ${error.code || error.name} (${Date.now() - started}ms)`);
    }
  }
  const report = { mode: process.env.CHAT_ROUTING_MODE, model: process.env.CHAT_ROUTING_LOCAL_MODEL,
    chatModel: process.env.CHAT_ROUTING_EVAL_CHAT_MODEL || process.env.CHAT_ROUTING_LOCAL_MODEL, timeoutMs: router.configuration().timeoutMs,
    evaluatedAt: new Date().toISOString(), passed: results.filter(item => item.passed).length, total: results.length, results };
  const destination = path.resolve(__dirname, process.env.CHAT_ROUTING_MODE === 'local_tev1'
    ? '../artifacts/chat-routing-evaluation.json' : `../artifacts/chat-routing-evaluation-${process.env.CHAT_ROUTING_MODE}.json`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.passed}/${report.total} cases passed. Report: ${destination}`);
  if (report.passed !== report.total) process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
