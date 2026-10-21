'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
async function main() {
  const credentials = JSON.parse(fs.readFileSync(0, 'utf8')), base = 'http://localhost:5500';
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) });
  if (!login.ok) throw new Error('LOGIN_FAILED');
  const headers = { 'Content-Type': 'application/json', Cookie: login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${result.message || result.error}`);
    return result;
  };
  try {
    const { package: record } = await api('/api/workflow-plugins/contract_lookup');
    fs.writeFileSync('artifacts/agent-acceptance/contract-workflow-before.private.json', JSON.stringify(record, null, 2));
    const template = structuredClone(record.draft.templates.find(item => item.id === 'contract_details'));
    const removed = [];
    for (const [bindingId, binding] of Object.entries(template.bindings)) {
      const parsed = new (require('node-sql-parser').Parser)().astify(binding.sql.replace(/@[a-zA-Z][a-zA-Z0-9_]*/g, 'NULL'), { database: 'TransactSQL' });
      const statement = Array.isArray(parsed) ? parsed[0] : parsed;
      const projections = new Set(statement.columns.map(column => String(column.as || column.expr?.column || '').toLowerCase()));
      binding.resultMapping = binding.resultMapping.filter(mapping => {
        if (projections.has(mapping.key.toLowerCase())) return true;
        removed.push({ bindingId, key: mapping.key });
        for (const outputKey of Object.keys(template.output.mapping)) delete template.output.presentation?.labels?.[`${outputKey}.${mapping.key}`];
        return false;
      });
    }
    if (removed.map(item => item.key).sort().join(',') !== 'CompanyID,ContractID,TypeID') throw new Error('UNEXPECTED_MAPPING_DIFF');
    await api('/api/question-templates/contract_lookup%2Fcontract_details/draft', 'PUT', { revision: record.revision, template });
    await api('/api/workflow-plugins/contract_lookup/validate', 'POST', {});
    const fixtures = await api('/api/workflow-plugins/contract_lookup/test', 'POST', {});
    if (!fixtures.passed) throw new Error('FIXTURES_FAILED');
    const { package: tested } = await api('/api/workflow-plugins/contract_lookup');
    const published = await api('/api/workflow-plugins/contract_lookup/publish', 'POST', { revision: tested.revision });
    const query = '02/HĐTQSDĐ.LG.2010';
    const created = await api('/api/automation-runs', 'POST', { templateId: 'contract_lookup/contract_details', inputs: { query }, conversationId: 'contract-mapping-' + crypto.randomUUID(), requestId: crypto.randomUUID() });
    let execution = created.execution;
    for (let i = 0; i < 100 && !['SUCCEEDED', 'FAILED', 'NEEDS_REVIEW', 'CANCELLED'].includes(execution.status); i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      ({ execution } = await api('/api/automation-runs/' + execution.id));
    }
    fs.writeFileSync('artifacts/agent-acceptance/contract-workflow-fixed.private.json', JSON.stringify({ removed, version: published.package.published.manifest.version, fixtures, query, execution }, null, 2));
    console.log(JSON.stringify({ version: published.package.published.manifest.version, removed, fixturesPassed: fixtures.passed, mappingValidation: fixtures.bindingMappingValidation, runId: execution.id, status: execution.status, count: execution.result?.count, error: execution.error }));
    if (execution.status !== 'SUCCEEDED') process.exitCode = 1;
  } finally { await api('/api/auth/logout', 'POST').catch(() => {}); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
