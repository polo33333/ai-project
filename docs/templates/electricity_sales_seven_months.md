# Chi tiết sản lượng điện bán ra — phiên bản 3

Mẫu yêu cầu đủ ba thông tin trước khi truy vấn, không có giá trị mặc định:

- months: số tháng có dữ liệu gần nhất, từ 1 đến 100.
- drawChart: có vẽ biểu đồ không.
- exportFile: có xuất Excel không.

Câu hỏi chung phải hỏi cả ba; chỉ hỏi trường còn thiếu. Giá trị false là câu trả lời hợp lệ.

Quy trình 9 node: thu thập yêu cầu → xác định phạm vi → tổng hợp SQL → kiểm tra giới hạn → xác thực số tháng → chuẩn bị bảng → vẽ biểu đồ nếu chọn → xuất Excel nếu chọn → trả kết quả.

SQL dùng tham số @months, tổng hợp SUM(TotalQty) theo tháng của ElectricityOutputDate trong dbo.T_ElectricityOutput. Lấy tối đa N tháng có dữ liệu mới nhất, hiển thị từ cũ đến mới. Không phụ thuộc ngày hiện tại, không chèn tháng trống. DB có 2 tháng và yêu cầu 7 thì trả 2 tháng. DB rỗng không tạo file. Biểu đồ dùng kWh; Excel chứa bảng dữ liệu.

Giữ ID electricity_sales/last_seven_months để cập nhật mẫu cũ. Binding dùng db-src-1785684548077; đổi nguồn khi nhập ở môi trường khác.

Tái tạo JSON: node scripts/create_electricity_template.js

Kiểm tra nguồn thật và cập nhật mẫu: node scripts/create_electricity_template.js --install

Lượt chạy cũ giữ phiên bản cũ; tạo lượt mới để dùng mẫu mới. Quy tắc hỏi và điều kiện chạy nằm trong mẫu, không thêm từ khóa nghiệp vụ vào bộ định tuyến.