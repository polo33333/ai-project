# Fix nhanh: chọn bảng khi gõ sai và hỏi lại khi chưa xác định bảng

> Ngày 22/09/2026; rà soát theo code ngày 23/09/2026.
> Tách khỏi `SEMANTIC_QUERY_UNDERSTANDING_PLAN_220926.md`.
> Trạng thái triển khai và giới hạn kiểm chứng được ghi ngay dưới đây.

## Trạng thái triển khai 23/09/2026

- Đã sửa Fix 4: `plan_data_query` nhận clarification không có `rootTable`; validator trả `rootTable: null` khi chưa resolve được và tiếp tục từ chối intent thực thi thiếu bảng.
- Đã sửa Fix 3: Qdrant trả trạng thái chi tiết `ok/degraded` cho schema retrieval, vẫn giữ API trả mảng cho caller cũ. `retrieval.semanticSearch` được giữ khi model refine danh sách bảng.
- Đã triển khai bước đầu Fix 1: khi lexical mạnh, giữ tối đa một bảng semantic ngoài tập lexical nếu hit có score từ 0.5 trở lên, có thể chỉnh bằng `AI_SCHEMA_SEMANTIC_MIN_SCORE`. Ngưỡng này là mặc định tạm thời, cần hiệu chỉnh bằng benchmark live. Nếu `MAX_TABLES=1`, không giữ thêm ứng viên.
- Chưa bật Fix 2 và chưa sửa gate câu ngắn: hai việc này phụ thuộc fixture/baseline với Qdrant thật. Môi trường kiểm thử hiện tại không kết nối được Qdrant ở `127.0.0.1:6333`, nên chưa có số liệu để chốt ngưỡng chất lượng hoặc latency.
- Baseline trước sửa: 102/102 test liên quan đạt. Sau sửa: toàn bộ `npm test` đạt 313, bỏ qua 2; các test mới kiểm chứng clarification, trạng thái lỗi và bảo toàn bảng semantic.

## Đánh giá sau khi đối chiếu code

Hướng sửa nhỏ trước khi quyết định thay kiến trúc là hợp lý, nhưng không nên triển khai nguyên bản cả 4 fix cùng lúc:

| Hạng mục | Kết luận | Điều chỉnh |
| --- | --- | --- |
| Fix 1: lọc `tablePool` | Có nguy cơ loại ứng viên semantic thật | Không chỉ thay lexical bằng tổng điểm; cần bảo toàn ứng viên semantic trong giới hạn top-K |
| Fix 2: tìm kiếm hai biến thể | Chưa có bằng chứng cải thiện embedding | Chuyển thành thử nghiệm tắt mặc định, sau baseline |
| Fix 3: báo suy giảm | Có thiếu trạng thái lỗi, nhưng không hoàn toàn im lặng | Sửa contract ở `qdrant_service`, giữ metadata qua refine và response |
| Fix 4: clarification thiếu root | Xác nhận lỗi validator và tool schema | Sửa cả contract tool, validator và kiểm chứng lifecycle |
| Gate câu ngắn | Plan cũ bỏ sót | Đo riêng các câu bị trả `general` trước retrieval |

Các fix có phụ thuộc: Fix 2 dùng lại cách hợp nhất ứng viên của Fix 1 và trạng thái lỗi của Fix 3. Cần đo từng bước để biết thay đổi nào thực sự có ích.

## Fix 1 — Giữ ứng viên semantic qua bước lọc và giới hạn bảng

**Bằng chứng:** `src/backend/intelligent_core/schema_context_service.js`, hàm `buildSchemaContext()`:

- `scores` bắt đầu từ lexical, sau đó cộng `rankBoost + max(0, result.score)` cho từng vector hit.
- `tablePool` lại chỉ lọc theo lexical nếu `maxLexicalScore >= 4`.
- Sau đó còn `slice(0, MAX_TABLES)`; có mặt trong pool chưa bảo đảm có mặt trong context.

**Không dùng bản sửa tổng điểm trong plan cũ làm giải pháp hoàn chỉnh.** Ví dụ A có lexical 0, một hit semantic với rank boost 1 và score 0.9, tổng là 1.9; B có lexical 8. Ngưỡng tổng điểm vẫn ít nhất 4, nên A tiếp tục bị loại. Nhiều column hits cũng cộng dồn cho một bảng, làm tổng điểm phụ thuộc số hit chứ không chỉ độ phù hợp.

