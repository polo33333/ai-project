# Tiến độ phase 1 — 26/09/2026

**Đã triển khai backend/frontend phase 1 và chạy luồng hoàn chỉnh bằng fixture. Chưa đạt nghiệm thu phát hành phase 1 trên dữ liệu thật.** Không tính việc đã viết code/test là đã đạt toàn bộ gate của kế hoạch.

## Hạng mục đã triển khai

| Phạm vi | Kết quả |
| --- | --- |
| Catalog/plugin mở | Import/export, namespace, version bất biến, draft/validate/fixture/publish, enable/disable, dependency validation, rollback; domain/tags tự khai báo |
| Tái sử dụng skill | Giữ cấu hình và luồng legacy; starter snapshot giữ name/instructions/enabled/exampleIds/version, ghim hướng dẫn vào definition |
| Template/slot | Schema chung, input/default/provenance, required/requiredWhen, hỏi bổ sung, enum/date validation; reference không tồn tại/bước tương lai bị từ chối |
| Tùy chỉnh | Overlay theo scope tài khoản/tenant, version riêng, fixture trước publish, giữ ranh giới grant và yêu cầu bắt buộc |
| Workflow runtime | Worker tách khỏi request, checkpoint từng bước, lease theo run, CAS revision, retry có giới hạn, resume/cancel, xử lý gián đoạn export bằng NEEDS_REVIEW |
| SQL và output | Binding SQL đọc cố định, allowlist bảng, tham số driver thật, kiểm tra lại source/catalog/quyền; output contract và nhãn render tổng quát |
| File và quyền | CSV/XLSX, owner-scoped artifact endpoint, hạn tải, kiểm tra owner cho read/input/resume/cancel/events/download |
| Chat/API | Orchestrator chung trước local/provider harness, chọn template từ catalog, trích xuất có evidence/schema, giữ abstention/no-match; page/modal có panel input/tiến trình/kết quả/file |
| Frontend quản trị | Mở tab Quy trình tự động, tạo/import template, sửa form và danh sách bước, test/publish/rollback/overlay, lọc domain/tags và lịch sử run |
| Storage/rollout | Migration 004 và runtime grants; JSON single-process + PG CAS; tích hợp worker shutdown/backup gate; snapshot/import/export/backup giữ domain mới |
| Phân kỳ | Không phụ thuộc Laya/Playwright runtime để chạy phase 1. Review AI required bị giữ lại chờ phase 2, không bỏ qua |

## Kết quả kiểm thử

### Cập nhật giao diện nhập liệu

- Bỏ thao tác tách mẫu khỏi menu. Thêm xóa từng mẫu có xác nhận, kiểm tra quyền admin/revision; xóa khỏi danh sách và discovery bằng dấu xóa, giữ phiên bản và lịch sử chạy. Các mẫu khác trong cùng gói vẫn sử dụng được.
- Sửa màu chữ menu và bổ sung dark mode cho thẻ mẫu, menu, trạng thái trống, editor, node, form và thao tác xóa. Browser kiểm tra hủy/xác nhận xóa một mẫu trong gói và hiển thị editor/menu tối.

- Nhận diện chia thành mô tả nghiệp vụ, cách hỏi mẫu/hướng dẫn và các ô nhập. Lựa chọn, giới hạn số/độ dài và giá trị mặc định có form trực tiếp; cấu trúc nhóm/điều kiện chuyên sâu nằm ở nâng cao.
- Mỗi fixture có tên, đầu vào theo slot và kết quả mong đợi theo output, hai cột trên desktop và một cột trên mobile. Có thêm/xóa trường hợp và tùy chọn cung cấp/bỏ qua từng giá trị; giữ dữ liệu giả lập từng bước ở nâng cao. Browser kiểm tra chỉnh input/expected và fixture vẫn đạt.

- Các vùng thiết kế, mẫu dùng trong chat và lịch sử có icon, tiêu đề/mô tả và trạng thái trống riêng. Form output dạng object chuyển thành danh sách cột: mã, tên hiển thị, kiểu, giá trị lấy từ kịch bản, bắt buộc và giới hạn nâng cao; giữ cấu trúc contract ở backend. Browser kiểm tra thay nhãn cột và lưu cùng definition cũ.

