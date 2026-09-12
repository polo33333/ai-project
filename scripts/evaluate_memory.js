'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { routeMemory } = require('../src/backend/memory_core/memory_router');

const fixturePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tests', 'fixtures', 'memory_conversation_cases.json'));
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const details = cases.map(item => {
  const decision = routeMemory({
    question: item.question,
    currentPlan: item.currentPlan,
    session: { id: `eval-${item.name}`, lastPlan: item.lastPlan, references: item.references || {} }
  });
  return { name: item.name, expectedMode: item.expectedMode, actualMode: decision.mode, reason: decision.reason, passed: decision.mode === item.expectedMode };
});
const passed = details.filter(item => item.passed).length;
process.stdout.write(`${JSON.stringify({ fixture: fixturePath, cases: details.length, passed, recall: details.length ? passed / details.length : 0, details }, null, 2)}\n`);
if (passed !== details.length) process.exitCode = 1;
