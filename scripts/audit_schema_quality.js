'use strict';

const fs = require('node:fs'), path = require('node:path');
const storage = require('../src/backend/storage');
const quality = require('../src/backend/services/schema_quality');

async function main() {
  storage.loadEnvironment();
  const output = path.resolve('output/schema-quality');
  fs.mkdirSync(output, { recursive: true });
  try {
    await storage.bootstrapStorage();
    await storage.run(async () => {
      const dictionary = require('../src/backend/services/dictionary_service');
      const tables = dictionary.getGroupedTables(), relationships = dictionary.getTableRelationships();
      const before = quality.audit(tables, relationships);
      const changes = [];
      for (const entry of before.tables.filter(t => t.issues.some(i => i.code === 'TABLE_DESCRIPTION_MISSING'))) {
        const table = tables.find(t => t.tableId === entry.tableId);
        if (!table.semanticModel) continue;
        let model;
        try { model = require('../src/backend/services/semantic_model').validateModel(table.semanticModel, table); } catch { continue; }
        const description = [
          `Đối tượng nghiệp vụ: ${model.entity}.`, `Mức dữ liệu: ${model.grain}.`,
          `Cột định danh: ${model.identityFields.join(', ')}.`, `Danh sách mặc định: ${model.summaryFields.join(', ')}.`,
          ...(model.segments.length ? [`Phân nhóm đã cấu hình: ${model.segments.map(s => `${s.label} (${s.column} = ${JSON.stringify(s.value)})`).join('; ')}. Chỉ áp dụng khi yêu cầu chọn nhóm tương ứng.`] : []),
          ...(model.monetaryFields?.length ? [`Cột tiền: ${model.monetaryFields.join(', ')}; đơn vị hiển thị ${model.defaultCurrency || 'chưa xác định'}.`] : []),
          ...(table.tableDescription && table.tableDescription !== `Bảng dữ liệu ${table.tableName} thuộc CSDL ${table.dbName}` ? [`Ghi chú trước đây: ${table.tableDescription}`] : [])
        ].join('\n');
        changes.push({ tableId: table.tableId, tableName: table.tableName, before: table.tableDescription || '', after: description,
          evidence: 'Existing validated semanticModel; no inferred joins, statuses or business filters.' });
      }
      const apply = process.argv.includes('--apply-descriptions');
      const stamp = new Date().toISOString().replaceAll(':', '-');
      fs.writeFileSync(path.join(output, `description-plan-${stamp}.json`), JSON.stringify(changes, null, 2));
      if (apply && changes.length) {
        fs.writeFileSync(path.join(output, `metadata-before-${stamp}.json`), JSON.stringify({ tables, relationships }, null, 2));
        for (const change of changes) tables.find(t => t.tableId === change.tableId).tableDescription = change.after;
        dictionary.persist();
        await dictionary.syncToQdrant();
      }
      const report = quality.audit(tables, relationships);
      fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(report, null, 2));
      const uniqueRelationships = new Set(report.tables.flatMap(t => t.issues.filter(i => i.code === 'RELATIONSHIP_UNVERIFIED').map(i => i.field)));
      const lines = ['# Rà soát metadata cho AI', '', `Nguồn lưu trữ: ${storage.enabled() ? 'PostgreSQL' : 'JSON'}.`,
        `Bảng bật cho AI: ${report.activeTables}. Lỗi cấu hình: ${report.errors}. Cảnh báo theo bảng: ${report.warnings}.`,
        `Quan hệ chưa xác minh liên quan các bảng bật: ${uniqueRelationships.size} quan hệ duy nhất.`,
        `${apply ? 'Đã chuẩn hóa' : 'Đề xuất chuẩn hóa'} ${changes.length} mô tả dựa trên semanticModel hiện có.`,
        '', 'Không tự thay đổi khóa, cardinality, trạng thái xác minh hoặc bộ lọc nghiệp vụ. Kiểm tra này không chứng minh tính đúng của số liệu SQL.', '',
        ...report.tables.filter(t => t.issues.length).flatMap(t => [`## ${t.tableName}`, '', ...t.issues.map(i => `- ${i.severity}: ${i.field} — ${i.message}`), ''])];
      fs.writeFileSync(path.join(output, 'review.md'), lines.join('\n'));
      console.log(JSON.stringify({ backend: storage.enabled() ? 'postgres' : 'json', activeTables: report.activeTables, errors: report.errors, warnings: report.warnings, unverifiedRelationships: uniqueRelationships.size, descriptions: changes.length, applied: apply }));
    });
  } finally { await storage.close(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
