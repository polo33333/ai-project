'use strict';
// The agent loop's backend-planned calls and follow-up scope projection return
// their decision to the loop instead of setting loop variables; these pin the
// branches that the end-to-end harness tests do not reach.
const test = require('node:test');
const assert = require('node:assert/strict');
const { planBackendResponse, projectFollowupScope } = require('../src/backend/agent/harness/steps/loop/backend_calls');
const resultScope = require('../src/backend/memory/result_scope');
const workflowPreference = require('../src/backend/memory/workflow_preference');

const state = (plan = {}, extra = {}) => ({ plan, context: {}, toolContext: {}, toolCalls: [], conversation: [],
  trace: { iterations: 1, steps: [] }, check() {}, ...extra });
const sqlCall = [{ id: 'model-1', name: 'execute_sql_query', arguments: { sql: 'SELECT Name FROM Customer' } }];

test('a follow-up SQL that cannot keep the previous scope asks once for a repair, then answers', t => {
  t.mock.method(resultScope, 'project', () => { throw Object.assign(new Error('no'), { code: 'FOLLOWUP_SCOPE_UNSUPPORTED' }); });
  const s = state({ followupScope: { datasets: [] } });
  assert.deepEqual(projectFollowupScope(s, sqlCall, {}), { retry: true });
  assert.equal(s.conversation.length, 1);
  const second = projectFollowupScope(s, sqlCall, {});
  assert.match(second.reply, /giữ nguyên phạm vi/);
  assert.equal(s.plan.memoryUnresolved, true);
  assert.deepEqual(s.trace.steps.map(step => step.type), ['FOLLOWUP_SCOPE_REJECTED', 'FOLLOWUP_SCOPE_REJECTED']);
});

test('a follow-up SQL is projected onto the scoped groups and marked backend-generated', t => {
  t.mock.method(resultScope, 'project', () => [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }]);
  const s = state({ followupScope: { datasets: [] } }), response = {};
  const { calls } = projectFollowupScope(s, sqlCall, response);
  assert.deepEqual(calls.map(call => call.id), ['semantic-group-0', 'semantic-group-1']);
  assert.equal(response.backendGenerated, true);
  assert.deepEqual(projectFollowupScope(state(), sqlCall, {}), { calls: sqlCall });
});

test('pending workflow input resumes the run before any other planned call', async t => {
  t.mock.method(workflowPreference, 'choose', async () => ({ inputs: { month: '02/2024' } }));
  const s = state({ pendingSchemaRoot: 'Invoice' }, { pendingInput: { runId: 'r1', revision: 3 } });
  const response = await planBackendResponse(s, []);
  assert.equal(response.tool_calls[0].function.name, 'resume_workflow');
  assert.deepEqual(JSON.parse(response.tool_calls[0].function.arguments), { runId: 'r1', revision: 3, inputs: { month: '02/2024' } });
  assert.equal(s.plan.pendingSchemaRoot, 'Invoice');
});

test('a missing primary table is recovered by schema search, otherwise the model decides', async t => {
  t.mock.method(workflowPreference, 'choose', async () => null);
  const s = state({ pendingSchemaRoot: 'Invoice', semanticIntent: 'x' }, { pendingInput: { runId: 'r1' } });
  const response = await planBackendResponse(s, []);
  assert.equal(response.tool_calls[0].function.name, 'search_schema');
  assert.equal(s.plan.pendingSchemaRoot, undefined);
  assert.equal(await planBackendResponse(s, []), null);
});
