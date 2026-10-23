# Rà soát cơ chế harness — 23/10/2026

## Cập nhật sau sửa

Đã sửa ở mã nguồn local:

- Kiểm tra AST phép tổng hợp cho cả aggregate thông thường và timeseries: đúng hàm và cột đo, không chấp nhận nhắc cột trong comment/WHERE/alias thay cho phép đo.
- So sánh phạm vi aggregate có JOIN: chuẩn hóa alias về bảng vật lý, giữ các điều kiện WHERE/ON khi sửa truy vấn; bổ sung bảng không được làm mất điều kiện cũ.
- Chuẩn hóa Date thành ISO trước khi bảo vệ dữ liệu lưu trữ.
- Chọn kết quả nhóm mới nhất đạt kiểm tra bằng chứng; bỏ bản superseded, lỗi hoặc không đạt kiểm chứng. Cùng tiêu chí dùng khi render và đánh giá hoàn tất.
- Lưu attempt bị preflight chặn với rejected/not_executed và lý do, không tăng số SQL đã thực thi.
- Sửa đơn giá ngân sách theo tokenCost/1.000, tương ứng quy ước hiện có của giao diện/analytics; đối soát theo usage thực nếu adapter cung cấp.
- Cập nhật mock DOM/timer và fixture nguồn/quan hệ của test JOIN; giữ nguyên lớp bảo vệ sản phẩm.

Kiểm thử sau sửa: **1.068 test, 1.054 đạt, 0 lỗi, 14 bỏ qua**. Log: `output/ipms-electricity-audit-20261023/full-mechanism-fixed-test.log`. Các test hồi quy mới ở `tests/harness_audit_regressions.test.js` và `tests/harness_evidence_flow.test.js`.

Chưa triển khai host. Không phục hồi tự động ngày đã mất trong dữ liệu lưu cũ. Các giới hạn thiết kế bên dưới vẫn cần phân biệt với lỗi đã sửa: kiểm tra mất phạm vi hiện áp dụng SELECT các bảng vật lý, không chứng minh đầy đủ mọi CTE/self-JOIN; phép đo phải được khai báo trong plan mới đối chiếu được. Đây chưa phải bộ chứng minh toàn bộ ý nghĩa nghiệp vụ hoặc phát hiện mọi câu trả lời sai.

## Phạm vi và kết luận

Rà luồng nhận câu hỏi, lịch sử, định tuyến workflow/schema, hợp đồng yêu cầu, JOIN, SQL, bằng chứng, hoàn tất và hiển thị. Kết hợp đọc mã, bộ kiểm thử toàn dự án, bốn phép tái hiện cô lập và bằng chứng chạy thật đã lưu từ các lượt trước. Lượt này không thay đổi mã chạy sản phẩm, không triển khai host và không gọi thêm provider.

Kết luận: kiểm soát quyền, nguồn dữ liệu và an toàn SQL có nhiều lớp hợp lý. Điểm yếu chính là **SQL chạy hợp lệ chưa đồng nghĩa trả lời đúng yêu cầu nghiệp vụ**. Cần hợp đồng chung về chỉ tiêu, bộ lọc, thời gian, mức hạt và phép tính; không nên bổ sung nhánh theo từng câu hỏi.

## Phần hợp lý cần giữ

- Connector kiểm tra nguồn, quyền và chính sách trước truy vấn; nguồn chỉ định sai bị từ chối thay vì tự chuyển sang nguồn khác. Có timeout và hủy truy vấn.
- JOIN dựa trên quan hệ đã xác minh và quyền hiện tại. Bản sửa trước đã bổ sung mở rộng plan thiếu bảng nhưng vẫn kiểm tra khóa JOIN và giữ ràng buộc cũ. Không nên giải quyết M_Customer bằng cách bỏ kiểm tra phạm vi.
- Workflow có kiểm tra chủ sở hữu, quyền khi tiếp tục/chuyển kết quả, phiên bản thực thi và cache theo phạm vi quyền.
- Tách kết quả một phần khỏi thành công, giữ NULL/tháng thiếu, yêu cầu bằng chứng SQL cho dữ liệu và kiểm tra dữ liệu biểu đồ/xuất file.
- Đồng hồ yêu cầu lấy từ backend; truy vấn “sắp đến hạn” thiếu khoảng ngày phải hỏi lại. Đây là hướng đúng, cần mở rộng kiểm chứng ý nghĩa khoảng thời gian.
- Đường trả lời chat công khai chỉ chọn các trường provider cần thiết; chưa thấy bằng chứng lộ khóa provider qua đường này.

