'use strict';
const fs = require('node:fs');
const path = require('node:path');
require('../src/backend/storage').loadEnvironment();
const { createPool, transaction } = require('../src/backend/storage/postgres/pool');
const { AutomationRepository } = require('../src/backend/automation/repository');
const { PluginRegistry } = require('../src/backend/automation/registry');
const { validatePackage, hash } = require('../src/backend/automation/contract');

const metadata = {
  routingScope: 'aggregate',
  description: 'Chi tiết/báo cáo sản lượng điện bán ra: tổng hợp SUM(TotalQty), đơn vị kWh, theo tháng có dữ liệu mới nhất. Yêu cầu sản lượng điện hoặc chi tiết sản lượng điện chọn nghiệp vụ này dù chưa nêu số tháng, biểu đồ hay Excel; hỏi bổ sung sau khi chọn. Không tra cứu hồ sơ nhân viên, hợp đồng hoặc từng giao dịch điện.',
  examples: ['chi tiết sản lượng điện', 'sản lượng điện', 'Chi tiết sản lượng điện bán ra', 'Báo cáo sản lượng điện bán ra', 'Vẽ biểu đồ sản lượng điện bán ra 7 tháng gần nhất và xuất file']
};

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = createPool({ runtime: true });
  try {
    await transaction(pool, async client => {
      const repository = new AutomationRepository({ pool: client });
      const registry = new PluginRegistry(repository);
      const record = (await client.query(`SELECT document FROM app.workflow_catalog WHERE id='electricity_sales'${apply ? ' FOR UPDATE' : ''}`)).rows[0]?.document;
      if (!record?.published || hash(record.draft) !== hash(record.published) || Object.keys(record.overlays || {}).length) throw new Error('Unpublished edits or overlays require review.');
      const bundle = structuredClone(record.published);
      const template = bundle.templates.find(item => item.id === 'last_seven_months');
      if (!template) throw new Error('Electricity report template missing.');
      if (Object.entries(metadata).every(([key, value]) => hash(template[key]) === hash(value))) return console.log('Electricity routing metadata already updated.');
      const executable = value => { const copy = structuredClone(value); for (const key of Object.keys(metadata)) delete copy[key]; return copy; };
      const before = hash(executable(template));
      Object.assign(template, metadata);
      if (before !== hash(executable(template))) throw new Error('Executable definition changed.');
      bundle.manifest.version = Math.max(record.published.manifest.version, ...(record.versions || []).map(item => item.manifest.version)) + 1;
      validatePackage(bundle); await registry.dependencies(bundle);
      const report = await registry.testBundle(bundle);
      if (!report.passed) throw new Error('Existing report fixtures failed.');
      if (apply) {
        fs.mkdirSync(path.resolve(__dirname, '../artifacts'), { recursive: true });
        fs.writeFileSync(path.resolve(__dirname, `../artifacts/electricity-metadata-backup-${Date.now()}.json`), JSON.stringify(record, null, 2));
        await repository.put('catalog', { ...record, draft: bundle, published: structuredClone(bundle), testedHash: hash(bundle), lastTest: report,
          updatedBy: 'electricity-routing-metadata-update', publishedBy: 'electricity-routing-metadata-update', publishedAt: new Date().toISOString(),
          versions: [...(record.versions || []), structuredClone(bundle)] }, record.revision);
      }
      console.log(JSON.stringify({ applied: apply, version: bundle.manifest.version, fixturesPassed: report.results.length }));
    }, { readOnly: !apply });
  } finally { await pool.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { metadata };
