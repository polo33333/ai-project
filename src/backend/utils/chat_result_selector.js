'use strict';

/**
 * Chart/export requests may run exploratory or repaired SQL before arriving at
 * the dataset that is actually presented. Earlier calls belong in the
 * technical trace, not in the user-facing result tables.
 */
function selectUserFacingSqlExecutions(sqlExecutions, { hasChart = false, hasExport = false } = {}) {
  if (!Array.isArray(sqlExecutions)) return [];
  if (!hasChart && !hasExport) return sqlExecutions;

  const successful = sqlExecutions.filter(execution => execution?.success !== false);
  const primary = successful[successful.length - 1];
  return primary ? [primary] : [];
}

module.exports = { selectUserFacingSqlExecutions };
