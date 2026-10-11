'use strict';

// Explicit live check: uses the configured model and real Library files, with
// a fresh temporary conversation. It does not restart the app or reindex data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../src/backend/storage');

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Use --live to run six turns against the configured model and Library.');
  storage.loadEnvironment();
  await storage.bootstrapStorage();
  const sessionId = `document-followup-eval-${crypto.randomUUID()}`;
  let accountId, core, memory, library, expected;
  const report = { generatedAt: new Date().toISOString(), mode: 'live_core', turns: [] };
  const history = [];
  try {
    await storage.run(async () => {
      const StorageHelper = require('../src/backend/utils/storage_helper');
      const account = StorageHelper.loadJson('accounts.json', []).find(item => item.role === 'admin' && item.isActive !== false);
      if (!account) throw new Error('No active administrator is available for this local evaluation.');
      accountId = account.id;
      core = require('../src/backend/intelligent_core/core');
      memory = require('../src/backend/memory_core').memoryService;
      library = require('../src/backend/knowledge_core/services/library_service');
      const documents = library.getDocuments();
      const ipms = documents.find(item => /TPSOFT_HDSD_IPMS_APP/i.test(item.title));
      const smartca = documents.find(item => /Kich_ban_tich_hop_smartca/i.test(item.title));
      if (!ipms || !smartca) throw new Error('This six-turn corpus requires the IPMS and SmartCA Library documents.');
      expected = { ipms, smartca, ipmsPages: await library.getPageInfo(ipms.id), smartcaPages: await library.getPageInfo(smartca.id) };
      report.sources = [ipms, smartca].map(item => ({ id: item.id, title: item.title }));
    });
    const cases = [
      { question: 'Dựa trên kho tri thức, hướng dẫn tải và cài đặt ứng dụng IPMS theo tài liệu TPSOFT_HDSD_IPMS_APP__v1.0.docx.', document: expected.ipms },
      { question: 'tl trên có mấy trang?', document: expected.ipms, pages: expected.ipmsPages },
      { question: 'Trong tài liệu đó, cách đăng nhập ứng dụng IPMS như thế nào?', document: expected.ipms },
      { question: 'file đó bao nhiêu trang?', document: expected.ipms, pages: expected.ipmsPages },
      { question: `Theo kho tri thức, tóm tắt tài liệu ${expected.smartca.title} về tích hợp SmartCA.`, document: expected.smartca },
      { question: 'tl trên có bao nhiêu trang?', document: expected.smartca, pages: expected.smartcaPages }
    ];
    for (const [index, item] of cases.entries()) {
      console.log(`START ${index + 1}/6 ${item.question}`);
      const startedAt = Date.now();
      await storage.run(async () => {
        const result = await core.chat(item.question, { history: history.slice(-20), knowledgeSearchEnabled: true,
          knowledgeSourceIds: [], session: { id: sessionId, accountId }, permissions: ['knowledge:read'],
          signal: AbortSignal.timeout(120000) });
        const citations = result.citations || [];
        const passed = result.success === true && result.answerDisposition !== 'clarify'
          && (item.pages ? result.replyText?.includes(`${item.pages.pageCount} trang`)
            && citations.some(citation => citation.documentId === item.document.id)
            : citations.some(citation => citation.documentId === item.document.id));
        const turn = { turn: index + 1, question: item.question, passed, completionStatus: result.completionStatus,
          answerDisposition: result.answerDisposition || null, reply: result.replyText || result.error,
          citations: citations.map(({ documentId, title }) => ({ documentId, title })),
          resolution: result.contextSelection?.referenceResolution || null, routingSource: result.trace?.workflowRouting?.decisionSource,
          durationMs: Date.now() - startedAt };
        report.turns.push(turn);
        if (result.completionStatus === 'SUCCESS') {
          history.push({ role: 'user', content: item.question }, { role: 'assistant', content: result.replyText });
        }
        memory.persistSuccessfulExchange({ sessionId, accountId, question: item.question, reply: result.replyText,
          completionStatus: result.trace?.completionStatus, currentPlan: result.trace?.training?.plan,
          responseEvaluation: result.trace?.training?.responseEvaluation, toolCalls: result.toolCalls || [] });
        console.log(`${passed ? 'PASS' : 'FAIL'} ${index + 1}/6 ${JSON.stringify({ reply: turn.reply, citations: turn.citations, routing: turn.routingSource })}`);
      });
    }
  } finally {
    try {
      if (memory && accountId) await storage.run(() => memory.clearSession(sessionId, accountId));
    } finally { await storage.close(); }
    report.passed = report.turns.filter(turn => turn.passed).length;
    report.total = report.turns.length;
    const destination = path.resolve(__dirname, '../docs/reports/document_followups_live_111026.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
    console.log(`Report: ${destination} (${report.passed}/${report.total})`);
  }
  if (report.passed !== 6) process.exitCode = 1;
}

main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
