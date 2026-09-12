# Kế hoạch nâng cấp Skill Core và chỉnh sửa trên UI

> Cập nhật theo phạm vi người dùng chốt ngày 12/09/2026. Skill Core là module nghiệp vụ của project. Tham khảo [Memory Core v2](MEMORY_CORE_UPGRADE_PLAN_v2_120926.md) và [master plan](LOCAL_MODEL_OPTIMIZATION_MASTER_PLAN_v2.md); phạm vi rút gọn dưới đây thay cho các yêu cầu mở rộng ở bản trước.

> Trạng thái: registry JSON, contract, API và tab chỉnh sửa Skills trong Training Core đã được triển khai. Domain note chưa triển khai vì là bước tùy chọn sau editor.

## 1. Phạm vi đã chốt

- Bỏ yêu cầu triển khai A/B live trên SQL Server, database fixture và ngưỡng cải thiện chất lượng làm điều kiện triển khai Skill Core trong đợt này.
- Bỏ gói quản trị riêng, quản lý phiên bản/revision, phê duyệt/phát hành, lịch sử phiên bản và rollback riêng cho skill. Không xây thêm hệ thống phân quyền.
- Giữ kiểm tra dữ liệu khi lưu và tests chức năng để xác nhận sửa skill có hiệu lực, không phá routing hoặc prompt. Đây là kiểm tra kỹ thuật thông thường, không có quy trình nghiệm thu/phê duyệt riêng.
- Bổ sung **chỉnh sửa skill trực tiếp trên UI**, lưu JSON và áp dụng cho request mới mà không cần sửa source hoặc restart.
- Dùng cơ chế đăng nhập/quyền hiện có của ứng dụng cho API mới; việc bỏ gói quản trị riêng không đồng nghĩa mở API ghi cấu hình công khai.

SQL Server vẫn là nguồn dữ liệu nghiệp vụ của ứng dụng; chỉ bỏ công việc dựng benchmark A/B trong kế hoạch này. Không thay SQL Server bằng SQLite hoặc sửa/xóa hạ tầng eval đang có.

## 2. Hiện trạng đã kiểm tra

| Thành phần | Code hiện tại | Phần cần bổ sung |
|---|---|---|
| `src/backend/skill_core/registry.js` | Hai skill tĩnh: `record_lookup`, `aggregate_report`; field `id`, `version`, `intents`, `instructions`, `exampleIds` | Đọc cấu hình đã lưu, cập nhật nội dung và bật/tắt từng skill |
| `skill_core/selector.js` | Chọn theo intent, bỏ qua khi thiếu table hoặc data=false | Kiểm tra skill bật/tắt và input/schema cần thiết |
| `skill_core/examples/index.js` | Template JS cho lookup/list/monthly aggregate; default 2 ví dụ | Lọc đúng intent/schema; UI chọn template có sẵn |
| `local_model_harness.js` | Đã nhận skill và examples theo hai cờ env | Giữ một skill/request, dùng nội dung lấy từ registry lúc bắt đầu request |
| `local_prompt_builder.js` | Chèn hướng dẫn và examples vào system message đầu khi có tools | Preview đúng nội dung; kiểm tra thiếu tools/system và giới hạn prompt |
| `src/frontend/views/training_core.html` | Trang Training Core, danh sách case và bộ lọc | Thêm tab cấp trang “Skills” cạnh “Case cải tiến” |
| `src/frontend/js/modules/training_core.js` | Fetch/render report, cập nhật trạng thái case, escape HTML, thông báo kết quả | Có thể tái dùng cách hiển thị; tách JS editor để không làm rối module report |
| `src/backend/routes/router.js` | API Training/report và kiểm tra quyền tập trung | Thêm API dưới `/api/training/skills` để kế thừa quy tắc `/api/training/` hiện có |
| `StorageHelper` | JSON theo `KNOWLEDGEHUB_DATA_DIR`, ghi atomic; JSON hỏng sẽ throw | Tái dùng để lưu `skills.json`, xử lý lỗi rõ ràng |

**Có thể chỉnh skill trên UI, nhưng hiện tại project chưa có chức năng đó.** Không cần framework frontend, database hoặc model mới. Chỉ thêm form editor, API và lớp lưu cấu hình vào luồng đang có.

Planner hiện sinh ba intent: `record_lookup`, `list`, `aggregate_timeseries`; chart/export là output flags. Hai skill đã phủ tên các intent này, nhưng không bảo đảm mọi câu hỏi đều được planner phân loại đúng. Không mở rộng taxonomy trong đợt này.

## 3. Giao diện đề xuất: Training Core → Skills

Tab “Case cải tiến” giữ các bộ lọc hiện tại. Tab “Skills” có danh sách bên trái và form sửa bên phải; màn hình nhỏ xếp dọc. Danh sách skill độc lập với báo cáo case: dù chưa có case cần xem lại vẫn mở được editor.

