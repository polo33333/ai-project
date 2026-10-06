# Rà soát mô tả nghiệp vụ cho routing

Ngày rà soát: 04/10/2026. Nguồn: catalog đang lưu trong PostgreSQL `app.workflow_catalog`, các bản published và SQL binding tương ứng. Đây là đánh giá và nội dung đề xuất; chưa sửa hoặc publish catalog đang chạy.

## Cập nhật đã áp dụng theo yêu cầu

Nhân viên và hợp đồng đã publish v4 qua `scripts/update_lookup_routing_metadata.js --apply`, chỉ sửa tên/mô tả/ví dụ/hướng dẫn và nhãn/câu hỏi input. Giữ nguyên SQL, workflow, schema, fixtures và các version cũ. Với hợp đồng, tên là tên khách hàng, mã là mã/số hợp đồng. Hai nghiệp vụ đều là tra cứu chi tiết có điều kiện; thiếu tên/mã thì chọn nghiệp vụ và hỏi bổ sung, không chuyển thành danh sách toàn bộ.

Câu hỏi routing TEV1 được rút gọn mà vẫn giữ đầy đủ catalog. Task với metadata mới cho “thông tin chi tiết nv” có 1821 token ước tính; “thông tin chi tiết hợp đồng” có 1842, cộng dự phòng 200 vẫn trong giới hạn 2050. Lịch sử, pending hoặc câu hỏi dài có thể vượt giới hạn và phải escalate.

Thử inference thật trước khi publish: hai câu trên đều chọn đúng lookup, inputs rỗng để runtime hỏi tên/mã. Cả hai quyết định cuối đều từ Qwen trong auto, không phải TEV1 tự quyết định chắc chắn. Hai câu danh sách toàn bộ cũng đi nhánh chat trong lượt thử riêng. Báo cáo: `artifacts/lookup-routing-detail-evaluation.json`; báo cáo lượt thử ban đầu có lỗi input rỗng: `artifacts/lookup-routing-metadata-evaluation.json`. Backend đã sửa việc xử lý placeholder tên/mã rỗng không hợp schema thành input còn thiếu. Không chạy SQL/workflow thật trong các lượt đánh giá.

Regression: 431 test đạt, 11 bỏ qua. Bản sao catalog trước thay đổi được lưu trong `artifacts/lookup-metadata-backup-*.json`. Code routing mới cần khởi động lại ứng dụng theo quyết định của người dùng.

Phần dưới giữ lại phát hiện ở bản v3 để đối chiếu với bản sửa.

### Bản sửa tiếp theo: v5 và native task

Đã publish v5 cho hai lookup để khai báo `routingScope: targeted`; SQL và các version cũ vẫn nguyên. Native task không gửi lịch sử bảng dài/instructions thực thi, dùng mô tả/ví dụ trong phương án và sắp catalog theo ID. Một câu hỏi độc lập xác nhận có input thực ngăn “chi tiết hđ” trở thành giá trị query. Kiểm tra scope vẫn chặn danh sách toàn bộ vào lookup, giữ nguyên các ngưỡng cấu hình.

Trace lượt lỗi “chi tiết hđ” lúc 18:51:51 cho thấy TEV1 bị `ROUTING_CONTEXT_EXCEEDED` trước HTTP request; Gemini trả `ROUTING_INVALID_OUTPUT`, sau đó luồng SQL tự do thất bại với `UNKNOWN_COLUMN:ContractDetailID`. Bản sửa giữ lỗi/unclear trong bước chọn nghiệp vụ và hỏi người dùng thay vì tự chuyển sang SQL. Gemini có cấu hình structured JSON cho routing.

