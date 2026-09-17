# Kế hoạch tối ưu luồng AI provider bên thứ ba

- Ngày lập: 17/09/2026.
- Trạng thái: Đã triển khai và kiểm thử; theo dõi vận hành sau phát hành.
- Phạm vi: Luồng chat dùng provider bên thứ ba, kiểm tra hoàn tất, chuẩn hóa đầu ra và tích hợp memory do ứng dụng quản lý.

## 1. Mục tiêu

1. Trả đúng kết quả người dùng yêu cầu, không kết thúc bằng SQL/JSON tool thô khi người dùng đang yêu cầu dữ liệu.
2. Tự phát hiện thiếu đầu ra và sửa trong giới hạn thời gian, số lần gọi model/tool.
3. Dùng chung tiêu chuẩn kiểm tra nghiệp vụ cho local và provider bên thứ ba.
4. Giữ memory độc lập với provider, chỉ lưu kết quả đạt điều kiện chất lượng.
5. Giữ khả năng chẩn đoán lỗi, không đưa thông tin kỹ thuật không cần thiết vào câu trả lời chính.

## 2. Ca lỗi làm cơ sở

Nguồn: `data/chat_history.json`, bản ghi `chat-1789455879618`.

| Thuộc tính | Quan sát trong log |
|---|---|
| Câu hỏi | `ds hợp đồng` |
| Provider/model được ghi nhận | Google Gemini - 3.5 Flash / `gemini-3.5-flash-lite` |
| Nhận diện yêu cầu | `intent: list`, `outputs.data: true` |
| Bảng đã chọn | `T_Contract` |
| Đầu ra model | Khối SQL `SELECT TOP 20 ... FROM T_Contract` |
| Thực thi | `toolCalls: []`, `sqlQuery: null` |
| Số vòng | 1; bước cuối là `final_answer` |
| Đánh giá | `PARTIAL`, lỗi `MISSING_SQL` |
| Memory | `memoryPersisted: false`, `pendingTurnRecorded: true` |

Kết luận: hệ thống đã chọn đúng ngữ cảnh và phát hiện yêu cầu chưa hoàn tất, nhưng đánh giá diễn ra sau khi bộ điều phối đã chấp nhận văn bản model làm câu trả lời cuối. Đầu ra thô vẫn được trả cho giao diện.

Chưa đủ bằng chứng để kết luận lỗi do cấu hình `supportsToolCalling`, khả năng model hay model không tuân thủ hướng dẫn. Cần kiểm tra cấu hình và request tool thực tế khi triển khai; không suy đoán nguyên nhân từ tên model.

## 3. Hiện trạng và vị trí thay đổi

| Thành phần | Vai trò hiện tại / hướng thay đổi |
|---|---|
| `src/backend/intelligent_core/core.js` | Chuẩn bị schema, tài liệu, web, memory; chọn harness; chuẩn hóa kết quả. Tích hợp yêu cầu đầu ra và đánh giá thống nhất. |
| `src/backend/agent_core/harness/agent_harness.js` | Luồng bên thứ ba kết thúc khi không có tool call. Bổ sung kiểm tra trước khi kết thúc và vòng sửa có giới hạn. |
| `src/backend/agent_core/harness/local_model_harness.js` | Có kiểm tra SQL theo kế hoạch, gọi lặp, yêu cầu biểu đồ/export và fallback dựa trên dữ liệu. Tách phần phù hợp để dùng chung từng bước. |
| `src/backend/agent_core/harness/tool_call_normalizer.js` | Tận dụng chuẩn hóa native tool call và JSON trong nội dung, có kiểm soát theo khả năng provider. |
| `src/backend/agent_core/harness/request_execution_budget.js` | Hiện thiên về local. Thiết kế budget dùng chung, giữ tương thích cấu hình local. |
| `src/backend/agent_core/tools/tool_manager.js` | Bảo đảm giới hạn tool được phép được kiểm tra tại thời điểm thực thi, không chỉ lọc danh sách gửi model. |
| `src/backend/intelligent_core/adapters/` | Kiểm tra khả năng tool, chuẩn hóa lỗi/usage/finish reason giữa các provider. |
| `src/backend/memory_core/` | Tiếp tục là nguồn memory chính; nhận trạng thái chất lượng cuối cùng để quyết định lưu. |
| `src/backend/routes/router.js` | Đồng bộ response, stream, audit và memory; rà soát đường dẫn mặc định trạng thái thành công khi thiếu trace. |

