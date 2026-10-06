# Báo cáo chịu tải TEV1 — 05/10/2026

## Kết luận cho nhóm 20 người, 11–15 yêu cầu đồng thời

Máy hiện tại xử lý được tải thử không lỗi, nhưng p95 định tuyến ở mức 11–15 là 7,10–9,64 giây. Không đạt mục tiêu giả định p95 <=5 giây. Đây là thời gian riêng router; chưa gồm trả lời AI, SQL hay toàn bộ giao diện. Không thể cam kết 15 người đều nhận câu trả lời hoàn chỉnh trong 10 giây.

## Cấu hình và phương pháp

- Ryzen 7 7800X3D, 8 core/16 thread; RAM 15,6 GiB; RTX 5070, VRAM 12 GB.
- Dịch vụ báo phiên bản 0.35.1; model `tev1:4b`, 4,2B, Q8_0, context đang nạp 2050, toàn model trên GPU (~4,35 GiB).
- Catalog PostgreSQL thật gồm 3 workflow đã publish. Năm câu hỏi tiếng Việt luân phiên, không pending/history; greeting probe bật, mỗi lượt có probe và quyết định nghiệp vụ.
- Tải closed-loop không nghỉ, 3 phút cho mức 1; lượt sàng lọc riêng 60 giây/mức cho 4–20, cộng thời gian drain lượt đang chạy. Không có kiểm tra chất lượng chạy đồng thời trong lượt sàng lọc.
- Lượt ramp ban đầu có kiểm tra chất lượng chồng lên mức 4 và đã dừng; chỉ dùng mức 1 của `tev1-load-baseline.json`. Các mức 4–20 dùng lần chạy sạch trong `tev1-load-report.json`.
- Không thực thi workflow hoặc truy vấn dữ liệu nghiệp vụ; không sửa/restart dịch vụ.

| Đồng thời | Số lượt | Thành công/giây | p50 (giây) | p95 (giây) | Lỗi |
|---:|---:|---:|---:|---:|---:|
| 1 | 266 | 1,48 | 0,67 | 0,71 | 0 |
| 4 | 98 | 1,57 | 2,53 | 2,58 | 0 |
| 8 | 101 | 1,57 | 5,10 | 5,21 | 0 |
| 11 | 105 | 1,58 | 6,87 | 7,10 | 0 |
| 15 | 107 | 1,57 | 9,56 | 9,64 | 0 |
| 20 | 113 | 1,57 | 12,74 | 12,82 | 0 |

VRAM toàn GPU cao nhất trong các mẫu sàng lọc: 6355 MiB (~6,21 GiB), còn dung lượng trên GPU 12 GB. Lấy mẫu 5 giây có thể bỏ sót spike. Không đo peak RAM/CPU dịch vụ. Thông lượng gần phẳng khi concurrency tăng, độ trễ tăng gần tỷ lệ tải: phù hợp với xử lý có giới hạn song song/hàng đợi, chưa đủ chứng minh nguyên nhân cụ thể hoặc GPU bão hòa.

## Tính công suất và cấu hình

1. Nếu chấp nhận riêng router khoảng 10 giây khi 15 yêu cầu cùng lúc: cấu hình đã đo là mốc triển khai pilot có bằng chứng. GPU 12 GB đã chứa được TEV1 riêng trong bài đo; chưa cần mua GPU VRAM lớn chỉ để chứa model này. CPU 8 core và RAM 16 GB là cấu hình đã kiểm thử, không phải cấu hình tối thiểu đã xác minh cho app/DB.
2. Nếu cần p95 router <=5 giây: cấu hình hiện tại chưa đạt ở mức 8 trở lên. Mốc đã quan sát dưới 5 giây là 4 concurrent (98 mẫu, cần xác nhận dài hơn). Phương án 4 replica độc lập, phân tải khoảng 4 yêu cầu/replica cho burst 15, là giả thuyết triển khai cần benchmark lại; nhiều process cùng một GPU không đồng nghĩa nhiều công suất độc lập. Phép tính công suất thô cho 15 lượt/5 giây cần ít nhất 3 lượt/giây; có 30% dự phòng cần khoảng 4,3 lượt/giây. Đây là mục tiêu benchmark, không phải đảm bảo p95.
3. Nhu cầu bình quân khác burst: giả sử 15 người gửi 2 câu/phút =>0,5 lượt/giây. Với công suất thực ~1,57 lượt/giây, sử dụng 70% để hoạch định cho ~1,10 lượt/giây, tức ~66 lượt/phút. Chỉ áp dụng workload router đã đo và không đảm bảo độ trễ của burst.
4. Chưa có cơ sở chọn SKU GPU mới hoặc RAM/disk của máy chạy toàn ứng dụng. Nếu chạy thêm model chat 9B, embedding, PostgreSQL và Qdrant cùng máy, cần đo đồng thời; không suy ra từ VRAM TEV1 riêng.

Trước khi mua phần cứng, kiểm tra cấu hình xử lý song song của dịch vụ TEV1 và benchmark lại. [FAQ chính thức Ollama](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests) mô tả `OLLAMA_NUM_PARALLEL` và bộ nhớ tăng theo số lượt song song/context; bản dịch vụ có endpoint `/v1/systemone` cần xác minh hỗ trợ thực tế, không giả định cơ chế giống Ollama chuẩn. Chưa thay đổi thiết lập này.

## Chất lượng và giới hạn

Chạy `evaluate_tev1_live_catalog.js --local-only` sau khi kết thúc tải: 5/11 ca đạt, 6 ca trả `unclear` thay vì kỳ vọng. Lỗi gồm câu viết tắt, trả lời input pending và yêu cầu danh sách. Kết quả cùng tỷ lệ như kiểm tra trong lúc có tải; chưa khẳng định nguyên nhân do model, catalog hay ngưỡng probability/margin. Chi tiết ở `artifacts/tev1-live-catalog-local.json`.

Trong bài tải, `unclear` khoảng 39–40% được tính là phản hồi inference hợp lệ, không phải routing thành công về ngữ nghĩa. Chế độ `auto` có thể thêm model chat dự phòng, tăng tổng thời gian và tải; chưa đo. Bộ 11 ca nhỏ không đại diện toàn bộ người dùng.

Đây là sàng lọc công suất, không phải chứng nhận ổn định dài hạn. Cần xác nhận SLA người dùng mong muốn, đo tải toàn luồng và soak trước khi chốt cấu hình production. Báo cáo JSON lưu tại `artifacts/tev1-load-report.json` và `artifacts/tev1-load-baseline.json`.
