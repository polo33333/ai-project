'use strict';

const policy = require('./memory_policy');
const { sanitizeObject } = require('./memory_sanitizer');

const TYPES = ['lastEntity', 'lastDataset', 'lastExport'];

function timestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function isValid(reference, now = Date.now(), ttlMinutes = policy.referenceTtlMinutes()) {
  if (!reference || !reference.updatedAt) return false;
  const updatedAt = timestamp(reference.updatedAt);
  return updatedAt > 0 && updatedAt <= now && now - updatedAt <= ttlMinutes * 60 * 1000;
}

function resolveReference(questionText, references = {}, now = Date.now(), preferredType = null) {
  const existing = TYPES.filter(type => references[type]?.updatedAt);
  const valid = existing.filter(type => isValid(references[type], now));
  const keywordTypes = TYPES.filter(type => policy.matchesReferenceKeyword(questionText, type));
  const candidates = keywordTypes.filter(type => valid.includes(type));

  if (preferredType && valid.includes(preferredType)) {
    return { type: preferredType, data: sanitizeObject(references[preferredType]) };
  }

  if (candidates.length) {
    const type = candidates.sort((a, b) => timestamp(references[b].updatedAt) - timestamp(references[a].updatedAt))[0];
    return { type, data: sanitizeObject(references[type]) };
  }
  if (keywordTypes.length) {
    return { type: null, data: null, reason: keywordTypes.some(type => existing.includes(type)) ? 'reference_expired' : 'missing_reference' };
  }
  if (!valid.length) {
    return { type: null, data: null, reason: existing.length ? 'reference_expired' : 'missing_reference' };
  }
  // A one-row workflow dataset and its entity pointer identify the same
  // object, not two competing antecedents for "the employee above".
  if (valid.length === 2 && valid.includes('lastEntity') && valid.includes('lastDataset')
      && references.lastDataset.rowCount === 1 && references.lastEntity.runId
      && references.lastEntity.runId === references.lastDataset.runId) {
    return { type: 'lastEntity', data: sanitizeObject(references.lastEntity) };
  }
  // A SQL lookup creates both a dataset and an entity from the same result.
  // They are two representations of one antecedent, not competing references.
  if (valid.length === 2 && valid.includes('lastEntity') && valid.includes('lastDataset')) {
    const entity = references.lastEntity, dataset = references.lastDataset;
    const keys = dataset.entityKeys || [];
    const sameResult = entity.table === dataset.table && timestamp(entity.updatedAt) === timestamp(dataset.updatedAt)
      && (!entity.dbSourceId || !dataset.dbSourceId || entity.dbSourceId === dataset.dbSourceId);
    const sameLegacyEntity = keys.length === 1 && Object.entries(keys[0]).length > 0
      && Object.entries(keys[0]).every(([key, value]) => String(entity.filters?.[key]) === String(value));
    if (sameResult && (dataset.rowCount === 1 || (dataset.rowCount === undefined && sameLegacyEntity))) {
      return { type: 'lastEntity', data: sanitizeObject(entity) };
    }
  }
  if (valid.length > 1 && policy.strictReferenceResolution()) {
    return { type: null, data: null, reason: 'ambiguous_reference' };
  }
  const type = valid.sort((a, b) => timestamp(references[b].updatedAt) - timestamp(references[a].updatedAt))[0];
  return { type, data: sanitizeObject(references[type]) };
}

function pickEntityFilters(row = {}) {
  const preferred = Object.keys(row).filter(key => /(?:employee|customer|client|company|person).*(?:id|code|name)$|^(?:name|code)$/i.test(key));
  const keys = preferred.length ? preferred : Object.keys(row).filter(key => /(?:id|code|name)$/i.test(key));
  return Object.fromEntries(keys.slice(0, 4).filter(key => row[key] !== null && row[key] !== '').map(key => [key, row[key]]));
}

