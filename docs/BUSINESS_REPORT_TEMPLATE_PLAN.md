# Kế hoạch chuẩn hóa mẫu báo cáo nghiệp vụ

Trạng thái: đề xuất triển khai; chưa thay đổi mẫu đang chạy.

## Mục tiêu

Chuẩn hóa “Chi tiết sản lượng điện bán ra” thành mẫu gốc báo cáo sản lượng theo tháng. Quản trị viên nhân bản mẫu, đổi nguồn dữ liệu, chỉ tiêu, đơn vị và mô tả nghiệp vụ; không sửa bộ định tuyến, runtime hay viết lại các node. Mỗi nghiệp vụ vẫn có ID, phiên bản, quyền sử dụng và fixture riêng.

## Hiện trạng và điểm cần sửa

- Mẫu điện đã hỏi số tháng, vẽ biểu đồ, xuất file; có 9 node và điều kiện bỏ qua.
- Tên file, nhãn dữ liệu, thông báo và script tạo mẫu còn gắn với điện/kWh/7 tháng.
- Bộ dựng giao diện chính và embed riêng biệt từng gây lệch hỗ trợ biểu đồ.
- Cấu hình nguồn chứa ID DB của môi trường tạo mẫu; cần ánh xạ lại khi import.
- Tên “chi tiết” dễ bị hiểu là từng chứng từ trong khi kết quả đang tổng hợp theo tháng. Phải mô tả rõ phạm vi; báo cáo chứng từ là mẫu riêng.
- Một số trường kết quả tùy chọn chưa có schema chặt chẽ khi node bị bỏ qua.

## Danh mục bổ sung

Đã thấy các cột sau trong từ điển dữ liệu local. Cần xác minh ý nghĩa, đơn vị và dữ liệu thật trước khi publish.

| Ưu tiên | Mẫu | Bảng | Ngày | Chỉ tiêu dự kiến |
|---|---|---|---|---|
| 1 | Điện bán ra | T_ElectricityOutput | ElectricityOutputDate | SUM(TotalQty), kWh |
| 1 | Điện mua vào | T_ElectricityInput | ElectricityInputDate | SUM(TotalQty), xác minh kWh |
| 2 | Nước đầu vào | T_WaterInput | WaterDate | SUM(Qty), xác minh m³ |
| 2 | Nước đầu ra | T_WaterOutput | WaterDate | Qty1/Qty2: xác minh ý nghĩa trước khi chọn hoặc cộng |
| 3 | Rác đầu vào | T_GarbageInput | GarbageInputDate | Chọn chỉ tiêu kg, tấn hoặc số thùng |
| 3 | Rác đầu ra | T_GarbageOutput | GarbageOutputDate | Chọn chỉ tiêu kg, tấn hoặc số thùng |

Không cộng QtyKg với QtyTon hoặc các cột Qty120…Qty660 một cách mặc định. Chỉ quy đổi khi có quy tắc đã xác minh; nếu là số liệu trùng lặp ở hai đơn vị thì không cộng. Không suy diễn Input/Output của bảng rác thành thu gom/xử lý khi chưa xác minh.

Sau các mẫu trên: báo cáo theo khách hàng/đơn vị, doanh thu và chi phí, so sánh các kỳ, danh sách chứng từ. Báo cáo chênh lệch đầu vào–đầu ra cần thống nhất kỳ, phạm vi và đơn vị; không tự gọi chênh lệch là hao hụt.

## Cấu hình để nhân bản

Một cấu hình nghiệp vụ gồm:

- Nhận diện: ID, tên, mô tả, câu ví dụ, hướng dẫn và phạm vi không hỗ trợ.
- Nguồn: kết nối DB, schema, bảng hoặc view được phép, cột ngày nghiệp vụ.
- Chỉ tiêu: cột số hoặc công thức từ danh sách phép toán cho phép, cách tổng hợp, đơn vị, độ chính xác, quy tắc null/số âm.
- Bộ lọc: đơn vị, khách hàng, trạng thái chứng từ nếu bảng có; phân biệt quyền bắt buộc với lựa chọn người dùng.
- Đầu ra: tiêu đề, nhãn cột, tên file, kiểu biểu đồ, định dạng xuất.

Chuẩn hóa các cột kỹ thuật thành `period`, `quantity`; nhãn và đơn vị đến từ cấu hình. Chỉ mở rộng nhiều chỉ tiêu khi dữ liệu nước/rác cần, không ép chúng vào một tổng sai nghĩa.

Ví dụ cấu hình khái niệm (chưa phải JSON import):

```json
{
  "id": "electricity_purchase",
  "name": "Sản lượng điện mua vào theo tháng",
  "source": { "table": "dbo.T_ElectricityInput", "dateColumn": "ElectricityInputDate" },
  "metric": { "column": "TotalQty", "aggregate": "sum", "unit": "kWh" },
  "periodPolicy": "latest_available_months",
  "output": { "filenamePrefix": "San_luong_dien_mua_vao" }
}
```

## Luồng node dùng chung

1. Thu thập yêu cầu: số tháng, biểu đồ, xuất file; chỉ hỏi phần thiếu, không tự mặc định.
2. Chuẩn hóa yêu cầu và phạm vi được phép.
3. Truy vấn và tổng hợp tối đa N tháng có dữ liệu mới nhất trong phạm vi đã lọc.
4. Kiểm tra số dòng, thứ tự kỳ, kiểu số và đơn vị; gom hai node kiểm tra hiện tại khi primitive hỗ trợ.
5. Chuẩn bị bảng kết quả và thông tin kỳ thực tế.
6. Vẽ biểu đồ nếu người dùng chọn và có dữ liệu.
7. Xuất file nếu người dùng chọn và có dữ liệu.
8. Trả bảng, biểu đồ và liên kết tải thực tế; ẩn đầu ra của node bỏ qua.