Tên module mới sẽ chốt trong lúc triển khai sau khi rà soát khả năng tái sử dụng; không sao chép toàn bộ local harness sang luồng bên thứ ba.

## 4. Luồng mục tiêu

```text
Câu hỏi + phiên hội thoại
  → Kiểm tra đầu vào, quyền và phạm vi
  → Xác định yêu cầu đầu ra: văn bản / dữ liệu / biểu đồ / file / mã SQL
  → Chọn schema, tài liệu, web và memory liên quan
  → Chuẩn bị prompt/tool theo khả năng provider và context budget
  → Gọi model
      → Có tool call: chuẩn hóa → kiểm tra → thực thi → nhận kết quả
      → Có câu trả lời: kiểm tra đủ yêu cầu và căn cứ dữ liệu
          → Chưa đạt, còn budget: hướng dẫn sửa cụ thể → gọi lại
          → Đạt: hoàn thiện nội dung
          → Hết budget: trả phần kết quả đã xác minh hoặc thông báo chưa hoàn tất
  → Chuẩn hóa trạng thái, bảng/biểu đồ/file và câu trả lời
  → Trả giao diện, ghi audit và cập nhật memory theo chất lượng
```

## 5. Nguyên tắc xử lý

- Phân biệt yêu cầu lấy dữ liệu với yêu cầu viết/giải thích SQL. Không bắt chạy SQL khi người dùng chỉ yêu cầu mã SQL.
- Không tự thực thi một đoạn SQL chỉ vì xuất hiện trong câu trả lời. Mọi thao tác đi qua quyền, danh sách tool cho phép và kiểm tra SQL.
- Không chặn tất cả code block hoặc JSON. Chỉ xem là đầu ra không phù hợp khi chúng thay thế kết quả người dùng yêu cầu.
- SQL thành công nhưng trả 0 dòng là một kết quả hợp lệ. Trả lời rõ không tìm thấy dữ liệu; không tự nới bộ lọc.
- Biểu đồ/export cho yêu cầu dữ liệu nghiệp vụ phải dựa trên kết quả đã xác minh, không chỉ dựa vào lời model nói đã hoàn thành.
- Không coi việc model ngừng gọi tool là bằng chứng yêu cầu đã hoàn tất.
- Khi fallback provider, giữ yêu cầu nghiệp vụ và budget chung; không đặt lại giới hạn hoặc bỏ kiểm tra.
- Nội dung trả lời cuối phải qua kiểm tra trước khi phát ra stream. Tiến độ có thể phát trong lúc xử lý.
- Không sửa hoặc xóa bản ghi chat gốc để làm ca kiểm thử; tạo fixture tối thiểu, loại thông tin không cần thiết.

## 6. Các giai đoạn triển khai

### Giai đoạn 1 — Chặn đầu ra thô và kết thúc sớm

- [x] Tạo bộ kiểm tra hoàn tất dựa trên request plan, context và kết quả tool.
- [x] Đặt kiểm tra trong `AgentHarness` trước khi chấp nhận câu trả lời cuối.
- [x] Phát hiện SQL-only/JSON tool-only trong yêu cầu cần dữ liệu thực tế.
- [x] Phát hiện thiếu dữ liệu, biểu đồ hoặc file theo yêu cầu.
- [x] Phân biệt kết quả rỗng hợp lệ, tool lỗi và chưa gọi tool.
- [x] Chuẩn hóa lý do chưa hoàn tất để dùng cho sửa, diagnostics và memory.

