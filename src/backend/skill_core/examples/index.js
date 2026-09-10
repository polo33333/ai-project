'use strict';

const examples = {
  lookup_by_code: {
    id: 'lookup_by_code', skillId: 'record_lookup', version: 1,
    render(plan) {
      const code = (plan.schemaColumns || []).find(name => /(?:code|no)$/i.test(name));
      if (!code || !plan.table) return null;
      return `User: Tìm bản ghi theo mã cụ thể\nAssistant tool call: {"tool":"execute_sql_query","arguments":{"sql":"SELECT TOP 100 * FROM [${plan.table}] WHERE [${code}] = N'<value>'"}}`;
    }
  },
  monthly_aggregate: {
    id: 'monthly_aggregate', skillId: 'aggregate_report', version: 1,
    render(plan) {
      if (!plan.table || !plan.metric || !plan.timeColumn) return null;
      return `User: Tổng hợp theo tháng\nAssistant tool call: {"tool":"execute_sql_query","arguments":{"sql":"SELECT FORMAT([${plan.timeColumn}], 'yyyy-MM') AS [Period], ${plan.aggregation || 'SUM'}([${plan.metric}]) AS [${plan.metric}] FROM [${plan.table}] GROUP BY FORMAT([${plan.timeColumn}], 'yyyy-MM') ORDER BY [Period]"}}`;
    }
  },
  list_rows: {
    id: 'list_rows', skillId: 'aggregate_report', version: 1,
    render(plan) {
      if (!plan.table) return null;
      return `User: Liệt kê dữ liệu\nAssistant tool call: {"tool":"execute_sql_query","arguments":{"sql":"SELECT TOP 100 * FROM [${plan.table}]"}}`;
    }
  }
};

function selectExamples(skill, plan, limit = 2) {
  return (skill?.exampleIds || []).map(id => examples[id]?.render(plan)).filter(Boolean).slice(0, limit);
}

module.exports = { selectExamples };
