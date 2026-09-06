'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeAssistantResponse } = require('../src/backend/agent_core/harness/tool_call_normalizer');

const fixturePath = path.join(__dirname, '../tests/fixtures/local_model_cases.json');
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
let passed = 0;
for (const item of cases) {
  const normalized = normalizeAssistantResponse({ content: item.content });
  const ok = normalized.kind === item.expectedKind
    && (!item.expectedTool || normalized.calls[0]?.name === item.expectedTool);
  if (ok) passed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${item.name}`);
}
console.log(`\nLocal harness format score: ${passed}/${cases.length}`);
process.exitCode = passed === cases.length ? 0 : 1;
