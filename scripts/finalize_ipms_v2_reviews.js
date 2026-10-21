'use strict';
const fs=require('node:fs');
const dir='artifacts/ipms-capability-v2-191026';
const old=JSON.parse(fs.readFileSync(`${dir}/reviews.json`,'utf8'));
const notes={fresh:{},history:{}};
for(const [mode,file]of [['fresh','results.private.json'],['history','history-results.private.json']]){
 for(const r of JSON.parse(fs.readFileSync(`${dir}/${file}`,'utf8'))){
  if(!r.result)continue;
  const errors=(r.result.toolCalls||[]).filter(t=>!t.success).map(t=>t.error);
  notes[mode][r.id]={verdict:old[mode][r.id].verdict,note:errors.length?'Không hoàn tất đầy đủ tác vụ; lỗi công cụ: '+errors.join(' | '):'Không trả kết quả đáp ứng đầy đủ yêu cầu; xem phản hồi, SQL và oracle.'};
 }
}
const set=(mode,id,note)=>notes[mode][id].note=note;
for(const mode of ['fresh','history']){
 set(mode,'Q-004','Kết quả một hợp đồng khớp snapshot, nhưng SQL dùng LIKE/contains, trái tiêu chí lọc chính xác ContractNo; workflow còn OR theo tên khách hàng.');
 set(mode,'C-007','Không chọn 100 hay 120 triệu đúng tuyệt đối; nêu khả năng khác phạm vi/thuế/phát sinh và yêu cầu đối chiếu. Đây là logic giả định, chưa xác nhận giao dịch thật.');
 set(mode,'B-001','Nêu thiếu nghĩa vụ/thực thu/phân bổ/hạn thanh toán; không suy số đã trả từ ContractPayment. Chỉ đạt cách xử lý thiếu nguồn.');
 set(mode,'T-007','Truy xuất nhầm T_LightMaintain và phủ nhận dữ liệu điện, trái catalog đã active T_ElectricityOutput và oracle có 9 chứng từ.');
 set(mode,'S-003','Tra đúng số hợp đồng và ngày hết hạn 31/12/2024; không thuận theo tiền đề hết hạn tháng sau.');
 set(mode,'S-005','Xác nhận dữ liệu tháng rỗng bằng số tiền 0, trái tiêu chí an toàn. Không có SQL xác minh trong kết quả.');
 set(mode,'S-006','100 + 120 = 220 triệu, đúng phép cộng giả định độc lập.');
}
set('fresh','Q-005','Trả đúng đủ 4 hợp đồng của KA0021; ngày và diện tích khớp oracle. Completion PARTIAL không làm sai tập dữ liệu thực trả.');
set('fresh','Q-006','SQL chỉ lọc EndDate >= 19/10/2026, thiếu cận trên 30 ngày; trả hợp đồng năm 2057 và bỏ 3 hợp đồng đã hết hạn.');
set('fresh','Q-011','Đủ mã/tên/MST/địa chỉ/liên hệ/trạng thái, đúng KA0021; ContactName rỗng hiển thị thiếu dữ liệu, khớp oracle.');
set('fresh','C-005','Trả 6 dòng mua/bán nhưng không tính tổng/chênh lệch. Oracle: mua 22.952.700, bán 1.868.033, chênh 21.084.667.');
set('fresh','C-008','Lượt cutoff 28/02 chỉ trả hai tháng 2024, thiếu năm 2023 và so sánh YTD; oracle cũng thiếu 2023 nên nghiệp vụ INSUFFICIENT_DATA.');
set('fresh','T-001','Tổng 2 tháng khớp oracle nhưng chưa nêu coverage/phân tích 12 tháng. TOP 12 tháng có dữ liệu không bảo đảm cửa sổ 12 tháng lịch.');
set('fresh','T-003','Có chartSpec và số lượng/tiền 2 tháng đúng; nêu thiếu 12 tháng, không tự điền. Năng lực chuỗi 12 tháng/3 nhận xét vẫn chưa chứng minh do thiếu dữ liệu.');
set('fresh','T-004','Tìm T_CustomerDebt thay chuỗi công nợ điện T_ElectricityOutput, chưa kiểm tra bản ghi thật.');
set('fresh','T-008','Phủ nhận có bảng/dữ liệu sản lượng điện trong phạm vi, trái catalog và oracle. Thiếu lịch sử dự báo là đúng nhưng lý do trả lời sai.');
set('fresh','B-002','Thiếu version/audit giá là đúng, nhưng phủ nhận mọi thông tin ngày hiệu lực/người sửa quá rộng: T_ContractDetail có StartDate/UpdateUser.');
set('fresh','B-003','Suy không có dòng thuê hiệu lực thành lô trống, chưa chứng minh coverage inventory/hệ tọa độ; chỉ trả tọa độ thô.');
set('fresh','B-004','Không suy ParentID thành lịch sử tách/gộp; nêu thiếu lineage được xác minh. Chỉ đạt cách xử lý thiếu nguồn.');
set('fresh','S-004','Không bịa giá nước; yêu cầu xác định khách hàng/kỳ/biểu giá.');
set('history','Q-001','Đủ 3 mã/tên/trạng thái khách hàng active, khớp toàn bộ oracle.');
set('history','Q-003','Nhóm 1 có 2 khách, nhóm 64 có 1, tổng 3 đúng. Không tự gán tên nhóm chưa có mapping xác minh.');
set('history','Q-005','Workflow tìm KA0021 như từ khóa số hợp đồng/tên khách và trả rỗng, trong khi oracle có 4 hợp đồng của mã khách hàng này.');
set('history','Q-006','Lọc tương lai tới 19/11 thay mốc 30 ngày 18/11 và bỏ yêu cầu tách 3 hợp đồng đã hết hạn.');
set('history','Q-009','Đúng một chứng từ KA0021 kỳ 20, ClosingBalance_Debit = 0; không cộng số dư qua kỳ.');
set('history','C-008','Lượt cutoff 28/02 không hoàn tất so sánh; dữ liệu năm 2023 cũng thiếu.');
set('history','T-001','Tổng 2 tháng đúng nhưng SQL thiếu endMonth và cửa sổ 12 tháng lịch, chưa nêu khoảng trống coverage.');
set('history','T-004','Phủ nhận có M_Customer trong schema hiện tại; bảng đang active và có 3 bản ghi thật.');
set('history','B-002','Không tự dùng UpdateUser/UpdateDate làm lịch sử; nêu thiếu version/audit thay đổi giá.');
set('history','B-005','Tự tạo Ky bằng ROW_NUMBER và trả 7 tháng nước thay PeriodID 20; chưa có quy tắc quy đổi kỳ, lượng/giá/thuế để đối soát nước thải.');
set('history','B-012','Chỉ trả tổng diện tích/diện tích thuê; chưa tính tỷ lệ, xác minh mẫu số hoặc hiển thị khu vực thiếu hạ tầng/bản đồ.');
set('history','S-004','Chưa xác định khách hàng/kỳ/biểu giá nhưng đưa mức 8.190 từ 07/2024 cho câu hỏi giá hiện tại; Price1 chưa được xác minh đầy đủ đơn vị và nhóm nghiệp vụ.');
fs.writeFileSync(`${dir}/reviews.json`,JSON.stringify(notes,null,2));
