const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('swapping workflow steps exchanges only the two nodes and preserves their configuration', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/workflow_plugins.js'), 'utf8');
  const context = {}; vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function moveWorkflowStep('), source.indexOf('  function editDialog(')), context);
  const moved = { id: 'a', config: { mapping: { value: 1 } }, ui: { backgroundColor: '#112233' } };
  const steps = [moved, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.equal(context.moveWorkflowStep(steps, 0, 3), true);
  assert.deepEqual(steps.map(step => step.id), ['d', 'b', 'c', 'a']);
  assert.equal(steps[3], moved);
  assert.equal(context.moveWorkflowStep(steps, 3, 1), true);
  assert.deepEqual(steps.map(step => step.id), ['d', 'a', 'c', 'b']);
  assert.equal(context.moveWorkflowStep(steps, 1, 1), false);
  assert.equal(context.moveWorkflowStep(steps, -1, 2), false);
  assert.equal(context.moveWorkflowStep(steps, 0, 4), false);
  assert.equal(steps[1].ui.backgroundColor, '#112233');
});

test('pipeline connects adjacent cards across rows and redraws after resizing', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/workflow_plugins.js'), 'utf8');
  const element = () => ({ children: [], attributes: {}, classList: { add() {} }, setAttribute(key, value) { this.attributes[key] = value; }, replaceChildren() { this.children = []; }, append(...items) { this.children.push(...items); } });
  let resize, pending, disconnected = false;
  let rectangles = [
    { left: 0, right: 240, top: 0, bottom: 80, height: 80 },
    { left: 264, right: 504, top: 0, bottom: 80, height: 80 },
    { left: 0, right: 240, top: 104, bottom: 184, height: 80 }
  ];
  const pipeline = { prepend(svg) { this.svg = svg; }, getBoundingClientRect() { return { left: 0, top: 0, width: 530, height: 184 }; }, querySelectorAll() { return rectangles.map(rect => ({ getBoundingClientRect: () => rect })); } };
  const context = { document: { createElementNS: element }, requestAnimationFrame(callback) { pending = callback; return 1; }, cancelAnimationFrame() {}, ResizeObserver: class { constructor(callback) { resize = callback; } observe() {} disconnect() { disconnected = true; } } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  function pipelineConnectors('), source.indexOf('  function editDialog(')), context);
  const cleanup = context.pipelineConnectors(pipeline); pending();
  assert.equal(pipeline.svg.children.length, 4); // Two connections, no trailing arrow.
  assert.equal(pipeline.svg.children[0].attributes.d, 'M 248 40 C 252 40 252 40 256 40');
  assert.equal(pipeline.svg.children[2].attributes.d, 'M 384 80 V 80 Q 384 92 372 92 H 132 Q 120 92 120 104 V 104');
  rectangles = rectangles.map((rect, index) => ({ left: 0, right: 240, top: index * 104, bottom: index * 104 + 80, height: 80 }));
  resize(); pending();
  assert.equal(pipeline.svg.children[0].attributes.d, 'M 120 80 V 104');
  cleanup(); assert.equal(disconnected, true);
});
