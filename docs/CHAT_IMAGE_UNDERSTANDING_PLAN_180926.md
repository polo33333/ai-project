# Kế hoạch: AI đọc hiểu ảnh đính kèm trong Chat

> Rà soát lại ngày 19/09/2026. Phạm vi MVP: một ảnh trong một lượt chat chính,
> AI đọc/hiểu và trả lời; không thay đổi pipeline ingest Library. Đây là kế hoạch,
> chưa triển khai. Các bước VC là thứ tự công việc, không phải mức ưu tiên bảo mật P0.

## 1. Hiện trạng thật (đã xác nhận trong code, không phải giả định)

Khi người dùng đính kèm một file ảnh (.png/.jpg) vào chat hiện nay:

```
page_chat.js → buildPageChatAttachmentContext()
  if (!isText) return `[Tệp đính kèm: ${file.name}, ${size} KB]`
```
→ **Ảnh chỉ được gửi cho AI dưới dạng một dòng text ghi tên file và dung lượng.**
Không có byte ảnh nào, không có base64 nào được gửi đi. AI hoàn toàn "mù", chỉ biết là có
một file tên gì đó.

Ở tầng gọi model, cả 4 adapter (`ollama.js`, `openai.js`, `anthropic.js`, `gemini.js`)
đều không có bất kỳ xử lý nào cho ảnh/base64/`image_url`/`inlineData` — message gửi đi
luôn chỉ có `content` dạng chuỗi text thuần.

**Kết luận: đây là khoảng trống toàn tuyến (frontend → schema message → adapter), không
phải một chỗ nhỏ cần vá.** Nhưng tin tốt là Ollama (nền tảng local model chính của dự án)
đã hỗ trợ sẵn ảnh ở tầng API (`/api/chat` nhận field `images: [base64,...]` trong message
khi model được pull là bản có khả năng nhìn ảnh) — nên **không cần xây một service OCR/
vision riêng**, chỉ cần nối đúng đường dẫn dữ liệu.

## 2. Chọn model và xác minh khả năng đọc ảnh

