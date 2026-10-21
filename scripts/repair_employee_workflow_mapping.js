'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
async function main() {
  const credentials = JSON.parse(fs.readFileSync(0, 'utf8')), base = 'http://localhost:5500';
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  if (!login.ok) throw new Error('LOGIN_FAILED');
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  const api = async (url, method = 'GET', body) => { const response = await fetch(base + url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }); const data = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${data.message || data.error}`); return data; };
  try {
    await api('/api/settings/restart', 'POST');
    await new Promise(resolve => setTimeout(resolve, 2500));
    let ready = false;
    for (let i = 0; i < 15; i++) { try { ready = (await api('/api/auth/me')).authenticated; } catch {} if (ready) break; await new Promise(resolve => setTimeout(resolve, 1000)); }
    if (!ready) throw new Error('SERVER_NOT_READY');
    const { package: record } = await api('/api/workflow-plugins/employee_lookup');
    fs.writeFileSync('artifacts/agent-acceptance/employee-workflow-before.private.json', JSON.stringify(record, null, 2));
    const template = structuredClone(record.draft.templates.find(item => item.id === 'employee_details'));
    const { loadEnvironment } = require('../src/backend/storage/postgres/config'); loadEnvironment();
    const pool = require('../src/backend/storage/postgres/pool').createPool({ runtime: true });
    let tables; try { const { documents } = await new (require('../src/backend/storage/postgres/repository').PostgresRepository)(pool).snapshot(['dictionary.json']); tables = documents.get('dictionary.json'); } finally { await pool.end(); }
    const fixes = [];
    for (const [bindingId, binding] of Object.entries(template.bindings)) {
      const ast = new (require('node-sql-parser').Parser)().astify(binding.sql.replace(/@[a-zA-Z][a-zA-Z0-9_]*/g, 'NULL'), { database: 'TransactSQL' });
      for (const mapping of binding.resultMapping || []) {
        if (mapping.tableId && mapping.columnName) continue;
        const matches = ast.columns.filter(column => column.expr?.type === 'column_ref' && column.expr.column === mapping.key);
        if (matches.length !== 1) throw new Error('AMBIGUOUS_MAPPING_REPAIR');
        const projection = matches[0], source = ast.from.find(item => (item.as || item.table) === projection.expr.table);
        const table = tables.find(item => item.dbSourceId === binding.dbSourceId && item.tableName === source?.table && item.isActive !== false);
        if (!table?.columns.some(column => column.columnName === projection.expr.column && column.isVisible !== false)) throw new Error('SOURCE_NOT_EXPOSED');
        const oldKey = mapping.key;
        Object.assign(mapping, { key: projection.as || projection.expr.column, tableId: table.tableId, columnName: projection.expr.column, relationId: null });
        const labels = template.output.presentation?.labels;
        if (labels) for (const outputKey of Object.keys(template.output.mapping)) if (labels[`${outputKey}.${oldKey}`]) labels[`${outputKey}.${mapping.key}`] = mapping.label || labels[`${outputKey}.${oldKey}`];
        fixes.push({ bindingId, oldKey, key: mapping.key, tableId: mapping.tableId, columnName: mapping.columnName });
      }
    }
    if (fixes.length !== 1) throw new Error('EXPECTED_ONE_MAPPING_FIX');
    fs.writeFileSync('artifacts/agent-acceptance/employee-workflow-fixed.private.json', JSON.stringify({ template, fixes }, null, 2));
    await api('/api/question-templates/employee_lookup%2Femployee_details/draft', 'PUT', { revision: record.revision, template });
    await api('/api/workflow-plugins/employee_lookup/validate', 'POST', {});
    const fixtures = await api('/api/workflow-plugins/employee_lookup/test', 'POST', {});
    if (!fixtures.passed) throw new Error('FIXTURES_FAILED');
    const { package: tested } = await api('/api/workflow-plugins/employee_lookup');
    const published = await api('/api/workflow-plugins/employee_lookup/publish', 'POST', { revision: tested.revision });
    const executions = [];
    for (const query of ['NV007', 'NV0007']) {
      const created = await api('/api/automation-runs', 'POST', { templateId: 'employee_lookup/employee_details', inputs: { query }, conversationId: `mapping-acceptance-${crypto.randomUUID()}`, requestId: crypto.randomUUID() });
      let execution = created.execution;
      for (let i = 0; i < 100 && !['SUCCEEDED', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED'].includes(execution.status); i++) { await new Promise(resolve => setTimeout(resolve, 500)); ({ execution } = await api(`/api/automation-runs/${execution.id}`)); }
      executions.push({ query, execution });
    }
    fs.writeFileSync('artifacts/agent-acceptance/employee-workflow-live.private.json', JSON.stringify({ version: published.package.published.manifest.version, fixes, fixtures, executions }, null, 2));
    console.log(JSON.stringify({ version: published.package.published.manifest.version, fixes, fixturesPassed: fixtures.passed, mappingValidation: fixtures.bindingMappingValidation, executions: executions.map(({ query, execution }) => ({ query, id: execution.id, status: execution.status, error: execution.error, resultCount: execution.result?.count })) }));
    if (executions.some(item => item.execution.status !== 'SUCCEEDED')) process.exitCode = 1;
  } finally { await api('/api/auth/logout', 'POST').catch(() => {}); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
