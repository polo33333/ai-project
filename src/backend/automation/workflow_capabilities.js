'use strict';
const { resolve } = require('./contract');
function operations(definition) {
  const result = new Set((definition.tags || []).filter(tag => tag.startsWith('operation:')).map(tag => tag.slice(10))
    .filter(operation => ['list', 'detail', 'attribute', 'compare', 'aggregate', 'chart', 'export'].includes(operation)));
  const allowed = new Set(definition.allowedCapabilities || []), state = { input: {}, steps: {} };
  const markers = new Set();
  const contains = value => value && typeof value === 'object' && (markers.has(value) || Object.values(value).some(contains));
  for (const step of definition.workflow?.steps || []) {
    if (step.type === 'chart' && allowed.has('data.chart')) { const marker = { chartCapability: true }; markers.add(marker); state.steps[step.id] = marker; }
    else if (step.type === 'export' && allowed.has('artifact.export')) { const marker = { exportCapability: true }; markers.add(marker); state.steps[step.id] = { filename: marker, artifactId: marker, downloadUrl: marker }; }
    else if (step.type === 'transform' && allowed.has('data.transform')) state.steps[step.id] = resolve(step.config?.mapping || {}, state);
    else if (step.type === 'sql' && allowed.has('sql.read')) {
      state.steps[step.id] = {};
      try {
        const sql = definition.bindings?.[step.config?.bindingRef]?.sql;
        const ast = new (require('node-sql-parser').Parser)().astify(sql, { database: 'TransactSQL' });
        const aggregate = node => node && typeof node === 'object' && (node.type === 'aggr_func' || Object.values(node).some(value => Array.isArray(value) ? value.some(aggregate) : aggregate(value)));
        if (aggregate(ast)) result.add('aggregate');
      } catch { /* Unknown SQL does not establish an aggregate capability. */ }
    } else state.steps[step.id] = {};
  }
  const output = resolve(definition.output?.mapping || {}, state);
  if (contains(output)) {
    const has = (value, key) => value && typeof value === 'object' && (markers.has(value) && value[key] === true || Object.values(value).some(child => has(child, key)));
    if (has(output, 'chartCapability')) result.add('chart');
    if (has(output, 'exportCapability')) result.add('export');
  }
  return [...result];
}
module.exports = { operations };
