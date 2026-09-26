# Workflow/plugin phase 1

Ngày triển khai: 26/09/2026. Backend và frontend dùng contract version 1. Tính năng mặc định tắt; SQL/RAG cũ vẫn hoạt động khi tắt.

## Bắt đầu

Embed chat dùng cùng bộ nhận diện mẫu, kiểm tra audience và runtime. Widget có form bổ sung dữ liệu, kết quả theo mapping, token và nút làm lại; khôi phục tối đa 20 tác vụ bằng `sessionStorage` khi tải lại trong cùng tab. Mỗi phiên có credential ký riêng, không thể đọc tác vụ bằng run ID của phiên khác. Widget bị vô hiệu hóa sẽ chặn tác vụ mới và worker. Số dòng kết quả bị giới hạn bởi `maxRows`; tải artifact chưa hỗ trợ trong embed. `WORKFLOW_PLUGINS_ENABLED=false` vẫn chặn tạo/chạy nghiệp vụ.

1. Với storage PostgreSQL: sao lưu theo quy trình hiện có, chạy `npm run db:migrate` bằng migration role. Migration `004_workflow_plugins.sql` thêm `app.workflow_catalog`, `app.automation_runs`; CLI cấp quyền cho runtime role. Không cần migration browser hoặc decision provider.
2. Khởi động server bình thường. Worker automation được bật cùng worker hệ thống; `KNOWLEDGEHUB_WORKERS_ENABLED=false` vẫn dùng cho môi trường không chạy job.
3. Mở **Mẫu nghiệp vụ**. Admin có thể **Tạo mẫu** hoặc **Import gói**. Các ví dụ phase 1 dùng fixture, chưa chứa mapping nghiệp vụ thật.
4. Chỉnh thông tin, slots/câu hỏi, bindings, danh sách bước, output và fixtures. Chạy **Validate**, **Chạy fixture**, rồi **Publish**. Draft chưa publish không tham gia routing.
5. `WORKFLOW_PLUGINS_ENABLED=false` luôn tắt tính năng, ưu tiên hơn cấu hình đã lưu và không cho bật lại từ UI. Để cho phép sử dụng, đổi biến thành `true` rồi khởi động lại máy chủ; sau đó bật workflow/plugin trong trang này nếu cấu hình lưu đang tắt. Khi biến không được khai báo, dùng cấu hình đã lưu (mặc định tắt nếu chưa có).
6. Chạy template từ trang quản trị hoặc hỏi theo examples trong chat. Bổ sung dữ liệu bằng form hoặc trả lời chat. Chat hỗ trợ hủy tác vụ; run/file luôn kiểm tra owner phía server.

## Definition và SQL binding

Import JSON chứa `manifest` và `templates`; xem cấu trúc đầy đủ trong `src/backend/automation/pilot.json`. `manifest` khai báo id, name, version nguyên dương, engineContractVersion=1, domain/tags tùy ý và dependencies theo id/version. Không có enum nghiệp vụ trong engine.

Mỗi template khai báo inputs, examples, allowedCapabilities, workflow, output.schema/output.mapping và fixtures. Input slot gồm `schema`, `label`, `ask`, `required` hoặc `requiredWhen`, và default nếu phù hợp. Schema version 1 hỗ trợ object/array/string/number/integer/boolean/null, required, enum, giới hạn số/chuỗi, additionalProperties, date/date-time. Các keyword khác bị từ chối thay vì bị bỏ qua.

Primitive hỗ trợ: transform, condition, assert, collect, delay, sql, export. Reference dùng `{{input.slot}}` và `{{steps.previousStep.field}}`. Reference tới bước chưa chạy hoặc slot không tồn tại bị chặn. Không hỗ trợ JavaScript tùy ý, HTTP/MCP/browser trong bản phase 1 này.

Ví dụ cấu hình binding đọc SQL Server:

```json
{
  "lookup_binding": {
    "dbSourceId": "ID_NGUON_SQL_DA_CAU_HINH",
    "tables": ["dbo.Customers"],
    "sql": "SELECT TOP 100 [Code], [Name] FROM [dbo].[Customers] WHERE [Code]=@code",
    "parameters": { "code": { "slot": "customerCode", "type": "string" } }
  }
}
```

Step: `{"id":"query","name":"Đọc dữ liệu","type":"sql","config":{"bindingRef":"lookup_binding"}}`. Output đọc `{{steps.query.rows}}`. Fixture SQL phải cung cấp `stepResults.query`; fixture không kết nối live. Validate/publish kiểm tra source live và bảng có trong catalog, runtime kiểm tra lại trước mỗi truy vấn. Tham số đi qua `Request.addParameter` của Tedious, không nội suy vào SQL. Các loại parameter: string, integer, number, boolean, date; kiểu phải khớp slot schema. Identifier/SQL nằm trong definition do admin quản lý. Không nhận SQL từ slot.

