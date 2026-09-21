'use strict';

const crypto = require('node:crypto');
const dictionaryService = require('./dictionary_service');
const relationshipService = require('./relationship_service');

function preferredPath(paths = []) {
  const ranked = paths.map(path => ({ path,
    preferred: path.filter(edge => edge.relation.preferred === true).length,
    confidence: path.reduce((sum, edge) => sum + (Number(edge.relation.confidenceScore) || 0), 0) }))
    .sort((a, b) => b.preferred - a.preferred || b.confidence - a.confidence);
  if (!ranked.length || ranked[0].preferred === 0) return null;
  if (ranked[1] && ranked[0].preferred === ranked[1].preferred && ranked[0].confidence === ranked[1].confidence) return null;
  return ranked[0].path;
}

function planJoin(tableIds = [], options = {}) {
  const requested = tableIds.filter(Boolean);
  if (requested.length < 2) return { outcome: 'ready', planId: crypto.randomUUID(), tableRefs: requested.map((tableId, index) => ({ tableId, alias: `t${index + 1}` })), edges: [] };
  const root = options.rootTableId && requested.includes(options.rootTableId) ? options.rootTableId : requested[0];
  const orderedRequested = [root, ...requested.filter(tableId => tableId !== root)];
  const selectedEdges = [];
  const ambiguities = [];
  for (const target of orderedRequested.slice(1)) {
    const paths = relationshipService.findPaths(root, target, options);
    if (!paths.length) return { outcome: 'no_path', code: 'JOIN_RELATIONSHIP_MISSING', reason: 'Không có đường quan hệ đã xác minh trong giới hạn.', sourceTableId: root, targetTableId: target };
    if (paths.length > 1) {
      const requestedParallelIds = new Set(options.parallelRelationshipIds || []);
      const parallel = paths.filter(path => path.length === 1 && !path[0].reversed
        && requestedParallelIds.has(path[0].relation.id));
      if (parallel.length && requested.length === 2) {
        const enrichment = planEnrichment(root, parallel.map(path => path[0].relation), { ...options, purpose: 'join' });
        if (enrichment) return { ...enrichment, rootTableId: root, expectedGrain: options.expectedGrain || null };
      }
      const preferred = preferredPath(paths);
      if (preferred) {
        paths.splice(0, paths.length, preferred);
      } else {
        ambiguities.push({ targetTableId: target, relationshipPaths: paths.map(path => path.map(edge => edge.relation.id)) });
      }
    }
    for (const edge of paths[0]) if (!selectedEdges.some(item => item.relation.id === edge.relation.id)) selectedEdges.push(edge);
  }
  if (selectedEdges.length > (Number(options.maxEdges) || 3)) return { outcome: 'no_path', code: 'JOIN_LIMIT_EXCEEDED', reason: 'Đường JOIN vượt giới hạn số cạnh.' };
  if (ambiguities.length) return { outcome: 'ambiguous', code: 'JOIN_ROLE_AMBIGUOUS', reason: 'Có nhiều đường quan hệ cùng độ dài.', choices: ambiguities };
  const allTableIds = selectedEdges.some(edge => edge.fromTableId === edge.toTableId)
    ? [root, root, ...new Set(selectedEdges.flatMap(edge => [edge.fromTableId, edge.toTableId]).filter(id => id !== root))]
    : [...new Set([root, ...selectedEdges.flatMap(edge => [edge.fromTableId, edge.toTableId])])];
  const tableRefs = allTableIds.map((tableId, index) => {
    const table = dictionaryService.getGroupedTables().find(item => item.tableId === tableId);
    return { tableRefId: `${tableId}#${index + 1}`, tableId, alias: `t${index + 1}`, tableName: table?.tableName, schemaName: table?.schemaName || 'dbo' };
  });
  return {
    outcome: 'ready', planId: crypto.randomUUID(), dbSourceId: options.dbSourceId || null,
    schemaRevision: options.schemaRevision || null, relationshipRevision: selectedEdges.map(edge => `${edge.relation.id}:${edge.relation.revision}`).join('|'),
    tableRefs, rootTableId: root, expectedGrain: options.expectedGrain || null,
    edges: selectedEdges.map(edge => ({ relationshipId: edge.relation.id, revision: edge.relation.revision,
      fromTableId: edge.fromTableId, toTableId: edge.toTableId, reversed: edge.reversed,
      columnPairs: edge.reversed ? edge.relation.columnPairs.map(pair => ({ sourceColumn: pair.targetColumn, targetColumn: pair.sourceColumn })) : edge.relation.columnPairs,
      cardinality: edge.reversed ? ({ 'one-to-many': 'many-to-one', 'many-to-one': 'one-to-many' }[edge.relation.cardinality] || edge.relation.cardinality) : edge.relation.cardinality,
      businessRole: edge.relation.businessRole || '', displayColumn: edge.relation.displayColumn || '', joinType: edge.relation.defaultJoinType || 'LEFT' }))
  };
}

function planEnrichment(rootTableId, relations = [], options = {}) {
  const rootTable = dictionaryService.getGroupedTables().find(item => item.tableId === rootTableId);
  if (!rootTable || !relations.length) return null;
  const tableRefs = [{ tableRefId: `${rootTableId}#1`, tableId: rootTableId, alias: 't1', tableName: rootTable.tableName, schemaName: rootTable.schemaName || 'dbo' }];
  const edges = [];
  relations.forEach((relation, index) => {
    const target = dictionaryService.getGroupedTables().find(item => item.tableId === relation.targetTableId);
    if (!target) return;
    const targetRef = { tableRefId: `${relation.targetTableId}#${index + 2}`, tableId: relation.targetTableId,
      alias: `t${index + 2}`, tableName: target.tableName, schemaName: target.schemaName || 'dbo' };
    tableRefs.push(targetRef);
    edges.push({ relationshipId: relation.id, revision: relation.revision, fromTableId: rootTableId,
      toTableId: relation.targetTableId, fromTableRefId: tableRefs[0].tableRefId, toTableRefId: targetRef.tableRefId,
      reversed: false, columnPairs: relation.columnPairs || [], cardinality: relation.cardinality,
      businessRole: relation.businessRole || '', displayColumn: relation.displayColumn || '', joinType: relation.defaultJoinType || 'LEFT' });
  });
  if (!edges.length) return null;
  return { outcome: 'ready', purpose: options.purpose || 'enrichment', planId: crypto.randomUUID(), dbSourceId: options.dbSourceId || null,
    rootTableId, expectedGrain: options.expectedGrain || ((options.purpose || 'enrichment') === 'enrichment' ? 'root' : null),
    relationshipRevision: edges.map(edge => `${edge.relationshipId}:${edge.revision}`).join('|'), tableRefs, edges };
}

module.exports = { planJoin, planEnrichment };
