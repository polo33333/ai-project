'use strict';

// A schema refresh updates the catalog; it must not silently replace the
// execution JOIN plan of the same request with a narrower one. Within one
// source and one root table, plans accumulate: a narrower result keeps the
// broader verified plan, a broader one replaces it, and different table sets
// are re-planned together through verified relationships. A different root
// table means the requested fact changed, so the newer plan wins.
const ready = plan => plan?.outcome === 'ready' && Array.isArray(plan.tableRefs) && plan.tableRefs.length > 0;
const tableIds = plan => new Set(plan.tableRefs.map(ref => ref.tableId).filter(Boolean));
const rootOf = plan => plan?.rootTableId || plan?.tableRefs?.[0]?.tableId || null;

function reconcile(previous, next, { dbSourceId = null, nextRootTableId = null, planJoin } = {}) {
  if (!ready(previous) || (previous.dbSourceId && dbSourceId && previous.dbSourceId !== dbSourceId)) return { plan: next, action: 'replaced' };
  const nextRoot = (ready(next) ? rootOf(next) : null) || nextRootTableId;
  if (nextRoot && rootOf(previous) && nextRoot !== rootOf(previous)) return { plan: next, action: 'root_changed' };
  if (!ready(next)) return { plan: previous, action: 'retained' };
  const before = tableIds(previous), after = tableIds(next);
  if ([...after].every(id => before.has(id))) return { plan: previous, action: 'retained' };
  if ([...before].every(id => after.has(id))) return { plan: next, action: 'replaced' };
  const union = [...new Set([...before, ...after])];
  try {
    const merged = planJoin(union, { dbSourceId: dbSourceId || previous.dbSourceId, rootTableId: rootOf(previous), maxEdges: 3 });
    if (ready(merged)) return { plan: { ...merged, allowedTableIds: union,
      allowedTableNames: merged.tableRefs.map(ref => ref.tableName) }, action: 'merged' };
    return { plan: next, action: 'conflict', code: merged.code || 'JOIN_PLAN_CONFLICT' };
  } catch (error) { return { plan: next, action: 'conflict', code: error.code || 'JOIN_PLAN_CONFLICT' }; }
}

module.exports = { reconcile };
