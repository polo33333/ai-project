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
  const sqlCall = [...toolCalls].reverse().find(call => call.toolName === 'execute_sql_query' && call.success && Array.isArray(call.result?.rows));
  if (sqlCall && currentPlan.table) {
    updates.lastDataset = sanitizeObject({
      table: currentPlan.table,
      metric: currentPlan.metric || null,
      timeColumn: currentPlan.timeColumn || null,
      requiredColumns: currentPlan.requiredColumns || [],
      dbSourceId: currentPlan.dbSourceId || null,
      queryScope: { question: currentPlan.question || null, unfilteredList: currentPlan.unfilteredList === true,
        temporalMonths: currentPlan.temporalMonths || null },
      entityKeys: datasetEntityKeys(sqlCall.result.rows, currentPlan),
      updatedAt: now
    });
    const firstRow = sqlCall.result.rows.length === 1 ? sqlCall.result.rows[0] : null;
    const filters = firstRow && pickEntityFilters(firstRow);
    if (filters && Object.keys(filters).length) {
      updates.lastEntity = sanitizeObject({ table: currentPlan.table, filters, updatedAt: now });
    }
  }
  const exportCall = [...toolCalls].reverse().find(call => call.toolName === 'export_data' && call.success && call.result?.downloadUrl);
  if (exportCall) {
    updates.lastExport = sanitizeObject({ downloadUrl: exportCall.result.downloadUrl, table: currentPlan.table || null, updatedAt: now });
  }
  return updates;
}

module.exports = { TYPES, datasetEntityKeys, deriveReferences, isValid, resolveReference };
