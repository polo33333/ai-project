# Đo tải TEV1 cho nhóm 20 người

Mục tiêu: 11–15 yêu cầu định tuyến đồng thời; đo thêm mức 20. Người dùng đang mở ứng dụng không đồng nghĩa yêu cầu inference đang chạy. Đo này dùng tải closed-loop không có thời gian nghỉ, chỉ đánh giá router TEV1, chưa đánh giá model trả lời, SQL, PostgreSQL ghi dữ liệu hay toàn ứng dụng.

## Chạy trên máy có dịch vụ TEV1

```powershell
$env:TEV1_CONCURRENCY = '1,4,8,11,15,20'
$env:TEV1_DURATION_SECONDS = '180'
$env:TEV1_P95_TARGET_MS = '5000'
node scripts/benchmark_tev1.js
```

Mốc p95 5 giây là giả định ban đầu, cần thống nhất theo trải nghiệm mong muốn. Script đọc cấu hình `.env`, catalog đã publish trong PostgreSQL, gọi endpoint thật `/v1/systemone`, gồm greeting probe nếu bật; không khởi động/restart dịch vụ, không chạy workflow hoặc truy vấn dữ liệu nghiệp vụ. Có thể đặt `TEV1_CATALOG_FILE` trỏ tới catalog JSON đã xuất; báo cáo sẽ ghi rõ nguồn này.

Kết quả tại `artifacts/tev1-load-report.json`: độ trễ p50/p95/p99 gồm thời gian chờ phía dịch vụ, yêu cầu thành công/giây, tỷ lệ lỗi, tỷ lệ unclear và mẫu GPU mỗi 5 giây. Thời gian lượt đầu tách riêng nhưng chỉ được xem là cold start nếu model chưa nạp. Không thay đổi thiết lập parallel/context của Ollama. Không gọi model chat khi unclear; cần đo riêng phần fallback. Kiểm thử chất lượng routing dùng `evaluate_tev1_live_catalog.js`; tỷ lệ unclear không phải độ chính xác.

## Dùng số đo để chọn cấu hình

- Ngưỡng tham chiếu: lỗi <=1%, p95 <= mục tiêu; ít nhất 100 lượt mỗi mức mới đánh dấu đạt. Chạy dài hơn nếu mẫu ít. Đo lại giờ cao điểm và cùng model/quantization/catalog thực tế.
- Nhu cầu RPS = số người hoạt động × số câu mỗi người mỗi phút / 60. Ví dụ 15 người, 2 câu/phút tạo 0,5 RPS trung bình; vẫn phải thử burst 15 yêu cầu.
- Công suất dự phòng: lấy RPS ổn định đạt SLA × 0,7 để lập kế hoạch, tránh dùng thông lượng tại mức đã quá tải.
- Số replica ước tính = làm tròn lên (RPS cao điểm / công suất dự phòng mỗi replica). Phải xác minh khả năng phân phối tải; không giả định GPU nhanh gấp đôi sẽ đạt gấp đôi RPS.
- VRAM lấy theo peak đo trên GPU, nhưng lấy mẫu 5 giây có thể bỏ sót spike. Phải cộng phần bộ nhớ cho model khác chạy cùng và đo lại khi đồng thời. CPU/RAM máy app/DB cần benchmark toàn ứng dụng riêng; script này không cung cấp peak RAM hoặc CPU của dịch vụ TEV1.
- Nếu 15 concurrent đạt, thử mức 20 và bài soak 30 phút tại mức 15 để đánh giá độ ổn định. Nếu không đạt, xác định GPU bão hòa, hàng đợi hay lỗi/timeout trước khi chọn máy mới.

## Trạng thái ngày 05/10/2026

Máy kiểm tra: Ryzen 7 7800X3D (8 core/16 thread), RAM khoảng 15,6 GiB, RTX 5070 12 GB. Dịch vụ ban đầu chưa bật; sau khi người dùng bật, đã đo inference thật. Kết quả và đề xuất ở [TEV1_CAPACITY_REPORT.md](TEV1_CAPACITY_REPORT.md).
