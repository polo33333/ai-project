'use strict';
// Read-only evaluation of schema selection: runs the agent's search_schema tool on a golden set and reports
// whether the expected primary table is chosen first, whether it is selected at all, how many tables are
// selected and how large the model-facing schema copy is (token proxy).
// Usage: node scripts/evaluate_schema_selection.js [golden.json] [output.json]
const fs = require('node:fs');
const path = require('node:path');
const storage = require('../src/backend/storage');
storage.loadEnvironment();
const datasetPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tests', 'fixtures', 'schema_selection_golden.json'));

// Mirrors the reduced copy the governed harness sends to the model (guarded_agent_harness.js, search_schema branch).
function modelPayload(result) {
  const { compactAgentToolResult } = require('../src/backend/agent_core/harness/agent_context');
  return compactAgentToolResult('search_schema', { success: true, result: {
    contextRevision: result.contextRevision, metadataCacheHit: result.metadataCacheHit, mappedRelationships: result.mappedRelationships,
    tables: result.tables, selectedTables: result.selectedTables, dbSourceId: result.dbSourceId,
    relationships: result.schemaContext?.split('Relationships:')[1]?.split('Auto-enrichment requirement:')[0],
    enrichmentRequirement: result.schemaContext?.split('Auto-enrichment requirement:')[1]
  } }, 12000);
}

// `prepare` runs inside the storage scope before evaluation, e.g. to apply a proposed metadata change in memory.
async function main({ prepare } = {}) {
  const cases = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  await storage.bootstrapStorage();
  try {
    return await storage.run(async () => {
      if (prepare) await prepare();
      const tools = require('../src/backend/intelligent_core/tool_registry');
      const details = [];
      for (const item of cases) {
        const execution = await tools._searchSchema({ query: item.query, request: { operation: item.operation, attributes: [], presentation: 'table' } },
          { governedController: true, userMessage: item.query, conversationResolution: { operation: item.operation } });
        const selected = execution.result?.selectedTables || [];
        details.push({ query: item.query, expected: item.primary, primaryHit: selected[0] === item.primary, selectedHit: selected.includes(item.primary),
          tableCount: selected.length, payloadChars: execution.success ? modelPayload(execution.result).length : 0, selected });
      }
      const mean = key => details.reduce((sum, item) => sum + Number(item[key]), 0) / details.length;
      const report = { dataset: datasetPath, cases: details.length, primaryAt1: mean('primaryHit'), selectedRecall: mean('selectedHit'),
        avgTables: mean('tableCount'), avgPayloadChars: Math.round(mean('payloadChars')), details };
      if (process.argv[3]) fs.writeFileSync(path.resolve(process.argv[3]), JSON.stringify(report, null, 2));
      return report;
    }, { files: ['dictionary.json', 'domain_aliases.json', 'table_relationships.json', 'db_sources.json', 'glossary.json', 'library.json', 'logs.json'] });
  } finally { await storage.close(); }
}

function print(report) {
  const { details, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  for (const item of details.filter(entry => !entry.primaryHit)) console.log(`MISS ${item.expected} <- ${item.selected.join(', ')} | ${item.query}`);
}

if (require.main === module) {
  main().then(report => { print(report); process.exit(0); }).catch(error => { console.error(error.message); process.exit(1); });
}

module.exports = { main, print };