Kiểm tra cuối trên catalog DB với `gemini-3.5-flash-lite`: 8/8 đạt; 5 yêu cầu chi tiết đi thẳng TEV1, 3 lượt còn lại escalate. Thời gian trung bình 5 lượt trực tiếp 683 ms với model sẵn sàng. Báo cáo `artifacts/tev1-live-catalog-auto.json`; 436 test đạt, 11 bỏ qua. Không chạy SQL/workflow thật trong bộ đánh giá. Các kết quả v4 ở trên là lịch sử kiểm tra, không phải trạng thái cuối.

## Kết quả hiện tại

Ba gói published đang bật: `employee_lookup` v3, `contract_lookup` v3, `electricity_sales` v3. Gói `phase1_examples` đang tắt và chưa publish, không tham gia routing. Ba gói đang bật không có overlay.

| Nghiệp vụ | Đánh giá | Điểm cần làm rõ |
| --- | --- | --- |
| Nhân viên | Đúng đối tượng và điều kiện tên/mã | Mô tả nói toàn bộ cột nhưng SQL SELECT chỉ có 13 cột. Thêm cách nói `nv`, yêu cầu chi tiết chưa có tên/mã; phân biệt với danh sách toàn bộ nhân viên. |
| Hợp đồng | Đúng đối tượng và điều kiện số hợp đồng/tên khách hàng | SQL tìm theo chuỗi chứa, không chỉ khớp chính xác số hợp đồng. Thêm `hđ`, yêu cầu chi tiết thiếu điều kiện; phân biệt với danh sách và thống kê hợp đồng. |
| Sản lượng điện | Đúng phép tổng hợp và kỳ dữ liệu | Tên “Chi tiết” dễ gợi scope targeted, trong khi SQL SUM theo tháng, scope aggregate. Không phải doanh thu/tiền điện hoặc chi tiết từng khách hàng. Số tháng là N tháng có dữ liệu mới nhất, không nhất thiết liên tiếp theo lịch. |

Thiếu input không đồng nghĩa với mơ hồ về nghiệp vụ. Chọn đúng lookup rồi runtime hỏi tên/mã, số hợp đồng/tên khách hàng. Với báo cáo điện, runtime hỏi số tháng và hai lựa chọn boolean còn thiếu, không tự gán mặc định.

## Mô tả đề xuất

### Nhân viên

Tên: **Tra cứu chi tiết nhân viên**.

Mô tả: “Tra cứu thông tin chi tiết nhân viên (nv) theo tên hoặc mã nhân viên. Chưa có tên/mã vẫn chọn nghiệp vụ này để hỏi bổ sung. Trả tối đa 50 hồ sơ phù hợp với các trường đã cấu hình. Không dùng cho danh sách toàn bộ nhân viên hoặc thống kê nhân sự.”

Ví dụ: `thông tin chi tiết nv`; `xem hồ sơ nhân viên`; `thông tin nhân viên tên Duy`; `tra cứu nhân viên mã NV004`.

Input `query`: tên hoặc mã nhân viên được nêu rõ. Không lấy toàn bộ câu yêu cầu hay từ `nv` làm giá trị. SQL so sánh mã chính xác hoặc tìm tên có chứa chuỗi, trả 13 trường được chọn; tên phòng ban và giới tính lấy từ quan hệ JOIN đã cấu hình.

### Hợp đồng

Tên: **Tra cứu chi tiết hợp đồng**.

Mô tả: “Tra cứu thông tin chi tiết hợp đồng (hđ) theo số hợp đồng hoặc tên khách hàng, hỗ trợ tìm theo chuỗi chứa. Chưa có điều kiện vẫn chọn nghiệp vụ này để hỏi bổ sung. Trả tối đa 50 hợp đồng phù hợp. Không dùng cho danh sách toàn bộ hợp đồng, thống kê doanh thu hoặc hồ sơ nhân viên.”

Ví dụ: `thông tin chi tiết hợp đồng`; `chi tiết hđ`; `tra cứu hợp đồng số HD001`; `hợp đồng của khách hàng An`.

