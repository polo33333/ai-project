'use strict';

// Business metrics for the default IPMS source, written to the application
// store (PostgreSQL db_sources.json → governedMetrics). SQL Server is never
// written. Every definition is checked against the dictionary (active table,
// visible measure/date columns) and the governed metric schema.
//
//   node scripts/seed_business_metrics.js            preview only
//   node scripts/seed_business_metrics.js --apply    write (backup in data/backup/)
//
// Drafted 2026-10-26 from the dictionary's column labels and descriptions and
// approved at the user's request so v2 uses them at once; review the
// "assumption" notes and change definitions in Quản trị → Chỉ tiêu nghiệp vụ.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const apply = process.argv.includes('--apply');
const OWNER = 'Bản soạn tự động 26/10 (chờ nghiệp vụ rà soát)';
const base = { owner: OWNER, timezone: 'Asia/Ho_Chi_Minh', nullRule: 'exclude', approved: true };
const sale = { table: 'dbo.T_ElectricityOutput', timeColumn: 'ElectricityOutputDate', grain: 'Một chứng từ điện bán ra (ElectricityOutputID)',
  dimensions: ['CustomerID', 'PeriodID', 'ElectricityTypeID', 'MeterTypeID', 'EmployeeID'] };
const purchase = { table: 'dbo.T_ElectricityInput', timeColumn: 'ElectricityInputDate', grain: 'Một chứng từ điện mua vào (ElectricityInputID)',
  dimensions: ['VendorID', 'PeriodID', 'EmployeeID'] };
const DEFINITIONS = [
  { ...sale, metricId: 'dien_ban_tien_sau_thue', label: 'Tiền hóa đơn điện sau thuế', valueColumn: 'FinalTotalAmount', aggregation: 'SUM', unit: 'VNĐ', rounding: 0,
    aliases: ['tiền hóa đơn điện sau thuế', 'tiền điện sau thuế', 'tổng tiền hóa đơn điện'],
    definition: 'Tổng tiền hóa đơn/chứng từ điện bán ra sau thuế (FinalTotalAmount), cộng theo chứng từ, lọc tháng theo ngày chứng từ.' },
  { ...sale, metricId: 'dien_ban_tien_truoc_thue', label: 'Tiền hóa đơn điện trước thuế', valueColumn: 'PreTotalAmount', aggregation: 'SUM', unit: 'VNĐ', rounding: 0,
    aliases: ['tiền hóa đơn điện trước thuế', 'tiền điện trước thuế'],
    definition: 'Tổng tiền chứng từ điện bán ra trước thuế (PreTotalAmount), cộng theo chứng từ.' },
  { ...sale, metricId: 'dien_ban_thue_vat', label: 'Thuế VAT hóa đơn điện', valueColumn: 'VATTotalAmount', aggregation: 'SUM', unit: 'VNĐ', rounding: 0,
    aliases: ['thuế VAT hóa đơn điện', 'tiền thuế hóa đơn điện'],
    definition: 'Tổng tiền thuế VAT của chứng từ điện bán ra (VATTotalAmount).' },
  { ...sale, metricId: 'dien_ban_san_luong', label: 'Sản lượng điện bán ra', valueColumn: 'TotalQty', aggregation: 'SUM', unit: 'kWh', rounding: 2,
    aliases: ['sản lượng điện', 'sản lượng điện bán ra', 'điện tiêu thụ'],
    definition: 'Tổng sản lượng trên chứng từ điện bán ra (TotalQty). Giả định đơn vị kWh.' },
  { ...sale, metricId: 'dien_ban_so_hoa_don', label: 'Số hóa đơn điện bán ra', valueColumn: 'ElectricityOutputID', aggregation: 'COUNT', unit: 'hóa đơn', rounding: 0,
    aliases: ['số hóa đơn điện', 'số chứng từ điện bán ra'],
    definition: 'Số chứng từ điện bán ra (đếm ElectricityOutputID).' },
  { ...purchase, metricId: 'dien_mua_tien_sau_thue', label: 'Tiền điện mua vào sau thuế', valueColumn: 'FinalTotalAmount', aggregation: 'SUM', unit: 'VNĐ', rounding: 0,
    aliases: ['tiền điện mua vào', 'tiền điện đầu vào sau thuế'],
    definition: 'Tổng tiền sau thuế của chứng từ điện mua vào từ nhà cung cấp (FinalTotalAmount).' },
  { ...purchase, metricId: 'dien_mua_tien_truoc_thue', label: 'Tiền điện mua vào trước thuế', valueColumn: 'PreTotalAmount', aggregation: 'SUM', unit: 'VNĐ', rounding: 0,
    aliases: ['tiền điện đầu vào trước thuế'],
    definition: 'Tổng tiền trước thuế của chứng từ điện mua vào (PreTotalAmount).' },
  { ...purchase, metricId: 'dien_mua_san_luong', label: 'Sản lượng điện mua vào', valueColumn: 'TotalQty', aggregation: 'SUM', unit: 'kWh', rounding: 2,
    aliases: ['sản lượng điện mua vào', 'sản lượng điện đầu vào'],
    definition: 'Tổng sản lượng trên chứng từ điện mua vào (TotalQty). Giả định đơn vị kWh.' },
  { metricId: 'phieu_thu_tong_tien', label: 'Tổng tiền phiếu thu', table: 'dbo.T_Revenue', valueColumn: 'TotalAmount', aggregation: 'SUM', unit: 'VNĐ', rounding: 0,
    timeColumn: 'RevenueDate', grain: 'Một phiếu thu (RevenueID)', dimensions: ['CustomerID', 'EmployeeID'],
    aliases: ['tiền phiếu thu', 'số tiền đã thu'],
    definition: 'Tổng số tiền trên phiếu thu (TotalAmount), lọc theo ngày phiếu thu.' },
  { metricId: 'phan_anh_so_luong', label: 'Số phản ánh', table: 'dbo.T_Feedback', valueColumn: 'FeedbackID', aggregation: 'COUNT', unit: 'phản ánh', rounding: 0,
    timeColumn: 'FeedbackDate', grain: 'Một yêu cầu/phản ánh (FeedbackID)', dimensions: ['StatusID', 'FeedbackTypeID', 'DepartmentID', 'CustomerID'],
    aliases: ['số phản ánh', 'số yêu cầu phản ánh'],
    definition: 'Số yêu cầu và phản ánh khách hàng (đếm FeedbackID), lọc theo ngày phản ánh.' },
  { metricId: 'cong_no_so_ban_ghi', label: 'Số bản ghi công nợ', table: 'dbo.T_CustomerDebt', valueColumn: 'CustomerDebtID', aggregation: 'COUNT', unit: 'bản ghi', rounding: 0,
    timeColumn: 'DebtDate', grain: 'Một bản ghi công nợ (CustomerDebtID)', dimensions: ['CustomerID', 'EmployeeID'],
    aliases: ['số bản ghi công nợ'],
    definition: 'Số bản ghi công nợ khách hàng (đếm CustomerDebtID). Số dư cuối kỳ không phải chỉ tiêu cộng dồn nên không định nghĩa ở đây.' }
].map(definition => ({ ...base, ...definition }));

