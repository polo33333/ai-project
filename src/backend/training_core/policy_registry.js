'use strict';

const POLICIES = Object.freeze({
  data: ['business_sql_success', 'requested_columns_satisfied', 'answer_grounded'],
  chart: ['business_sql_success', 'render_chart_success'],
  export: ['business_sql_success', 'export_data_success']
});

function requirementsFor(plan = {}) {
  return [...new Set(Object.entries(plan.outputs || {}).filter(([, enabled]) => enabled).flatMap(([key]) => POLICIES[key] || []))];
}

module.exports = { POLICIES, requirementsFor };
