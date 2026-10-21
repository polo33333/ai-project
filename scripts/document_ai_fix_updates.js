const fs = require('fs');
const path = require('path');
module.exports = base => {
  const evidence = name => {
    const file = path.join(base, name);
    return { file: name, capturedAt: fs.statSync(file).mtime.toISOString(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  };
  return {
    updatedAt: new Date().toISOString(),
    note: 'Giữ nguyên baseline 63 ca: 12 đạt, 42 không đạt, 9 cần đối chiếu. Chỉ các ca dưới đây đã được chạy lại; chưa chạy lại toàn bộ 63 ca sau các bản sửa. Các bằng chứng là snapshot tại thời điểm chạy lại, không chứng minh mọi lần gọi model đều ổn định.',
    cases: [
      { id: 'DOC-001', status: 'VERIFIED', label: 'Đã sửa và xác minh lại',
        change: 'Tách mô tả cấu trúc khỏi truy vấn bản ghi; sửa nhầm “về” thành yêu cầu vẽ biểu đồ; kết thúc dựa trên schema đã được cấp quyền.',
        outcome: 'Lượt chạy lại trả thông tin M_Customer, SUCCESS, một lần search_schema; không chạy SQL, không tạo biểu đồ. Luồng tổng hợp câu trả lời sau đó được cải thiện tiếp; chưa chạy lại riêng DOC-001 trên bản sửa cuối cùng.',
        scope: 'Xác minh lỗi fallback/đòi SQL hoặc biểu đồ trong lượt chạy này; chưa chứng minh diễn giải nghiệp vụ của mọi trường hoặc toàn bộ schema.',
        evidence: [evidence('fix-doc001-live.json')] },
      { id: 'DOC-002', status: 'VERIFIED', label: 'Đã sửa và xác minh lại',
        change: 'Tìm schema không được tự nâng câu hỏi giải thích thành yêu cầu đọc bản ghi. Tổng hợp tiêu chí từ các trường được cấu hình, không liệt kê mọi cột làm tiêu chí.',
        outcome: 'Hai lượt chạy lại đều SUCCESS: phiên mới nêu TypeID, CustomerGroupID, StageID, IsCompany; phiên có lịch sử nêu loại, nhóm và giai đoạn khách hàng. Không chạy SQL.',
        scope: 'Chưa xác minh danh mục/ý nghĩa từng giá trị ID và việc giao diện thực tế hỗ trợ lọc theo tất cả tiêu chí này.',
        evidence: [evidence('classification-fix-live.json'), evidence('classification-fix-history-live.json')] },
      { id: 'DOC-007', status: 'VERIFIED', label: 'Đã sửa và xác minh lại',
        change: 'Bổ sung loại yêu cầu guidance; giải thích đầu vào workflow thay vì tự chạy tra cứu. Không suy diễn mọi cột hợp đồng thành bộ lọc được hỗ trợ.',
        outcome: 'Phiên mới và phiên có lịch sử đều SUCCESS, trả lời cần tên khách hàng hoặc mã/số hợp đồng; chỉ đọc catalog, schema/tài liệu, không chạy workflow hoặc SQL nghiệp vụ.',
        scope: 'Xác minh hướng dẫn đầu vào; chưa kiểm tra mọi biến thể nhập hoặc trường hợp nhiều hợp đồng trùng tên.',
        evidence: [evidence('contract-help-before.json'), evidence('contract-help-history-live.json')] },
      { id: 'TRUST-05', status: 'PARTIAL', label: 'Đã sửa lỗi cộng trùng; cần hoàn thiện diễn đạt',
        change: 'Bổ sung đánh giá phạm vi nghiệp vụ trước calculate_expression: phân biệt khoản độc lập với hai nguồn có thể mô tả cùng nghĩa vụ/cùng kỳ.',
        outcome: 'Lượt chạy lại SUCCESS, không cộng thành 220 triệu và yêu cầu đối soát. Ca đối chứng hai khoản mua hàng độc lập vẫn cộng 220 triệu bằng calculate_expression.',
        scope: 'Câu trả lời chạy lại chưa nêu rõ con số chênh 20 triệu và chưa hỏi cụ thể thuế/phụ lục/khoản điều chỉnh. Vì thế chưa chuyển toàn bộ tiêu chí gốc thành PASS. Chốt kiểm tra dùng đánh giá của model, chưa chứng minh độ ổn định qua nhiều lần.',
        evidence: [evidence('conflict-amount-live.json'), evidence('independent-amounts-live.json')] }
    ],
    shared: [
      { name: 'Thông báo fallback', status: 'Đã đổi nội dung', detail: 'Câu mới: “Chưa thể hoàn tất yêu cầu. Vui lòng thử lại.” Áp dụng lượt trả lời mới; lịch sử cũ giữ nguyên. 32/32 kiểm thử liên quan đạt tại thời điểm sửa.' },
      { name: 'Ẩn phần lập kế hoạch khỏi đáp án', status: 'Đã bổ sung cơ chế; cần thêm ca thực tế', detail: 'Dùng khối final_answer và loại các khối reasoning có đánh dấu, kèm yêu cầu chỉ trả đáp án cuối theo ngôn ngữ câu hỏi. Kiểm thử protocol đạt; lượt DOC-001 chạy lại không có phần lập kế hoạch. Chưa có bằng chứng cơ chế nhận diện mọi đoạn lập kế hoạch không đánh dấu khi model không tuân thủ protocol.' },
      { name: 'Kiểm thử mã mới nhất', status: '748 đạt · 14 bỏ qua · 0 lỗi', detail: '762 ca kiểm thử tự động tại bản sửa mâu thuẫn số tiền. Đây là kiểm thử mã, không thay thế kết quả 63 ca nghiệp vụ hoặc chủ nghiệp vụ duyệt.' }
    ]
  };
};
