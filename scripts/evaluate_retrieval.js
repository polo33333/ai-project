const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
}

const storage = require('../src/backend/storage');
storage.loadEnvironment();
const datasetPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tests', 'fixtures', 'retrieval_golden.sample.json'));
const limit = Math.max(1, Number(process.argv[3] || 5));

async function main() {
  const retrievalService = require('../src/backend/knowledge_core/services/retrieval_service');
  const cases = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  if (!Array.isArray(cases) || !cases.length) throw new Error('RETRIEVAL_GOLDEN_FIXTURE_EMPTY');
  if (cases.some(item => !item.query || (item.expectedDocumentIds || []).some(id => /replace-with|placeholder/i.test(String(id))))) {
    throw new Error('RETRIEVAL_GOLDEN_FIXTURE_PLACEHOLDER');
  }
  let hits = 0;
  let reciprocalRank = 0;
  let documentRecall = 0;
  const details = [];
  for (const item of cases) {
    const { results, mode } = await retrievalService.search(item.query, { limit });
    const expected = new Set((item.expectedDocumentIds || []).map(String));
    const rank = results.findIndex(result => expected.has(String(result.payload?.documentId))) + 1;
    if (rank > 0) { hits++; reciprocalRank += 1 / rank; }
    const returned = new Set(results.map(result => String(result.payload?.documentId)));
    const matched = [...expected].filter(id => returned.has(id)).length;
    if (expected.size) documentRecall += matched / expected.size;
    details.push({ query: item.query, mode, rank: rank || null, returnedDocumentIds: results.map(result => result.payload?.documentId) });
  }
  const answerable = cases.filter(item => (item.expectedDocumentIds || []).length).length;
  const report = { dataset: datasetPath, cases: cases.length, limit,
    hitRateAtK: answerable ? hits / answerable : 0,
    documentRecallAtK: answerable ? documentRecall / answerable : 0,
    documentMrr: answerable ? reciprocalRank / answerable : 0, details };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (answerable && hits !== answerable) process.exitCode = 1;
}

(async()=>{
  await storage.bootstrapStorage();
  try{await storage.run(main);}finally{await storage.close();}
})().catch(error=>{console.error(error.code||error.message);process.exitCode=1;});
