# Sửa tiếp nối ngữ cảnh — 23/10/2026

## Cơ chế đã sửa

Áp dụng cho guarded harness dùng chung, không rẽ nhánh theo hợp đồng, khách hàng hay mã KA0021.

1. **Tham chiếu cả câu trả lời:** lastDataset có nhiều datasets, nhãn nhóm, tổng số hàng, phạm vi SQL chuẩn hóa, cột đầu ra và khóa bản ghi. Nhóm rỗng không ghi đè nhóm có dữ liệu. Business state giữ cấu trúc semanticGroups.
2. **Thêm thông tin giữ phạm vi:** tham chiếu đã được xác minh trở thành followupScope. Backend dựng lại từng nhóm từ các điều kiện cũ; SQL model chỉ cung cấp phép chiếu và JOIN bổ sung. Giữ cột cũ, nhận diện alias theo nguồn vật lý; lookup dùng LEFT JOIN và vẫn phải qua bộ kiểm tra JOIN hiện có.
3. **Kiểm tra hai lần:** trước SQL kiểm tra root, WHERE, GROUP BY/HAVING, JOIN và các trường giữ lại; sau SQL kiểm tra thêm tập khóa khi reference có đủ khóa và toàn bộ kết quả nhỏ đã được lưu. Khóa định danh bản ghi được tách khỏi các trường tóm tắt để thiếu ngày hiển thị không vô hiệu hóa kiểm tra PK.
4. **Tiếp nối nhiều lượt:** so sánh cấu trúc không phụ thuộc thứ tự khóa object của PostgreSQL JSONB; chuẩn hóa alias, thứ tự hai vế đẳng thức và literal chuỗi tương đương. Giữ alias hiển thị của trường đã bổ sung ở lượt trước.
5. **Nhóm điều kiện không phải nhóm theo cột:** semanticGroups không bị đánh giá lại bằng partition trên một SQL cuối. Backend giữ nhóm rỗng trong render và đánh giá hoàn tất.
6. **Resolver lỗi không mở rộng truy vấn:** câu phụ thuộc tham chiếu chưa giải quyết được sẽ hỏi lại và bị đánh dấu chưa hoàn tất. Với tham chiếu tập hợp đã phân giải và duy nhất một dataset phù hợp, dùng dataset đó thay cho các entity riêng lẻ. Yêu cầu thêm cột bị model gán continuation vẫn được chuẩn hóa về thao tác trên danh sách.
7. **Không ghi đè bằng kết quả lỗi:** lượt bổ sung PARTIAL giữ riêng followupBase đã xác minh để có thể thử lại; đây không phải dữ liệu của lượt lỗi. Pending của yêu cầu không liên quan vẫn che kết quả cũ như trước. Nguồn, quyền, tài khoản và TTL tiếp tục được kiểm tra.
8. **Audit và ngân sách:** ghi scope được giữ/từ chối, số nhóm dựng lại; lệnh preflight rejected/not_executed không tiêu hao hạn mức SQL đã thực thi. Hạn mức công cụ/vòng sửa vẫn giữ để chặn lặp vô hạn.
9. **Kiểu dữ liệu và metadata ngày:** sanitizer giữ Date dạng ISO. Kiểm tra thời gian dùng đầy đủ cột được phép trong intentCatalog, bổ sung kiểu từ metadata đã mở rộng khi cần; không phụ thuộc việc cột ngày có nằm trong phần chiếu rút gọn hay không.

## Kiểm thử

- Bộ toàn dự án: 1.077 test, **1.063 đạt, 0 lỗi, 14 bỏ qua**.
- Test mới `tests/memory_continuity.test.js`: hợp đồng/nhân viên/đơn hàng; nhóm có dữ liệu và nhóm rỗng; bổ sung nhiều lượt; mô phỏng JSONB đổi thứ tự khóa; đổi alias JOIN và đảo vế khóa bằng nhau; mapped display thay FK; nguồn khác; resolver ID sai; scopeAction/continuation; pending lỗi; cột ngày deferred; hạn mức SQL phân biệt rejected với executed.
- Log: `output/ipms-electricity-audit-20261023/memory-continuity-full-tests.log`.
- Chạy hội thoại thật chỉ dùng provider và nguồn mặc định, cùng session qua HTTP, không dùng lịch sử dựng giả. Chuỗi cuối: lấy danh sách hết hạn/sắp đến hạn 30 ngày, tách hai nhóm → thêm tên khách hàng → thêm mã khách hàng. **Cả ba lượt SUCCESS**, lần lượt khoảng 18,5 / 21,5 / 20,6 giây; mỗi lượt có hai SQL thành công và đều memoryPersisted=true.
- Đọc lại memory sau lượt thứ ba và assert: root T_Contract, khóa chính ContractID, đúng tập 11/57/105, hai nhóm 3/0 hàng, có CustomerCode và CustomerName, pendingTurn=null. Kết quả: `output/ipms-electricity-audit-20261023/memory-continuity-verified.json`; runner kiểm chứng: `verify-memory-continuity.cjs`. Không chỉ đối chiếu nội dung câu trả lời hoặc trạng thái SUCCESS.
- Bằng chứng lượt chạy cuối: `memory-continuity-fixed-v8-live.private.json` và `memory-continuity-fixed-v8-audits.private.json` trong cùng thư mục output. Các lượt thử trung gian được giữ để thấy nguyên nhân sửa, không dùng làm kết quả nghiệm thu.

## Giới hạn chủ động

- Tự tiếp nối phạm vi hỗ trợ SELECT trực tiếp từ các bảng vật lý và lookup LEFT JOIN đã được kiểm chứng. CTE/subquery/self-JOIN không đủ thông tin vai trò sẽ không tự suy đoán phạm vi.
- Kiểm tra tập khóa chính đầy đủ phụ thuộc giới hạn lưu khóa dataset; tập lớn vẫn kiểm tra phạm vi SQL, không khẳng định đã đối chiếu mọi khóa bản ghi.
- Tham chiếu cũ trước bản sửa có thể thiếu cấu trúc nhóm/phạm vi. Khi đó cần xác nhận hoặc chạy lại câu gốc; không tự hợp thức hóa kết quả sai đã lưu.
- Không bật lưu mọi PARTIAL như SUCCESS, không nới ACL hoặc cho phép JOIN theo tên cột giống nhau.
- Chưa triển khai host trong tác vụ này.