Input `query`: số hợp đồng hoặc tên khách hàng được nêu rõ; không lấy toàn bộ câu yêu cầu. SQL dùng LIKE cho cả hai điều kiện. Ví dụ HD001 chỉ là chuỗi thử routing, không xác nhận bản ghi đó tồn tại.

### Sản lượng điện

Tên: **Báo cáo tổng hợp sản lượng điện bán ra theo tháng**.

Mô tả: “Tổng hợp sản lượng điện bán ra (kWh) theo N tháng có dữ liệu mới nhất trong DB. Thu thập số tháng 1–100, lựa chọn vẽ biểu đồ và xuất Excel trước khi chạy. Không tự gán mặc định. Không dùng cho doanh thu/tiền điện hoặc chi tiết từng khách hàng.”

Ví dụ: `báo cáo sản lượng điện bán ra`; `thống kê sản lượng điện theo tháng`; `sản lượng điện bán ra 7 tháng gần nhất, vẽ biểu đồ và xuất Excel`.

Input `months`: N tháng có dữ liệu mới nhất. `drawChart`, `exportFile`: chỉ ghi true/false khi người dùng thể hiện rõ lựa chọn; chưa nêu thì hỏi thêm. Dữ liệu hiện tại SUM(TotalQty) nhóm theo tháng của ElectricityOutputDate, không dựa vào tháng hiện tại.

## Vấn đề ngữ cảnh thực tế

`tev1_decision.buildTask()` gửi name, description, examples và toàn bộ instructions thành guidance, cộng các câu hỏi route/scope/input. Kết quả dựng task với cả ba nghiệp vụ published:

| Câu hỏi | Token ước tính của task | Cộng dự phòng 200 | Giới hạn |
| --- | ---: | ---: | ---: |
| thông tin chi tiết nv | 2338 | 2538 | 2050 |
| thông tin chi tiết hợp đồng | 2360 | 2560 | 2050 |
| Báo cáo sản lượng điện bán ra | 2376 | 2576 | 2050 |

Cả ba đều bị guard trả `ROUTING_CONTEXT_EXCEEDED` trước khi gọi TEV1. Đây là token ước tính của backend, không phải số token từ model. Với `auto`, chúng chuyển sang model chat. Vì vậy thêm ví dụ vào hướng dẫn dài chưa đủ để TEV1 chọn tốt hơn; còn có thể tăng kích thước task.

Hướng sửa tiếp theo: tách metadata routing ngắn khỏi instructions thực thi/hiển thị, giữ đủ đối tượng, thao tác, scope, điều kiện input và giới hạn. Cần kiểm tra task đầy đủ, gồm lịch sử/pending/input candidates, vẫn vừa giới hạn; không cắt bỏ nghiệp vụ để ép vừa. Hướng dẫn thực thi đầy đủ tiếp tục dùng cho runtime. Chỉ publish bản version mới sau khi kiểm tra contract và routing; không sửa trực tiếp bản published v3.

## Các kết quả routing cần đạt

| Yêu cầu | Kết quả mong đợi |
| --- | --- |
| thông tin chi tiết nv | employee_lookup/employee_details; query còn thiếu, hỏi tên/mã |
| thông tin chi tiết hợp đồng | contract_lookup/contract_details; query còn thiếu, hỏi số HĐ/tên khách hàng |
| ds tất cả nv | Chat dữ liệu; không chọn lookup nhân viên |
| danh sách toàn bộ hợp đồng | Chat dữ liệu; không chọn lookup hợp đồng |
| thống kê sản lượng điện theo tháng | electricity_sales/last_seven_months; hỏi input còn thiếu |
| doanh thu hợp đồng | Chat dữ liệu; không chọn báo cáo sản lượng điện |

Rà soát này chỉ đọc catalog và SQL cấu hình, dựng task offline; không truy vấn dữ liệu nghiệp vụ, chạy workflow hay xác nhận độ chính xác TEV1 bằng inference thật.
