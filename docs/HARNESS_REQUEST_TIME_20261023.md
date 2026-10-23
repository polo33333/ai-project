# Ngày tham chiếu của harness

Đã thêm cơ chế dùng chung trong `src/backend/services/request_time.js`. Không có điều kiện theo mã khách hàng, bảng hợp đồng hay tên provider.

## Hành vi

- Mỗi lượt hỏi lấy một snapshot thời gian backend, dùng lịch `Asia/Ho_Chi_Minh`. Cùng snapshot được cấp cho main agent, memory resolution, semantic review, workflow preference và hai công cụ ngày. Không lấy ngày mới nhất trong dữ liệu làm “hôm nay”.
- Câu hỏi hiện tại/tương đối được kiểm tra trước khi SQL thực thi và kiểm tra lại khi chọn bằng chứng trả lời. Ngày trong điều kiện trên cột date/datetime phải có căn cứ từ snapshot, khoảng lịch backend hoặc ngày người dùng nêu rõ. Chuỗi giống ngày trong cột mã không được xem là bộ lọc thời gian.
- Structured query hỗ trợ `{anchorDate:"today",offsetDays:N}`; backend tính ngày lịch, không yêu cầu model tự tính. Ngày lịch sử tường minh vẫn được giữ nguyên.
- Trước ngày hôm nay là đã qua hạn; ngày kết thúc hôm nay thuộc nhóm chưa qua hạn. “N ngày tới” dùng khoảng `[hôm nay, hôm nay + N)`; khoảng có đầu bao gồm/cuối không bao gồm, không dùng `23:59:59` nên không bỏ phần mili giây.
- “Sắp đến hạn” không tự mặc định 30 ngày. Số ngày do người dùng chỉ định có ưu tiên; nếu chưa có thì có thể dùng cấu hình được quản trị chấp thuận. Khi chưa xác định được ngưỡng, trả câu hỏi bổ sung và trạng thái PARTIAL; nếu đã tra được nhóm hết hạn thì vẫn hiển thị nhóm đó.
- Công cụ ngày và câu hỏi nối tiếp dùng lại quy tắc múi giờ, nhưng mỗi lượt mới lấy snapshot mới. Chỉ kế thừa yêu cầu thời gian trước khi resolver xác nhận là follow-up dùng dữ liệu hiện tại; không lấy lịch sử làm mốc hôm nay.
- Yêu cầu đang chờ số ngày được lưu như task theo phiên/tài khoản/nguồn CSDL, không phải tham chiếu hợp đồng hay dữ liệu. Vì vậy trả lời “30 ngày” có thể tiếp tục tra cứu; task không được dùng làm bằng chứng cho một bản ghi cụ thể hoặc dataset lịch sử. Retry nhận PARTIAL chỉ thiếu ngưỡng khi đã có SQL được xác minh và không còn lỗi tiêu chí khác.
- SQL không được thay NULL bằng một ngày cũ để tự coi là hết hạn. Không tự suy mã trạng thái hoặc loại hợp đồng gia hạn/thanh lý khi thiếu metadata đã xác minh. Kết quả theo EndDate không chứng minh tình trạng pháp lý/hợp đồng đã gia hạn ngoài dữ liệu.
- Câu trả lời tra cứu tương đối có ngày tham chiếu; ngưỡng sắp đến hạn được ghi rõ. Audit có snapshot, múi giờ, nguồn ngưỡng và kết quả duyệt thời gian, không thêm prompt/rows/credentials vào diagnostics.

## Cấu hình

`AI_UPCOMING_WINDOW_DAYS` là cấu hình tùy chọn, số nguyên dương tối đa 36600. Không thiết lập biến này trong lượt sửa. Nếu chưa có chính sách chung phù hợp mọi nghiệp vụ, để trống và yêu cầu người dùng nêu số ngày. Không thay giá trị người dùng không hợp lệ bằng cấu hình một cách âm thầm.

## Kiểm tra thực tế

Nguồn IPMS, provider đang mặc định, qua API local:

1. Câu gốc không nêu ngưỡng: trả ba hợp đồng có EndDate trước 23/10/2026 và hỏi số ngày cho nhóm sắp đến hạn; PARTIAL có chủ đích, không báo nhóm chưa truy vấn là rỗng.
2. Câu chỉ rõ 30 ngày: SUCCESS; ba hợp đồng đã qua EndDate, không có bản ghi trong `[2026-10-23, 2026-11-22)`. SQL không còn ngày 2023 làm mốc hiện tại.
3. Câu lịch sử “hết hạn trước 2024-01-01”: SUCCESS; không có bản ghi, giữ đúng ngày lịch sử thay vì đổi sang hôm nay.
4. Hai lượt trong cùng phiên thật: câu gốc → PARTIAL kèm câu hỏi số ngày; trả lời “30 ngày” → SUCCESS, tra lại nguồn và trả ba hợp đồng qua hạn/không có hợp đồng sắp đến hạn. Không cần nhập lại cả câu hỏi.

Ba hợp đồng đối chiếu: 05/HĐ.LG.2023 và 52/HĐ.LG.2023 kết thúc 31/12/2024; 02/HĐ.LG.2024 kết thúc 31/12/2025. Hợp đồng còn lại kết thúc 26/11/2057. Cả bốn đều có EndDate.

Artifacts kiểm tra riêng tư: `output/ipms-electricity-audit-20261023/expiry-clock-live.private.json`, `expiry-clock-final-live.private.json` và các audit tương ứng. Giữ riêng kết quả lần đầu phát hiện việc schema ngày còn deferred; đã thêm hồi quy để temporal validator dùng schema cuối sau khi mở các trường được phép.

233 kiểm thử đạt, gồm múi giờ qua nửa đêm UTC, mốc cũ bị chặn trước DB, field date bị deferred, số ngày cấu hình/người dùng, lịch sử tường minh, năm nhuận/cuối năm, từ chối OR/subquery không ràng buộc ngày của bản ghi ngoài, không đánh dấu cả tập kết quả đa nhóm là thiếu lịch sử chỉ vì một nhóm rỗng, task chờ ngưỡng không vượt nguồn/giả danh entity, và điều kiện chấp nhận retry có dữ liệu đã xác minh.

## Giới hạn

Guard này xử lý ngày tham chiếu và căn cứ khoảng ngày; không thay thế xác minh nghĩa nghiệp vụ của metric/trường thời gian, trạng thái hợp đồng hay toàn bộ bộ lọc người dùng. Các biểu thức SQL thời gian phức tạp chưa chứng minh được sẽ bị chặn và yêu cầu viết lại bằng cột date với mốc ngày rõ ràng hoặc structured query. Các cách diễn đạt thời gian ngoài phạm vi nhận diện hiện tại vẫn cần mở rộng theo nhóm ngữ nghĩa và bộ kiểm thử, không thêm nhánh theo từng câu.

Chỉ sửa/khởi động lại local; chưa triển khai hoặc restart host. Không đổi provider hay publish workflow.
