'use strict';
// Reviewed Vietnamese labels. Unknown business codes deliberately remain blank.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const storage = require('../src/backend/storage');
const labels = {
  CustomerID:'ID khách hàng', CustomerCode:'Mã khách hàng', CustomerName:'Tên khách hàng', CustomerGroupID:'Nhóm khách hàng',
  CompanyID:'ID đơn vị quản lý', CompanyCode:'Mã đơn vị quản lý', CompanyName:'Tên đơn vị quản lý',
  EmployeeID:'ID nhân viên', EmployeeCode:'Mã nhân viên', EmployeeName:'Tên nhân viên', DepartmentID:'Phòng ban', GenderID:'Giới tính', DOB:'Ngày sinh',
  VendorID:'ID nhà cung cấp', VendorCode:'Mã nhà cung cấp', VendorName:'Tên nhà cung cấp', VendorGroupID:'Nhóm nhà cung cấp',
  IndustrialParkID:'ID khu công nghiệp', IndustrialParkCode:'Mã khu công nghiệp', IndustrialParkName:'Tên khu công nghiệp',
  Note:'Ghi chú', Description:'Mô tả', Address:'Địa chỉ', ContactName:'Người liên hệ', Phone:'Số điện thoại', Mobile:'Số di động', Email:'Email', Fax:'Fax', TaxCode:'Mã số thuế', Representator:'Người đại diện',
  IsActive:'Đang hoạt động', isActive:'Đang hoạt động', CreateUser:'Người tạo', CreateDate:'Ngày tạo', UpdateUser:'Người cập nhật', UpdateDate:'Ngày cập nhật',
  ApproachID:'ID lần tiếp cận', ContactDate:'Ngày liên hệ', OwnerID:'Người phụ trách', ChannelID:'Kênh tiếp cận', InterestLevelID:'Mức độ quan tâm',
  NegotiateID:'ID lần thương lượng', NegotiationDate:'Ngày thương lượng', DiscussedTopics:'Nội dung thảo luận', CustomerRequests:'Yêu cầu của khách hàng', InternalFeedback:'Phản hồi nội bộ', ResultID:'Mã kết quả',
  QuoteID:'ID báo giá', QuoteNumber:'Số báo giá', SentDate:'Ngày gửi', ProductsOrServices:'Sản phẩm hoặc dịch vụ', PaymentTerms:'Điều khoản thanh toán', ExpiryDate:'Ngày hết hạn', Version:'Phiên bản',
  SurveyID:'ID khảo sát', SurveyDate:'Ngày khảo sát', SurveyorID:'Người khảo sát', MethodID:'Phương thức khảo sát', Requirements:'Yêu cầu', CurrentProducts:'Sản phẩm hiện tại', Issues:'Vấn đề', Goals:'Mục tiêu',
  ConstantID:'ID danh mục dùng chung', ConstantType:'Loại danh mục dùng chung', ConstantName:'Tên danh mục dùng chung', MasterID:'ID danh mục phân loại', MasterType:'Loại danh mục',
  DataLockID:'ID khóa dữ liệu', LockDate:'Ngày khóa dữ liệu', IsLock:'Đã khóa', PriceID:'ID bảng giá', ElectricityTypeID:'Loại điện', CurrencyID:'Loại tiền',
  UserID:'ID tài khoản', UserName:'Tên tài khoản', UserDesc:'Mô tả tài khoản',
  ContractID:'ID hợp đồng', ContractNo:'Số hợp đồng', ContractDate:'Ngày hợp đồng', ContractTypeID:'Loại hợp đồng', TotalArea:'Tổng diện tích', StatusID:'Trạng thái',
  ContractDetailID:'ID chi tiết hợp đồng', ContractLandID:'ID đất theo hợp đồng', ContractPaymentID:'ID đợt thanh toán hợp đồng',
  StartDate:'Ngày bắt đầu', EndDate:'Ngày kết thúc', FromDate:'Từ ngày', ToDate:'Đến ngày', Area:'Diện tích', Qty:'Số lượng', Price:'Đơn giá', ExchangeRate:'Tỷ giá', Amount:'Số tiền', TotalAmount:'Tổng số tiền', PreAmount:'Thành tiền trước thuế', VATAmount:'Tiền thuế VAT', FinalAmount:'Thành tiền sau thuế', PreTotalAmount:'Tổng tiền trước thuế', VATTotalAmount:'Tổng thuế VAT', FinalTotalAmount:'Tổng tiền sau thuế',
  CustomerDebtID:'ID công nợ khách hàng', DebtDate:'Ngày công nợ', InvoiceNo:'Số hóa đơn',
  OpeningBalance_Debit:'Số dư Nợ đầu kỳ', OpeningBalance_Credit:'Số dư Có đầu kỳ', CurrentPeriodAmount_Debit:'Phát sinh Nợ trong kỳ', CurrentPeriodAmount_Credit:'Phát sinh Có trong kỳ', ClosingBalance_Debit:'Số dư Nợ cuối kỳ', ClosingBalance_Credit:'Số dư Có cuối kỳ',
  ElectricityInputID:'ID chứng từ điện đầu vào', ElectricityInputCode:'Số chứng từ điện đầu vào', ElectricityInputDate:'Ngày chứng từ điện đầu vào',
  ElectricityOutputID:'ID chứng từ điện bán ra', ElectricityOutputCode:'Số chứng từ điện bán ra', ElectricityOutputDate:'Ngày chứng từ điện bán ra', ElectricityOutputDetailID:'ID chi tiết điện bán ra', MeterTypeID:'Loại công tơ', ClockNo:'Số công tơ', TotalQty:'Tổng sản lượng', OldIndex:'Chỉ số cũ', NewIndex:'Chỉ số mới', Multiplier:'Hệ số nhân',
  ExpenseID:'ID phiếu chi', ExpenseCode:'Số phiếu chi', ExpenseDate:'Ngày phiếu chi', ExpenseDetailID:'ID chi tiết phiếu chi', ExpenseTypeID:'Loại chi', Reason:'Lý do',
  FactoryForRentID:'ID chứng từ thuê nhà xưởng', FFRCode:'Số chứng từ thuê nhà xưởng', FFRDate:'Ngày chứng từ thuê nhà xưởng',
  FeedbackID:'ID phản ánh', FeedbackDate:'Ngày phản ánh', FeedbackTypeID:'Loại phản ánh', SenderName:'Tên người gửi', Title:'Tiêu đề', ReceptionDepartmentID:'Phòng ban tiếp nhận', RecipientID:'Người tiếp nhận', ResponseDate:'Ngày phản hồi', ProcessingDate:'Ngày xử lý', FeedbackDetailID:'ID chi tiết phản ánh', HandleDate:'Ngày xử lý', HandleWork:'Nội dung xử lý', Comment:'Ý kiến',
  GarbageInputID:'ID chứng từ rác đầu vào', GarbageInputCode:'Số chứng từ rác đầu vào', GarbageInputDate:'Ngày chứng từ rác đầu vào', GarbageOutputID:'ID chứng từ rác đầu ra', GarbageOutputCode:'Số chứng từ rác đầu ra', GarbageOutputDate:'Ngày chứng từ rác đầu ra', QtyKg:'Khối lượng (kg)', QtyTon:'Khối lượng (tấn)',
  GasPipelineForRentID:'ID chứng từ thuê đường ống khí', GasPipelineForRentDate:'Ngày chứng từ thuê đường ống khí',
  InfrastructureID:'ID hạ tầng', InfrastructureTypeID:'Loại hạ tầng', InfrastructureName:'Tên hạ tầng', ManfactureDate:'Ngày sản xuất', Origin:'Xuất xứ', InfrastructureMaintainID:'ID lần bảo trì hạ tầng', MaintainDate:'Ngày bảo trì', MaintainEmployeeID:'Nhân viên bảo trì', Solution:'Giải pháp', ResultDate:'Ngày có kết quả', Result:'Kết quả',
  LandFeeForRentID:'ID chứng từ tiền thuê đất', LFFRCode:'Số chứng từ tiền thuê đất', LFFRDate:'Ngày chứng từ tiền thuê đất', LandTaskForRentID:'ID lô đất', LandLot:'Mã lô đất', LandArea:'Diện tích lô đất', LocationX:'Tọa độ X', LocationY:'Tọa độ Y', Coordinates:'Tọa độ',
  LightID:'ID đèn', LightTypeID:'Loại đèn', LightName:'Tên đèn', Specification:'Thông số kỹ thuật', InstallationTime:'Thời gian lắp đặt', LightMaintainID:'ID lần bảo trì đèn', LTFRentDetailID:'ID chi tiết thuê lô đất',
  RevenueID:'ID phiếu thu', RevenueCode:'Số phiếu thu', RevenueDate:'Ngày phiếu thu', RevenueDetailID:'ID chi tiết phiếu thu', RevenueTypeID:'Loại thu', WaterInputID:'ID chứng từ nước đầu vào', WaterOutputID:'ID chứng từ nước đầu ra', WaterDate:'Ngày chứng từ nước'
};
const scoped = {M_Master:{Code:'Mã danh mục',Name:'Tên danh mục'},T_ContractPayment:{Stage:'Đợt thanh toán'}};
async function main() {
  storage.loadEnvironment(); await storage.bootstrapStorage();
  const dir = 'artifacts/column-display-names'; fs.mkdirSync(dir,{recursive:true});
  const report = {tables:[],updated:0,preserved:0,skipped:[],applied:process.argv.includes('--apply')};
  let before;
  try {
    await storage.run(async()=>{
      const d = require('../src/backend/services/dictionary_service');
      before = structuredClone(d.tablesStore);
      if(report.applied)fs.writeFileSync(`${dir}/backup-${Date.now()}.json`,JSON.stringify(before,null,2));
      for(const t of d.tablesStore.filter(t=>t.isActive&&!t.schemaMissing)) {
        const changes=[];
        for(const c of t.columns.filter(c=>c.isVisible!==false)) {
          if(c.displayName?.trim()){report.preserved++;continue;}
          const displayName = scoped[t.tableName]?.[c.columnName] || labels[c.columnName];
          if(displayName)changes.push({columnName:c.columnName,displayName});
          else report.skipped.push({table:t.tableName,column:c.columnName});
        }
        if(report.applied&&changes.length)await d.saveTableConfiguration({tableId:t.tableId,columns:changes});
        report.tables.push({tableId:t.tableId,table:t.tableName,changes});report.updated+=changes.length;
      }
    });
    if(report.applied)await storage.run(async()=>{
      const after = require('../src/backend/services/dictionary_service').tablesStore;
      const expected=structuredClone(before);
      for(const t of report.tables)for(const c of t.changes)expected.find(x=>x.tableId===t.tableId).columns.find(x=>x.columnName===c.columnName).displayName=c.displayName;
      assert.deepStrictEqual(after,expected,'Unexpected metadata change');
      report.verified=true;
    });
    fs.writeFileSync(`${dir}/${report.applied?'result':'preview'}.json`,JSON.stringify(report,null,2));
    console.log(JSON.stringify({tables:report.tables.length,updated:report.updated,preserved:report.preserved,skipped:report.skipped.length,verified:report.verified,skippedNames:[...new Set(report.skipped.map(c=>c.column))]}));
  }finally {await storage.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
