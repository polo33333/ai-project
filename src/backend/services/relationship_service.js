'use strict';

const dictionaryService = require('./dictionary_service');

function verifiedRelationships(options = {}) {
  const relationshipIds = options.relationshipIds ? new Set(options.relationshipIds) : null;
  const tables = dictionaryService.getGroupedTables();
  const visibleColumns = new Map(tables.filter(table => table.isActive !== false && !table.schemaMissing)
    .map(table => [table.tableId, new Set((table.columns || []).filter(column => column.isVisible !== false).map(column => column.columnName))]));
  const columnVisible = (tableId, columnName) => {
    return visibleColumns.get(tableId)?.has(columnName) === true;
  };
  return dictionaryService.getTableRelationships().filter(relation => relation.isActive !== false
    && relation.status === 'verified'
    && relation.columnPairs?.length > 0
    && (!relationshipIds || relationshipIds.has(relation.id))
    && (relation.columnPairs || []).every(pair => columnVisible(relation.sourceTableId, pair.sourceColumn)
      && columnVisible(relation.targetTableId, pair.targetColumn))
    && (!relation.displayColumn || columnVisible(relation.targetTableId, relation.displayColumn))
    && (!options.dbSourceId || relation.sourceTableId?.startsWith(`${String(options.dbSourceId).toLowerCase()}::`)));
}

function relationshipGraph(options = {}) {
  const graph = new Map();
  const add = (fromTableId, toTableId, relation, reversed) => {
    if (!graph.has(fromTableId)) graph.set(fromTableId, []);
    graph.get(fromTableId).push({ relation, fromTableId, toTableId, reversed });
  };
  for (const relation of verifiedRelationships(options)) {
    add(relation.sourceTableId, relation.targetTableId, relation, false);
    add(relation.targetTableId, relation.sourceTableId, relation, true);
  }
  return graph;
}

function adjacent(tableId, options = {}) {
  return relationshipGraph(options).get(tableId) || [];
}

function findPaths(sourceTableId, targetTableId, options = {}) {
  const maxEdges = Math.max(1, Number(options.maxEdges) || 3);
  // Request-local graph: avoids repeated catalog scans without sharing permission scopes.
  const graph = relationshipGraph(options);
  if (sourceTableId === targetTableId) return (graph.get(sourceTableId) || [])
    .filter(edge => edge.toTableId === sourceTableId && !edge.reversed)
    .map(edge => [edge]);
  const queue = [{ tableId: sourceTableId, path: [], visited: new Set([sourceTableId]) }];
  const results = [];
  let shortest = Infinity;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    if (current.path.length >= maxEdges || current.path.length >= shortest) continue;
    for (const edge of graph.get(current.tableId) || []) {
      if (!edge.toTableId || current.visited.has(edge.toTableId)) continue;
      const path = [...current.path, edge];
      if (edge.toTableId === targetTableId) {
        shortest = path.length;
        results.push(path);
        continue;
      }
      queue.push({ tableId: edge.toTableId, path, visited: new Set([...current.visited, edge.toTableId]) });
    }
  }
  return results.filter(path => path.length === shortest);
}

module.exports = { verifiedRelationships, adjacent, findPaths };