## Lỗi tái hiện được

### P1 — Sai chỉ tiêu tổng hợp vẫn được chấp nhận

`src/backend/training_core/sql_evaluator.js:35` chỉ kiểm tra metric/aggregation khi intent là `aggregate_timeseries`. Với intent `aggregate`, plan yêu cầu SUM(Amount), SQL SUM(OtherAmount) vẫn được `assessSqlEvidence` chấp nhận, không có lỗi.

**Ảnh hưởng:** câu hỏi tổng tiền, sản lượng hoặc công nợ có thể ra con số hợp lệ về SQL nhưng sai đại lượng.

**Sửa chung:** hợp đồng phép đo gồm cột nguồn, hàm tổng hợp, đơn vị, cơ sở tiền và mức hạt. Đối chiếu AST SQL với hợp đồng cho mọi loại tổng hợp. Không dựa vào việc có bất kỳ SUM/COUNT nào.

### P1 — Không phát hiện mất bộ lọc khi SQL có JOIN

`completion_policy.js:73` bỏ qua so sánh phạm vi nếu FROM không có đúng một bảng. Phép thử tổng hóa đơn JOIN khách hàng có CustomerCode, sau đó cùng truy vấn bỏ CustomerCode, trả `dropsAggregateScope=false`.

**Ảnh hưởng:** bước sửa SQL có thể mở rộng từ một khách hàng sang toàn bộ dữ liệu mà cơ chế chống mất phạm vi này không phát hiện. Các lớp quyền khác vẫn hoạt động; đây là mất phạm vi câu hỏi, không phải bằng chứng vượt quyền.

**Sửa chung:** ghi bộ lọc chuẩn hóa vào hợp đồng yêu cầu, gắn với bảng/cột nguồn; kiểm tra từng SQL cuối, bao gồm JOIN/CTE. Không chỉ so với truy vấn trước đó.

### P2 — Giá trị Date bị biến thành `{}` khi bảo vệ dữ liệu lưu trữ

`src/backend/storage/postgres/crypto.js:39` duyệt mọi object bằng Object.entries, không xử lý Date. Phép thử ngày ISO đầu vào trở thành object rỗng. Đường repository/codec dùng hàm này.

**Ảnh hưởng:** mất ngày trong dữ liệu lưu/audit đi qua đường này; dữ liệu trước và sau lưu có thể khác nhau, làm yếu khả năng tái hiện bằng chứng. Không kết luận mọi bảng/ngày đều bị lỗi vì còn phụ thuộc kiểu giá trị trước khi lưu.

**Sửa chung:** chuẩn hóa kiểu dữ liệu trước mã hóa và băm bằng chứng; Date thành ISO, quy định rõ kiểu hỗ trợ. Kiểm thử round-trip cả JSON và PostgreSQL.

### P2 — Kết quả nhóm chọn lần thành công đầu tiên

`semantic_groups.js:10` dùng `find`. Phép thử nhóm có kết quả đầu Total=1 và lần sửa Total=2 vẫn chọn Total=1.

**Ảnh hưởng:** khi một nhóm có nhiều kết quả thành công, bản sửa có thể không được dùng. Phép thử xác nhận hành vi chọn; chưa khẳng định mọi luồng hiện tại đều tạo nhiều lần thành công cùng nhóm.

**Sửa chung:** kết quả được chọn phải có revision, trạng thái bị thay thế và xác minh hợp đồng. Không đơn thuần đổi sang “lấy cuối” vì bản cuối cũng có thể sai.

## Bất hợp lý và khoảng trống khác qua mã nguồn