**Phương án triển khai nhỏ, cần hiệu chỉnh bằng fixture:**

1. Giữ tập lexical mạnh hiện tại. Tạo riêng danh sách bảng semantic từ vector hits đã map vào `activeTables`, khử trùng theo `tableIdentity`; dùng thứ tự hit tốt nhất để xếp danh sách này.
2. Hợp nhất hai tập, giữ xếp hạng hiện tại cho ứng viên thông thường. Khi cắt `MAX_TABLES`, dành tối đa một vị trí cho bảng semantic tốt nhất chưa có trong tập lexical nếu tín hiệu semantic đạt ngưỡng đã hiệu chỉnh. Không hardcode ngưỡng score khi chưa có baseline.
3. Khi không có lexical mạnh, tiếp tục dùng luồng ranking hiện có trong đợt sửa đầu. Không mở rộng sang thay toàn bộ thuật toán retrieval.
4. Trường hợp `MAX_TABLES = 1` và lexical/semantic bất đồng không thể bảo toàn cả hai: ghi nhận riêng, chốt quy tắc chọn theo fixture trước khi bật. Không tuyên bố bảo đảm giữ mọi bảng đúng.
5. Giữ lọc database/source và bảng active trước khi cấp vị trí; không cho bảng ngoài scope lọt vào context. Payload cũ chỉ có tên bảng có thể map nhiều identity: không cấp ưu tiên semantic khi mapping mơ hồ; ghi nhận để đánh giá chất lượng index.
6. Đo tác động tới JOIN: thêm ứng viên có thể đổi root, làm mất điều kiện `selected.length === 1` của auto-enrichment hoặc làm join plan mơ hồ. Kiểm tra cả bảng cuối cùng và schema text sau giới hạn ký tự.

**Nghiệm thu:** thêm test xác định trong `tests/schema_context_service.test.js` với mock vector hits:

- A lexical 0 nhưng semantic tốt; B lexical mạnh không liên quan; A còn trong `selectedTableIds` và schema text khi đủ budget.
- Hơn `MAX_TABLES` ứng viên; hit lặp từ nhiều cột không chiếm nhiều vị trí bảo toàn.
- Không hit, semantic yếu, bảng inactive, bảng ngoài source, tên bảng trùng và `MAX_TABLES = 1`.
- Câu chuẩn chọn đúng root; regression auto-enrichment/JOIN hiện có vẫn đạt.

## Fix 2 — Thử nghiệm biến thể truy vấn, chưa bật mặc định

**Bằng chứng hiện có:** lexical dùng `normalize()` bỏ dấu, còn Qdrant nhận `expandedQuery`. Điều này chưa chứng minh lỗi dấu làm giảm recall của embedding đang dùng, cũng chưa chứng minh bỏ dấu sẽ cải thiện.

Chuẩn hóa Unicode/vị trí dấu và sửa một từ sai dấu thành đúng nghĩa là các việc khác nhau. Không giả định thư viện bộ gõ sẽ tự suy ra ý định. `normalize()` hiện tại còn tách camelCase, bỏ ký tự và chuyển chữ thường, nên không dùng thẳng làm hàm chuẩn hóa cho semantic.

**Thử nghiệm sau Fix 1 và Fix 3:**

- Giữ bản gốc; thử thêm bản chỉ bỏ dấu tiếng Việt, không sửa literal trong yêu cầu gốc, intent hay SQL.
- Chỉ gọi thêm khi biến thể khác bản gốc và câu gốc có 1–6 token phân cách bằng khoảng trắng. Đây là ngưỡng thử nghiệm, không phải kết luận rằng câu dài tự bù được lỗi.
- Tắt mặc định bằng cấu hình; tối đa hai truy vấn và có timeout/budget cho toàn lượt. Ghi rõ số lần embed/search thực tế.
- Hợp nhất theo rank với công thức cố định, ví dụ RRF `sum(1 / (60 + rank))`, rank bắt đầu từ 1. Khử trùng point ID trước khi map bảng; không cộng score cosine của hai truy vấn như cùng thang với lexical, không coi điểm RRF là cosine trong boost hiện tại. Adapter sang danh sách semantic của Fix 1 phải được test riêng.
- Một nhánh lỗi vẫn dùng nhánh còn lại và báo suy giảm; cả hai lỗi thì fallback lexical. Kết quả rỗng thành công không phải lỗi.

