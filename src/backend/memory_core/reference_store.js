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
  return now - timestamp(reference.updatedAt) <= ttlMinutes * 60 * 1000;
}

function resolveReference(questionText, references = {}, now = Date.now()) {
  const existing = TYPES.filter(type => references[type]?.updatedAt);
  const valid = existing.filter(type => isValid(references[type], now));
  const keywordTypes = TYPES.filter(type => policy.matchesReferenceKeyword(questionText, type));
  const candidates = keywordTypes.filter(type => valid.includes(type));

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
  const type = valid.sort((a, b) => timestamp(references[b].updatedAt) - timestamp(references[a].updatedAt))[0];
  return { type, data: sanitizeObject(references[type]) };
}

function pickEntityFilters(row = {}) {
  const preferred = Object.keys(row).filter(key => /(?:employee|customer|client|company|person).*(?:id|code|name)$|^(?:name|code)$/i.test(key));
  const keys = preferred.length ? preferred : Object.keys(row).filter(key => /(?:id|code|name)$/i.test(key));
  return Object.fromEntries(keys.slice(0, 4).filter(key => row[key] !== null && row[key] !== '').map(key => [key, row[key]]));
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
      updatedAt: now
    });
    const firstRow = sqlCall.result.rows[0];
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

module.exports = { TYPES, deriveReferences, isValid, resolveReference };
