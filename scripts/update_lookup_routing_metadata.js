'use strict';

// Metadata-only update. Preserve immutable published versions and SQL bindings.
const fs = require('node:fs');
const path = require('node:path');
const storage = require('../src/backend/storage');
storage.loadEnvironment();
const { createPool, transaction } = require('../src/backend/storage/postgres/pool');
const { AutomationRepository } = require('../src/backend/automation/repository');
const { PluginRegistry } = require('../src/backend/automation/registry');
const { validatePackage, hash } = require('../src/backend/automation/contract');

const changes = {
  employee_lookup: {
    routingScope: 'targeted',
    name: 'Tra cứu chi tiết nhân viên theo tên hoặc mã',
    description: 'Tra cứu chi tiết nhân viên (nv) theo tên hoặc mã nhân viên; tối đa 50 hồ sơ với các trường đã cấu hình. Thiếu tên/mã thì hỏi bổ sung. Không dùng cho danh sách toàn bộ nhân viên hoặc thống kê.',
    examples: ['thông tin chi tiết nv', 'tra cứu nhân viên theo tên hoặc mã', 'thông tin nhân viên tên Duy', 'nhân viên mã NV004'],
    instructions: 'query chỉ lấy tên/mã nêu rõ, thiếu thì hỏi. Mã khớp chính xác; tên tìm chuỗi chứa. Trả mọi kết quả và trường thực tế, không suy diễn. Không có kết quả thì báo; đủ 50 thì đề nghị thu hẹp.',
    label: 'Tên hoặc mã nhân viên', ask: 'Bạn muốn tra cứu chi tiết nhân viên theo tên gì hoặc mã nào?'
  },
  contract_lookup: {
    routingScope: 'targeted',
    name: 'Tra cứu chi tiết hợp đồng theo tên khách hàng hoặc mã',
    description: 'Tra cứu chi tiết hợp đồng (hđ) theo tên khách hàng hoặc mã/số hợp đồng, hỗ trợ tìm chuỗi chứa; tối đa 50 kết quả. Thiếu tên/mã thì hỏi bổ sung. Không dùng cho danh sách toàn bộ, thống kê hoặc tra cứu nhân viên.',
    examples: ['thông tin chi tiết hợp đồng', 'chi tiết hđ theo tên hoặc mã', 'hợp đồng số HD001', 'hợp đồng của khách hàng An'],
    instructions: 'query chỉ lấy tên khách hàng hoặc mã/số hợp đồng nêu rõ, thiếu thì hỏi. Tìm chuỗi chứa; không lấy cả câu yêu cầu. Trả mọi kết quả thực tế, không suy diễn; không có thì báo, đủ 50 thì đề nghị thu hẹp.',
    label: 'Tên khách hàng hoặc mã/số hợp đồng', ask: 'Bạn muốn tra cứu chi tiết hợp đồng theo tên khách hàng nào hoặc mã/số hợp đồng nào?'
  }
};

async function main() {
  const apply = process.argv.includes('--apply');
  const pool = createPool({ runtime: true });
  try {
    await transaction(pool, async client => {
      const repository = new AutomationRepository({ pool: client });
      const registry = new PluginRegistry(repository);
      const records = (await client.query(`SELECT document FROM app.workflow_catalog WHERE id=ANY($1::text[]) ORDER BY id${apply ? ' FOR UPDATE' : ''}`, [Object.keys(changes)])).rows.map(row => row.document);
      if (records.length !== 2) throw new Error('Expected both published lookup packages.');
      const prepared = [];
      for (const record of records) {
        if (!record.published || hash(record.draft) !== hash(record.published) || Object.keys(record.overlays || {}).length) {
          throw new Error(`Unpublished edits or overlays require review: ${record.id}`);
        }
        if (record.published.templates.length !== 1) throw new Error(`Unexpected template count: ${record.id}`);
        const bundle = structuredClone(record.published), template = bundle.templates[0];
        const { label, ask, ...metadata } = changes[record.id];
        if (Object.entries(metadata).every(([key, value]) => hash(template[key]) === hash(value))
          && template.inputs.query.label === label && template.inputs.query.ask === ask) {
          console.log(`${record.id}: already updated`); continue;
        }
        Object.assign(template, metadata);
        template.inputs.query.label = label; template.inputs.query.ask = ask;
        bundle.manifest.version = Math.max(record.published.manifest.version, ...(record.versions || []).map(item => item.manifest.version)) + 1;
        // Verify all executable fields are unchanged before committing.
        const executable = value => {
          const copy = structuredClone(value);
          for (const key of Object.keys(metadata)) delete copy[key];
          delete copy.inputs.query.label; delete copy.inputs.query.ask;
          return copy;
        };
        if (hash(executable(template)) !== hash(executable(record.published.templates[0]))) throw new Error('Executable definition changed.');
        validatePackage(bundle); await registry.dependencies(bundle);
        const report = await registry.testBundle(bundle);
        if (!report.passed) throw new Error(`Existing fixtures failed: ${record.id}`);
        prepared.push({ record, bundle, report });
      }
      if (apply && prepared.length) {
        const destination = path.resolve(__dirname, '../artifacts', `lookup-metadata-backup-${Date.now()}.json`);
        fs.writeFileSync(destination, JSON.stringify(prepared.map(item => item.record), null, 2));
      }
      for (const { record, bundle, report } of prepared) {
        if (apply) await repository.put('catalog', {
          ...record, draft: bundle, published: structuredClone(bundle),
          testedHash: hash(bundle), lastTest: report,
          updatedBy: 'lookup-routing-metadata-update', publishedBy: 'lookup-routing-metadata-update',
          publishedAt: new Date().toISOString(), versions: [...(record.versions || []), structuredClone(bundle)]
        }, record.revision);
        console.log(JSON.stringify({ applied: apply, package: record.id, version: bundle.manifest.version,
          fixturesPassed: report.results.length, template: bundle.templates[0].name }));
      }
    }, { readOnly: !apply });
  } finally { await pool.end(); }
}

if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { changes };
