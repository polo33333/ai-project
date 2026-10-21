'use strict';
const { randomUUID } = require('node:crypto');
class ContextResultStore {
  constructor(authorize = async () => {}, snapshot = () => null) { this.entries = new Map(); this.authorize = authorize; this.snapshot = snapshot; }
  put(result) {
    const id = randomUUID();
    this.entries.set(id, { result: structuredClone(result), authorization: this.snapshot() });
    return id;
  }
  async read({ resultId, offset = 0, limit = 10, columns } = {}) {
    const entry = this.entries.get(resultId);
    if (!entry) throw new Error('CONTEXT_RESULT_NOT_AVAILABLE');
    await this.authorize(entry.authorization);
    const result = entry.result;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('CONTEXT_RESULT_PAGE_INVALID');
    const available = new Set(result.rows.flatMap(row => Object.keys(row)));
    if (columns && (!Array.isArray(columns) || !columns.length || columns.some(column => !available.has(column)))) throw new Error('CONTEXT_RESULT_COLUMN_INVALID');
    const rows = result.rows.slice(offset, offset + limit).map(row => columns ? Object.fromEntries(columns.map(column => [column, row[column]])) : row);
    return { resultId, rows: structuredClone(rows), columns: columns || [...available], offset,
      returnedRowCount: rows.length, storedRowCount: result.rows.length, rowCount: result.rowCount ?? result.rows.length,
      hasMore: offset + rows.length < result.rows.length, sourceHasMore: result.hasMore === true || result.truncated === true
        || Number(result.rowCount) > result.rows.length,
      units: result.units, instruction: 'This is a page of the original authorized result, not a new database query. Never compute full totals from a partial page; use source aggregation. Current values require a fresh query.' };
  }
}
module.exports = { ContextResultStore };
