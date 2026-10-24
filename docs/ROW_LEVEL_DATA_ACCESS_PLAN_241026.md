# Kế hoạch: lọc dữ liệu theo dòng cho từng người dùng — 24/10/2026

## 1. Mục tiêu

Mỗi tài khoản hoặc vai trò chỉ thấy những dòng dữ liệu SQL thuộc phạm vi của mình (ví dụ theo đơn vị, chi nhánh, dự án). Điều này áp dụng cho mọi đường truy vấn: trò chuyện với AI, mẫu nghiệp vụ, chỉ số đã duyệt, công cụ MCP và widget nhúng.

Ngoài phạm vi:
- Không ghi bất cứ gì vào SQL Server IPMS (chỉ đọc). Vì vậy không dùng tính năng bảo mật theo dòng có sẵn của SQL Server. Toàn bộ việc lọc nằm ở ứng dụng, còn cấu hình lưu ở PostgreSQL của ứng dụng.
- Không thay đổi cơ chế quyền chức năng và phạm vi nguồn đã có (xem `ACCOUNT_ROLES_PERMISSIONS_171026.md`).

## 2. Hiện trạng

| Lớp | Đã có | Vị trí |
|---|---|---|
| Quyền chức năng | 13 quyền, vai trò tùy chỉnh, quyền riêng từng tài khoản | `services/account_roles.js`, `services/account_access.js`, `routes/router.js:370` |
| Phạm vi nguồn | `dataAccess.sql` / `dataAccess.documents` (giao giữa vai trò và tài khoản) | `governance/context.js` → `canRead()` |
| Chính sách nguồn | `visibility`, `subjects`, `roles`, `allowedTables`, `blockedColumns`, `modelDestinations` | `governance/routes.js`, `governance/sql_policy.js` |
| Lọc theo dòng | **Chưa có** | — |

Mọi câu SQL chạy thật đều đi qua một điểm duy nhất:
`sql_connector.executeSqlQuery()` → `executeAdmittedSql()` → `governance/sql_policy.check()`. Đây là nơi đặt bộ lọc theo dòng, vì không đường nào vượt qua được nó.

Các đường gọi hiện có: `tool_registry._executeSqlQuery`, `agent_core/tools/builtins`, `automation/sql.js`, `governance/metrics.js`, `text2sql_agent.js` và `dictionary_service` (kiểm tra chất lượng, chỉ admin dùng).

Ngoài ra còn mấy điểm đang mặc định cho phép, nên xử lý cùng đợt (giai đoạn 0):
- `account_access.allowed()` cho qua mọi thứ khi tài khoản không có danh sách quyền.
- Vai trò hệ thống `user` có đủ mọi quyền và không bị giới hạn nguồn.

## 3. Thiết kế

### 3.1 Thuộc tính phạm vi của người dùng

Thêm `scopeAttributes` cho vai trò và tài khoản, kế thừa giống `dataAccess`:

```json
{ "scopeAttributes": { "don_vi": ["DV01", "DV02"], "chi_nhanh": null } }
```

- Khóa (`don_vi`, `chi_nhanh`...) là **tên thuộc tính trừu tượng**, do admin khai báo trong một danh mục thuộc tính. Đó không phải tên cột.
- `null` nghĩa là kế thừa, `[]` nghĩa là không có giá trị nào (sẽ chặn hết).
- Giá trị hiệu lực bằng giao giữa vai trò và tài khoản, cùng quy tắc với `dataAccess` trong `account_roles.effective()`. Tài khoản chỉ được thu hẹp, không được mở rộng.
- Các giá trị này là cấu hình phân quyền gắn với tài khoản. Chúng không được đưa vào metadata lược đồ hay lời nhắc gửi cho AI (theo quy tắc "không đưa giá trị thật vào metadata").

### 3.2 Quy tắc lọc trên từng bảng (thuộc chính sách nguồn)

Mở rộng `governedPolicy` của nguồn SQL:

