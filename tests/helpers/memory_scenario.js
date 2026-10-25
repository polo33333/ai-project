'use strict';
// A fixed conversation driven through MemoryService's public API. It records
// what every reader of conversation state sees after each step, with times and
// generated IDs replaced, so a change in how state is stored can be checked
// against the previous behaviour.
const { MemoryService } = require('../../src/backend/memory_core/memory_service');

const sql = (rows, sqlText = 'SELECT CustomerCode, CustomerName FROM M_Customer') => ({ toolName: 'execute_sql_query', success: true,
  args: { sql: sqlText }, result: { sql: sqlText, rows, rowCount: rows.length } });

function normalize(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (key === 'referenceCutoff' && typeof item === 'number') return item ? '<time>' : 0;
    if (typeof item !== 'string') return item;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item)) return '<id>';
    // Times also appear inside serialized state in system messages.
    return item.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, '<time>');
  }));
}

function observe(memory, label) {
  const session = memory.getSession('s1', false, 'a1');
  const plan = { table: 'M_Customer', dbSourceId: 'db', intent: 'list' };
  const decision = memory.route({ sessionId: 's1', accountId: 'a1', question: 'thêm cột tên cho ds trên', currentPlan: plan });
  const resolution = memory.getResolutionContext(decision, plan);
  return normalize({ label,
    state: session ? Object.fromEntries(['lastPlan', 'references', 'entityReferences', 'conversationState', 'businessState',
      'lastWorkflowRun', 'activeScope', 'summary', 'pendingTurn'].map(field => [field, session[field] ?? null])) : null,
    decision: { ...decision, fallbackHistory: undefined },
    context: memory.getContext(decision),
    resolution: { ...resolution, turns: resolution.turns?.map(turn => ({ question: turn.question, status: turn.status, workflow: turn.workflow || null })) },
    agentState: memory.getAgentState(decision, plan) });
}

// Production settings (.env): pending turns and summaries are on.
function run() {
  const saved = { pending: process.env.MEMORY_PENDING_TURN_ENABLED, summary: process.env.MEMORY_SUMMARY_ENABLED };
  process.env.MEMORY_PENDING_TURN_ENABLED = 'true'; process.env.MEMORY_SUMMARY_ENABLED = 'true';
  try { return steps(); }
  finally {
    for (const [key, name] of [['pending', 'MEMORY_PENDING_TURN_ENABLED'], ['summary', 'MEMORY_SUMMARY_ENABLED']])
      if (saved[key] === undefined) delete process.env[name]; else process.env[name] = saved[key];
  }
}

function steps() {
  const memory = new MemoryService({ store: { sessions: {} }, save() {} });
  const steps = [];
  const plan = { table: 'M_Customer', dbSourceId: 'db', intent: 'list', metric: null,
    conversationState: { operation: 'list', cardinality: 'collection', requestedAttributes: ['CustomerCode'] } };
  memory.persistSuccessfulExchange({ sessionId: 's1', accountId: 'a1', question: 'danh sách khách hàng', reply: 'Có 2 khách hàng.',
    currentPlan: plan, toolCalls: [sql([{ CustomerCode: 'KA0021', CustomerName: 'A' }, { CustomerCode: 'DC6011', CustomerName: 'B' }])],
    completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] } });
  steps.push(observe(memory, 'after a successful list'));

  const failed = memory.persistSuccessfulExchange({ sessionId: 's1', accountId: 'a1', question: 'thêm cột địa chỉ', reply: 'Chưa xác định.',
    currentPlan: { ...plan, followupScope: { table: 'M_Customer', dbSourceId: 'db', datasets: [{ scope: 'x' }] } }, toolCalls: [],
    completionStatus: 'PARTIAL', responseEvaluation: { valid: false, failures: ['MISSING_SQL'] } });
  memory.recordPendingTurn({ sessionId: 's1', accountId: 'a1', question: 'thêm cột địa chỉ', currentPlan: { ...plan, followupScope: null },
    completionStatus: 'PARTIAL', responseEvaluation: { valid: false, failures: ['MISSING_SQL'] } });
  steps.push({ ...observe(memory, 'after a partial turn'), persisted: failed.persisted });

  memory.persistSuccessfulExchange({ sessionId: 's1', accountId: 'a1', question: 'báo cáo sản lượng 2 tháng', reply: 'Đang chạy quy trình.',
    currentPlan: { table: 'T_Output', dbSourceId: 'db', intent: 'workflow' }, toolCalls: [{ toolName: 'run_workflow', success: true, result: { runId: 'run-1' } }],
    completionStatus: 'PARTIAL', responseEvaluation: { valid: false, failures: ['WORKFLOW_HANDOFF'] } });
  memory.persistWorkflowExchange({ sessionId: 's1', accountId: 'a1', rows: [{ Thang: '2024-01', SanLuong: 10 }, { Thang: '2024-02', SanLuong: 12 }],
    workflow: { runId: 'run-1', templateId: 'report', name: 'Báo cáo', inputs: { months: 2 }, table: 'T_Output', dbSourceId: 'db',
      updatedAt: new Date().toISOString(), datasets: [{ field: 'rows', columns: ['Thang', 'SanLuong'], rowCount: 2, preview: [{ Thang: '2024-01', SanLuong: 10 }] }] } });
  steps.push(observe(memory, 'after a finished workflow'));

  memory.persistSuccessfulExchange({ sessionId: 's1', accountId: 'a1', question: 'thông tin khách hàng KA0021', reply: 'KA0021 là A.',
    currentPlan: { table: 'M_Customer', dbSourceId: 'db', intent: 'record_lookup' }, toolCalls: [sql([{ CustomerCode: 'KA0021', CustomerName: 'A' }])],
    completionStatus: 'SUCCESS', responseEvaluation: { valid: true, failures: [] } });
  steps.push(observe(memory, 'after a single-record lookup'));

  // A reload: the store goes through JSON, as it does in PostgreSQL or the JSON file.
  const reloaded = new MemoryService({ store: JSON.parse(JSON.stringify(memory.store)), save() {} });
  steps.push(observe(reloaded, 'after a reload'));
  return steps;
}

module.exports = { run, normalize };