Nghiệm thu: ca `ds hợp đồng` với response SQL thô không được chấp nhận là câu trả lời hoàn tất và không được hiển thị nguyên khối SQL làm kết quả chính.

### Giai đoạn 2 — Tự sửa có giới hạn và hoàn thiện câu trả lời

- [x] Gửi lỗi cụ thể về model: ví dụ thiếu thực thi SQL, thiếu biểu đồ, tool arguments không hợp lệ.
- [x] Ưu tiên yêu cầu model gọi đúng tool thay vì chỉ yêu cầu diễn đạt lại.
- [x] Thiết lập giới hạn sửa mặc định đề xuất là 2 lượt; cấu hình riêng, không thay đổi mặc định local ngoài chủ đích.
- [x] Có budget tổng cho request: thời gian, số lần gọi model, số lần thực thi SQL/tool; tính cả sửa, fallback và tổng hợp cuối.
- [x] Dừng khi hủy request, hết budget hoặc không có tiến triển.
- [x] Khi đã có dữ liệu hợp lệ nhưng model trả lời rỗng/thô, dùng lời dẫn và bảng từ dữ liệu thực thay vì bịa nội dung.
- [x] Khi không có kết quả hợp lệ, trả thông báo chưa hoàn tất; lưu lỗi chi tiết trong diagnostics.

Nghiệm thu: tự sửa được ca SQL-only thành gọi tool và trả dữ liệu; nếu sửa thất bại thì kết thúc rõ ràng, không lặp vô hạn hoặc trả thành công giả.

### Giai đoạn 3 — Dùng chung kiểm tra nghiệp vụ

- [x] Tách kiểm tra bảng/cột, điều kiện tự thêm và truy vấn metadata thay cho dữ liệu nghiệp vụ từ luồng local.
- [x] Dùng chung kiểm tra tool được phép tại điểm thực thi và kiểm tra tham số.
- [x] Phát hiện tool call lặp cùng tham số; cho phép lặp có chủ đích chỉ khi có lý do/trạng thái thay đổi phù hợp.
- [x] Kiểm tra nguồn dữ liệu của biểu đồ/export và yêu cầu đầu ra còn thiếu.
- [x] Thống nhất cách đánh giá hoàn tất giữa local và bên thứ ba.
- [x] Giữ riêng prompt, chuẩn hóa và rút gọn context đặc thù của local khi cần.

Nghiệm thu: cùng một yêu cầu nghiệp vụ và kết quả tool phải được đánh giá chất lượng nhất quán giữa hai luồng; bộ test local hiện có vẫn đạt.

### Giai đoạn 4 — Chuẩn hóa theo khả năng provider

- [x] Rà soát `supportsToolCalling`, API format và request thực tế gửi tools.
- [x] Ưu tiên native tool calling; JSON trong văn bản chỉ là đường tương thích được kiểm tra chặt.
- [x] Nếu model không đáp ứng khả năng cần thiết, trả lỗi năng lực rõ hoặc fallback theo chính sách hiện hành; không âm thầm trả SQL thô.
- [x] Cấu hình context window và output reserve theo model/provider, tránh dùng mặc định local cho mọi provider.
- [x] Rút gọn tool result theo mục đích nhưng giữ nguồn và dữ liệu cần cho câu trả lời.
- [x] Chuẩn hóa HTTP status, timeout, abort và lỗi không thể phục hồi để fallback đúng.
- [x] Bảo đảm provider thay thế không làm mất giới hạn tool, quyền và budget.

Nghiệm thu: kiểm thử được native tools, JSON tương thích, model thiếu khả năng, lỗi xác thực, rate limit, timeout và người dùng hủy request.

### Giai đoạn 5 — Memory, trạng thái và giao diện

