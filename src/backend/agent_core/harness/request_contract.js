'use strict';

// Consume structured intent and permission-filtered metadata, never business regex.
const key = value => String(value || '').normalize('NFC').toLocaleLowerCase('vi').trim();
const intentSchema = { type: 'object', additionalProperties: false, required: ['operation', 'attributes', 'presentation'], properties: {
  operation: { enum: ['list', 'compare', 'detail', 'attribute', 'aggregate', 'describe', 'guidance'],
    description: 'describe: explain stored fields or classification criteria; guidance: lookup prerequisites/how-to, not execution; aggregate: statistics/count/sum; list/detail/attribute/compare: actual records.' },
  attributes: { type: 'array', maxItems: 32, uniqueItems: true, description: 'Only output fields/grouping dimensions explicitly requested by the user. For a general aggregate with no named output fields or dimensions use []; a category mentioned as a filter is not an output attribute. Never populate this with every discovered schema column.', items: { type: 'string', minLength: 1, maxLength: 100 } },
  presentation: { enum: ['text', 'table', 'unspecified'] },
  analysis: { enum: ['none', 'anomaly', 'trend', 'forecast'], description: 'Preserve the requested analytical task independently of SQL aggregation. Anomaly detection is anomaly, not just a monthly list; trend analysis is trend. Use none for simple retrieval.' }
} };
const validateIntent = new (require('ajv'))().compile(intentSchema);
function decodeIntent(value) {
  if (!validateIntent(value)) throw Object.assign(new Error('REQUEST_INTENT_INVALID'), { code: 'REQUEST_INTENT_INVALID' });
  return structuredClone(value);
}

function resolveRequestIntent(declared, plan = {}, resolved) {
  const intent = decodeIntent(plan.semanticIntent || declared);
  // A review grounded in the current question and authorized schema supersedes
  // the earlier memory classification, including after schema-root recovery.
  if (!plan.semanticIntent) {
    if (plan.conversationState?.operation && !['chart', 'export'].includes(plan.conversationState.operation)) intent.operation = plan.conversationState.operation;
    if (resolved?.operation === 'aggregate') intent.operation = 'aggregate';
    if (resolved && ['list', 'detail', 'attribute', 'compare'].includes(resolved.operation)) {
      intent.operation = resolved.operation;
      if (!resolved.attributes?.length) intent.attributes = [];
    }
  }
  if (resolved?.relation === 'independent' && resolved.operation === 'conversation' && resolved.dataUse === 'none'
    && !['describe', 'guidance'].includes(intent.operation)) intent.operation = 'conversation';
  // Metadata discovery may change the fact table, not replace a requested
  // analysis of records with an explanation of how such analysis would work.
  if ((['analyze', 'forecast'].includes(resolved?.operation) && resolved.dataUse !== 'none'
    || plan.analysisTask && plan.analysisTask !== 'none' || intent.analysis && intent.analysis !== 'none')
    && ['describe', 'guidance'].includes(intent.operation)) {
    intent.operation = resolved?.operation === 'forecast' ? 'forecast' : 'analyze';
    intent.attributes = [];
  }
  return intent;
}