```json
{
  "rowRules": [
    { "table": "dbo.HopDong", "column": "MaDonVi",  "attribute": "don_vi", "bypassRoles": ["admin"] },
    { "table": "dbo.HoaDon",  "column": "DonViID",  "attribute": "don_vi" }
  ],
  "rowRuleDefault": "deny"
}
```

- Mỗi quy tắc gắn **bảng + cột** với **thuộc tính phạm vi**. Ý nghĩa: `cột IN (giá trị thuộc tính của người dùng)`.
- `bypassRoles`: những vai trò không bị lọc. Mặc định chỉ `admin` được bỏ qua. Nếu muốn lọc cả admin thì để danh sách rỗng.
- `rowRuleDefault`: khi bảng có quy tắc mà người dùng không có giá trị cho thuộc tính đó thì xử lý thế nào. Mặc định là `deny`, tức trả về 0 dòng.
- Bảng không có quy tắc thì không bị lọc, giữ như hiện tại.
- Giai đoạn sau có thể thêm quy tắc qua bảng trung gian (ví dụ bảng chi tiết chỉ có `HopDongID`, cần đi qua `HopDong` để lấy đơn vị). Quan hệ này lấy từ các quan hệ đã xác minh trong `relationship_service`.

Khi lưu chính sách: kiểm tra bảng/cột có thật trong từ điển dữ liệu, và thuộc tính có trong danh mục. Mỗi lần sửa thì tăng `revision`, như cách làm hiện tại.

### 3.3 Viết lại câu SQL trước khi chạy

Thêm `governance/row_policy.js` và gọi nó trong `sql_policy.check()`, sau bước kiểm tra chỉ đọc và kiểm tra bảng/cột:

1. Phân tích câu SQL bằng `node-sql-parser` (TransactSQL), thư viện đã có sẵn.
2. Duyệt toàn bộ cây cú pháp, gồm FROM, JOIN, truy vấn con, CTE, UNION, `EXISTS` và `IN (SELECT ...)`. Mỗi lần gặp bảng có quy tắc thì thay bằng bảng dẫn xuất:
   ```sql
   (SELECT * FROM dbo.HopDong WHERE MaDonVi IN (@rls_0, @rls_1)) AS <bí danh gốc>
   ```
   Giữ nguyên bí danh, nên phần còn lại của câu không phải đổi.
3. Giá trị luôn truyền bằng **tham số** (`@rls_n`) qua `parameters` của `executeAdmittedSql`, không bao giờ ghép chuỗi. Tên tham số phải không trùng với tham số sẵn có của mẫu nghiệp vụ.
4. **Không chắc thì chặn.** Câu không phân tích được, có tên bảng không xác định được (tên động, `OPENQUERY`, view/hàm không có trong từ điển), hoặc cây cú pháp không dựng lại được thành SQL: tất cả đều bị từ chối với mã `SQL_ROW_SCOPE_DENIED`, không chạy bản chưa lọc.
5. Vì `blockedColumns` chặn `SELECT *` nên hàm kiểm tra cột phải chạy **trước** bước viết lại. `SELECT *` bên trong bảng dẫn xuất do hệ thống tự sinh nên được phép.
6. View: nếu view đọc từ bảng có quy tắc mà chính view không có quy tắc, chính sách phải bắt khai báo quy tắc cho view, nếu không thì chặn view đó.

Nên chọn cách bọc bảng thay vì chèn `WHERE` vào câu gốc. Cách bọc đúng với mọi kiểu JOIN (kể cả LEFT/RIGHT/OUTER), với gộp nhóm và truy vấn con, và không đụng đến logic AI đã sinh ra.

### 3.4 Ngữ cảnh người dùng

- `governance/context.js`: principal mang thêm `scopeAttributes` hiệu lực. Truyền vào ở `router.js:286`, `mcp_host_routes.js:85` và `automation/runtime.js:43/227`.
- `refresh()` đọc lại phạm vi mới nhất trước khi chạy. Đổi thuộc tính hoặc quy tắc thì thu hồi phiên liên quan, giống cách làm hiện tại khi đổi quyền.
- Widget nhúng (`channel: 'embed'`): cấu hình widget có `scopeAttributes` cố định. Bảng có quy tắc mà widget không được gán giá trị thì chặn theo `rowRuleDefault`.
- Tác vụ nội bộ không có ngữ cảnh người dùng (`current()` rỗng): chỉ được phép với các đường nội bộ đã liệt kê (kiểm tra chất lượng từ điển). Mọi đường phục vụ người dùng bắt buộc phải có principal.

