'use strict';

const dictionaryService = require('./dictionary_service');

function verifiedRelationships(options = {}) {
  return dictionaryService.getTableRelationships().filter(relation => relation.isActive !== false
    && relation.status === 'verified'
    && (!options.dbSourceId || relation.sourceTableId?.startsWith(`${String(options.dbSourceId).toLowerCase()}::`)));
}

function adjacent(tableId, options = {}) {
  const edges = [];
  for (const relation of verifiedRelationships(options)) {
    if (relation.sourceTableId === tableId) edges.push({ relation, fromTableId: tableId, toTableId: relation.targetTableId, reversed: false });
    if (relation.targetTableId === tableId) edges.push({ relation, fromTableId: tableId, toTableId: relation.sourceTableId, reversed: true });
  }
  return edges;
}

function findPaths(sourceTableId, targetTableId, options = {}) {
  const maxEdges = Math.max(1, Number(options.maxEdges) || 3);
  if (sourceTableId === targetTableId) return adjacent(sourceTableId, options)
    .filter(edge => edge.toTableId === sourceTableId && !edge.reversed)
    .map(edge => [edge]);
  const queue = [{ tableId: sourceTableId, path: [], visited: new Set([sourceTableId]) }];
  const results = [];
  let shortest = Infinity;
  while (queue.length) {
    const current = queue.shift();
    if (current.path.length >= maxEdges || current.path.length >= shortest) continue;
    for (const edge of adjacent(current.tableId, options)) {
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