Adapter có fallback tên model `qwen2.5-coder`; đó không phải bằng chứng về model đang
chạy thực tế. Kiểm tra provider/model tag được chọn và thử một ảnh mẫu trên phần cứng
thật, ghi nhận phiên bản Ollama, model, RAM/VRAM và độ trễ. Không chốt model chỉ theo tên.
Theo [tài liệu vision chính thức của Ollama](https://github.com/ollama/ollama/blob/main/docs/capabilities/vision.mdx),
REST API nhận ảnh base64; cần model có khả năng vision. Có thể làm contract, UI và test
adapter bằng mock song song với chọn model; chỉ nghiệm thu live khi model thật đã chạy được.

## 3. Thiết kế thay đổi — theo đúng pattern đã có trong code

### 3.1. Thêm cờ khả năng `supportsVision` cho provider (giống hệt `supportsToolCalling`)

- `ai_provider_manager.js`: thêm `supportsVision` vào danh sách field allowlist (dòng có
  `'supportsToolCalling', 'supportsJsonToolCalling', ...`), mặc định `false`.
- `ai_providers.html` / `ai_providers.js`: thêm một toggle "Hỗ trợ đọc ảnh" trong form cấu
  hình provider, cùng chỗ với toggle tool calling hiện có.
- Bổ sung tại cả create, update, normalize boolean, public DTO và persistence; chỉ sửa
  một allowlist là chưa đủ. Đổi model/baseUrl phải làm mất hiệu lực kết quả probe cũ.
- Toggle là khai báo cấu hình, không chứng minh model chạy được. Backend kiểm tra cả
  capability, adapter đã hỗ trợ và kết quả probe gắn với model cụ thể; UI dùng cùng dữ liệu.

### 3.2. Frontend — cho phép đính kèm ảnh thật sự

Sửa `buildPageChatAttachmentContext()` trong `page_chat.js`:
- MVP nhận JPEG/PNG, tối đa một ảnh; resize/nén khi vượt budget, giữ tỷ lệ và preview
  cho người dùng. Không cố định 1568px cho mọi model; chốt kích thước bằng bộ ảnh chữ nhỏ.
- Trả về một cấu trúc có phần `images: [{mimeType, data}]` riêng biệt với `content` text, thay vì
  gộp chung vào một chuỗi text như cách làm hiện tại cho file text.
- Ẩn/disable việc đính kèm ảnh trên UI khi provider đang chọn có `supportsVision !== true`,
  kèm gợi ý ngắn cho người dùng biết vì sao (tránh đính kèm vô ích).

### 3.3. Backend — mở rộng schema message để mang theo ảnh

- Contract nội bộ: `images: [{mimeType: 'image/png', data: '<base64>'}]`, không có tiền tố
  data URL. MIME được backend xác minh từ byte ảnh; không tin extension hoặc `file.type`.
- Cả `/api/intelligent-core/chat/stream` và `/api/intelligent-core/chat` phải validate và
  forward ảnh qua `core.js` đến adapter. Các API chat/embed khác chưa hỗ trợ phải từ chối
  payload ảnh rõ ràng, không âm thầm bỏ field.
- `readJsonBody` hiện mặc định 1 MiB. Đề xuất MVP: ảnh giải mã tối đa 2 MiB, tối đa
  16 megapixel, request chat ảnh tối đa 4 MiB (base64 tăng khoảng 1/3, còn text/history).
  Giới hạn riêng route, kiểm tra cả tổng payload lẫn byte/kích thước ảnh tại backend;
  không nâng giới hạn toàn bộ API. Đảm bảo lỗi 413 có nội dung đọc được trước khi đóng
  kết nối; validate trước khi mở SSE hoặc trả event lỗi đúng nếu stream đã mở.
- Base64 lỗi, MIME giả, SVG/GIF và ảnh không giải mã được trả lỗi xác định. Client resize
  chỉ tối ưu UX; backend vẫn áp giới hạn tài nguyên khi decode, không nhận URL ảnh tùy ý.

### 3.4. Adapter — forward ảnh đúng định dạng từng nhà cung cấp

| Adapter | Việc cần làm | Ưu tiên |
|---|---|---|
| `ollama.js` | Trong `convertMessagesToOllama`, chuyển ảnh đã validate thành `images: message.images.map(image => image.data)` | MVP — provider local ưu tiên |
| `openai.js` | Chuyển text và ảnh thành content blocks; image URL là data URL dựng từ MIME đã xác minh và base64 | Sau MVP, khi thực sự cần |
| `anthropic.js` | Chuyển thành content block `{type:'image', source:{type:'base64', media_type, data}}` | P2 |
| `gemini.js` | Thêm `inlineData: {mimeType, data}` vào parts | P2 |

**Chỉ làm Ollama trước.** Vì trọng tâm dự án là local model, và làm cả 4 adapter cùng
lúc sẽ kéo dài thời gian trước khi có thứ dùng thử được. Sau khi Ollama chạy tốt, mở rộng
sang provider khác nếu thực sự cần.

Các adapter mở rộng dùng MIME đã xác minh trong contract; kiểm tra tài liệu API chính thức
tại thời điểm triển khai trước khi chốt payload và giới hạn của từng provider.

### 3.5. Routing, fallback và lịch sử — điều kiện bắt buộc của MVP

- Request có ảnh đi qua nhánh hiểu ảnh trong core, giữ nguyên kiểm tra quyền/scope;
  MVP không bật SQL/web/agent tools cho lượt đọc ảnh. Nội dung ảnh là dữ liệu, không
  phải chỉ thị để thực thi tool. Kết hợp ảnh với SQL/RAG là giai đoạn riêng.
- Core hiện có schema selector, memory/context budget, local harness và provider fallback.
  Nhánh ảnh phải tránh bị các bước chỉ xử lý text làm mất payload; chọn đường gọi adapter
  trực tiếp cho MVP sau kiểm tra chung, kèm timeout, cancellation và usage/progress.
- Lọc mọi fallback theo vision + adapter support + chính sách local/cloud; MVP local không
  tự chuyển ảnh lên cloud. Không còn provider phù hợp thì báo lỗi, không fallback text-only.
- Budget ảnh tính riêng theo giới hạn model/độ phân giải, không đưa chuỗi base64 vào phép
  đếm token text. Không gửi ảnh cho schema selector hoặc bước tóm tắt memory.
- Lịch sử UI hiện lưu trong PostgreSQL qua `page_chat_history_service.js`; vì vậy phải
  chủ động loại byte/base64/data URL khỏi session, audit, log, training và memory ở backend,
  kể cả client cố tình gửi vào API lưu session. Chỉ lưu metadata và câu trả lời dạng text.
- Ảnh gốc chỉ dùng trong request hiện tại; preview dùng object URL trong bộ nhớ và revoke
  khi bỏ ảnh/chuyển phiên. Lượt sau có thể dùng câu trả lời text trước đó, nhưng muốn đọc
  lại ảnh phải đính kèm lại; tải lại trang hiển thị metadata, không giả vờ còn ảnh gốc.

## 4. Lộ trình từng bước

| Bước | Nội dung | Kết quả kiểm tra được |
|---|---|---|
| VC-1 | Pull thử 1–2 model vision qua Ollama, kiểm tra chạy được trên phần cứng hiện tại (RAM/VRAM, tốc độ) | Chọn được model cụ thể để dùng ở các bước sau |
| VC-2 | Thêm cờ `supportsVision` (mục 3.1) | Bật/tắt được trong UI Provider Management, không ảnh hưởng provider khác |
| VC-3 | Sửa `ollama.js` forward `images` (mục 3.4) | Gọi thẳng qua script test (không qua UI) xác nhận Ollama nhận và trả lời đúng nội dung một ảnh mẫu có chữ |
| VC-4 | Frontend + hai route chat + validation + nhánh core + fallback + loại byte ảnh khỏi persistence (mục 3.2–3.5) | UI gửi ảnh thành công; SSE/non-stream tương đương; lỗi trả rõ; không có base64 trong lịch sử/log |
| VC-5 | Test tay với bộ ảnh mẫu đa dạng: ảnh chụp văn bản có dấu tiếng Việt, ảnh chứng từ/hoá đơn, ảnh chụp màn hình có bảng số liệu, ảnh biểu đồ | Bảng ghi nhận: loại ảnh nào đọc tốt, loại nào sai nhiều — làm căn cứ có nên mở rộng thêm hay dừng ở đây |
| VC-6 (tuỳ chọn) | Mở rộng sang OpenAI/Anthropic/Gemini adapter (mục 3.4, P2) | Chỉ làm nếu VC-5 cho thấy nhu cầu vượt khả năng model local hiện có |

## 5. Rủi ro cần lưu ý

- **Chất lượng đọc ảnh:** chữ nhỏ, chữ viết tay và bảng số liệu dày cần test thật ở VC-5;
  không suy ra độ chính xác từ tên model hoặc việc chạy local/cloud.
- **Payload lớn:** ảnh gốc chưa resize có thể làm request tới Ollama rất nặng, ảnh hưởng độ
  trễ hoặc vượt giới hạn — bắt buộc kiểm tra budget; resize khi cần, không giảm ảnh nhỏ
  đã đạt giới hạn vì có thể làm mất chữ.
- **Không tự động lưu ảnh vào Library/RAG:** đây là luồng chat tạm thời (ảnh chỉ tồn tại
  trong request hiện tại). Nội dung trả lời vẫn theo chính sách lưu lịch sử chat. Lưu ảnh
  để đọc lại hoặc tìm kiếm lâu dài là phạm vi ingest/retention riêng, ngoài MVP.

### Gate nghiệm thu và rollout

- Test contract frontend → hai route → core → Ollama; text-only không đổi; mock chỉ chứng
  minh truyền payload, không chứng minh chất lượng đọc ảnh.
- Test ảnh quá lớn, sai MIME/base64, decode thất bại, provider không vision, timeout/cancel,
  fallback local/cloud, ảnh chứa chỉ thị gọi SQL, reload và lưu session không có byte ảnh.
- VC-5 dùng ít nhất 20 ảnh có đáp án kiểm tra: văn bản tiếng Việt, chứng từ, bảng số liệu,
  biểu đồ và ảnh mờ/không đọc được. Ghi field đúng/sai, số liệu đọc sai nhưng trả lời tự tin,
  tỷ lệ từ chối và p50/p95; chốt ngưỡng trước lần chạy holdout. Không chấp nhận bịa số liệu
  trong bộ nghiệm thu; ảnh không rõ phải nêu phần không đọc được.
- Flag dự kiến `CHAT_IMAGE_UNDERSTANDING_ENABLED=false`, bật thử local trước. Tắt flag
  phải trả thông báo tính năng tắt cho request có ảnh, không âm thầm bỏ ảnh.
- Theo mục C7 của [kế hoạch tổng](NEXT_STEPS_PLAN_180926.md): có thể phát triển bằng mock
  song song JOIN; phát hành nhiều người dùng sau các gate quyền/bảo mật chung. Không phụ
  thuộc JOIN, persistent Knowledge Graph hoặc ingest ảnh Library.

## 6. Tài liệu tham chiếu

- `src/frontend/js/modules/page_chat.js` (`buildPageChatAttachmentContext`, dòng 187–196)
- `src/backend/intelligent_core/adapters/ollama.js` (`convertMessagesToOllama`)
- `src/backend/intelligent_core/adapters/{openai,anthropic,gemini}.js`
- `src/backend/services/ai_provider_manager.js` (pattern cờ `supportsToolCalling`)
- `src/frontend/js/modules/ai_providers.js` (UI cấu hình provider)
