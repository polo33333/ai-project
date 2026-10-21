# Quản lý tài khoản đăng nhập — 17/10/2026

Màn hình **Quản lý tài khoản** nằm trong nhóm **Cấu hình Agent**, chỉ hiển thị cho Admin. Có thể mở trực tiếp `/accounts` khi đã đăng nhập bằng Admin.

## Chức năng

- Tạo tài khoản: tên đăng nhập duy nhất, tên hiển thị, email tùy chọn, mật khẩu 8–128 ký tự, role và trạng thái.
- Chỉnh sửa tên, email, role và khóa/mở tài khoản. Tên đăng nhập giữ cố định sau khi tạo.
- Admin đặt lại mật khẩu, kể cả tài khoản đang bị khóa; thao tác này không tự mở khóa tài khoản.
- Tìm kiếm theo tên/tài khoản/email; lọc role/trạng thái; phân trang mặc định 10 dòng với các mức 10/20/50/100.
- Không xóa tài khoản để tránh làm mất liên kết dữ liệu và lịch sử; sử dụng trạng thái khóa để ngừng truy cập.

## Role

- **Admin**: quản lý tài khoản và cấu hình hệ thống theo cơ chế phân quyền đang có.
- **User**: sử dụng chức năng ứng dụng và dữ liệu được cấp quyền; không truy cập API quản lý tài khoản hoặc cấu hình dành cho Admin.

Đã bổ sung role tùy chỉnh và phân quyền riêng từng tài khoản; xem `ACCOUNT_ROLES_PERMISSIONS_171026.md`. Quyền quản trị hệ thống vẫn chỉ dành cho Admin; phạm vi SQL/tài liệu hiệu lực tiếp tục chịu chính sách nguồn trong Quản trị dữ liệu.

## Kiểm soát

Mật khẩu dùng cơ chế scrypt hiện có. API không trả hash hoặc mật khẩu. Kiểm tra quyền ở backend, không chỉ ẩn nút trên UI. Đổi role, khóa tài khoản và đặt lại mật khẩu thu hồi phiên đăng nhập; securityVersion còn vô hiệu hóa phiên cũ phát sinh đồng thời với thay đổi. Đổi mật khẩu của chính Admin yêu cầu đăng nhập lại.

Không cho tự khóa hoặc hạ quyền Admin đang thực hiện thao tác. Kiểm tra tên đăng nhập không phân biệt hoa/thường và luôn giữ ít nhất một Admin hoạt động, gồm kiểm tra lại sau merge trong transaction PostgreSQL để tránh hai thao tác đồng thời phá ràng buộc. Có revision để từ chối chỉnh sửa quản trị đã cũ. Nhật ký chỉ lưu actorId, accountId và loại thao tác, không lưu mật khẩu.

API: GET/POST `/api/accounts`, PUT `/api/accounts/:id`, POST `/api/accounts/:id/password`.

## Kiểm chứng

Kiểm thử HTTP trong môi trường riêng: tạo, đăng nhập, trùng username, input sai, chặn User/khách, cập nhật role, khóa tài khoản, đặt mật khẩu, thu hồi phiên, revision, bảo vệ tự khóa/tự hạ quyền và DTO không chứa mật khẩu. Kiểm thử ràng buộc commit và phiên có securityVersion cũ.

Toàn bộ bộ kiểm thử: 830 ca, 816 đạt, 14 bỏ qua, 0 lỗi. Kiểm tra thật localhost: đăng nhập Admin, đọc API accounts, chặn API khi chưa đăng nhập, truy cập `/accounts`, template và JS đều thành công. Không tạo tài khoản kiểm thử hoặc thay đổi role/mật khẩu tài khoản thật.

Nguồn UI tách riêng: `src/frontend/views/accounts.html`, `src/frontend/js/modules/accounts.js`; tích hợp loader, sidebar, tìm kiếm chức năng và phân trang dùng chung. Backend dùng tài khoản/session đang lưu trong storage hiện có, không cần schema mới.