function createRequestContract(plan = {}, selection = {}) {
  const state = plan.conversationState || {};
  const operation = state.operation || plan.intent;
  if (plan.codeOnly || !['list', 'compare', 'detail', 'attribute'].includes(operation)) return null;
  const table = plan.table ? (selection.tables || []).find(item => item.tableName === plan.table)
    : (selection.tables || [])[0];
  const columns = (table?.columns || []).filter(column => column.isVisible !== false);
  const mapped = (selection.joinPlan?.edges || []).filter(edge => !edge.reversed && edge.displayColumn && edge.businessRole
    && selection.joinPlan.tableRefs?.find(ref => ref.tableRefId === edge.fromTableRefId)?.tableName === table?.tableName)
    .map(edge => ({ ...edge, targetTable: selection.joinPlan.tableRefs?.find(ref => ref.tableRefId === edge.toTableRefId)?.tableName }));
  // A multi-table search may have no executable join plan. Verified relationship
  // metadata still identifies the business display field, but only when both
  // ends are present in the permission-filtered schema returned to this request.
  for (const relation of selection.mappedRelationships || []) {
    const target = (selection.tables || []).find(item => item.tableName === relation.targetTable);
    if (relation.sourceTable !== table?.tableName || !relation.businessRole || !relation.displayColumn
      || !(relation.columnPairs || []).length
      || !relation.columnPairs.every(pair => columns.some(column => (column.name || column.columnName) === pair.sourceColumn))
      || !target?.columns?.some(column => column.isVisible !== false && (column.name || column.columnName) === relation.displayColumn)
      || mapped.some(edge => edge.businessRole === relation.businessRole)) continue;
    mapped.push(relation);
  }
  const replaced = new Set(mapped.flatMap(edge => (edge.columnPairs || []).map(pair => pair.sourceColumn)));
  const requested = Array.isArray(state.requestedAttributes) ? state.requestedAttributes : (plan.requiredColumns || []);
  const explicit = requested.length > 0;
  // An unspecified list is a collection of identifiable records, not a full profile.
  // Detail/compare requests still require all visible business fields.
  const listIdentity = operation === 'list' && !explicit
    ? new Set([...(plan.identityColumns || []), ...(plan.displayIdentityColumns || [])]) : new Set();
  const summaryList = listIdentity.size > 0;
  const criteria = [];
  const add = (name, aliases, requestedAs = name, mappedSource = null) => {
    if (!name || criteria.some(item => item.name === name)) return;
    criteria.push({ name, requestedAs, resultKeys: [...new Set([name, ...aliases].filter(Boolean))],
      ...(mappedSource ? { mappedSource } : {}) });
  };
  const unresolved = [];
  if (explicit) {
    for (const attribute of requested) {
      const roles = mapped.filter(edge => key(edge.businessRole) === key(attribute)
        || key(edge.displayColumn) === key(attribute)
        || (edge.columnPairs || []).some(pair => key(pair.sourceColumn) === key(attribute)));
      if (roles.length === 1) { add(roles[0].businessRole, [], attribute,
        roles[0].targetTable ? { table: roles[0].targetTable, column: roles[0].displayColumn } : null); continue; }
      const matches = columns.filter(column => [column.name, column.columnName, column.label, column.displayName, column.description]
        .some(value => value && key(value) === key(attribute)));
      if (matches.length === 1) {
        const column = matches[0];
        add(column.name || column.columnName, [column.label, column.displayName, plan.columnDisplayNames?.[column.name || column.columnName]], attribute);
      } else if (matches.length) unresolved.push({ requestedAs: attribute, reason: 'ambiguous' });
      else {
        // Explicit outputs may belong to a joined detail/lookup table. Resolve
        // only a unique visible match in the current authorized schema; SQL
        // still has to pass JOIN validation and project that physical column.
        const related = (selection.tables || []).filter(item => item !== table && item.isActive !== false
          && (!selection.dbSourceId || !item.dbSourceId || item.dbSourceId === selection.dbSourceId))
          .flatMap(item => (item.columns || []).filter(column => column.isVisible !== false
            && [column.name, column.columnName, column.label, column.displayName, column.description]
              .some(value => value && key(value) === key(attribute)))
            .map(column => ({ table: item.tableName, column })));
        if (related.length === 1) {
          const { table: sourceTable, column } = related[0];
          add(column.name || column.columnName, [column.label, column.displayName], attribute,
            { table: sourceTable, column: column.name || column.columnName });
        } else unresolved.push({ requestedAs: attribute, reason: related.length ? 'ambiguous' : 'not_exposed' });
      }
    }
  } else {
    for (const column of columns.filter(column => (!summaryList || listIdentity.has(column.name || column.columnName))
      && !replaced.has(column.name || column.columnName)
      && (column.label || column.displayName || column.description
      || (plan.identityColumns || []).includes(column.name || column.columnName)))) {
      add(column.name || column.columnName, [column.label, column.displayName, plan.columnDisplayNames?.[column.name || column.columnName]]);
    }
  }
  if (!explicit && !summaryList) {
    for (const edge of mapped) add(edge.businessRole, [], edge.businessRole,
      edge.targetTable ? { table: edge.targetTable, column: edge.displayColumn } : null);
  }
  return {
    schemaVersion: '1', operation,
    entities: structuredClone(state.references || []), attributes: criteria,
    scope: { table: table?.tableName || plan.table || null, dbSourceId: selection.dbSourceId || plan.dbSourceId || null,
      rowLimit: plan.rowLimit || null, dataUse: state.dataUse || 'current' },
    presentation: state.presentation && state.presentation !== 'unspecified' ? state.presentation
      : plan.presentation || (operation === 'compare' ? 'table' : 'unspecified'),
    completeness: { mode: explicit ? 'requested_attributes' : summaryList ? 'identity_fields' : 'visible_business_fields',
      metadataAvailable: Boolean(table), unresolved }
  };
}

