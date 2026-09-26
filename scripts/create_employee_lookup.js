'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'data/dictionary.json'), 'utf8'));
const table = dictionary.find(item => item.tableName === 'M_Employee');
if (!table) throw new Error('Không tìm thấy M_Employee trong catalog.');
const labels = { EmployeeID: 'ID nhân viên', EmployeeCode: 'Mã nhân viên', EmployeeName: 'Họ và tên', DepartmentID: 'ID phòng ban', GenderID: 'ID giới tính', DOB: 'Ngày sinh', MaritalStatusID: 'ID tình trạng hôn nhân', NationalityID: 'ID quốc tịch', ReligionID: 'ID tôn giáo', EthnicID: 'ID dân tộc', CompanyID: 'ID công ty', POBAddress: 'Địa chỉ nơi sinh', PRAddress: 'Địa chỉ thường trú', SAddress: 'Địa chỉ liên hệ', NativeLand: 'Quê quán', IDNo: 'Số giấy tờ tùy thân', IDDate: 'Ngày cấp giấy tờ', IDExpiryDate: 'Ngày hết hạn giấy tờ', IDIssuedBy: 'Nơi cấp giấy tờ', PassportNo: 'Số hộ chiếu', PassportDate: 'Ngày cấp hộ chiếu', PassportExpiryDate: 'Ngày hết hạn hộ chiếu', DOW: 'Ngày vào làm', TitleID: 'ID chức danh', EmployeeTypeID: 'ID loại nhân viên', EducationLevelID: 'ID trình độ học vấn', ProfessionalLevel: 'Trình độ chuyên môn', Mobile: 'Điện thoại', Email: 'Email', TaxCode: 'Mã số thuế', TaxCodeDate: 'Ngày cấp mã số thuế', TaxCodeIssuedBy: 'Nơi cấp mã số thuế', BankID: 'ID ngân hàng', BankBranch: 'Chi nhánh ngân hàng', BankAccountName: 'Tên tài khoản ngân hàng', BankAccountNo: 'Số tài khoản ngân hàng', Note: 'Ghi chú', IsActive: 'Đang hoạt động', Avatar: 'Ảnh đại diện', CreateUser: 'Người tạo', CreateDate: 'Ngày tạo', UpdateUser: 'Người cập nhật', UpdateDate: 'Ngày cập nhật' };
const quote = value => '[' + value.replace(/]/g, ']]') + ']';
const sql = `SELECT TOP 50 ${table.columns.map(column => quote(column.columnName)).join(', ')} FROM ${quote(table.schemaName || 'dbo')}.${quote(table.tableName)} WHERE [EmployeeCode] = @query OR [EmployeeName] LIKE CONCAT('%', REPLACE(REPLACE(REPLACE(@query, '[', '[[]'), '%', '[%]'), '_', '[_]'), '%') ORDER BY [EmployeeCode], [EmployeeID]`;
const expected = rows => ({ employees: rows, count: rows.length, empty: rows.length === 0 });
const sample = { EmployeeCode: 'TEST_NV001', EmployeeName: 'Nhân viên thử nghiệm', DepartmentID: 1 };
const bundle = {
  manifest: { id: 'employee_lookup', name: 'Tra cứu thông tin nhân viên', version: 1, engineContractVersion: 1, domain: 'Nhân sự', tags: ['nhân viên', 'nhân sự', 'tra cứu'] },
  templates: [{
    id: 'employee_details', name: 'Tra cứu thông tin nhân viên', enabled: true,
    description: 'Tra cứu theo tên hoặc mã nhân viên, trả toàn bộ các cột của hồ sơ trong M_Employee. Tối đa 50 kết quả; nhiều người trùng tên thì dùng mã để tra cứu chính xác.',
    examples: ['Tra cứu thông tin nhân viên', 'Thông tin nhân viên tên Duy', 'Tra cứu nhân viên mã NV004', 'Tìm nhân viên theo tên', 'Xem đầy đủ thông tin nhân viên'],
    instructions: 'Chọn mẫu khi người dùng muốn tra cứu hồ sơ nhân viên theo tên hoặc mã. Lấy đúng tên/mã được nêu trong câu hỏi vào query; không đưa các từ tra cứu, nhân viên, tên, mã vào giá trị. Nếu chưa có tên/mã, hỏi bổ sung. Trả toàn bộ thông tin thực tế trong employees, giữ cả trường trống; không suy diễn tên phòng ban/chức danh từ ID. Nhiều kết quả thì hiển thị các nhân viên phù hợp, không tự chọn một người. Không có kết quả thì thông báo không tìm thấy. Nếu đủ 50 kết quả, yêu cầu tên đầy đủ hoặc mã để thu hẹp.',
    inputs: { query: { label: 'Tên hoặc mã nhân viên', ask: 'Bạn muốn tra cứu nhân viên tên gì hoặc có mã nào?', required: true, schema: { type: 'string', minLength: 1, maxLength: 100 } } },
    allowedCapabilities: ['sql.read'],
    bindings: { employee: { dbSourceId: table.dbSourceId, tables: [`${table.schemaName || 'dbo'}.${table.tableName}`], sql, parameters: { query: { slot: 'query', type: 'string' } } } },
    workflow: { steps: [{ id: 'lookup', name: 'Tìm hồ sơ theo tên hoặc mã nhân viên', type: 'sql', config: { bindingRef: 'employee' } }] },
    output: { mapping: { employees: '{{steps.lookup.rows}}', count: '{{steps.lookup.rowCount}}', empty: '{{steps.lookup.empty}}' }, schema: { type: 'object', properties: { employees: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: true } }, count: { type: 'integer' }, empty: { type: 'boolean' } }, required: ['employees', 'count', 'empty'], additionalProperties: false }, presentation: { labels: { employees: 'Hồ sơ nhân viên', count: 'Số nhân viên tìm thấy', empty: 'Không tìm thấy nhân viên', ...Object.fromEntries(table.columns.map(column => [`employees.${column.columnName}`, labels[column.columnName] || column.columnName])) }, emptyText: 'Không tìm thấy nhân viên phù hợp. Hãy kiểm tra lại tên hoặc mã.' } },
    fixtures: [
      { name: 'Tìm theo mã', input: { query: 'TEST_NV001' }, stepResults: { lookup: { rows: [sample], rowCount: 1, empty: false } }, expected: expected([sample]) },
      { name: 'Trùng tên trả nhiều nhân viên', input: { query: 'Nhân viên thử nghiệm' }, stepResults: { lookup: { rows: [sample, { ...sample, EmployeeCode: 'TEST_NV002' }], rowCount: 2, empty: false } }, expected: expected([sample, { ...sample, EmployeeCode: 'TEST_NV002' }]) },
      { name: 'Không tìm thấy', input: { query: 'TEST_NOT_FOUND' }, stepResults: { lookup: { rows: [], rowCount: 0, empty: true } }, expected: expected([]) }
    ]
  }]
};
require('../src/backend/automation/contract').validatePackage(bundle);
const destination = path.join(root, 'docs/templates/employee_lookup.json');
fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, JSON.stringify(bundle, null, 2) + '\n');
console.log('Created docs/templates/employee_lookup.json; columns:', table.columns.length);
if (process.argv.includes('--install') || process.argv.includes('--activate')) (async () => {
  const storage = require('../src/backend/storage'); storage.loadEnvironment();
  try {
    await storage.bootstrapStorage();
    await storage.run(async () => {
      const automation = require('../src/backend/automation'); const context = { accountId: 'local-template-setup', permissions: ['admin'] };
      const previous = await automation.repository.get('catalog', bundle.manifest.id);
      if (previous && require('../src/backend/automation/contract').hash(previous.draft) !== require('../src/backend/automation/contract').hash(bundle)) throw new Error('Mẫu đã tồn tại với nội dung khác; không ghi đè.');
      if (!previous) await automation.registry.import(bundle, context);
      const report = await automation.registry.test(bundle.manifest.id, context);
      console.log('Draft installed; fixtures passed:', report.passed);
      if (process.argv.includes('--activate')) {
        const live = await require('../src/backend/automation/sql').executeBinding(bundle.templates[0].bindings.employee, { query: 'TEST_EMPLOYEE_LOOKUP_NO_MATCH_20260926' }, { permissions: ['admin'], signal: AbortSignal.timeout(15000) });
        console.log('Live SQL smoke passed; returned rows:', live.rowCount);
        const current = await automation.repository.get('catalog', bundle.manifest.id);
        if (!current.published) await automation.registry.publish(bundle.manifest.id, context, current.revision);
        const settings = await automation.settings(); if (!settings.enabled) await automation.configure({ enabled: true, revision: settings.revision }, context);
        console.log('Published and chat workflow enabled.');
      }
    });
  } finally { await storage.close(); }
})().catch(error => { console.error('Install failed:', error.code || error.message); process.exitCode = 1; });