1. **P2 — Chẩn đoán thiếu lệnh bị chặn trước thực thi.** `guarded_agent_harness.js:634–668`: nhánh rejection ghi mã vào trace.steps nhưng phần thêm vào toolCalls ở nhánh thực thi. Cần một bản ghi attempt chung, phân biệt rejected/executed, giữ lý do và tham số đã che thông tin nhạy cảm. Không tính rejected là đã chạy SQL.
2. **P2 — Hai tên trường chi phí không khớp.** Provider manager dùng `tokenCost`; adapter dự trù ngân sách bằng `costPerToken` và mặc định 0. Nếu không có giá trị bổ sung tại runtime, phần dự trù chi phí sẽ bằng 0. Cần thống nhất tên và đơn vị giá, sau đó kiểm tra đối soát usage thực tế; không tự đổi đơn vị khi chưa có quy ước.
3. **P1 — Kiểm chứng ý nghĩa còn thiếu.** Các kiểm tra hiện tại mạnh hơn ở cấu trúc/quyền so với đúng chỉ tiêu, đúng kỳ, snapshot công nợ, mức hạt và đầy đủ lịch sử. Bản sửa đồng hồ ngăn ngày tự bịa nhưng chưa thay thế hợp đồng “hết hạn dùng EndDate và toán tử nào”. Cần bộ kiểm chứng có cấu trúc thay vì chỉ nhận xét văn bản bằng model.
4. **P2 — Nhiều tầng cùng điều chỉnh kế hoạch.** Memory, semantic review, schema recovery và các đường harness cũ làm việc xác định kế hoạch cuối khó hơn. Cần phiên bản kế hoạch bất biến theo từng lần sửa và lý do thay đổi; không xóa toàn bộ lịch sử để giảm token.
5. **P2 — Workflow đúng operation chưa chắc đúng nghiệp vụ.** Khả năng aggregate/list là cần thiết nhưng chưa đủ để xác nhận định nghĩa tiền, kỳ, ngày chứng từ hay công tơ. Workflow nên công bố input, phép đo, mức hạt, điều kiện dữ liệu và giới hạn; chỉ publish sau kiểm thử số liệu đối chứng.
6. **P2 — Trình bày có thể tạo cảm giác đủ dữ liệu.** Một hàng SUM với NULL không có nghĩa tìm được một chứng từ; bảng xem trước không phải toàn bộ tập kết quả. Cần tách số hàng trả về, số bản ghi nghiệp vụ, độ đầy đủ và phạm vi đã xác minh.

## Kiểm thử và giới hạn

- `npm test`: **1.062 test; 1.043 đạt; 5 lỗi; 14 bỏ qua**.
- Bốn lỗi frontend dừng ở môi trường VM/mock thiếu clearInterval (2), document.querySelectorAll (1), renderPageChatQuestionActions (1). Chưa phải bằng chứng bốn lỗi tương ứng xảy ra trên trình duyệt thật.
- Một test tool_registry mong lỗi thiếu JOIN plan nhưng hiện bị chặn sớm bởi SQL_SOURCE_REQUIRED. Cần cập nhật fixture nguồn để test thật sự tới đúng lớp JOIN; không nới kiểm tra nguồn để làm test xanh.
- Script tái hiện: `output/ipms-electricity-audit-20261023/mechanism-probes.cjs`. Dùng dữ liệu giả lập, chạy với setup_isolated_data; cả bốn hành vi nêu trên đã được assert.
- Log toàn bộ: `output/ipms-electricity-audit-20261023/full-mechanism-test.log`.
- Chưa kiểm tra tải đồng thời, mọi provider, mọi đường legacy và bản đang triển khai trên host trong lượt này. Kết quả đạt unit test không chứng minh độ chính xác câu trả lời thực tế.

## Thứ tự sửa đề xuất

1. Hợp đồng yêu cầu thống nhất: nguồn, thực thể, bộ lọc, thời gian, phép đo, mức hạt, phép tính, đầu ra và tiêu chí dữ liệu đủ. Dùng cùng hợp đồng trước SQL và trước trả lời.
2. Bộ kiểm chứng AST cho metric/filter/JOIN; chỉ kết quả đạt hợp đồng mới được chọn. Bảo toàn kết quả đúng một phần khi bước sau lỗi.
3. Sửa round-trip Date và vòng đời revision của bằng chứng/nhóm kết quả; bổ sung attempt bị chặn vào audit.
4. Chốt định nghĩa nghiệp vụ điện/công nợ thành workflow có phiên bản và dữ liệu đối chứng; vẫn có đường SQL chung cho yêu cầu ngoài workflow.
5. Sửa hạ tầng test, thống nhất chi phí/token và kiểm tra hồi quy default provider. Sau đó đối chiếu host bằng build/config fingerprint và cùng bộ câu hỏi.

Tiêu chí nghiệm thu: cùng một ý hỏi diễn đạt khác nhau, chat mới, hỏi nối tiếp và thử lại phải giữ đúng nguồn/phạm vi/chỉ tiêu; sai hoặc thiếu dữ liệu phải nêu rõ thiếu gì, không trả số từ kết quả chưa đạt hợp đồng. Đối chiếu SQL oracle độc lập, không lấy chính câu trả lời model làm đáp án chuẩn.