- [x] Dùng memory của ứng dụng làm nguồn chính cho cả local/cloud; không phụ thuộc bộ nhớ riêng của provider.
- [x] Đưa trạng thái cuối sau kiểm tra/sửa vào điều kiện lưu memory.
- [x] Không lưu SQL/JSON thô hoặc lời khẳng định chưa có bằng chứng thành trao đổi thành công.
- [x] Yêu cầu dang dở được lưu riêng theo cờ cấu hình và TTL hiện có; không lẫn với dữ liệu đã xác minh.
- [x] Giữ phân tách tài khoản/phiên và lọc scope khi lấy memory.
- [x] Tham chiếu dữ liệu cần lưu nguồn, bộ lọc và thời điểm; truy vấn lại khi người dùng cần dữ liệu mới.
- [ ] Nếu dùng model hỗ trợ tóm tắt, ứng dụng kiểm tra và quyết định lưu; không cho model tự ghi nhớ không kiểm soát.
- [x] Đồng bộ trạng thái giữa chat thường, stream, endpoint tương thích, audit và memory; rà soát các giá trị mặc định `SUCCESS`.
- [x] Giữ SQL/trace ở vùng chẩn đoán phù hợp; câu trả lời chính tập trung vào kết quả người dùng yêu cầu.

Nghiệm thu: đổi provider trong cùng phiên vẫn tiếp tục được ngữ cảnh; kết quả chưa hoàn tất không được ghi nhớ như thành công; stream không phát đầu ra thô trước bước kiểm tra.

### Giai đoạn 6 — Kiểm thử, quan sát và triển khai dần

- [x] Tạo fixture hồi quy tối thiểu từ ca chat đã xác định.
- [x] Thêm test cho bộ kiểm tra hoàn tất và vòng sửa bên thứ ba bằng provider/tool giả lập.
- [x] Kiểm tra tích hợp API thường/stream và điều kiện lưu memory.
- [x] Chạy test hiện có và bộ đánh giá local, SQL, memory có liên quan.
- [x] Kiểm tra thực tế với provider đã cấu hình khi triển khai; ghi rõ model, cấu hình và kết quả, không suy rộng từ mock test.
- [x] Bật thay đổi qua cờ cấu hình để quan sát trước khi áp dụng rộng.
- [ ] Theo dõi tỷ lệ hoàn tất, đầu ra thô bị chặn, số lượt sửa, số tool call, latency, token và memory bị từ chối lưu.

Nghiệm thu: test hồi quy đạt, không làm giảm tính đúng đắn của local, có thể tắt thay đổi nếu phát hiện lỗi triển khai.

## 7. Ma trận kiểm thử tối thiểu

| Ca | Kết quả mong đợi |
|---|---|
| `ds hợp đồng`, model trả SQL-only | Bị chặn, yêu cầu gọi tool; trả dữ liệu thực hoặc trạng thái chưa hoàn tất |
| `Viết SQL lấy danh sách hợp đồng` | Được trả SQL; không tự chạy truy vấn |
| Tool call JSON trong văn bản | Chuẩn hóa theo chính sách tương thích; kiểm tra quyền và tham số trước thực thi |
| SQL đúng cú pháp nhưng sai bảng/bộ lọc | Bị kiểm tra và yêu cầu sửa trước khi chấp nhận |
| SQL thành công, 0 dòng | Trả không tìm thấy dữ liệu; không thử vô hạn |
| Yêu cầu biểu đồ nhưng chỉ có lời mô tả | Chưa hoàn tất; gọi tool biểu đồ từ dữ liệu hợp lệ |
| Yêu cầu export nhưng chưa có file | Không khẳng định đã xuất file; sửa hoặc báo chưa hoàn tất |
| Tool lặp cùng tham số, không tiến triển | Dừng theo chính sách và trả kết quả đã xác minh nếu có |
| Model trả lời rỗng sau khi SQL thành công | Dựng lời dẫn/bảng từ kết quả thật |
| Timeout, hủy, hết budget | Dừng đúng; không tiếp tục gọi model/tool sau khi hủy |
| Provider fallback | Giữ quyền, plan, context và budget request |
| Chat thường, tài liệu, web | Không bị ép gọi SQL do kiểm tra quá rộng |
| Đổi provider giữa phiên | Tiếp tục dùng memory của ứng dụng đúng scope |
| Kết quả PARTIAL hoặc SQL thô | Không lưu thành memory thành công |
| Stream trả lời | Chỉ phát câu trả lời cuối sau kiểm tra; tiến độ vẫn hoạt động |