| Trường trên UI | Cách sử dụng |
|---|---|
| Tên skill | Tên dễ đọc, ví dụ “Tra cứu bản ghi”, “Báo cáo dữ liệu” |
| Mã skill | Hiển thị ID cố định của skill có sẵn |
| Bật/tắt | Cho phép loại skill khỏi selection mà không xóa cấu hình |
| Áp dụng cho | Hiển thị intent bằng nhãn tiếng Việt; mapping giữ cố định ở đợt đầu để tránh hai skill tranh cùng intent |
| Hướng dẫn xử lý | Textarea chỉnh `instructions`; hiển thị giới hạn độ dài |
| Ví dụ gợi ý | Checkbox chọn các template có sẵn tương thích với skill |
| Xem trước | Hiển thị hướng dẫn đã lưu/đang soạn và mô tả template được chọn; không tự chạy SQL hoặc gọi model |
| Lưu / Hủy chỉnh sửa | Lưu qua API; Hủy tải lại giá trị đã lưu, không phải khôi phục phiên bản cũ |

Luồng: mở Skills → chọn skill → sửa hướng dẫn/ví dụ/trạng thái → Lưu → thông báo thành công. Request bắt đầu sau khi lưu nhận cấu hình mới; request đang xử lý tiếp tục dùng bản đã lấy trước đó.

Khi cờ Skill Core đang tắt, editor vẫn cho lưu nhưng hiển thị “Skill Core đang tắt; cấu hình đã lưu chưa áp dụng cho chat”, kèm đường dẫn tới Settings hiện có. Nếu few-shot tắt, lựa chọn examples vẫn được giữ nhưng không chèn vào prompt.

Đợt đầu tập trung **sửa hai skill hiện có**. Không có nút tạo/xóa skill tùy ý, upload file JS/`SKILL.md`, sửa mã tool hoặc template JS trên UI. Việc thêm skill mới cần mapping/contract phù hợp và có thể làm sau khi thật sự cần.

## 4. Lưu cấu hình và API

### 4.1 Registry đọc JSON

- Chuyển registry sang đọc `skills.json` qua StorageHelper; file chưa có dùng hai skill hiện tại làm mặc định. Sau lần Lưu đầu tiên, cấu hình được ghi xuống file.
- Các trường chỉnh được: `name`, `enabled`, `instructions`, `exampleIds`. ID, intent mapping và contract do code quản lý; backend không nhận trường tùy ý từ form.
- Field `version: 1` hiện có có thể giữ để tương thích prompt/trace; không tự tăng revision khi lưu, không thêm lịch sử phiên bản hay nút rollback.
- Registry đọc lại khi bắt đầu request hoặc cập nhật cache sau khi ghi thành công. Selector trả bản sao dữ liệu, không giữ object mutable dùng chung với editor.
- Lưu atomic; chỉ trả thành công khi dữ liệu đã được ghi. Nếu JSON hỏng, báo lỗi rõ trên UI, không ghi đè file lỗi bằng mặc định. Chat có thể bỏ guidance lỗi với reason trong trace thay vì sập toàn request.
- Đợt đầu lưu trực tiếp, lần lưu thành công sau cùng có hiệu lực; chưa có cơ chế gộp chỉnh sửa đồng thời hay revision conflict. UI không tự lưu theo từng phím gõ và khóa nút Lưu khi request đang chạy.

### 4.2 API dự kiến

Các endpoint đã triển khai:

| Endpoint | Chức năng |
|---|---|
| `GET /api/training/skills` | Danh sách skill, giá trị cấu hình, danh sách template được phép và trạng thái cờ đang áp dụng |
| `POST /api/training/skills/save` | Nhận ID skill cùng các trường chỉnh được, validate và ghi cấu hình |

Tái sử dụng kiểm tra đăng nhập/quyền hiện có trong `router.js`; không xây role/quyền mới. Prefix `/api/training/skills` khớp quy tắc `/api/training/` hiện tại. Không dựa vào việc ẩn nút trên UI để bảo vệ API.

Validation tối thiểu: ID tồn tại, enabled là boolean, tên/hướng dẫn là chuỗi không rỗng trong giới hạn, exampleIds không trùng và thuộc skill. Từ chối payload sai kiểu/field không hỗ trợ; báo lỗi ngay cạnh trường liên quan. Escape nội dung khi hiển thị, không render instructions thành HTML tùy ý.

## 5. Contract và few-shot

- Thêm `skill_contract.js` để phân biệt `matched`, `ambiguous`, `no_match`, giữ `matched: boolean` tương thích. Skill bị tắt không được chọn.
- Aggregate_timeseries cần metric/timeColumn thuộc schema được chọn và aggregation hợp lệ; list không bị bắt phải có timeColumn. Skill không được cấp thêm tool hoặc đổi quyền request.
- Thiếu input thiết yếu trả reason và trường thiếu; không chèn ví dụ thực thi như request đã đủ dữ liệu. Harness/planner vẫn quyết định hỏi rõ hoặc tiếp tục xử lý.
- `monthly_aggregate` chỉ cho aggregate_timeseries; `list_rows` chỉ cho list; lookup chỉ dùng template phù hợp. UI chọn template không bỏ qua kiểm tra schema lúc runtime.
- Kiểm tra tên bảng/cột, serialize JSON và quote identifier đúng. `<value>` trong ví dụ không được coi là dữ liệu người dùng đã cung cấp.
- Giữ tối đa một skill/request và số ví dụ có giới hạn. Hướng dẫn, examples và domain note phải tính vào budget prompt; module budget hiện có mới giới hạn optional memory, chưa phải ngân sách đầy đủ cho mọi dispatch.
- Chart/export vẫn do output flags và harness xử lý. Instructions chỉnh trên UI không được bỏ validator, SQL security, deadline hoặc quality gate memory.
- Completion kiểm tra dữ liệu/artifact thực tế và evaluator hiện có; câu chỉ báo “tìm thấy 1 dòng” không đủ để trả lời câu hỏi hỏi ID. Không coi tool success đơn thuần là request đã hoàn tất.