function assessRequestContract(contract, call) {
  if (!contract) return null;
  const rows = call?.result?.rows;
  const hasRows = Array.isArray(rows);
  const sql = call?.result?.sql || call?.args?.sql;
  let statement = null;
  if (sql) { try {
    const parsed = new (require('node-sql-parser').Parser)().astify(sql, { database: 'TransactSQL' });
    statement = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {} }
  const fields = contract.attributes.map(attribute => {
    let aliases = attribute.resultKeys;
    if (attribute.mappedSource && sql) {
      const sources = (statement?.from || []).filter(source => key(source.table) === key(attribute.mappedSource.table));
      aliases = (statement?.columns || []).filter(column => column.expr?.type === 'column_ref'
        && key(column.expr.column) === key(attribute.mappedSource.column)
        && sources.some(source => key(column.expr.table) === key(source.as || source.table)))
        .map(column => column.as || column.expr.column);
    }
    const statuses = hasRows ? rows.map(row => {
      const matching = Object.keys(row).filter(name => aliases.some(alias => key(alias) === key(name)));
      if (matching.length !== 1 || row[matching[0]] === undefined) return 'not_queried';
      return row[matching[0]] === null ? 'null' : 'present';
    }) : ['not_queried'];
    return { name: attribute.name, status: statuses.includes('not_queried') ? 'not_queried'
      : statuses.includes('null') ? 'null' : hasRows && rows.length === 0 ? 'empty_result' : 'present' };
  });
  const failures = [];
  if (!contract.completeness.metadataAvailable) failures.push('CONTRACT_METADATA_UNAVAILABLE');
  if (!contract.attributes.length && !contract.completeness.unresolved.length) failures.push('CONTRACT_CRITERIA_UNRESOLVED');
  if (contract.completeness.unresolved.length) failures.push('CONTRACT_ATTRIBUTES_UNRESOLVED');
  if (!hasRows || fields.some(field => field.status === 'not_queried')) failures.push('CONTRACT_FIELDS_NOT_QUERIED');
  if (call?.result?.hasMore || call?.result?.truncated) failures.push('CONTRACT_SCOPE_PARTIAL');
  const actualSource = call?.result?.dbSourceId || call?.result?.sourceId;
  if (actualSource && contract.scope.dbSourceId && actualSource !== contract.scope.dbSourceId) failures.push('CONTRACT_SOURCE_MISMATCH');
  return { schemaVersion: '1', complete: failures.length === 0, fields, failures,
    evidenceRef: call ? { toolName: call.toolName, dbSourceId: actualSource || contract.scope.dbSourceId } : null };
}

function createMetricContract(result, args = {}) {
  if (!result?.metricId || !Number.isInteger(result.metricVersion)) return null;
  return { schemaVersion: '1', operation: 'aggregate', entities: [],
    attributes: [...new Set(['value', ...(args.dimensions || [])])].map(name => ({ name, requestedAs: name, resultKeys: [name] })),
    scope: { dbSourceId: result.sourceId, metricId: result.metricId, metricVersion: result.metricVersion,
      timeRange: structuredClone(result.timeRange), grain: result.grain, units: structuredClone(result.units) },
    presentation: 'table', completeness: { mode: 'approved_metric_fields', metadataAvailable: true, unresolved: [] } };
}

module.exports = { createRequestContract, assessRequestContract, createMetricContract, intentSchema, decodeIntent, resolveRequestIntent };