## 8. Thứ tự ưu tiên và phạm vi bàn giao

1. **Ưu tiên cao nhất:** Giai đoạn 1–2 và test hồi quy ca `chat-1789455879618`.
2. **Tiếp theo:** Giai đoạn 3–4 để thống nhất kiểm tra và xử lý khác biệt provider.
3. **Hoàn thiện:** Giai đoạn 5–6 để đồng bộ memory, giao diện, quan sát và triển khai.

Mỗi đợt bàn giao cần ghi rõ file thay đổi, hành vi trước/sau, test đã chạy và hạn chế còn lại. Không đổi provider đang dùng, chỉnh sửa lịch sử chat hoặc chuyển memory sang bên thứ ba chỉ để phục vụ việc tối ưu này.

## 9. Kết quả triển khai ngày 17/09/2026

### Các thay đổi chính

- `guarded_agent_harness.js`: vòng gọi model/tool có kiểm tra hoàn tất, tối đa 2 lượt sửa mặc định, chống gọi lặp, budget toàn request, fallback theo loại lỗi và hoàn thiện câu trả lời từ kết quả thật.
- `completion_policy.js` và `grounded_reply.js`: kiểm tra/dựng kết quả dùng chung với local. Luồng bên thứ ba kiểm tra đầy đủ các vi phạm SQL mà bộ đánh giá hiện có phát hiện; local giữ các điều kiện thực thi đặc thù.
- Export nghiệp vụ lấy toàn bộ rows từ kết quả SQL đã xác minh ở server, không xuất phần preview bị cắt gửi cho model. Biểu đồ phải dùng nhãn/số liệu khớp rows đã truy vấn; phép biến đổi cần được tính trong SQL trước.
- Adapter Gemini/Anthropic giữ đủ nhiều tool call, các system message và finish reason; Gemini giữ signed parts cho lượt tiếp theo và không đưa thought text vào câu trả lời. HTTP status được giữ cho quyết định fallback.
- Context window/output reserve và khả năng gọi tool có thể chỉnh trên trang AI Providers. JSON tool trong văn bản chỉ được thực thi khi bật chế độ tương thích; mọi lời gọi vẫn qua whitelist, tham số và quyền.
- API chat thường, SSE, API tương thích và audit trả cùng trạng thái hoàn tất; API tương thích không tự gắn thêm SQL vào nội dung trả lời. Giao diện hiển thị trạng thái chưa hoàn tất khi cần.
- Memory vẫn ở ứng dụng. Frontend không gửi lại lượt `PARTIAL` như hội thoại thành công; history cũ chứa SQL/JSON tool thô được lọc theo cặp hỏi/đáp. Đổi database source không tái sử dụng tham chiếu cũ. Dataset reference có source, phạm vi câu hỏi và thời điểm.
- Page chat, modal chat và embed chat đều chỉ thêm cặp hỏi/đáp vào history gửi model khi `completionStatus` là `SUCCESS`; lượt chưa hoàn tất vẫn hiển thị trên giao diện.
- Diagnostics lưu budget, loại harness, nguyên nhân dừng và lỗi kiểm tra. Không đưa prompt, rows hoặc credentials vào các trường chẩn đoán mới.

### Kiểm thử và tái hiện