**Nghiệm thu:** mock chỉ kiểm chứng số call, fusion, khử trùng và fallback. Chất lượng phải đo với Qdrant/embedding thật trên snapshot index cố định: câu chuẩn, thiếu dấu, sai dấu thành từ khác, typo ký tự và câu dài. Báo recall@K, rank bảng đúng, tỷ lệ bảng sai lọt context, latency p50/p95 và số call. Chỉ bật nếu đạt ngưỡng chấp nhận chốt trước khi chạy; nếu không cải thiện thì giữ tắt.

## Fix 3 — Phân biệt semantic lỗi, không có hit và chưa chạy

**Bằng chứng:**

- `schema_context_service.js` có outer `catch (_) {}`.
- Nhưng `qdrant_service.js::searchSchema()` đã catch lỗi, `console.error` rồi trả `[]`. Vì vậy thêm outer catch đơn thuần không nhận biết lỗi thực tế; nhận định “không có log nào” của plan cũ không đúng.
- `core.js` thay `contextSelection = refined` khi model chọn lại bảng. `_buildSuccessResponse()` chỉ serialize một số field, trong đó có `retrieval`.

**Sửa contract có tương thích:** bổ sung API chi tiết, ví dụ `searchSchemaDetailed()` trả `{ results, status, errorCode }`. Giữ `searchSchema()` làm wrapper trả mảng để không đổi contract caller cũ. Tái sử dụng cùng một đường embed/search, tránh gọi hai lần.

Trong context dùng `retrieval.semanticSearch = { status, errorCode }`, với status `ok`, `degraded`, `skipped`; khi có hai biến thể cần thêm trạng thái từng nhánh. `ok` với results rỗng khác `degraded`; `skipped` dành cho đường không gọi semantic. Chỉ phát log lỗi một lần ở tầng sở hữu request; trả mã lỗi ổn định, không đưa raw error/query/credentials vào response.

Giữ metadata retrieval ban đầu khi `refineSchemaContext()` thay context, rồi bổ sung metadata refinement nếu cần. Dùng field `retrieval` đang được response serializer hỗ trợ thay vì thêm `degraded` ở top-level rồi bị bỏ mất. Không chặn fallback lexical.

**Nghiệm thu:** test lỗi embed và HTTP tại service thật với dependency mock, không chỉ stub `searchSchema` ném lỗi. Test thành công rỗng, thành công có hit, skipped, metadata qua refinement và response. Nếu thử hai biến thể, thêm partial failure.

## Fix 4 — Clarification không cần root, xuyên suốt tool và harness

**Bằng chứng:**

- `data_intent_service.js::validateIntentPlan()` resolve và bắt buộc root trước nhánh clarification.
- `agent_core/tools/builtins/index.js::PlanDataQueryTool` còn khai báo `required: ['intent', 'rootTable']`.
- Tool đã có instruction hỏi lại không chạy SQL; local harness đã có nhánh `intentClarification`. Cần test hành vi, không mặc định toàn bộ lifecycle đang hỏng hay đã đúng.

**Thay đổi:**

1. Trong tool schema, chỉ bắt buộc `intent` chung; mô tả `rootTable` bắt buộc với intent thực thi. Validator giữ trách nhiệm ràng buộc có điều kiện. Rà adapter schema của provider để tránh adapter vô tình bắt buộc root trở lại.
2. Validator kiểm tra intent trước. Với clarification, bắt buộc câu hỏi là string không rỗng sau trim; trả sớm trước các validation dành cho thực thi.
3. Root thiếu hoặc không resolve được trong clarification thì trả `rootTable: null`; nếu resolve được thì trả tên canonical. Không trả nguyên tên bảng chưa kiểm chứng như plan cũ. Giới hạn confidence về [0, 1] nhất quán với intent khác.
4. Với intent thực thi, giữ kiểm tra root, field, filter và scope hiện tại. Clarification không tạo kế hoạch SQL thực thi được.
5. Rà local/provider harness và completion repair: trả câu hỏi làm rõ, không ép SQL, chart hay export khi plan clarification đã được chấp nhận. Chỉ sửa nhánh còn thiếu sau khi có test tái hiện.

**Nghiệm thu:**

- `tests/data_intent_service.test.js`: clarification thiếu root, root không tồn tại, root hợp lệ, context không có bảng; câu hỏi rỗng/sai kiểu bị từ chối; intent thực thi thiếu/sai root vẫn lỗi.
- Test qua `PlanDataQueryTool.execute()` để bao gồm schema validation, không chỉ gọi validator trực tiếp.
- `tests/local_harness.test.js` và `tests/provider_harness.test.js`: clarification được trả tới người dùng, không gọi SQL/chart/export và không bị completion repair biến thành intent thực thi.