Fixture thành công xác nhận contract/mapping; cần smoke test trên dữ liệu thật để xác nhận query, công thức và hiệu năng. Đầu ra SQL có `rows`, `rowCount`, `source`, `retrievedAt`, `empty`. Kết quả không có dòng được biểu diễn rõ bằng `empty`, không mặc định diễn giải số dư bằng 0.

`output.presentation.labels` ánh xạ đường dẫn field sang nhãn nghiệp vụ, ví dụ `{"rows.Code":"Mã khách hàng","source":"Nguồn dữ liệu"}`. Frontend render object thành các trường, danh sách object thành bảng và dùng nhãn của definition; không cần sửa UI khi thêm template. `presentation.emptyText` cấu hình thông báo không có dữ liệu.

## Version, skill và tùy chỉnh

Published version là bất biến; sửa gói tạo version cao hơn mọi version đã publish. Publish yêu cầu fixture đạt trên đúng hash draft. Rollback chọn version đã lưu, không sửa snapshot của run đang chạy. Disable gói chặn discovery/run mới; run đã ghim definition vẫn tiếp tục nếu quyền còn hợp lệ.

**Nạp 5 mẫu** sao chép cấu hình skill hiện tại vào `legacySkills`, giữ instructions/name/enabled/exampleIds/version. Hai template đầu giữ hướng dẫn và trạng thái enabled tương ứng. File `skills.json` và luồng legacy được giữ để rollback; hai skill cũ không tự được coi là template SQL đã nghiệm thu.

Overlay dùng scope `account:<accountId>` hoặc tenantId từ account đã xác thực. Giao diện nhận một definition hiệu lực đầy đủ, lưu snapshot overlay/version riêng; gói gốc giữ nguyên. Overlay được thay slots, câu hỏi, mapping, workflow và output trong contract được cấp: không mở rộng manifest/audience/capabilities, không đổi connection/bảng/SQL, không bỏ slot hoặc review bắt buộc. Mapping tham số có thể tùy chỉnh trong SQL/bảng đã cấp. Đổi quyền hoặc SQL thực hiện qua version gói do admin publish. Overlay tự ngừng áp dụng khi base version đổi; cần kiểm thử lại trên base mới.

## Trạng thái, khôi phục và file

Các trạng thái: READY → RUNNING → SUCCEEDED/FAILED; WAITING_INPUT để hỏi lại; NEEDS_REVIEW khi không thể tự khôi phục; CANCELLED khi hủy. Template yêu cầu review AI bắt buộc giữ NEEDS_REVIEW vì phase 2 chưa tích hợp.

Run store lưu definition/input/provenance/version, step attempts, checkpoint và sự kiện trong một document cập nhật atomically bằng CAS theo revision. PostgreSQL có index owner/conversation/status; JSON dùng ghi file atomically, phù hợp một server/process. Không chạy nhiều process ghi chung JSON.

Mỗi conversation chỉ có một run đang hoạt động/chờ; mỗi owner có phạm vi riêng. Sửa input vô hiệu hóa checkpoint/kết quả phụ thuộc rồi lập lại từ đầu; không cho sửa khi đang chạy hoặc đã tạo file. Dữ liệu mặc định hiển thị với provenance. Worker có tối đa hai job đồng thời và lease theo run; không giữ transaction SQL trong lúc thực thi bước.

Sau restart: READY tiếp tục; RUNNING có lease chưa hết hạn chờ lease hết hạn. Bước đọc/pure có thể chạy lại. Gián đoạn trong export chuyển NEEDS_REVIEW, không tự tạo file lần nữa; người dùng kiểm tra và hủy để tạo run mới. Cancel ngăn bước tiếp theo và gửi abort khi adapter hỗ trợ; không cam kết hoàn tác tác động đã gửi.

File CSV/XLSX nằm trong exports/automation, có owner/run và hạn tải bảy ngày. Chỉ tải qua `/api/automation-runs/:id/artifacts/:artifactId`; URL legacy `/api/exports/automation/...` bị chặn. File hết hạn không còn tải được; chưa có job xóa file vật lý tự động.

Sự kiện: GET `/api/automation-runs/:id/events`, gửi `Last-Event-ID` hoặc `?after=`. API trả một batch SSE hữu hạn; client kết nối lại lấy batch tiếp theo. Giao diện hiện poll run đang hiển thị mỗi 1,5 giây và phục hồi panel từ chat history sau reload. Lịch sử page chat hiện dùng PostgreSQL theo kiến trúc sẵn có; JSON fallback của automation không thay yêu cầu này.

## Backup và rollout

PG backup schema app bao gồm hai bảng mới. Backup bundle bổ sung automation_exports kể cả khi export directory nằm ngoài data directory. Snapshot/preflight/import/export PostgreSQL xử lý riêng hai domain JSON mới và verify trong cùng transaction với dữ liệu cũ. JSON backup toàn bộ data directory giữ catalog/run và exports ở vị trí mặc định.

