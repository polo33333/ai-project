'use strict';
// User-authorized metadata deployment. Uses the configured live store, not stale JSON.
const fs = require('node:fs');
const path = require('node:path');
const storage = require('../src/backend/storage');
storage.loadEnvironment();
const sourceId = 'db-src-1785684548077';
// entity, domain, business guidance. Unconfirmed meanings remain explicit.
const configs = {
 M_Master:['Danh mục phân loại','reference','Phân loại theo MasterType; MasterID là khóa, Code/Name là mã/tên. Chỉ giải nghĩa mã khi đã xác minh loại danh mục và quan hệ; không join mọi ID vào MasterID. Parameter1/2 và ParentID cần đối chiếu nghiệp vụ.'],
 M_Constant:['Danh mục dùng chung','reference','Phân loại theo ConstantType; ConstantID là khóa, ConstantName là tên. Parameter chưa xác minh ý nghĩa. Không tự suy mã kỳ, nhóm, trạng thái từ tên cột.'],
 M_Price:['Biểu giá dịch vụ','pricing','Giá theo TypeID, ElectricityTypeID, CurrencyID và StartDate. Price1..4 chưa xác minh loại giờ/bậc giá, đơn vị và thuế. Không tự coi bản ghi mới nhất là giá áp dụng cho mọi khách hàng; cần xác minh ưu tiên với giá hợp đồng.'],
 T_ContractDetail:['Chi tiết giá hợp đồng','contract','Nhiều dòng thuộc ContractID. Giá theo TypeID, ElectricityTypeID, CurrencyID, StartDate. Price1..4 cần xác minh nghĩa. Không cộng các đơn giá; UpdateDate/UpdateUser không phải lịch sử đầy đủ các lần sửa.'],
 T_ContractPayment:['Đợt và số tiền hợp đồng','contract','Nhiều dòng theo ContractID, Stage và Amount. Chưa xác minh Amount là nghĩa vụ hay tiền thực thu. Không kết luận đã thanh toán/quá hạn; chưa có hạn thanh toán hoặc phân bổ thu trong schema này.'],
 T_Revenue:['Phiếu thu','finance','Một phiếu theo RevenueID; RevenueCode là số phiếu, RevenueDate là ngày, CustomerID là khách hàng, TotalAmount là tổng phiếu. Không coi phiếu thu là phân bổ vào hóa đơn/hợp đồng khi chưa có khóa liên kết.'],
 T_RevenueDetail:['Chi tiết phiếu thu','finance','Nhiều khoản thu thuộc RevenueID; TypeID/RevenueTypeID phân loại, Amount là tiền từng dòng. Khi join đầu phiếu không cộng lặp TotalAmount. Chưa có khóa nghĩa vụ để đối soát allocation.'],
 T_Expense:['Phiếu chi','finance','Một phiếu theo ExpenseID; ExpenseCode là số phiếu, ExpenseDate là ngày, VendorID là nhà cung cấp, TotalAmount là tổng phiếu. Liên kết chi tiết qua ExpenseID.'],
 T_ExpenseDetail:['Chi tiết phiếu chi','finance','Nhiều khoản mục chi thuộc ExpenseID; ExpenseTypeID là loại chi cần danh mục xác minh, Amount là tiền từng dòng. Không cộng lặp tổng đầu phiếu sau join.'],
 T_CustomerDebt:['Công nợ khách hàng','finance','Bản ghi công nợ theo CustomerDebtID, CustomerID, DebtDate và InvoiceNo. OpeningBalance là đầu kỳ, CurrentPeriodAmount là phát sinh, ClosingBalance là cuối kỳ; Debit/Credit cần quy tắc bù trừ nghiệp vụ. Không cộng số dư nhiều ngày thành tổng nợ. Không suy hạn nợ từ DebtDate.'],
 M_Vendor:['Nhà cung cấp','vendor','Một nhà cung cấp theo VendorID; VendorCode/VendorName là mã/tên. Phân biệt với khách hàng M_Customer và đơn vị quản lý M_Company.'],
 M_IndustrialPark:['Khu công nghiệp','land','Một khu công nghiệp theo IndustrialParkID; mã/tên và đơn vị CompanyID. Không suy diện tích đất thương phẩm từ địa chỉ hoặc số khách hàng.'],
 T_LandTaskForRent:['Danh mục lô đất','land','Một lô theo LandTaskForRentID; LandLot là mã lô, LandArea là diện tích cần xác nhận đơn vị; LocationX/Y, Coordinates cần xác minh hệ tọa độ và định dạng. ParentID chỉ là quan hệ cha-con chưa chứng minh lịch sử tách/gộp. StatusID cần danh mục; xác định đất trống theo hiệu lực thuê tại asOf, không chỉ trạng thái hiện tại.'],
 T_ContractLand:['Lô đất trong hợp đồng','land','Bảng liên kết ContractID với LandTaskForRentID; Area là diện tích trên dòng liên kết. Tránh cộng lặp diện tích khi join nhiều chi tiết hoặc nhiều hợp đồng.'],
 T_LTFRentDetail:['Chi tiết thuê lô đất','land','Liên kết LandTaskForRentID, ContractID, CustomerID; Area, Qty và hiệu lực StartDate/EndDate. Xác minh biên ngày và đơn vị trước khi tính đất trống/lấp đầy; không tính trùng các khoảng thuê chồng nhau.'],
 T_FactoryForRent:['Phí thuê nhà xưởng','service','Chứng từ phí thuê nhà xưởng theo khách hàng, FromDate/ToDate, Area, Price, ExchangeRate. PreAmount/VATAmount/FinalAmount là trước thuế/thuế/sau thuế; không cộng ba trường thành doanh thu.'],
 T_GasPipelineForRent:['Phí thuê đường ống','service','Chứng từ phí đường ống theo CustomerID, FromDate/ToDate, Qty, Revenue. Xác minh ý nghĩa Revenue và công thức giá; không coi Revenue mặc nhiên là đơn giá.'],
 T_LandFeeForRent:['Phí thuê đất','service','Chứng từ phí thuê đất theo CustomerID, FromDate/ToDate, Area, Price, ExchangeRate. Phân biệt phí phát sinh, số dư và thực thu.'],
 T_WaterInput:['Nước đầu vào','water','Chứng từ nước mua vào theo VendorID, ClockNo, FromDate/ToDate; OldIndex/NewIndex, Qty, Price và tiền thuế. Xác minh đơn vị, kỳ và phạm vi trước khi so sánh với nước bán ra.'],
 T_WaterOutput:['Nước và khoản phí liên quan','water','Chứng từ theo CustomerID, WaterDate, FromDate/ToDate và công tơ. Có hai nhóm Qty1/Price1/PreAmount1/VATAmount1/FinalAmount1 và Qty2/Price2/ExchangeRate2/PreAmount2/VATAmount2/FinalAmount2. Chưa xác minh nhóm nào là nước sạch/nước thải; không tự gán nghĩa hoặc cộng hai sản lượng. Không coi PaymentDate là hạn trả khi chưa xác minh.'],
 T_GarbageInput:['Rác đầu vào','garbage','Chứng từ theo nhà cung cấp và FromDate/ToDate; Qty120..Qty660, QtyKg, QtyTon là các lượng cần xác minh đơn vị và quy đổi. Không cộng trực tiếp các lượng khác đơn vị.'],
 T_GarbageOutput:['Phí rác khách hàng','garbage','Chứng từ theo CustomerID và FromDate/ToDate; Qty120..Qty660, QtyKg, QtyTon cần xác minh đơn vị/quy đổi. Tách tiền trước thuế, thuế, sau thuế, số dư và thực thu.'],
 T_Feedback:['Yêu cầu và phản ánh khách hàng','crm','Yêu cầu theo FeedbackID, CustomerID, FeedbackDate; kênh FormID, loại FeedbackTypeID, bộ phận ReceptionDepartmentID/DepartmentID, người RecipientID/EmployeeID, trạng thái StatusID. TransferDate/ResponseDate/ProcessingDate cần xác minh nghĩa; chưa có đủ hạn SLA/lịch làm việc để kết luận trễ SLA. Không tự tạo ticketCode nếu schema chỉ có ID.'],
 T_FeedbackDetail:['Nhật ký xử lý phản ánh','crm','Nhiều dòng theo FeedbackID; HandleDate, HandleWork, Comment mô tả các lần xử lý. Không mặc nhiên xem đây là lịch sử chuyển người/trạng thái đầy đủ hoặc nguồn tệp đính kèm.'],
 T_Infrastructure:['Tài sản hạ tầng','maintenance','Tài sản theo InfrastructureID; loại, tên, trạng thái, ngày, vị trí. ExpiryDate cần xác minh nghĩa, không tự coi là hạn bảo trì.'],
 T_InfrastructureMaintain:['Bảo trì hạ tầng','maintenance','Nhiều lần bảo trì theo InfrastructureID; MaintainDate, MaintainEmployeeID, Reason, Solution, ResultDate, Result, Amount. Chưa xác minh ngày kế hoạch và trạng thái hoàn tất; không kết luận quá hạn chỉ vì ResultDate rỗng.'],
 T_Light:['Thiết bị đèn','maintenance','Thiết bị theo LightID; tên, loại, vị trí, thông số, InstallationTime, StatusID. Không suy chu kỳ bảo trì từ thời gian lắp đặt.'],
 T_LightMaintain:['Bảo trì đèn','maintenance','Nhiều lần bảo trì thuộc LightID; ngày MaintainDate, người MaintainEmployeeID, giải pháp, kết quả, ResultDate và Amount. Thiếu lịch kế hoạch thì chỉ tra lịch sử, chưa kết luận quá hạn.'],
 BS_Approach:['Lịch sử tiếp cận khách hàng','crm','Hoạt động theo ApproachID, CustomerID, ContactDate, OwnerID, ChannelID. Phân biệt ngày liên hệ với CreateDate. Chưa có khóa chiến dịch để trả chiến dịch gần nhất.'],
 BS_Survey:['Khảo sát khách hàng','crm','Lần khảo sát theo SurveyID, CustomerID, SurveyDate, SurveyorID; yêu cầu, vấn đề, mục tiêu. IsTransfer/TransferDate cần xác minh; SurveyDate không mặc nhiên là ngày vào bước khảo sát.'],
 BS_Negotiate:['Thương lượng khách hàng','crm','Lần thương lượng theo NegotiateID, CustomerID, NegotiationDate, OwnerID; nội dung, yêu cầu, phản hồi và ResultID cần danh mục. Không suy lịch sử bước từ StageID hiện tại.'],
 BS_Quote:['Báo giá khách hàng','crm','Báo giá theo QuoteID, CustomerID, QuoteNumber, SentDate, ExpiryDate, Version, OwnerID. Không coi báo giá là hợp đồng hay doanh thu thực tế.'],
 M_DataLock:['Khóa dữ liệu nghiệp vụ','reference','Bản ghi theo DataLockID, LockDate, EmployeeID, IsLock, CompanyID. Cần xác minh phạm vi ngày/kỳ và bảng chịu khóa. Chỉ tra cứu; chỉnh dữ liệu kỳ khóa cần workflow và quyền phù hợp.']
};
const common = {
 CustomerID:'Khóa tham chiếu khách hàng M_Customer.CustomerID; tên/mã lấy từ CustomerName/CustomerCode.',
 ContractID:'Khóa tham chiếu hợp đồng T_Contract.ContractID; số hợp đồng là ContractNo.',
 CompanyID:'Đơn vị quản lý/vận hành M_Company.CompanyID; không phải khách hàng.',
 VendorID:'Khóa nhà cung cấp M_Vendor.VendorID.',
 CreateDate:'Thời điểm tạo bản ghi; không thay ngày chứng từ, ngày hiệu lực hoặc ngày chuyển bước.',
 UpdateDate:'Lần cập nhật gần nhất; không phải toàn bộ lịch sử thay đổi.',
 CreateUser:'Người tạo bản ghi; cần xác minh kiểu định danh tài khoản.',
 UpdateUser:'Người cập nhật gần nhất; không chứng minh ai sửa từng giá trị trong lịch sử.',
 FromDate:'Đầu khoảng nghiệp vụ; xác minh quy tắc biên ngày và kỳ trước khi lọc.',
 ToDate:'Cuối khoảng nghiệp vụ; không mặc nhiên đồng nhất tháng lịch.',
 StartDate:'Ngày bắt đầu hiệu lực; cần đối chiếu quy tắc chọn bản ghi áp dụng.',
 EndDate:'Ngày kết thúc hiệu lực; NULL không tự coi là đã hết hạn.',
 PaymentDate:'Ngày liên quan thanh toán; chưa xác minh là ngày trả thực tế hay hạn trả. Không tự dùng làm due date.',
 PreAmount:'Thành tiền trước thuế của dòng/chứng từ.', VATAmount:'Tiền thuế của dòng/chứng từ.', FinalAmount:'Thành tiền sau thuế; không cộng thêm PreAmount/VATAmount.',
 Amount:'Số tiền của bản ghi; ý nghĩa nghĩa vụ, thực thu hay chi phí phụ thuộc bảng.',
 Price:'Đơn giá; xác minh đơn vị tính và cơ sở thuế trước khi tính toán.',
 CurrencyID:'Mã loại tiền; cần danh mục xác minh, không cộng các loại tiền khi chưa quy đổi.',
 ExchangeRate:'Tỷ giá áp dụng; cần xác minh chiều quy đổi và đồng tiền.',
 Note:'Ghi chú nghiệp vụ; không phải nguồn mã trạng thái hoặc công thức được xác minh.'
};
async function main(){
 await storage.bootstrapStorage();
 const dir=path.resolve('artifacts/ipms-testcase-catalog');fs.mkdirSync(dir,{recursive:true});
 const stamp=Date.now();const report={backend:process.env.APP_STORAGE_BACKEND,sourceId,startedAt:new Date().toISOString(),tables:[],relationships:[]};
 try{
  await storage.run(async()=>{
   const d=require('../src/backend/services/dictionary_service');
   fs.writeFileSync(path.join(dir,`backup-${stamp}.private.json`),JSON.stringify({tables:d.tablesStore,relationships:d.tableRelationships},null,2),{mode:0o600});
   for(const [name,[entity,domain,guidance]] of Object.entries(configs)){
    const t=d.tablesStore.find(t=>t.dbSourceId===sourceId&&t.tableName===name);if(!t)throw Error('Missing '+name);
    const visible=t.columns.filter(c=>c.isVisible!==false);
    const pk=visible.find(c=>c.isPrimaryKey)||visible[0];
    const semanticModel=t.semanticModel||{version:1,entity,kind:name.endsWith('Detail')?'detail':name.startsWith('M_')?'lookup':'transaction',grain:`Một bản ghi ${entity.toLowerCase()}, định danh bởi ${pk.columnName}.`,identityFields:[pk.columnName],summaryFields:visible.slice(0,8).map(c=>c.columnName),aliases:[entity.toLowerCase()],segments:[]};
    const columns=[];
    for(const c of t.columns){
     const generic=!c.description||/^Cột |^Cá»™t /.test(c.description);
     let description=common[c.columnName];
     if(/^Price[1-4]$/.test(c.columnName))description='Mức giá '+c.columnName+'; chưa xác minh loại giờ/bậc, đơn vị và thuế. Không tự gán cao điểm/thấp điểm.';
     if(/^ClosingBalance_/.test(c.columnName))description='Số dư cuối kỳ '+c.columnName+'; không cộng qua nhiều kỳ/ngày. Xác minh grain, nợ/có và phạm vi trước khi tổng hợp.';
     if(generic&&description)columns.push({columnName:c.columnName,description});
    }
    const wasActive=t.isActive;
    await d.saveTableConfiguration({tableId:t.tableId,table:{isActive:true,description:`${entity}. ${guidance} Chỉ trả dữ liệu thực tế trong phạm vi được phép; không có dòng khác với giá trị 0. Khi join 1-n, tổng hợp đúng grain để tránh nhân số tiền/diện tích.`,domain,semanticModel},columns});
    report.tables.push({name,activated:!wasActive,columnsUpdated:columns.length});
   }
  });
  await storage.run(async()=>{
   const d=require('../src/backend/services/dictionary_service');
   report.activeTables=d.tablesStore.filter(t=>t.dbSourceId===sourceId&&t.isActive).length;
   const projected=require('../src/backend/services/semantic_model').project(d.tablesStore.filter(t=>t.dbSourceId===sourceId&&t.isActive),{operation:'describe'},d.tableRelationships);
   if(!Object.keys(configs).every(n=>projected.tables.some(t=>t.tableName===n&&t.description&&t.semanticModel)))throw Error('Projection verification failed');
   report.projectionVerified=true;
   report.vectorSync=await d.syncToQdrant({defer:false});
  });
  report.completedAt=new Date().toISOString();fs.writeFileSync(path.join(dir,'deployment.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await storage.close();}
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
module.exports={configs,common};