### 3.5 Bộ nhớ đệm, bộ nhớ hội thoại và kết quả lưu lại

Người khác phạm vi không được dùng lại kết quả của nhau:
- `governance.summary().policyRevision` thêm **dấu vân tay phạm vi dòng**, là mã băm của các quy tắc đang áp dụng cùng giá trị thuộc tính của người dùng. Bộ nhớ dài hạn (`durable_memory`, `memory_service`) và tệp kết quả xuất (`governance/artifacts`) đang so `revision`, nên sẽ tự mất hiệu lực khi phạm vi khác.
- Bộ nhớ đệm lược đồ (`semantic_model`) chỉ chứa metadata, không cần đổi.
- Kết quả chạy mẫu nghiệp vụ (`automation/runtime.js`): lưu kèm dấu vân tay. Người xem có dấu vân tay khác thì không xem được kết quả đó.
- Kết quả tổng hợp mà AI đã đưa vào lịch sử trò chuyện vẫn thuộc về chủ hội thoại. Hiện lịch sử đã lọc theo `account_id`, cần kiểm tra lại các chức năng chia sẻ (nếu có).

### 3.6 Trả lời người dùng

- Khi có lọc, thêm ghi chú phạm vi vào phần bằng chứng của câu trả lời (`answer_envelope`), ví dụ "Số liệu trong phạm vi đơn vị được cấp". Như vậy người dùng không tưởng nhầm đó là số toàn công ty.
- Không đưa giá trị cụ thể của thuộc tính vào lời nhắc gửi cho AI. AI chỉ cần biết là có lọc, không cần biết giá trị.
- Nhật ký kiểm tra ghi lại: những bảng bị lọc, dấu vân tay, và số quy tắc đã áp dụng.

### 3.7 Giao diện quản trị

- **Quản lý tài khoản / Vai trò**: thêm mục "Phạm vi dữ liệu theo thuộc tính" (chọn thuộc tính, nhập hoặc chọn giá trị, có lựa chọn kế thừa).
- **Quản trị dữ liệu → nguồn SQL**: thêm bảng "Quy tắc lọc theo dòng" (bảng, cột, thuộc tính, vai trò được bỏ qua), có nút "Xem trước câu SQL sau khi lọc" bằng một câu mẫu.
- **Danh mục thuộc tính phạm vi**: thêm, sửa, ngừng dùng thuộc tính. Không xóa được thuộc tính còn đang được dùng.

## 4. Lưu trữ

- Migration PostgreSQL mới:
  - Bảng `app.scope_attributes`, là danh mục thuộc tính.
  - Thêm `scope_attributes` vào dữ liệu vai trò và tài khoản.
  - `rowRules` nằm trong `governedPolicy` của nguồn, theo cách lưu hiện có.
- Mở rộng schema Ajv trong `governance/routes.js` cho `rowRules` và `rowRuleDefault`.
- Thêm vào sao lưu/khôi phục theo danh mục lưu trữ hiện có.

## 5. Các giai đoạn