Kết quả kiểm tra cuối: **194/194 test đạt**, kiểm tra cú pháp 26 file JavaScript thay đổi đạt, `git diff --check` không có lỗi. Các bộ đánh giá local format **3/3**, SQL security **7/7**, memory fixture **2/2** và provider replay đều đạt.

Các test mới nằm trong `tests/provider_harness.test.js`, `tests/provider_adapters.test.js`, `tests/provider_core_integration.test.js`, `tests/provider_routes.test.js`. Fixture tối thiểu của ca lỗi ở `tests/fixtures/provider_raw_contract_chat.json`.

```powershell
npm test
npm run eval:local
npm run eval:sql
node --require ./tests/helpers/setup_isolated_data.js scripts/evaluate_memory.js
npm run eval:provider
```

Test HTTP/SSE chạy qua router trên server tạm với core được giả lập, xác nhận `PARTIAL` không bị ghi audit/memory thành công. Test core riêng chạy qua adapter và tool với dữ liệu giả lập. Test pending-panel cũ được bổ sung dependency `saveChatSessions` thiếu trong môi trường VM của test.

Đã gọi trực tiếp provider `provider-1785683549410`, model cấu hình `gemini-3.5-flash-lite`, với schema/rows mẫu và SQL tool giả lập, không truy cập database nghiệp vụ:

| Kịch bản live | Kết quả |
|---|---|
| Hỏi `ds hợp đồng` | `SUCCESS`, 2 lần gọi API, 1 lần SQL tool, khoảng 1,96 giây |
| Phát lại SQL thô ở lượt đầu rồi cho provider sửa | `SUCCESS`, 1 lượt sửa, 2 lần gọi API thực tế tiếp theo, 1 lần SQL tool, khoảng 1,88 giây |

Lệnh tái hiện (chỉ gửi dữ liệu mẫu; cần provider còn khả dụng):

```powershell
node scripts/evaluate_provider_harness.js --live provider-1785683549410
node scripts/evaluate_provider_harness.js --live provider-1785683549410 --replay-raw
```

### Bật/tắt và giới hạn đã biết

- Luồng mới bật mặc định khi `AGENT_CORE_ENABLED` không phải `false`. Đặt `AI_PROVIDER_GUARDS_ENABLED=false` để quay về vòng provider cũ; các sửa adapter, kiểm tra quyền và lọc memory vẫn giữ nguyên.
- Các biến budget nằm trong `.env.example`; không sửa `.env`, provider đang active hoặc dữ liệu chat của instance. Backend đang chạy bản cũ cần nạp lại code để áp dụng.
- Context budget là ước lượng theo ký tự, không phải tokenizer chính xác của từng model. Khi không đủ context, hệ thống dừng/fallback thay vì cắt tùy tiện các cặp tool call/result.
- Kiểm tra SQL dùng bộ đánh giá hiện có, không phải bộ phân tích đầy đủ mọi dạng SQL. Câu SQL còn đi qua lớp bảo vệ và SQL Server khi chạy thật.
- Kiểm tra tài liệu/web phát hiện một số dạng từ chối sai ngữ cảnh; chưa phải bộ chứng minh tính đúng đắn của mọi khẳng định tự do.
- Cancellation được truyền đến tool/connector. Tool tùy chỉnh không tuân thủ signal có thể tiếp tục công việc nội bộ sau khi bộ điều phối đã dừng chờ; không có lời gọi kế tiếp được phát ra.
- Chưa thử live mọi provider hoặc dữ liệu SQL nghiệp vụ; chưa chạy thao tác giao diện trong trình duyệt. Các đường tương ứng đã có kiểm thử tự động như mô tả trên.
- Hai mục chưa đánh dấu ở giai đoạn 5–6: chưa bổ sung model tạo summary (tiếp tục cơ chế summary có cấu hình hiện tại); đo chất lượng/chi phí trên lưu lượng vận hành cần thực hiện sau khi chạy thực tế. Diagnostics cho việc đo đã có.