Không phụ thuộc ngày hiện tại, không bù tháng trống. Nếu yêu cầu 7 tháng nhưng chỉ có 2, thông báo “Có dữ liệu 2/7 tháng được yêu cầu”. DB rỗng trả thông báo rõ ràng, không tạo file. Các tháng có bản ghi sản lượng bằng 0 vẫn là tháng có dữ liệu.

## Thay đổi kỹ thuật

1. Tách script sinh mẫu điện thành bộ sinh báo cáo dùng chung và cấu hình từng nghiệp vụ. Sinh workflow/binding/fixture, không copy code thực thi.
2. SQL được dựng từ metadata đã kiểm tra khi lưu/publish, lưu thành binding cố định; giá trị người dùng luôn qua tham số. Không nội suy tên bảng/công thức từ câu chat; không cho nhập JavaScript tùy ý.
3. Bổ sung primitive kiểm tra hoặc thao tác cấu hình tối thiểu nếu cần, áp dụng chung cho mọi báo cáo. Không thêm nhánh if theo tên điện/nước/rác vào engine.
4. Chuẩn hóa schema cho đầu ra tùy chọn; thống nhất xử lý null/không có trường giữa runtime, fixture, web chat và embed.
5. Thêm thao tác “Nhân bản mẫu”: bắt buộc ID mới; mặc định tạo bản nháp; giữ mẫu gốc; cho sửa các trường cấu hình thường dùng và xem trước node/SQL.
6. Import kiểm tra capability máy chủ và nguồn DB; hiển thị rõ phần không tương thích, cho ánh xạ kết nối. Không mang thông tin xác thực DB trong gói.
7. Dùng chung hợp đồng biểu đồ và bộ ca kiểm thử giữa web/ embed; tránh phải sửa hai nơi mỗi khi thêm kiểu kết quả.

## Lộ trình

### Giai đoạn 1 — Chuẩn hóa điện

- Xác minh cách tính hiện tại; ghi fixture có kết quả kỳ vọng.
- Tạo bộ sinh chung, chuyển mẫu điện bán ra sang cấu hình.
- Tạo điện mua vào chỉ bằng cấu hình mới.
- Giữ ID hiện tại của điện bán ra để không đứt tham chiếu; tên hiển thị không gắn 7 tháng. Publish phiên bản mới; run đang tồn tại vẫn giữ definition cũ.

Đạt khi hai mẫu cho đúng số liệu, câu hỏi và lựa chọn đầu ra; mẫu thứ hai không yêu cầu sửa engine.

### Giai đoạn 2 — Nhân bản và nước

- Thêm UI nhân bản/ánh xạ nguồn và xem trước.
- Xác minh Qty1, Qty2 và đơn vị nước; xây mẫu đầu vào/đầu ra.
- Sinh fixture từ cấu hình nhưng kiểm chứng kết quả kỳ vọng độc lập, không dùng lại chính hàm tổng hợp để tính expected.

Đạt khi quản trị viên tạo mẫu mới từ giao diện và chỉ sửa cấu hình nguồn/chỉ tiêu/nhãn.

### Giai đoạn 3 — Rác và nhiều chỉ tiêu

- Xác minh đơn vị, quan hệ các cột khối lượng và kích cỡ thùng.
- Mỗi chỉ tiêu khác đơn vị có cột/biểu đồ riêng; thêm chuyển đổi đơn vị đã kiểm chứng nếu cần.
- Mở rộng so sánh kỳ, khách hàng, chứng từ sau khi nhóm báo cáo sản lượng ổn định.

## Kiểm thử và nghiệm thu

- Câu hỏi chung hỏi đủ ba thông tin; đã có thông tin thì không hỏi lại; false không bị coi là thiếu.
- Không nhầm điện mua với bán, nước với điện, tổng hợp tháng với chứng từ.
- DB cũ hơn ngày hiện tại, thiếu tháng, tháng gián đoạn, DB rỗng, số 0 và số âm theo chính sách.
- Cả bốn tổ hợp bật/tắt biểu đồ và export; số liệu bảng, biểu đồ, Excel thống nhất.
- Giới hạn N tháng được áp dụng sau bộ lọc và quyền; không lộ dữ liệu ngoài phạm vi.
- Truy vấn có tham số, không nhân đôi số liệu do join header/detail.
- Web chat và embed: chờ bổ sung gọn, kết quả tùy chọn không hiện object/undefined, biểu đồ vừa khung hẹp.
- Import sang nguồn khác, host thiếu capability, cập nhật phiên bản và rollback.
- Thử các cách diễn đạt khác nhau qua AI thật, ghi quyết định định tuyến; test mock không thay thế đánh giá nhận diện thực tế.

## Những điểm cần chốt khi triển khai

- Ý nghĩa Qty1/Qty2 và đơn vị nước.
- Ý nghĩa các chỉ tiêu và nghiệp vụ Input/Output của rác.
- Chính sách bỏ chứng từ hủy/chưa duyệt, quyền CompanyID và xử lý điều chỉnh âm.
- Giữ nhãn “Chi tiết sản lượng…” hay đổi thành “Báo cáo sản lượng theo tháng” để phân biệt mẫu chứng từ.

Các điểm này không cản trở chuẩn hóa mẫu điện và tạo mẫu điện mua vào; cần xác minh trước khi phát hành mẫu nước/rác.
