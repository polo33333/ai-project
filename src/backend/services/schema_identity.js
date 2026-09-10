'use strict';

function part(value, fallback = '') {
  return String(value ?? fallback).trim().toLowerCase();
}

function tableIdentity(table = {}) {
  return [part(table.dbSourceId, 'legacy'), part(table.dbName, 'unknown'), part(table.schemaName, 'dbo'), part(table.tableName)].join('::');
}

function columnIdentity(table = {}, column = {}) {
  return `${tableIdentity(table)}::${part(column.columnName)}`;
}

function withIdentity(table = {}) {
  const normalized = { ...table, schemaName: table.schemaName || 'dbo' };
  normalized.tableId = tableIdentity(normalized);
  normalized.columns = (table.columns || []).map(column => ({ ...column, columnId: columnIdentity(normalized, column) }));
  return normalized;
}

function sameTable(left, right) {
  return tableIdentity(left) === tableIdentity(right);
}

module.exports = { tableIdentity, columnIdentity, withIdentity, sameTable };