(async () => {
  const storage = require(path.join(root, 'src/backend/storage'));
  storage.loadEnvironment();
  await storage.bootstrapStorage();
  try {
    await storage.run(() => {
      const governed = require(path.join(root, 'src/backend/governance/metrics'));
      const dictionary = require(path.join(root, 'src/backend/services/dictionary_service'));
      const sources = storage.read('db_sources.json', []);
      const source = sources.find(item => item.isDefault);
      if (!source) throw new Error('No default SQL source');
      const tables = dictionary.getGroupedTables().filter(table => table.isActive !== false && table.dbSourceId === source.id);
      const problems = [];
      for (const definition of DEFINITIONS) {
        if (!governed.validate(definition)) problems.push(`${definition.metricId}: ${JSON.stringify(governed.validate.errors)}`);
        const [schemaName, tableName] = definition.table.split('.');
        const table = tables.find(item => item.tableName === tableName && (item.schemaName || 'dbo') === schemaName);
        if (!table) { problems.push(`${definition.metricId}: table ${definition.table} not active`); continue; }
        for (const name of [definition.valueColumn, definition.timeColumn, ...definition.dimensions]) {
          const column = table.columns.find(item => item.columnName === name);
          if (!column || (column.isVisible === false && name !== definition.timeColumn)) problems.push(`${definition.metricId}: column ${name} missing or hidden`);
        }
        require(path.join(root, 'src/backend/governance/sql_policy')).check(`SELECT ${definition.valueColumn}, ${definition.timeColumn} FROM ${definition.table}`, source);
      }
      if (problems.length) throw new Error(`Definitions rejected:\n${problems.join('\n')}`);
      const existing = source.governedMetrics || [];
      const now = new Date().toISOString();
      const records = DEFINITIONS.map(definition => {
        const old = existing.find(item => item.metricId === definition.metricId);
        return { ...definition, version: (old?.version || 0) + 1, dialect: 'TransactSQL', updatedAt: now,
          approvedBy: 'Claude (tự duyệt theo yêu cầu người dùng 26/10)', permittedJoins: [], effectiveFrom: now };
      });
      for (const record of records) console.log(`${record.metricId} v${record.version} = ${record.aggregation}(${record.table}.${record.valueColumn}) [${record.unit}] "${record.label}"`);
      if (!apply) { console.log(`\nPreview only (${records.length} metrics, ${existing.length} existing). Run with --apply to write.`); return; }
      const backupDir = path.join(root, 'data/backup');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = path.join(backupDir, `governed_metrics_before_${now.slice(0, 10).replaceAll('-', '')}.json`);
      fs.writeFileSync(backup, JSON.stringify({ sourceId: source.id, governedMetrics: existing }, null, 2));
      const kept = existing.filter(item => !records.some(record => record.metricId === item.metricId));
      storage.write('db_sources.json', sources.map(item => item.id === source.id ? { ...item, governedMetrics: [...kept, ...records] } : item));
      console.log(`\nWrote ${records.length} metrics to source ${source.id}; backup ${path.relative(root, backup)}`);
    });
  } finally { await storage.close(); }
})().catch(error => { console.error('SEED_FAILED', error.message); process.exitCode = 1; });