## 6. Trace và domain note

- Đưa skill ID, enabled/matched/reason, số ví dụ được chèn và input thiếu qua trace → chat diagnostics → case collector → Training UI.
- Phân biệt skill bị tắt, không phù hợp và có chọn nhưng không chèn vì thiếu tools/system hoặc budget. Chưa cần dashboard thống kê theo version hay chỉ tiêu matched-rate để phát hành.
- Domain note là phần bổ sung sau editor skill. Giữ `getDomainAliases()` trả mảng aliases, không đổi trực tiếp cấu trúc làm hỏng planner/UI.
- Nếu cần, lưu note riêng bằng StorageHelper, lấy domain từ metadata bảng đúng scope/DB. Note có giới hạn độ dài/token, không ghi đè yêu cầu/filter rõ ràng. Chưa index note vào Qdrant hoặc làm A/B riêng trong phạm vi này.

## 7. Thứ tự triển khai

| Bước | Công việc |
|---|---|
| 1 | Contract và registry đọc/lưu cấu hình hai skill, giữ default và cờ hiện có |
| 2 | API đọc/lưu, validation, dùng quyền ứng dụng hiện có |
| 3 | Tab Skills, form sửa, chọn examples, lưu/hủy, báo trạng thái cờ |
| 4 | Nối runtime dùng cấu hình mới, few-shot đúng schema/intent và trace |
| 5 | Kiểm thử luồng sửa → lưu → request mới; thêm domain note nếu cần |

Không có giai đoạn A/B SQL Server, quản trị phiên bản, publish/approval hoặc rollback. Không bắt buộc tăng corpus tới 60 case hay đạt mức cải thiện 5 điểm phần trăm/20% trước khi dùng editor này.

## 8. Kiểm tra chức năng

- File chưa có dùng default; lưu rồi đọc lại/restart giữ cấu hình; lỗi ghi không báo thành công giả.
- Sửa instructions có mặt trong prompt request mới; request đang chạy giữ dữ liệu đã lấy; tắt skill loại khỏi selector.
- Form lưu/hủy đúng, lỗi không làm mất nội dung đang soạn, nội dung HTML được escape, API dùng access control hiện có.
- Sai ID/example/type/độ dài bị từ chối; few-shot không chọn sai cột/intent, cờ off không chèn guidance.
- Lookup/list/aggregate, input thiếu, empty rows, artifact thiếu, câu chỉ báo số dòng, deadline/abort vẫn được xử lý đúng.
- Case list và các tab “Cần xử lý/Đã xử lý” hiện có không bị editor làm hỏng.

Kiểm thử dùng fixture và mock tool manager; không cần SQL Server/model live. Kết quả này xác nhận chức năng cấu hình và contract, không chứng minh chất lượng SQL/model tăng ngoài thực tế.

```powershell
node --require ./tests/helpers/setup_isolated_data.js --test tests/skill_core.test.js tests/training_core.test.js tests/local_harness.test.js
```

Kết quả kiểm tra sau triển khai: **80/80 tests Skill/Training/Local Harness/Memory liên quan pass**. Toàn bộ suite đạt 163/164; lỗi còn lại ở `chat_pending_panel.test.js` (`saveChatSessions is not defined`) đã tồn tại ngoài phạm vi Skill Core.

## 9. Các file dự kiến thay đổi khi implement

- Backend: `skill_core/registry.js`, `selector.js`, `skill_contract.js` mới; `examples/index.js`; `routes/router.js`.
- Tích hợp: `agent_core/harness/local_model_harness.js`, `local_prompt_builder.js`, budget chung, `utils/chat_diagnostics.js`, `training_core/case_collector.js`.
- Frontend: `views/training_core.html`, module editor riêng (ví dụ `js/modules/skill_editor.js`) và đăng ký script theo cơ chế frontend hiện có; tái dùng CSS form/tab của project.
- Dữ liệu runtime: `skills.json` trong thư mục data hiệu lực; không ghi dữ liệu instance vào source để tạo default.

Hai cờ `LOCAL_MODEL_SKILL_CORE_ENABLED` và `LOCAL_MODEL_FEW_SHOT_ENABLED` tiếp tục dùng Settings hiện có. Editor, API và persistence đã triển khai; cấu hình được áp dụng cho request mới khi Skill Core được bật.
