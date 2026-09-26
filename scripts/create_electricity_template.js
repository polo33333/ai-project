'use strict';
// Regenerate the importable business template without accessing live data.
const fs = require('node:fs');
const { createChart } = require('../src/backend/automation/chart');
const rows = Array.from({ length: 7 }, (_, i) => ({ Thang: `2026-${String(i + 2).padStart(2, '0')}`, SanLuong_kWh: (i + 1) * 1000 }));
const chartConfig = { data: '{{steps.normalize.rows}}', x: 'Thang', y: 'SanLuong_kWh', title: 'Sản lượng điện bán ra theo tháng', unit: 'kWh' };
const steps = [
  { id: 'collect', name: '1. Thu thập yêu cầu báo cáo', type: 'collect', config: { slots: ['months', 'drawChart', 'exportFile'] } },
  { id: 'prepare', name: '2. Xác định phạm vi báo cáo', type: 'transform', config: { mapping: { months: '{{input.months}}', period: 'Tối đa {{input.months}} tháng có dữ liệu mới nhất trong DB', unit: 'kWh' } } },
  { id: 'query', name: '2. Tổng hợp điện bán ra theo tháng', type: 'sql', config: { bindingRef: 'electricity' } },
  { id: 'validate', name: '4. Kiểm tra giới hạn số tháng', type: 'condition', config: { left: '{{input.months}}', operator: 'lessThan', right: '{{steps.query.rows.length}}' } },
  { id: 'check', name: '5. Xác thực số tháng', type: 'assert', config: { left: '{{steps.validate}}', operator: 'equals', right: false, message: 'Kết quả vượt quá số tháng yêu cầu.' } },
  { id: 'normalize', name: '4. Chuẩn bị bảng sản lượng', type: 'transform', config: { mapping: { rows: '{{steps.query.rows}}', unit: '{{steps.prepare.unit}}' } } },
  { id: 'chart', name: '6. Vẽ biểu đồ khi được yêu cầu', type: 'chart', when: { left: '{{input.drawChart}}', operator: 'equals', right: true }, config: chartConfig },
  { id: 'export', name: '7. Xuất Excel khi được yêu cầu', type: 'export', when: { left: '{{input.exportFile}}', operator: 'equals', right: true }, config: { data: '{{steps.normalize.rows}}', format: 'xlsx', filename: 'San_luong_dien_ban_ra_{{input.months}}_thang' } },
  { id: 'complete', name: '7. Tổng hợp kết quả báo cáo', type: 'transform', config: { mapping: { period: '{{steps.prepare.period}}', chart: '{{steps.chart}}', rows: '{{steps.normalize.rows}}', filename: '{{steps.export.filename}}' } } }
];
const sql = `SELECT Thang, SanLuong_kWh FROM (
SELECT CONVERT(varchar(7), ElectricityOutputDate, 120) AS Thang,
ROW_NUMBER() OVER (ORDER BY CONVERT(varchar(7), ElectricityOutputDate, 120) DESC) AS MonthRank,
COALESCE(SUM(TotalQty), 0) AS SanLuong_kWh
FROM dbo.T_ElectricityOutput
WHERE ElectricityOutputDate IS NOT NULL
GROUP BY CONVERT(varchar(7), ElectricityOutputDate, 120)
 ) AS LatestMonths WHERE MonthRank <= @months ORDER BY Thang ASC`;