- Thẻ mẫu giữ ba thao tác chính (sửa, chạy thử, phát hành); thao tác phụ chuyển vào menu dấu ba chấm, đóng bằng Escape hoặc bấm ngoài. Form bỏ border fieldset lồng nhau, dùng tiêu đề/indent/khoảng cách và phân cách nhẹ ở cấp section.

- Mỗi node có icon xóa riêng và hộp xác nhận; bỏ nút xóa bước cuối. Có thể xóa node ở giữa; việc lưu vẫn kiểm tra reference và yêu cầu ít nhất một bước.
- Sửa bố cục form object/array lồng nhau để nhóm con chiếm toàn hàng, tránh co hẹp ô nhập. Thẻ mẫu và node được thu gọn, thêm icon/màu nhấn; icon xóa có nhãn truy cập.
- Chrome kiểm tra cả hủy/xác nhận xóa, xóa node giữa, lưu các node còn lại, và chiều rộng/overflow của form fixture lồng nhau.

- Cập nhật theo ảnh tham khảo: node nối theo hàng ngang, form node được chọn ở cột phải. Form thay đổi theo thao tác (chuẩn hóa, điều kiện, xác thực, thu thập, chờ, SQL, xuất file); đổi loại node giữ cấu hình riêng trong phiên sửa.
- Nạp 5 mẫu tạo 5 bản lưu riêng với kiểm thử/phát hành độc lập; nạp lại không ghi đè mẫu đang có. Gói cũ nhiều template hiển thị từng mẫu và có thao tác tách thành bản riêng, giữ nguyên gói cũ.
- Tạo mới bắt đầu bằng definition trống với một bước và một fixture kiểm tra kết quả rỗng. Người dùng tự đặt mã/tên, câu hỏi mẫu, ô nhập, output và fixture nghiệp vụ; có thể định nghĩa thêm mẫu trong danh sách lựa chọn. Đã kiểm tra tạo hai mẫu mới và lưu node chờ/thêm node bằng browser.

- Tab được đổi thành **Mẫu nghiệp vụ**, tập trung vào kịch bản thực hiện từ câu hỏi trong chat. Đã bỏ khối Workflow Automation độc lập khỏi trang; dữ liệu/API legacy vẫn được giữ.
- Trình sửa mẫu chia phần nhận diện/thu thập thông tin, kịch bản từng bước với bảng cấu hình bước được chọn, nguồn dữ liệu, kết quả và chạy thử. Mẫu published có nút **Dùng trong chat** để điền câu hỏi mẫu; quản trị viên có **Thử kịch bản**. Lịch sử nằm trong mục thu gọn.
- Browser kiểm tra chọn/chuyển bước, một bảng cấu hình hiển thị mỗi lần, giữ definition khi đổi mẫu, và chuyển từ mẫu sang chat rồi chạy đúng kịch bản.

- Thanh tìm kiếm, bộ lọc, trạng thái và ô nhập được định dạng đồng bộ; form hai cột trên desktop, một cột trên mobile. Tiêu đề và nút lưu luôn hiển thị khi cuộn trình sửa mẫu.
- Đầu vào template được sửa bằng form: mã trường, tên hiển thị, câu hỏi, kiểu ô nhập và bắt buộc. Có thêm/xóa ô nhập.
- Binding, output, fixture và cấu hình bước được sửa bằng các dòng/nhóm trường có thêm/xóa; JSON chỉ nằm trong mục nâng cao. Import hiển thị tên gói và số mẫu trước khi lưu.
- Khi chạy tác vụ, object dùng nhóm ô nhập, array dùng danh sách thêm/xóa mục, boolean dùng lựa chọn Có/Không; không yêu cầu người dùng nhập JSON.
- Chrome đã kiểm tra sửa/lưu mẫu giữ cấu hình cũ, form object/array/boolean gửi đúng kiểu dữ liệu, và modal mobile không tràn ngang. Bộ `npm test` vẫn đạt 330 pass, 0 fail, 4 skip.