## Gate câu ngắn — Điều kiện cần để đo đúng hiệu quả

`isGeneralConversation()` chạy trước Qdrant. Câu không có glossary expansion, không khớp data-intent regex, không có lexical match và tối đa 4 query token sẽ trả `mode: 'general'` ngay. Một số câu gõ sai vì thế không đi qua Fix 1–3.

Bổ sung nhóm fixture riêng cho gate này: typo tên miền ngắn, greeting, hội thoại thông thường, phép tính độc lập và câu dữ liệu có tiền tố rõ ràng. Trace ít nhất mode, việc semantic có chạy hay không và bảng cuối cùng.

Nếu baseline xác nhận lỗi gate, làm một thay đổi riêng: giữ các nhánh greeting/phép tính rõ ràng; với nhánh câu ngắn còn lại, thử một semantic probe có budget, chỉ chuyển sang data khi có bằng chứng đạt ngưỡng. Tái sử dụng kết quả probe cho retrieval, tránh gọi trùng. Ngưỡng và ảnh hưởng tới câu hội thoại phải được chốt bằng fixture trước khi bật. Không bỏ toàn bộ gate hoặc coi mọi câu ngắn là yêu cầu dữ liệu.

Nếu hoãn thay đổi gate, báo rõ tỷ lệ lỗi chưa xử lý; không quy kết kết quả yếu của nhóm này cho ranking hoặc embedding.

## Thứ tự triển khai và tiêu chí hoàn tất

1. Tạo fixture P0 trước khi sửa; plan lớn mới đề xuất bộ fixture, chưa mặc định đã có bộ dữ liệu hoàn chỉnh. Đóng băng dictionary, glossary/alias, index, model, cấu hình và expected table IDs/tool/clarification.
2. Làm Fix 4 và Fix 3 trước vì lỗi/contract đã có bằng chứng. Chạy regression liên quan.
3. Làm Fix 1, đo so với baseline; xử lý gate câu ngắn bằng thay đổi riêng nếu fixture chứng minh cần.
4. Chạy thử Fix 2 sau cùng, báo kết quả riêng, chỉ bật khi có lợi.
5. Báo theo từng nhóm câu: đúng bảng top-1/recall@K, đúng tool, hỏi lại đúng/sai, bảo toàn constraints, lỗi tool, semantic failure, số call và latency. Đo cả candidate và context cuối cùng; không suy ra đúng tool chỉ từ đúng bảng.

Trước thử nghiệm phải chốt ngưỡng recall tối thiểu, mức giảm chất lượng câu chuẩn cho phép và budget latency/call. Với fixture regression xác định: tất cả case bảo vệ scope, không thực thi khi clarification và JOIN hiện có phải đạt. Không đặt con số chất lượng tùy ý rồi coi là đã nghiệm thu.

Lệnh test tập trung dự kiến khi triển khai (dùng setup dữ liệu cô lập của repo):

```powershell
node --require ./tests/helpers/setup_isolated_data.js --test tests/schema_context_service.test.js tests/data_intent_service.test.js tests/local_harness.test.js tests/provider_harness.test.js
```

Bổ sung suite service/metadata nếu tạo mới. Benchmark live là bước riêng; unit test dùng mock không chứng minh cải thiện semantic thực tế. Sau từng thay đổi giữ kết quả riêng để có thể rollback ranking/biến thể truy vấn mà vẫn giữ bugfix clarification và telemetry.

Kết quả này giúp quyết định phần nào của P1–P4 trong plan lớn còn cần làm; không đủ để kết luận về mọi nguồn/tool ngoài SQL schema retrieval.

## Tài liệu tham chiếu

- `src/backend/intelligent_core/schema_context_service.js`
- `src/backend/services/qdrant_service.js`
- `src/backend/intelligent_core/core.js`
- `src/backend/services/data_intent_service.js`
- `src/backend/agent_core/tools/builtins/index.js`
- `src/backend/agent_core/harness/local_model_harness.js`
- `tests/schema_context_service.test.js`, `tests/data_intent_service.test.js`
- [Plan lớn: mục 4.5 và P0](SEMANTIC_QUERY_UNDERSTANDING_PLAN_220926.md)
