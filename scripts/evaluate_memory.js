'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { routeMemory } = require('../src/backend/memory_core/memory_router');
const { MemoryService } = require('../src/backend/memory_core/memory_service');

const fixturePath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tests', 'fixtures', 'memory_conversation_cases.json'));
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const details = cases.map(item => {
  if (item.evaluation === 'context') {
    const store = { sessions: { eval: {
      id: 'eval', activeScope: item.activeScope || null, messages: item.messages || [], references: {}
    } } };
    const memory = new MemoryService({ store, save: () => {} });
    const actualContext = memory.getContext({ mode: 'recent', sessionId: 'eval', currentScope: item.currentScope, maxMessages: 20 })
      .map(message => message.content);
    return { name: item.name, evaluation: 'context', expectedContext: item.expectedContext,
      actualContext, passed: JSON.stringify(actualContext) === JSON.stringify(item.expectedContext) };
  }
  const decision = routeMemory({
    question: item.question,
    currentPlan: item.currentPlan,
    session: { id: `eval-${item.name}`, lastPlan: item.lastPlan, activeScope: item.activeScope || null,
      messages: item.messages || [], references: item.references || {} },
    now: item.now ? Date.parse(item.now) : Date.now()
  });
  const expectedReferenceType = Object.hasOwn(item, 'expectedReferenceType') ? item.expectedReferenceType : undefined;
  const actualReferenceType = decision.reference?.type || null;
  const referencePassed = expectedReferenceType === undefined || actualReferenceType === expectedReferenceType;
  const reasonPassed = !item.expectedReason || decision.reason === item.expectedReason;
  return { name: item.name, evaluation: 'route', expectedMode: item.expectedMode, actualMode: decision.mode,
    expectedReferenceType, actualReferenceType, reason: decision.reason,
    passed: decision.mode === item.expectedMode && referencePassed && reasonPassed };
});
const passed = details.filter(item => item.passed).length;
const labeledReferences = details.filter(item => item.expectedReferenceType !== undefined);
const wrongReferences = labeledReferences.filter(item => item.actualReferenceType
  && item.actualReferenceType !== item.expectedReferenceType).length;
const missingReferences = labeledReferences.filter(item => item.expectedReferenceType
  && !item.actualReferenceType).length;
process.stdout.write(`${JSON.stringify({ fixture: fixturePath, cases: details.length, passed,
  recall: details.length ? passed / details.length : 0,
  wrongReferenceRate: labeledReferences.length ? wrongReferences / labeledReferences.length : 0,
  missingReferenceRate: labeledReferences.length ? missingReferences / labeledReferences.length : 0,
  details }, null, 2)}\n`);
if (passed !== details.length) process.exitCode = 1;