- `npm test`: **330 pass, 0 fail, 4 skip** (334 test). Skip gồm browser tùy chọn, test PG phase 1 và hai test PG có sẵn; browser đã chạy riêng.
- `npm run eval:workflows`: **14 pass, 0 fail, 2 skip**; hai skip là browser/PG tùy chọn.
- `npm run eval:local`: **3/3** format checks.
- `npm run eval:sql`: **7/7** security corpus.
- Chrome headless: đã kiểm tra import → fixture → publish → enable → nhập slot → hoàn thành; màn hình nhỏ; chat → bổ sung input → hoàn thành → reload phục hồi panel. Catalog/run dùng JSON thật; auth và chat-history store giả lập cho môi trường test.
- Gate mở rộng: hai gói lĩnh vực khác nhau ngoài pilot được thêm bằng definition và chạy hỏi lại → thực thi → output, không sửa engine/UI.
- Recovery/quyền: chặn thiếu input, CAS cập nhật đồng thời, request idempotency, một run chờ/conversation, pin version, disable discovery, overlay restrictions, restart/checkpoint, export cần review, thu hồi audience, read/download khác owner và SSE replay.
- Kiểm tra cú pháp JS và `git diff --check` đạt.

## Phần chưa nghiệm thu

| Mục | Tình trạng / điều kiện còn thiếu |
| --- | --- |
| PostgreSQL thật | `npm run test:storage` đã thử nhưng kết nối `127.0.0.1:5432` trả ECONNREFUSED; Docker daemon cũng chưa chạy. Đã thêm test PG phase 1 để chạy trên DB test riêng khi dịch vụ khả dụng. Migration chưa áp dụng lên database vận hành |
| 5 nghiệp vụ thật | Hiện có 5 template minh họa/fixture. Chưa có 5 câu hỏi nghiệp vụ, schema/binding và đáp án được người phụ trách xác nhận. Chưa xem chúng là pilot SQL thật |
| Chất lượng routing và multi-turn | Chưa có tập held-out nghiệp vụ 100 case/30 hội thoại để đo gate 95%; matcher khi không có model chỉ tự chọn phrase khớp rõ, trường hợp gần nhau hỏi người dùng chọn |
| Model/SQL live | Chưa chạy inference thực hoặc smoke query trên nguồn SQL nghiệp vụ. Test extraction và parameter transport có mock; fixture SQL không thay live SQL validation |
| Hiệu năng | Chưa đo p50/p95/SLO trên máy và tải vận hành thật |
| Retention/backup live | Hạn tải artifact có hiệu lực; chưa tự xóa file vật lý hết hạn. Code backup/transfer đã tích hợp nhưng chưa diễn tập PG/Qdrant backup-restore live |

## Đường dẫn và bước tiếp theo

Cập nhật giao diện kết quả chat: thêm spinner và trạng thái đang xử lý, khóa nút khi gửi thông tin bổ sung; thu gọn bước chạy sau khi kết thúc. Kết quả bảng giữ cột/nhãn theo mapping hiện hành, có tiêu đề cố định khi cuộn, dòng xen kẽ và ngày dễ đọc. Số lượng hiển thị bằng nhãn gọn; cờ `empty` được thay bằng trạng thái bảng không có dữ liệu. Polling tránh request chồng nhau và tạm ngừng khi tab trình duyệt bị ẩn. Đã kiểm tra Chrome bằng `automation_browser.test.js`: 1 pass, 0 fail, gồm loading, bảng, ngày, metadata và chi tiết thu gọn; chưa đo hiệu năng dưới tải.

Backend: `src/backend/automation/`. Frontend: `src/frontend/js/modules/workflow_plugins.js`, view workflows và panel page/modal chat. Hướng dẫn và cấu trúc definition: [WORKFLOW_PHASE1_RUNBOOK.md](WORKFLOW_PHASE1_RUNBOOK.md).

Khi PostgreSQL sẵn sàng: chạy test storage trên DB test, rồi migration theo môi trường được cấp quyền; mở tính năng qua UI cho pilot. Khi có 5 nghiệp vụ/schema: cấu hình binding, fixtures/đáp án chuẩn, smoke SQL và chạy eval routing/multi-turn/performance trước quyết định phát hành. Các bước này là phần còn lại của phase 1, không chuyển sang phase 2 để bỏ qua.
