# JOIN scope bị thu hẹp khi chuyển bảng chính

Lượt lỗi: `a3b65cd4-37c7-4e49-8062-edfd48b750a2`, 06:26:42 ngày 23/10/2026, câu hỏi chi tiết điện KA0021 kỳ 20.

## Nguyên nhân đã xác minh

Truy vấn đầu đã JOIN `T_ElectricityOutput` với `M_Customer` thành công, trả ba kỳ của khách hàng để tìm chứng từ. Sau đó model tìm schema bảng chi tiết và gọi `get_join_path` cho detail/header. Plan hẹp mới không chứa khách hàng, trong khi SQL cuối cần detail/header/customer.

`planForSql` trước đây chỉ dựng plan khi chưa có cạnh. Có một plan hợp lệ nhưng thiếu bảng cũng làm hàm dừng ngay. Vì vậy validator báo `JOIN_SCOPE_DENIED: dbo.m_customer` dù quan hệ header/customer đã có trạng thái verified và nguồn cho phép đọc. Đây là lỗi phạm vi plan trong request, không phải không tồn tại bảng hoặc sai chữ hoa/thường của M_Customer.

## Sửa dùng chung

Khi SQL trực tiếp tham chiếu một bảng chưa nằm trong plan hẹp, backend thử bổ sung đường từ catalog hiện tại đã lọc quyền. Chỉ áp dụng SELECT có 2–4 bảng vật lý riêng biệt. Plan đã đủ bảng được giữ nguyên; CTE/derived table/self join/lookup nhiều vai trò không tự được suy lại.

Plan bổ sung phải giữ mọi cạnh trước, cùng source, root/grain, purpose và yêu cầu mapped projection; không được tự thêm tên bảng vào allowlist. Trước khi cài plan, chạy lại validator với toàn bộ SQL: đúng cặp khóa, đúng quan hệ, không làm nhân tổng hoặc vi phạm grain. Bảng/khóa ẩn, quan hệ bị thu hồi, đường mơ hồ hay bảng bị source policy chặn vẫn không được nhận. SQL sai không làm mở rộng scope của request.

Receipt trả về ghi `reason: expanded_scope`, tên các bảng và relationship IDs để phân biệt bổ sung scope với SQL thành công đơn thuần. Không có nhánh riêng cho M_Customer hay nghiệp vụ điện.

## Kiểm tra

- Tái hiện bằng chính SQL bị lỗi và một plan chỉ detail/header: validator ban đầu báo JOIN_SCOPE_DENIED.
- Gọi SQL tool thật sau sửa: plan đủ `T_ElectricityOutputDetail → T_ElectricityOutput → M_Customer`, hai quan hệ verified; trả bốn dòng kỳ 20. Chỉ số, lượng, giá và tiền khớp oracle IPMS.
- Các giá: 1.669 / 3.093 / 1.084 và phí 85. Không cộng Qty của dòng phí vào tổng sản lượng điện.
- 130 kiểm thử liên quan đạt, gồm mở rộng plan hẹp, bảo toàn grain/mapped constraints, từ chối khóa sai, nguồn khác, lookup bị chặn/ẩn/thu hồi và đường mơ hồ.
- Chạy lại câu hỏi qua API chat ở hai phiên mới, chỉ provider mặc định: cả hai SUCCESS, trả bốn dòng có bộ lọc KA0021/kỳ 20; audit lượt thứ hai không có lỗi tool. Hai lượt này không chứng minh mọi biến thể câu hỏi đã ổn định.

Artifacts nội bộ: `output/ipms-electricity-audit-20261023/customer-join-reproduction.private.json`; kết quả chat thật ghi riêng trong các file `customer-join-scope-fixed-live-*.private.json`.

Chỉ sửa và restart local; chưa triển khai lên host. Sửa này không bảo đảm model luôn hiểu đúng mọi trường/kỳ hoặc giải quyết các thiếu hụt contract khác đã ghi trong báo cáo harness.
