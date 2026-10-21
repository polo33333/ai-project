# Vai trò tùy chỉnh và phân quyền từng tài khoản — 17/10/2026

## Sử dụng

Trong Quản lý tài khoản, dùng **Thêm vai trò** ở khối Vai trò & quyền mặc định hoặc **Tạo vai trò mới** ngay dưới ô chọn role của tài khoản. Vai trò có mã cố định, tên hiển thị, mô tả, danh sách quyền sử dụng chức năng và phạm vi nguồn SQL/tài liệu mặc định. Có thể sửa các vai trò tùy chỉnh; Admin/User là vai trò hệ thống, không sửa mã hoặc cấu hình của chúng.

Trong biểu mẫu tài khoản, mở **Phân quyền riêng cho tài khoản**:

- Quyền chức năng: kế thừa role hoặc chọn bộ quyền riêng do Admin cấp.
- Phạm vi SQL/tài liệu: kế thừa phạm vi của role hoặc giới hạn vào các nguồn được chọn. Chọn chế độ giới hạn nhưng không chọn nguồn nào sẽ chặn nhóm dữ liệu đó.
- Phạm vi dữ liệu hiệu lực là giao giữa phạm vi role và phạm vi riêng. Sau đó vẫn phải đạt chính sách Quản trị dữ liệu của nguồn; cấp quyền riêng không vượt được chính sách nguồn.

Admin hệ thống giữ toàn quyền. Vai trò tùy chỉnh quy định quyền **sử dụng**, không biến thành Admin qua tên gọi hoặc checkbox. Các API quản lý tài khoản, cấu hình hệ thống và thao tác quản trị dữ liệu tiếp tục chỉ dành cho Admin.

## Quyền chức năng

Tổng quan, Trò chuyện, Lược đồ CSDL, Danh sách nguồn CSDL, Thư viện tài liệu, Thuật ngữ, Sử dụng mẫu nghiệp vụ, Lịch sử trò chuyện, Đánh giá AI, Báo cáo, Bộ nhớ cá nhân, Tra cứu SQL qua AI, Tra cứu tài liệu qua AI.

Quyền mở màn hình và quyền dùng dữ liệu qua AI độc lập. Ví dụ, một role có thể dùng SQL trong chat mà không được mở màn hình quản lý kết nối. Các danh sách nguồn phục vụ chat chỉ được trả về khi có quyền tương ứng và được lọc theo nguồn được phép.

Lịch sử API cho tài khoản thường chỉ trả các lượt gắn với chính tài khoản; Admin giữ quyền đọc lịch sử hệ thống. Với workflow, kiểm tra quyền nguồn khi đọc trạng thái/kết quả/file và lọc danh sách kết quả theo nguồn hiện được phép.

## Kiểm tra backend

Quyền chức năng được kiểm tra tại router, không chỉ ẩn menu. Principal mang permissions và dataAccess hiệu lực. Bộ lọc SQL sources, metadata lược đồ, danh sách tài liệu, governance read/egress và các bước workflow kiểm tra phạm vi nguồn. Chính sách nguồn chấp nhận các role tùy chỉnh tồn tại trong catalog; không nhận role không có thật.

Đổi quyền riêng, role tài khoản hoặc quyền/phạm vi của role sẽ thu hồi phiên liên quan. Kiểm tra revision và ràng buộc role tại commit PostgreSQL ngăn cập nhật cũ và tham chiếu role không tồn tại. Ràng buộc username duy nhất/ít nhất một Admin vẫn được giữ.

## Lưu trữ và API

Migration `007_account_roles.sql` thêm bảng `app.account_roles` qua cơ chế migration hiện có; đã áp dụng và cấp quyền runtime. Metadata dùng `account_roles.json` trong storage abstraction, có trong snapshot/backup theo catalog.

- GET `/api/accounts/roles`: role, catalog quyền và danh sách nguồn để Admin cấu hình.
- POST `/api/accounts/roles`: tạo role tùy chỉnh.
- PUT `/api/accounts/roles/:id`: cập nhật role theo revision.
- Tài khoản: `permissions: null` để kế thừa hoặc array để tùy chỉnh; `dataAccess` chứa `sql` và `documents`, mỗi nhóm là null để kế thừa hoặc array ID để giới hạn. DTO quản trị có `permissionOverrides` và `dataOverrides`; DTO đăng nhập có quyền và phạm vi hiệu lực.

## Kiểm chứng

832 ca tự động: 818 đạt, 14 bỏ qua, 0 lỗi. Ca mới chạy HTTP trong môi trường cô lập: tạo role, gán tài khoản, đăng nhập, chặn sửa role bởi User, từ chối capability admin giả, lọc nguồn và lược đồ, chặn API chức năng bị cấm, giao phạm vi role/account, thu hồi phiên khi thay quyền role, giữ role hệ thống bất biến. Kiểm tra governance với policy role tùy chỉnh xác nhận vẫn phải đạt chính sách nguồn. Fixtures chỉ dùng metadata, không giả dữ liệu nghiệp vụ SQL đã kết nối.

Kiểm tra thật localhost: API quản trị accounts/roles trả thành công, catalog quyền và lựa chọn nguồn tải được. Kiểm tra trình duyệt biểu mẫu role và phân quyền riêng tài khoản. Không lưu role/tài khoản kiểm thử hoặc thay quyền tài khoản thật. Bằng chứng kiểm thử: `artifacts/semantic-model/account-role-permissions-tests.txt`.

Phạm vi cấu hình dữ liệu của tính năng này là **nguồn SQL và tài liệu**. Không phải phân quyền hàng dữ liệu hoặc mật khẩu/2FA mới. Giới hạn bảng/cột và quy định gửi dữ liệu tới model tiếp tục quản lý theo chính sách nguồn hiện có.
