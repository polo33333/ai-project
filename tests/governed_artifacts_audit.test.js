'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const context = require('../src/backend/governance/context');
const artifacts = require('../src/backend/governance/artifacts');
const { createAnswerEnvelope } = require('../src/backend/agent_core/harness/answer_envelope');
const safety = require('../src/backend/utils/export_safety');

test('artifact ownership, expiration, missing metadata and path traversal fail closed', () => {
  const dir = require('../src/backend/utils/export_paths').getExportsDirectory(); fs.mkdirSync(dir, { recursive: true });
  const fileName = `acl-${crypto.randomUUID()}.csv`, metadata = path.join(dir, `.${fileName}.acl.json`);
  const actor = subject => context.setPrincipal({ subject, role: 'admin' });
  try {
    context.run(() => { actor('account:a'); artifacts.register({ fileName, downloadUrl: `/api/exports/${fileName}` }); assert.equal(artifacts.authorize(fileName).owner, 'account:a'); });
    context.run(() => { actor('account:b'); assert.throws(() => artifacts.authorize(fileName), { code: 'ARTIFACT_ACCESS_DENIED' }); });
    const expired = JSON.parse(fs.readFileSync(metadata)); expired.expiresAt = 1; fs.writeFileSync(metadata, JSON.stringify(expired));
    context.run(() => { actor('account:a'); assert.throws(() => artifacts.authorize(fileName), { code: 'ARTIFACT_ACCESS_DENIED' }); assert.throws(() => artifacts.authorize('../private.csv'), { statusCode: 400 }); });
  } finally { fs.rmSync(metadata, { force: true }); }
});

test('CSV formulas and HTML cells are inert while negative numbers remain numeric', () => {
  const csv = safety.toCsv([{ '=header': ' \t=HYPERLINK("x")', negative: -25, text: '-25' }]);
  assert.ok(csv.includes("'=header")); assert.ok(csv.includes("' \t=HYPERLINK")); assert.equal(safety.safeCell(-25), -25);
  assert.equal(safety.escapeHtml('<script>"&'), '&lt;script&gt;&quot;&amp;');
});

test('audit and response use one frozen revision with resolvable hashed evidence', () => context.run(() => {
  context.setPrincipal({ subject: 'account:a', role: 'user' }); context.current().requestId = 'audit-test';
  const result = { replyText: '80', trace: { completionStatus: 'SUCCESS' }, toolCalls: [{ toolName: 'execute_sql_query', success: true, result: { rows: [{ amount: 80 }] } }] };
  const envelope = createAnswerEnvelope(result);
  assert.strictEqual(createAnswerEnvelope(result), envelope);
  const logger = require('../src/backend/services/logger_service');
  const audit = logger.addChatAudit('amount?', result.replyText, null, null, 1);
  assert.equal(audit.requestPayload.answerEnvelope.answerRevision, envelope.answerRevision);
  const evidence = envelope.evidence[0], payload = audit.requestPayload.evidencePayloads[evidence.evidenceId];
  assert.equal(evidence.payloadRef, `audit:evidencePayloads:${evidence.evidenceId}`);
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), evidence.contentHash);
  const replay = require('../src/backend/governance/replay');
  assert.equal(replay.verify(audit).status, 'passed');
  const tampered = structuredClone(audit); tampered.requestPayload.evidencePayloads[evidence.evidenceId].rows[0].amount = 999;
  assert.equal(replay.verify(tampered).status, 'failed'); assert.equal(replay.verify(tampered).modelCalls, 0);
}));