function datasetEntityKeys(rows = [], plan = {}) {
  const limit = Math.max(1, Math.min(50, Number(process.env.MEMORY_DATASET_ENTITY_LIMIT) || 20));
  const identityColumns = (plan.identityColumns || []).filter(Boolean);
  const displayNames = plan.columnDisplayNames || {};
  if (!identityColumns.length) return [];
  return rows.slice(0, limit).map(row => {
    const entries = Object.entries(row || {});
    const findValue = column => {
      const aliases = [column, displayNames[column]].filter(Boolean).map(value => String(value).toLocaleLowerCase('vi'));
      const matched = entries.find(([name]) => aliases.includes(String(name).toLocaleLowerCase('vi')));
      return matched?.[1];
    };
    return Object.fromEntries(identityColumns.map(column => [column, findValue(column)])
      .filter(([, value]) => value !== null && value !== undefined && value !== ''));
  }).filter(item => Object.keys(item).length);
}

function deriveReferences({ currentPlan = {}, toolCalls = [], now = new Date().toISOString() } = {}) {
  const updates = {};
  const identityPlan = currentPlan.recordIdentityColumns?.length ? { ...currentPlan, identityColumns: currentPlan.recordIdentityColumns } : currentPlan;
  const accepted = toolCalls.filter(call => call.toolName === 'execute_sql_query' && call.success && Array.isArray(call.result?.rows)
    && (!(call.result.sql || call.args?.sql) || require('../agent_core/harness/completion_policy').assessSqlEvidence(call, currentPlan)?.accepted));
  const selected = currentPlan.semanticGroups
    ? require('../agent_core/harness/semantic_groups').results(currentPlan.semanticGroups, accepted).map(group => group.call).filter(Boolean)
    : accepted.slice(-1);
  const sqlCall = selected.at(-1);
  if (sqlCall && currentPlan.table) {
    updates.lastDataset = sanitizeObject({
      table: currentPlan.table,
      metric: currentPlan.metric || null,
      timeColumn: currentPlan.timeColumn || null,
      requiredColumns: currentPlan.requiredColumns || [],
      dbSourceId: currentPlan.dbSourceId || null,
      rowCount: selected.reduce((sum, call) => sum + call.result.rows.length, 0),
      queryScope: { question: currentPlan.question || null, unfilteredList: currentPlan.unfilteredList === true,
        temporalMonths: currentPlan.temporalMonths || null },
      entityKeys: selected.flatMap(call => datasetEntityKeys(call.result.rows, identityPlan)),
      identityColumns: identityPlan.identityColumns || [],
      displayNames: currentPlan.columnDisplayNames || {},
      columns: [...new Set(selected.flatMap(call => call.result.columns?.length ? call.result.columns : call.result.rows.flatMap(row => Object.keys(row))))],
      datasets: selected.map(call => {
        const entityKeys = datasetEntityKeys(call.result.rows, identityPlan);
        return { label: currentPlan.semanticGroups?.[call.semanticGroup]?.label || null,
          scope: require('./result_scope').describe(call.result.sql || call.args?.sql || ''),
          rowCount: call.result.rows.length, entityKeys,
          identityComplete: Boolean(identityPlan.identityColumns?.length && !call.result.hasMore && !call.result.truncated
            && entityKeys.length === call.result.rows.length && entityKeys.every(row => identityPlan.identityColumns.every(column => Object.hasOwn(row, column)))) };
      }),
      updatedAt: now
    });
    const allRows = selected.flatMap(call => call.result.rows);
    const firstRow = allRows.length === 1 ? allRows[0] : null;
    const filters = firstRow && pickEntityFilters(Object.fromEntries(Object.entries(firstRow).map(([key, value]) => [
      Object.entries(currentPlan.columnDisplayNames || {}).find(([, alias]) => alias === key)?.[0] || key, value
    ])));
    if (filters && Object.keys(filters).length) {
      updates.lastEntity = sanitizeObject({ table: currentPlan.table, dbSourceId: currentPlan.dbSourceId || null, filters, updatedAt: now });
    }
  }
  const exportCall = [...toolCalls].reverse().find(call => call.toolName === 'export_data' && call.success && call.result?.downloadUrl);
  if (exportCall) {
    updates.lastExport = sanitizeObject({ downloadUrl: exportCall.result.downloadUrl, table: currentPlan.table || null, updatedAt: now,
      files: toolCalls.filter(call => call.toolName === 'export_data' && call.success && call.result?.downloadUrl)
        .map(call => ({ label: call.exportGroup || call.result.fileName, downloadUrl: call.result.downloadUrl, rowCount: call.result.recordCount })) });
  }
  return updates;
}

module.exports = { TYPES, datasetEntityKeys, deriveReferences, isValid, resolveReference };