| GĐ | Nội dung | Kết quả |
|---|---|---|
| 0 | Bỏ các chỗ mặc định cho phép (`allowed()` khi thiếu danh sách quyền; xem lại quyền mặc định của vai trò `user`) | Tài khoản cũ phải được gán quyền rõ ràng |
| 1 | Danh mục thuộc tính, `scopeAttributes` cho vai trò và tài khoản, đưa vào principal | Có dữ liệu phạm vi, chưa lọc |
| 2 | `row_policy.js`: viết lại SQL, truyền tham số, không chắc thì chặn. Nối vào `sql_policy.check()` | Mọi đường SQL đã được lọc |
| 3 | Dấu vân tay trong `policyRevision`, vô hiệu bộ nhớ, tệp xuất và kết quả mẫu nghiệp vụ | Không rò rỉ qua bộ nhớ đệm |
| 4 | Giao diện quản trị, xem trước SQL, ghi chú phạm vi trong câu trả lời, nhật ký | Admin tự cấu hình được |
| 5 | Widget nhúng và MCP: gán phạm vi cố định cho từng widget hoặc chủ sở hữu | Phủ hết các kênh |
| 6 (sau) | Quy tắc đi qua bảng trung gian, quy tắc cho view | Bảng chi tiết không có cột phạm vi |

## 6. Kiểm thử

Bộ kiểm tra tự động (`tests/row_policy.test.js` và bổ sung vào `tests/sql_security_corpus.test.js`, chạy bằng `npm run eval:sql`):
- Viết lại đúng cho: bảng đơn, JOIN nhiều bảng có quy tắc, LEFT JOIN, truy vấn con, CTE, UNION, `EXISTS`, gộp nhóm, bí danh và tên có schema hoặc không.
- Chặn: câu không phân tích được, bảng không xác định, tên động, `OPENQUERY`, view chưa khai báo.
- Không có SQL injection qua giá trị thuộc tính (giá trị chứa `'`, `;`, `--`).
- Không trùng tên tham số với mẫu nghiệp vụ có tham số.
- Giao phạm vi giữa vai trò và tài khoản, `[]` thì chặn, `bypassRoles`.
- Hai người dùng khác phạm vi: không dùng lại bộ nhớ, tệp xuất hay kết quả mẫu nghiệp vụ của nhau.
- Đổi quy tắc hoặc thuộc tính giữa chừng thì `refresh()` chặn truy vấn đang chuẩn bị chạy.

Kiểm tra hồi quy: `npm test`, `npm run eval:local`, `npm run eval:workflows`, `npm run eval:schema`. Bảng không có quy tắc phải cho kết quả giống hệt trước khi có tính năng.

Kiểm tra thật trên localhost: tạo hai tài khoản thử với hai phạm vi khác nhau, cùng hỏi một câu và so sánh số dòng hoặc tổng. Chỉ đọc SQL Server, không tạo dữ liệu nghiệp vụ giả.

## 7. Rủi ro và cách xử lý

| Rủi ro | Cách xử lý |
|---|---|
| Bộ phân tích SQL không hiểu một số cú pháp T-SQL nên chặn nhầm | Ghi nhật ký mã `SQL_ROW_SCOPE_DENIED`, bổ sung ca vào bộ kiểm tra. Chỉ bảng có quy tắc mới bị ảnh hưởng |
| Hiệu năng do bọc bảng dẫn xuất | SQL Server thường gộp điều kiện vào kế hoạch thực thi. Đo bằng `benchmark:http` trên các câu nặng |
| Số liệu "toàn công ty" bị hiểu nhầm khi đã lọc | Ghi chú phạm vi trong câu trả lời (mục 3.6) |
| Chỉ số đã duyệt (`governedMetrics`) được định nghĩa trên toàn bộ dữ liệu | Chỉ số đi qua cùng điểm chạy SQL nên tự được lọc. Ghi rõ trên giao diện chỉ số |
| Cột phạm vi bị đổi tên trong IPMS | Kiểm tra quy tắc với từ điển mỗi lần đồng bộ lược đồ. Quy tắc hỏng thì chặn bảng đó và báo admin |

## 8. Việc cần chốt trước khi làm

1. Danh sách thuộc tính phạm vi thực tế (đơn vị, chi nhánh, dự án...) và bảng/cột tương ứng trong IPMS.
2. Admin có bị lọc không (mặc định là không).
3. Khi người dùng chưa được gán giá trị thì chặn hết (mặc định) hay cho xem toàn bộ.
4. Có cần quy tắc qua bảng trung gian ngay từ đầu không, tức có bảng quan trọng nào thiếu cột phạm vi trực tiếp không.
