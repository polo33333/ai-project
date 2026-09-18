# Kiểm tra tốc độ tải lại trang — 18/09/2026

## Bổ sung tối ưu từng tab

Đã giới hạn store cho glossary, relationships, embed config, logs, history/feedback, MCP, API keys, tools, skills, Training, watchfolder và workflow; endpoint tải nội dung/file library cũng chỉ đọc metadata library. History và feedback cần đọc cả hai store để nối dữ liệu; workflow/tools cần MCP cho khởi tạo tool registry. Đã kiểm thử HTTP cho toàn bộ endpoint này để tránh thiếu dependency. Bỏ hai lượt gọi trùng MCP/tools trong switchMainTab.

Khóa giải mã được đọc một lần cho mỗi nguồn khóa trong process thay vì đọc file lặp lại khi giải mã từng record. Không cache nội dung domain hay quyền đăng nhập. Thay nội dung file khóa cần restart process; đổi khóa còn cần quy trình re-encrypt dữ liệu, không thay trực tiếp khóa đang dùng.

Đo snapshot trên dữ liệu hiện tại: glossary 5–7 ms, watchfolder 5 ms, scan log 7–9 ms, system log 8–9 ms, workflow 6–7 ms, MCP 4 ms. History từ 314–323 ms còn 71–76 ms; Training từ 318–330 ms còn 73–87 ms sau tối ưu đọc khóa. Đây là thời gian đọc/giải mã repository, chưa gồm render hoặc tính báo cáo Training.

201 test ứng dụng và 32 test PostgreSQL đạt. Các tab vẫn tải lại dữ liệu khi mở để thấy cập nhật mới; chưa thêm cache dài hạn hay phân trang audit. Cần restart backend để áp dụng.

Nguyên nhân xác định: mỗi request HTTP trước đây mở snapshot toàn bộ domain, gồm chat audit/tool call, memory và dictionary, kể cả khi chỉ tải JS/CSS hoặc view HTML. Các request tải song song còn phải chờ pool. Không cần tải những dữ liệu này để xác thực và trả tài nguyên trang.

Đã bổ sung scope dữ liệu theo request. Tài nguyên ngoài `/api/` chỉ đọc accounts/sessions; các API khởi tạo persona, provider, SQL sources, dictionary, domain alias, settings, Qdrant status, library và page chat đọc các store cần thiết. Route chưa khai báo và mutation khác tiếp tục dùng scope đầy đủ để giữ hành vi. Đọc/ghi store ngoài scope báo lỗi thay vì trả dữ liệu rỗng. Không cache quyền đăng nhập; commit gate và cơ chế hợp nhất transaction giữ nguyên.

Đo trên database hiện tại bằng role runtime, ba lần cho mỗi scope:

| Scope đọc repository | Thời gian (ms) |
|---|---|
| Toàn bộ domain | 372 / 366 / 367 |
| Auth cho tài nguyên trang | 5 / 4 / 4 |
| Auth + provider | 7 / 7 / 7 |
| Auth + dictionary/columns | 16 / 16 / 18 |

Đây là thời gian snapshot, không phải tổng thời gian tải trang trong trình duyệt. Tốc độ còn phụ thuộc tải mạng, render, dung lượng lịch sử UI, các API chưa tối ưu và dịch vụ bên ngoài. Đợt này chưa đo p95 tải lớn hoặc thay đổi cách tải toàn bộ message UI.

Kiểm tra: 201 test ứng dụng đạt; 32 test PostgreSQL đạt, bao gồm scope giới hạn, chặn store chưa tải, auth tài nguyên/view, API dictionary/provider, HTTP/SSE commit, memory và request replay. Cần khởi động lại backend đang chạy để áp dụng code mới.