Mở feature cho pilot sau fixture và smoke test. Tắt feature dừng nhận run mới và dừng nhận job đang chờ; run đang thực thi vẫn theo policy đã ghim. Không xóa definition/run/audit khi rollback code. Tài khoản bị khóa hoặc thu hồi audience/SQL source được kiểm tra trước bước tiếp theo. Worker dừng cùng backup gate và shutdown server.

## Kiểm thử

- `npm test`
- `npm run eval:local`
- `npm run eval:sql`
- `npm run eval:workflows`
- `npm run test:storage` khi có PostgreSQL bootstrap test credentials; tạo DB test riêng.
- Browser: cài Playwright vào thư mục công cụ riêng, đặt `PLAYWRIGHT_MODULE_PATH`, `TEST_BROWSER_PATH` nếu cần và `KNOWLEDGEHUB_TEST_BROWSER=1`; chạy `node --require ./tests/helpers/setup_isolated_data.js --test tests/automation_browser.test.js`.

Browser test dùng auth và chat-history store giả lập; catalog/run thực thi bằng repository JSON thật. Không xem test này là đã kiểm chứng PostgreSQL hoặc model live.
# Nguồn dữ liệu SQL, API, file và bước trước

Trong **Nguồn dữ liệu → Thêm**, chọn SQL, API, File trong Thư viện hoặc Kết quả bước trước. Với node đọc dữ liệu, chọn thao tác **Đọc nguồn SQL / API / file / bước trước** rồi chọn nguồn đã tạo. Node SQL cũ vẫn chạy như trước.

- API hỗ trợ GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS; header và query; body JSON, văn bản, URL-encoded form, multipart hoặc binary file. URL giữ origin cố định; path, query, header và body có thể tham chiếu đầu vào/bước trước. Xác thực gồm Bearer (biến môi trường hoặc token từ node trước), Basic (mật khẩu từ biến môi trường), API key qua header/query. Credential không cần lưu trực tiếp trong definition.
- Phản hồi API có JSON, văn bản, file tải xuống hoặc tự nhận diện Content-Type. `dataPath` chọn phần JSON, ví dụ `data.items`; `response.status` và `response.headers` cung cấp thông tin HTTP (không trả Set-Cookie). File phản hồi lưu thành artifact của run, có kiểm tra chủ sở hữu khi tải. API có thể nhận file trong Thư viện qua binary hoặc multipart `{ documentId, filename }`.
- API HTTP hoặc mạng nội bộ cần `WORKFLOW_API_ALLOWED_ORIGINS` trong `.env`, ví dụ `https://api.internal.example,http://localhost:8080`. Đây là danh sách origin chính xác; endpoint khác vẫn được kiểm tra DNS/IP. Giới hạn request/response 2 MB, timeout mặc định 30 giây (cấu hình 1–60 giây), redirect 0–5 lần trong cùng origin. OAuth có thể thiết lập bằng một node lấy token rồi truyền Bearer sang node tiếp theo; chưa có bộ tự refresh OAuth hoặc mTLS.
- API ghi dữ liệu không tự retry. Tác vụ bị gián đoạn khi ghi, hoặc chưa xác nhận được phản hồi, chuyển sang `NEEDS_REVIEW` để tránh gửi lặp.
- File chọn từ Thư viện, không nhận đường dẫn filesystem tùy ý. CSV/Excel trả về các dòng; JSON trả về dữ liệu đã parse; tài liệu khác dùng nội dung văn bản đã xử lý. Giới hạn 2 MB và 1.000 dòng. JSON có thể chọn định dạng thủ công cho tài liệu đã lưu; Excel dùng sheet đầu nếu chưa chọn sheet.
- Kết quả bước trước dùng tham chiếu `{{steps.node_id}}` hoặc đường dẫn con như `{{steps.node_id.rows}}`. Bộ chọn cung cấp kết quả, danh sách dòng, số dòng và các cột SQL đã mapping. Tham chiếu tới node hiện tại hoặc node phía sau bị từ chối khi lưu.
- Tham số SQL có thể giữ cấu hình `slot` cũ hoặc dùng `value: "{{steps.node_id.rows.0.Column}}"` và `type`. Giá trị kế thừa được kiểm tra kiểu và truyền qua parameter, không ghép vào chuỗi SQL.

Node đọc nguồn trả về `rows`, `rowCount`, `source`, `empty`; API/file/bước trước còn có `data` chứa dữ liệu gốc. Dùng các đường dẫn này trong cấu hình kết quả trả về chat. Fixture của API, file và SQL phải cung cấp `stepResults` để chạy thử không gọi nguồn thật; nguồn kế thừa chạy trên dữ liệu giả lập của bước trước.