const expected = { period: 'Tối đa 7 tháng có dữ liệu mới nhất trong DB', chart: createChart({ ...chartConfig, data: rows }), rows, filename: 'fixture.csv' };
const bundle = {
  manifest: { id: 'electricity_sales', name: 'Báo cáo điện bán ra', version: 2, engineContractVersion: 1, domain: 'Điện', tags: ['sản lượng', 'biểu đồ', 'Excel'] },
  templates: [{ id: 'last_seven_months', name: 'Biểu đồ điện bán ra 7 tháng và xuất Excel', enabled: true,
    description: 'Lấy tối đa 7 tháng có dữ liệu mới nhất trong DB, tổng hợp SUM(TotalQty) theo ElectricityOutputDate. Có 2 tháng chỉ trả 2 tháng; không chèn tháng trống. Biểu đồ trong ứng dụng và bảng dữ liệu Excel.',
    examples: ['Vẽ biểu đồ sản lượng điện bán ra trong 7 tháng gần nhất và xuất file', 'Báo cáo điện bán ra 7 tháng và xuất Excel'],
    instructions: 'Lấy tối đa 7 tháng có dữ liệu mới nhất trong DB, không dựa trên ngày hiện tại. Có ít hơn 7 tháng thì trả đúng số tháng hiện có, không chèn tháng trống. Sắp xếp từ cũ đến mới. SUM(TotalQty), đơn vị kWh. Không có dữ liệu thì thông báo và không xuất file. Excel chứa bảng dữ liệu; biểu đồ hiển thị trong ứng dụng.',
    inputs: {
      months: { label: 'Số tháng gần nhất trong DB', ask: 'Bạn muốn xem bao nhiêu tháng có dữ liệu gần nhất (1–100 tháng)?', required: true, schema: { type: 'integer', minimum: 1, maximum: 100 } },
      drawChart: { label: 'Vẽ biểu đồ', ask: 'Bạn có muốn vẽ biểu đồ không?', required: true, schema: { type: 'boolean' } },
      exportFile: { label: 'Xuất file Excel', ask: 'Bạn có muốn xuất file Excel không?', required: true, schema: { type: 'boolean' } }
    }, allowedCapabilities: ['input.collect', 'data.transform', 'data.condition', 'sql.read', 'data.validate', 'data.chart', 'artifact.export'],
    bindings: { electricity: { dbSourceId: 'db-src-1785684548077', tables: ['dbo.T_ElectricityOutput'], parameters: { months: { slot: 'months', type: 'integer' } }, sql } },
    workflow: { steps },
    output: { mapping: '{{steps.complete}}', schema: { type: 'object', properties: { period: { type: 'string' }, chart: { type: 'object', properties: {}, additionalProperties: true }, rows: { type: 'array', items: { type: 'object', properties: { Thang: { type: 'string' }, SanLuong_kWh: { type: 'number' } }, required: ['Thang', 'SanLuong_kWh'] } }, filename: { type: 'string' } }, required: ['period', 'chart', 'rows', 'filename'] }, presentation: { labels: { period: 'Kỳ báo cáo', rows: 'Sản lượng theo tháng', 'rows.Thang': 'Tháng', 'rows.SanLuong_kWh': 'Sản lượng (kWh)', filename: 'File Excel', chart: 'Biểu đồ' } } },
    fixtures: [{ input: { months: 7, drawChart: true, exportFile: true }, stepResults: { query: { rows, rowCount: 7 } }, expected }]
  }]
};
bundle.templates[0].output.mapping = Object.fromEntries(['period', 'chart', 'rows', 'filename'].map(key => [key, `{{steps.complete.${key}}}`]));
// Empty exports return a null filename; the runtime does not create an artifact.
delete bundle.templates[0].output.schema.properties.filename;
delete bundle.templates[0].output.schema.properties.chart;
bundle.templates[0].output.schema.required = ['period', 'rows'];
const template = bundle.templates[0];
template.name = 'Chi tiết sản lượng điện bán ra';
template.description = 'Báo cáo sản lượng điện bán ra theo các tháng có dữ liệu mới nhất trong DB. Thu thập số tháng, lựa chọn vẽ biểu đồ và xuất Excel trước khi chạy. Có ít tháng hơn yêu cầu thì chỉ trả số tháng thực có.';
template.examples = ['Chi tiết sản lượng điện bán ra', 'Báo cáo sản lượng điện bán ra', 'Vẽ biểu đồ sản lượng điện bán ra 7 tháng gần nhất và xuất file'];
template.instructions = 'Chọn mẫu khi yêu cầu báo cáo sản lượng điện bán ra. Bắt buộc thu thập months, drawChart, exportFile; không tự gán mặc định. Chỉ trích xuất những lựa chọn được người dùng nêu rõ. Hỏi lại phần còn thiếu. Câu hỏi chung chưa nêu tháng hoặc lựa chọn biểu đồ/xuất file phải chờ bổ sung. Có hoặc không đều là câu trả lời hợp lệ cho lựa chọn boolean. Lấy N tháng có dữ liệu mới nhất trong DB, không dựa vào ngày hiện tại, không chèn tháng trống. SUM(TotalQty) theo ElectricityOutputDate, đơn vị kWh. Chỉ vẽ biểu đồ khi drawChart=true; chỉ xuất Excel khi exportFile=true.';
bundle.manifest.version = 3;
steps.forEach((step, index) => { step.name = `${index + 1}. ${step.name.replace(/^\d+\. /, '')}`; });
for (const sample of [rows.slice(0, 2), []]) {
  bundle.templates[0].fixtures.push({ input: { months: 7, drawChart: true, exportFile: true }, stepResults: { query: { rows: sample, rowCount: sample.length } }, expected: { ...expected, rows: sample, chart: createChart({ ...chartConfig, data: sample }) } });
}
for (const drawChart of [false, true]) for (const exportFile of [false, true]) {
  const sample = rows.slice(0, 2), result = { period: 'Tối đa 2 tháng có dữ liệu mới nhất trong DB', rows: sample };
  if (drawChart) result.chart = createChart({ ...chartConfig, data: sample });
  if (exportFile) result.filename = 'fixture.csv';
  template.fixtures.push({ input: { months: 2, drawChart, exportFile }, stepResults: { query: { rows: sample, rowCount: 2 } }, expected: result });
}
require('../src/backend/automation/contract').validatePackage(bundle);
fs.writeFileSync('docs/templates/electricity_sales_seven_months.json', JSON.stringify(bundle, null, 2) + '\n');
if (process.argv.includes('--install')) {
  const storage = require('../src/backend/storage'); storage.loadEnvironment();
  (async () => {
    await storage.bootstrapStorage();
    try { await storage.run(async () => {
      const automation = require('../src/backend/automation');
      const previous = await automation.repository.get('catalog', bundle.manifest.id);
      const context = { accountId: 'local-template-setup', permissions: ['admin'] };
      const updated = structuredClone(bundle);
      if (previous) {
        updated.manifest.version = Math.max(updated.manifest.version, ...[previous.draft, ...(previous.versions || [])].filter(Boolean).map(item => item.manifest.version + 1));
        const old = previous.draft.templates.find(item => item.id === updated.templates[0].id);
        if (old?.bindings?.electricity?.dbSourceId) updated.templates[0].bindings.electricity.dbSourceId = old.bindings.electricity.dbSourceId;
        updated.templates.push(...previous.draft.templates.filter(item => item.id !== updated.templates[0].id));
      }
      const live = await require('../src/backend/automation/sql').executeBinding(updated.templates[0].bindings.electricity, { months: 7 }, { permissions: ['admin'], signal: AbortSignal.timeout(15000) });
      require('../src/backend/automation/chart').createChart({ ...chartConfig, data: live.rows });
      await automation.registry.import(updated, context, previous?.revision ?? null);
      const report = await automation.registry.test(updated.manifest.id, context);
      if (!report.passed) throw new Error('Fixture failed: ' + JSON.stringify(report));
      const record = await automation.repository.get('catalog', updated.manifest.id);
      await automation.registry.publish(record.id, context, record.revision);
      console.log(JSON.stringify({ published: record.id, version: updated.manifest.version, months: live.rows.map(row => row.Thang) }));
    }); } finally { await storage.close(); }
  })().catch(error => { console.error(error.message); process.exitCode = 1; });
}
