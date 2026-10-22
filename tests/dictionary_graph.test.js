'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('crossing masks use pill outlines and exclude both relationship endpoints', () => {
  const context = vm.createContext({ window: { addEventListener() {} }, document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/dictionary-graph.js'), 'utf8'), context);
  const markup = vm.runInContext(`dictionaryGraphCrossingRects([{name:'A',x:0,y:0,width:196,height:64},{name:'B',x:220,y:0,width:196,height:64},{name:'C',x:440,y:0,width:196,height:64}], 'A', 'C')`, context);
  assert.equal(markup, '<rect x="220" y="0" width="196" height="64" rx="32"></rect>');
  assert.equal(vm.runInContext(`dictionaryGraphCrossingRects([{name:'A'},{name:'C'}], 'A', 'C')`, context), '');
});

test('mapping badges avoid nodes, earlier labels and canvas edges', () => {
  const context = vm.createContext({ window: { addEventListener() {} }, document: { addEventListener() {} } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/dictionary-graph.js'), 'utf8'), context);
  const occupied = [{ x: 150, y: 100, width: 196, height: 64 }];
  context.occupied = occupied;
  const box = vm.runInContext('findDictionaryGraphLabelPosition({x:240,y:140},180,30,{width:800,height:500},occupied)', context);
  assert.ok(box.y + box.height + 5 <= 100 || box.y >= 169 || box.x + box.width + 5 <= 150 || box.x >= 351);
  occupied.push(box);
  const next = vm.runInContext('findDictionaryGraphLabelPosition({x:240,y:140},180,30,{width:800,height:500},occupied)', context);
  assert.ok(next.y + next.height <= box.y || next.y >= box.y + box.height || next.x + next.width <= box.x || next.x >= box.x + box.width);
  assert.ok(next.x >= 8 && next.y >= 8 && next.x + next.width <= 792 && next.y + next.height <= 492);
});

test('fullscreen requests browser fullscreen and selecting a table keeps it open', async () => {
  const classes = new Set();
  let options;
  const panel = { classList: { contains: name => classes.has(name), toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } }, async requestFullscreen(value) { options = value; document.fullscreenElement = panel; } };
  const document = { addEventListener() {}, getElementById(id) { return id === 'dictionary-graph-panel' ? panel : null; } };
  const context = vm.createContext({ window: { addEventListener() {} }, document, requestAnimationFrame() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/dictionary-graph.js'), 'utf8'), context);
  vm.runInContext('focusDictionaryGraphTable = () => {}; openDictionaryDrawer = () => { throw new Error("must keep fullscreen"); };', context);
  await vm.runInContext('toggleDictionaryGraphFullscreen()', context);
  assert.equal(options.navigationUI, 'hide');
  assert.equal(document.fullscreenElement, panel);
  await vm.runInContext("selectDictionaryGraphTable('T_Revenue')", context);
  assert.equal(context.window.dictionaryGraphSelection, 'T_Revenue');
  vm.runInContext('closeDictionaryGraphMappings()', context);
  assert.equal(context.window.dictionaryGraphSelection, null);
  assert.equal(context.window.dictionaryGraphHover, null);
});

test('fullscreen falls back to an expanded panel when browser permission is unavailable', async () => {
  const classes = new Set();
  const panel = { classList: { contains: name => classes.has(name), toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } }, async requestFullscreen() { throw new Error('unavailable'); } };
  const attributes = {};
  const button = { setAttribute(name, value) { attributes[name] = value; } };
  const document = { addEventListener() {}, getElementById(id) { return id === 'dictionary-graph-panel' ? panel : id === 'dictionary-graph-fullscreen' ? button : null; } };
  const context = vm.createContext({ window: { addEventListener() {} }, document, requestAnimationFrame() {} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/dictionary-graph.js'), 'utf8'), context);
  await vm.runInContext('toggleDictionaryGraphFullscreen()', context);
  assert.ok(classes.has('is-fullscreen'));
  assert.equal(attributes['aria-pressed'], 'true');
  await vm.runInContext('toggleDictionaryGraphFullscreen()', context);
  assert.ok(!classes.has('is-fullscreen'));
  assert.equal(attributes['aria-pressed'], 'false');
});

test('cluster layout is stable and keeps pills apart', () => {
  const context = vm.createContext({ document: { addEventListener() {} }, window: { addEventListener() {} }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/dictionary-graph.js'), 'utf8'), context);
  const result = vm.runInContext(`buildDictionaryClusterLayout(Array.from({length:24}, (_,i) => ({tableName:'T'+i,domain:'domain'+Math.floor(i/8)})), [])`, context);
  const points = [...result.positions.values()];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    assert.ok(Math.abs(points[i].x - points[j].x) >= 196 || Math.abs(points[i].y - points[j].y) >= 64);
  }
  assert.equal(result.clusters.length, 3);
  assert.equal(vm.runInContext(`dictionaryGraphMappingLabel({columnPairs:[{sourceColumn:'TenantID',targetColumn:'TenantID'},{sourceColumn:'OwnerID',targetColumn:'EmployeeID'}]})`, context), 'TenantID → TenantID · OwnerID → EmployeeID');
  assert.equal(vm.runInContext(`dictionaryGraphMappingLabel({sourceColumn:'CustomerID',targetColumn:'ID'})`, context), 'CustomerID → ID');
});

test('dictionary overview graph only uses active verified relationships', () => {
  const window = { addEventListener() {} };
  const context = vm.createContext({ document: { addEventListener() {} }, window, console });
  const source = fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/dictionary-graph.js'), 'utf8');
  vm.runInContext(source, context);
  window.tableRelationshipsData = [
    { id: 'verified', status: 'verified', isActive: true },
    { id: 'suggested', status: 'suggested', isActive: true },
    { id: 'rejected', status: 'rejected', isActive: true },
    { id: 'disabled', status: 'verified', isActive: false }
  ];
  assert.equal(vm.runInContext('getVerifiedDictionaryGraphRelationships().length', context), 1);
  assert.equal(vm.runInContext('getVerifiedDictionaryGraphRelationships()[0].id', context), 'verified');
});

test('overview packs forty-one tables and many small domains into a landscape canvas', () => {
  const context = vm.createContext({ document: { addEventListener() {} }, window: { addEventListener() {} }, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/frontend/js/modules/dictionary-graph.js'), 'utf8'), context);
  const result = vm.runInContext(`buildDictionaryClusterLayout([6,5,4,4,3,3,3,3,2,2,1,1,1,1,1,1].flatMap((count,domain) => Array.from({length:count}, (_,i) => ({tableName:domain+'_'+i,domain:String(domain)}))), [], 1400, 800)`, context);
  assert.equal(result.positions.size, 41);
  assert.ok(Math.min(1360 / result.width, 760 / result.height) >= .8);
  const boxes = [...result.positions.values()];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    assert.ok(Math.abs(boxes[i].x - boxes[j].x) >= 196 || Math.abs(boxes[i].y - boxes[j].y) >= 64);
  }
});
