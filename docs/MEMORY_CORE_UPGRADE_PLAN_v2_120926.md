# Kế hoạch nâng cấp Memory Core v2

> Cập nhật 12/09/2026 sau khi đối chiếu source hiện tại. Đây là kế hoạch, **chưa phải thay đổi runtime đã triển khai**. Nối tiếp [kế hoạch gốc](MEMORY_CORE_IMPLEMENTATION_PLAN.md) và phối hợp với giai đoạn Context, memory và compaction của [master plan](LOCAL_MODEL_OPTIMIZATION_MASTER_PLAN_v2.md).

> Trạng thái triển khai: đã bổ sung baseline eval, scope filtering, pending turn, structured summary và context budget dưới feature flag. Semantic routing vẫn tắt/chưa triển khai cho đến khi corpus baseline đủ lớn để quyết định theo gate ở mục 5.3.

## 1. Kết luận review

**Phù hợp về mục tiêu, cần điều chỉnh thiết kế trước khi triển khai.** Giảm mất context, cải thiện reference và đo chất lượng là cần thiết. Tuy nhiên, không nên luôn chèn summary khi router chọn `none`, không đưa response PARTIAL/invalid vào lịch sử đạt chuẩn, và không mở lại toàn bộ history cho synthesis. Những thay đổi đó sẽ làm suy yếu cơ chế chống nhiễm lịch sử hiện có.

Thứ tự đề xuất: baseline → routing/reference deterministic → dấu vết yêu cầu chưa hoàn tất riêng → budget và summary có điều kiện → semantic escalation nếu số liệu chứng minh cần thiết. Không thêm model hoặc framework memory ở các bước đầu.

## 2. Hiện trạng đã xác minh

Các đường dẫn backend dưới đây tính từ `src/backend/`.

| Hạng mục | Code hiện tại | Điều chỉnh kế hoạch |
|---|---|---|
| Router | `memory_core/topic_detector.js` đã có `same_table_followup`, `short_contextual_followup`, related-table và cross-domain reference. Fallback là `independent_request`, không phải `default_fallback` | Mở rộng baseline hiện có, không mô tả router là luôn bỏ follow-up ngoài đại từ |
| Heuristic | `memory_policy.js` xử lý dấu, dạng không dấu, follow-up ngắn; có một số keyword tiếng Anh | Coverage đa ngôn ngữ còn hạn chế; giữ regression phân biệt “đồ” trong “biểu đồ” với “đó” |
| Domain | `getDomain()` ưu tiên Data Dictionary `domain`, sau đó fallback theo tên bảng | Không xây bảng domain tĩnh cạnh tranh với dictionary |
| Recent | `recentMaxMessages()` dùng `Math.min(4, ...)`, mặc định 4 message; storage mặc định 40 message | Cap cứng có thật; mở rộng phải đi cùng token budget và chọn đúng lượt |
| Summary | `migrateSession()` tạo `summary: ''`; chưa cập nhật hoặc dùng summary | Có field dự phòng, chưa có rolling-summary subsystem |
| Quality gate | Mặc định SUCCESS + evaluator hợp lệ; `MEMORY_PERSIST_PARTIAL=true` nới gate theo `responseEvaluation.valid`; tắt core cũng bỏ gate | Không coi gate là tuyệt đối ở mọi cấu hình; không dùng cờ PARTIAL cũ cho cơ chế pending mới |
| Reference | `reference_store.js` có 3 slot, mỗi slot có `updatedAt` riêng, dùng chung cấu hình thời lượng TTL | TTL riêng theo loại là mở rộng chính sách, không phải bổ sung timestamp lần đầu |
| Reference payload | `lastDataset` giữ table/metric/timeColumn/requiredColumns; `lastEntity` có thể lấy từ hàng SQL đầu tiên | Chưa giữ đầy đủ filter/time range; hàng đầu của danh sách chưa chắc là entity người dùng chọn |
| Synthesis | `agent_core/harness/local_model_harness.js` tạo conversation mới từ current request/plan/SQL data/chart/export; bỏ chủ đề không liên quan | Đây là hàng rào grounding có chủ đích, cần giữ |
| Budget | Có `RequestExecutionBudget` cho deadline/model calls/SQL attempts; có `local_result_compactor.js` và `LOCAL_MODEL_NUM_CTX` | Còn thiếu phân bổ token chung theo thành phần; không viết lại execution budget |
| Observability | `training_core/failure_classifier.js` đã có HISTORY_CONTAMINATION, MISSING_REFERENCE và các nhãn memory; collector và Training UI có memory decision | Cần nâng độ chính xác, độ đầy đủ trace và thống kê rate; không tạo lại từ đầu |
| Embedding | `services/qdrant_service.js` có `embedTexts()`, Ollama/endpoint tương thích, mặc định `bge-m3`; repo đã có Qdrant | Tận dụng cấu hình/provider hiện có, không mặc định thêm nomic/mxbai hoặc vector DB khác |
| Tests/eval | `tests/memory_core.test.js` có follow-up web ngắn, TTL, migration, account isolation, sanitize, fail-closed | Cần eval hội thoại riêng; `eval:local` đo format tool-call, `eval:retrieval` đo document retrieval |

Luồng tích hợp:

```text
intelligent_core/core.js
  → context selection + trainingService.plan()
  → memoryService.route() → getContext()
  → messages → local/default harness → evaluation
routes/router.js (streaming và non-streaming)
  → persistSuccessfulExchange() → chat audit
training_core/case_collector.js → failure_classifier.js → Training UI
```

`services/conversation_memory_service.js` là compatibility export của singleton Memory Core. Khi sửa persistence phải kiểm tra cả hai nhánh chat trong `routes/router.js`. `strictSelectedKnowledge` hiện loại history khi có tài liệu được chọn tường minh; v2 phải giữ ranh giới này.

## 3. Nguyên tắc

1. **`none` vẫn trả context rỗng.** Không thêm summary/recent/pending qua đường vòng. Scope tài liệu được chọn, account/session và quyền DB hiện tại có ưu tiên cao hơn memory.
2. Tách audit theo chính sách log/mask hiện có, working memory đã kiểm duyệt, và structured state có nguồn gốc/thời hạn. Audit không trở thành nguồn prompt mặc định.
3. Memory là dữ liệu tham khảo, không phải chỉ thị thực thi. Nội dung user/assistant trong summary/reference phải được giới hạn field, sanitize và đánh dấu là dữ liệu; không nâng thành chỉ thị system.
4. Deterministic-first, không gọi model tóm tắt mỗi lượt. Semantic là thí nghiệm tắt mặc định, có deadline/abort và đo chi phí.
5. Tắt flag v2 để rollback về core hiện tại. Không mặc định tắt `MEMORY_CORE_ENABLED`, vì thao tác đó quay về recent 10 message và thay đổi quality gate.
6. Không thay hệ thống audit, không chia sẻ memory giữa tài khoản, không triển khai long-term cross-session memory trong phạm vi này.

## 4. Thiết kế đề xuất

### 4.1 Routing và chọn context

- Giữ tín hiệu đổi chủ đề rõ ràng → `none`. Cùng bảng chưa đủ chứng minh follow-up: bổ sung case yêu cầu độc lập cùng bảng, đổi entity/filter hoặc reset câu hỏi.
- Mở rộng heuristic bằng fixture tiếng Việt có/không dấu, viết tắt và tiếng Anh. Kết hợp plan/reference hợp lệ, không chỉ độ dài câu.
- Chuẩn hóa decision với `reason`, `confidence`, `signals`, nguồn context. Hiện không phải nhánh nào cũng có confidence; không ngầm coi thiếu field là low.
- Lọc recent theo turn/scope được phép trước khi cắt số lượng. Nhân viên → điện → follow-up điện không được kéo message nhân viên chỉ vì còn trong 4 message cuối.
- Nếu cần entity/filter trước context selection, thêm bước resolve ứng viên có giới hạn rồi validate theo schema/quyền hiện tại. Không chỉ chèn prompt sau khi planner đã chọn sai bảng. Ghi original plan và effective plan nếu có enrichment.
- Reference thiếu/hết TTL/mơ hồ phải trả reason rõ ràng. Lớp trả lời quyết định hỏi làm rõ; router không tự chọn entity để che lỗi thiếu context.

### 4.2 Structured state trước rolling summary

- Dataset: bổ sung filter/time range đã xác nhận từ execution/plan được validate, nguồn DB, source turn và scope. Plan dự kiến không phải bằng chứng query đã thực thi đúng filter.
- Entity: chỉ ghi entity duy nhất hoặc được chọn tường minh; không mặc định chọn hàng đầu khi kết quả nhiều người.
- Export: giữ artifact identity/URL và dataset nguồn; lớp artifact kiểm tra khả dụng/quyền trước khi dùng lại. TTL memory không chứng minh file còn tồn tại.
- Phân biệt “tải file đã tạo” với “tạo file từ dataset vừa xem”. Resolver hiện ưu tiên keyword `lastExport`, có thể trả `missing_reference` dù còn dataset. Nhánh tạo mới chỉ dùng dataset khi đủ metadata để truy vấn lại hợp lệ; không giả dataset thành file.
- Chỉ thêm `activeFilters`, `activeTimeRange`, `mentionedEntities` khi có contract provenance, giới hạn kích thước, reset scope và override. Filter mới tường minh thay filter cùng trường; không cộng dồn mù qua chủ đề.
- Có thể thêm TTL theo loại, fallback về `MEMORY_REFERENCE_TTL_MINUTES`. Kiểm tra timestamp lỗi/tương lai/hết hạn; reference cũ thiếu metadata được xử lý bảo thủ.

Schema v2 dự kiến gồm `schemaVersion`, `sourceTurnId`, `scope`, `dbSourceId`, `updatedAt`, `expiresAt`, `provenance`, chỉ thêm field cần cho từng loại. Kiểm tra quyền hiện tại mỗi lần resolve; quyền cũ đã lưu không là căn cứ cấp quyền mới.

### 4.3 Dấu vết PARTIAL/invalid riêng

Giữ `persistSuccessfulExchange()` cho exchange đạt chuẩn. Bổ sung API riêng, ví dụ `recordPendingTurn()`, lưu câu hỏi đã sanitize và trạng thái chưa hoàn tất; không lưu assistant bị loại vào `session.messages`.

- `pendingTurn` dự kiến gồm turn ID, câu hỏi giới hạn độ dài, completion status, failure codes được allowlist, scope dự kiến và timestamp/TTL. Đây là yêu cầu chưa giải quyết, không phải fact đã xác minh.
- Không cập nhật `lastPlan`, successful references hoặc summary facts từ response invalid. Nếu cần, giữ `requestedPlan` riêng với trạng thái chưa xác minh.
- Chỉ đưa pending vào context khi request hiện tại rõ ràng nối tiếp/retry cùng scope. Hết hạn/đổi scope hoặc bị yêu cầu mới thay thế thì bỏ; vẫn tuân thủ account/session và mode `none`.
- Builder tạo ghi chú ngắn “yêu cầu trước chưa hoàn tất”, không giả lập assistant đã khẳng định kết quả; tránh replay câu hỏi cũ khiến model trả lời lại. Completion không chứng minh người dùng đã đọc reply.
- `sanitizeMessage()` hiện chỉ trả `role/content`, làm mất metadata bổ sung. Không dựa vào field `quality` gắn tùy ý trên message rồi mong `getContext()` giữ lại.
- Giữ `memoryPersisted` với nghĩa successful exchange; thêm `pendingTurnRecorded` riêng. Collector/classifier không được gắn `INVALID_RESPONSE_PERSISTED` chỉ vì pending hợp lệ.
- Flag tắt mặc định, không phụ thuộc `MEMORY_PERSIST_PARTIAL=true`. Kiểm thử SUCCESS/PARTIAL/invalid/evaluator thiếu ở cả streaming và non-streaming.

### 4.4 Budget token và summary có điều kiện

Phối hợp giai đoạn 5 của master plan, tránh hai cơ chế budget cạnh tranh. Có thể đặt module dùng chung ở `agent_core/harness/context_budget.js` (file mới dự kiến), gọi khi core/harness chuẩn bị từng dispatch.

```text
effective context window
  >= system/tool definitions + current request + required schema
   + skill/examples + document/web context + selected memory
   + current tool results + output reserve + estimation margin
```

- Dùng context hiệu lực từ provider/config, không hard-code mọi request là 16K. Token estimate khác usage thật; ký tự/4 chỉ là baseline cần hiệu chỉnh, đặc biệt tiếng Việt.
- Bảo toàn current request, ràng buộc hệ thống, schema cần thiết, bằng chứng cần trả lời và output reserve. Loại context không liên quan trước; giảm ví dụ tùy chọn và memory cũ; compact tool/document results có chủ đích, không làm mất dữ kiện quyết định hoặc dữ liệu artifact gốc.
- Không đủ budget tối thiểu: báo thiếu context hoặc query/tổng hợp có mục tiêu trong execution budget; không cắt âm thầm bằng chứng cần thiết.
- Recent mặc định vẫn 4 message ở bước đầu. Chỉ mở cấu hình lớn hơn khi có token budget, hard ceiling công bố rõ, và chọn lượt hoàn chỉnh.
- Summary ban đầu là bản rút gọn deterministic từ structured state đã xác minh. Chỉ dùng trong `recent`, hoặc phần reference tương ứng khi cần; không dùng trong `none`/`strictSelectedKnowledge`.
- Summary có scope, source turn, TTL/version và token limit. Không ép mọi session giảm xuống 2 message. Sanitize khi ghi/đọc, bỏ summary sai version/scope.
- Chưa gọi Ollama tóm tắt sau mỗi lượt. Nếu thử LLM summary về sau: flag riêng, đo chất lượng/chi phí; cập nhật kiểm tra session version để tác vụ cũ không ghi đè scope mới hoặc phục hồi session đã xóa.

### 4.5 Giữ synthesis cách ly

Giữ `synthesisConversation` mới chỉ chứa context request hiện tại. Follow-up cần entity/filter thì resolve và validate vào effective request/plan trước khi gọi tool; synthesis nhận plan đã resolve và kết quả tool hiện tại.

Không truyền raw history/summary toàn phiên cho synthesis. Reference thiếu ảnh hưởng kết quả thì lớp trên yêu cầu làm rõ, không để model đoán. Kiểm thử số liệu vẫn grounding vào current SQL data sau nhiều lượt follow-up.

### 4.6 Semantic escalation — thí nghiệm sau baseline

- Chỉ xét decision thực sự mơ hồ và còn prior context hợp lệ. Không ghi đè high-confidence topic change, selected-document scope, thiếu quyền hoặc reference hết hạn.
- Similarity chỉ là tín hiệu cùng chủ đề, không chứng minh quan hệ tham chiếu. Kết hợp entity/filter/intent và counterexample cùng bảng nhưng yêu cầu độc lập.
- Tận dụng embedding provider/config hiện có. Trước khi dùng `embedTexts()` trên request path cần contract timeout/abort, model/dimension và phân biệt vector thật với deterministic fallback. Vector fallback không được dùng làm bằng chứng semantic.
- Cache theo account/session, source turn và embedding model/version/dimension; đổi model thì invalidate. Không cần collection hội thoại hoặc vector DB mới.
- Route hiện đồng bộ. Nếu thêm embedding phải có async path rõ ràng và cập nhật caller trong `intelligent_core/core.js`; truyền deadline/abort chung, giới hạn số lần và log chi phí riêng. Lỗi/timeout giữ decision deterministic ban đầu, không tự chuyển recent.
- Chưa đưa classifier LLM vào rollout đầu. Nếu thử sau này, tính model call vào `RequestExecutionBudget` và usage; ngưỡng p95 lấy từ benchmark thực, không cam kết +100–200 ms khi chưa đo.

## 5. Observability và eval

### 5.1 Mở rộng hạ tầng sẵn có

- Dùng trace, collector, classifier và `src/frontend/js/modules/training_core.js` hiện có. Kiểm tra round-trip decision/persistence qua audit cả hai nhánh chat: non-streaming hiện không ghi `memoryDecision` trực tiếp như streaming.
- Thêm selected turn IDs/reference type, scope, lý do bỏ context, token estimate trước/sau, pending marker, latency và config/version snapshot. Không cần log vector thô hoặc nội dung nhạy cảm để đo rate.
- `HISTORY_CONTAMINATION` hiện dựa regex “Yên Duy/nhân viên”; `MISSING_REFERENCE` dựa reason `missing_reference`. Phân biệt tín hiệu heuristic với kết luận từ case gán nhãn/review.
- Entity ngoài `currentPlan.table` chưa chắc là contamination: JOIN hoặc cross-table reference có thể hợp lệ. So với tập scope/entity/bằng chứng được phép của case.
- Shadow phải ghi decision đề xuất và thực sự áp dụng. Shadow hiện phát recent 10 message, có nhánh reference thiếu trả sớm trước shadow; chuẩn hóa trước khi dùng A/B. Không coi shadow legacy tương đương baseline core đang bật.

### 5.2 Runner hội thoại mới

Đề xuất `scripts/evaluate_memory.js` và `tests/fixtures/memory_conversation_cases.json` (chưa có). Mỗi case gồm nhiều turn, account/session, schema/DB scope, tool result fixture, expected mode hoặc tập mode hợp lệ, expected reference/filters, forbidden context và pending behavior.

Chạy process cô lập bằng `KNOWLEDGEHUB_DATA_DIR`, seed fixture, reset giữa case và giữ state giữa turn cùng case. Tách deterministic replay với live end-to-end benchmark; không ghi vào memory/audit/artifact của instance đang dùng.

| Nhóm case | Kỳ vọng |
|---|---|
| Follow-up tự nhiên có/không dấu, viết tắt, tiếng Anh, general/web | Đúng context cần dùng, không chỉ khớp câu mẫu regex |
| Cùng bảng nhưng độc lập; đổi entity/filter | Không kế thừa điều kiện cũ trái yêu cầu |
| Nhân viên → điện → follow-up điện | Không kéo employee messages/summary |
| “Người đó” sau một hàng và sau danh sách nhiều người | Resolve duy nhất; làm rõ khi mơ hồ |
| Tạo export từ dataset và tải export sẵn có | Đúng dataset/artifact, không tạo URL giả |
| TTL, timestamp lỗi/tương lai, đổi DB/quyền | Không dùng reference không hợp lệ |
| PARTIAL/invalid → follow-up/retry → SUCCESS | Chỉ pending hợp lệ, không promote invalid facts |
| Chọn tài liệu sau hội thoại SQL | Giữ `strictSelectedKnowledge` |
| Khác account cùng session ID, session mới/xóa, migration cũ | Không rò context hoặc phục hồi state đã xóa |
| Budget nhỏ, summary cũ, embedding lỗi/abort, flag off | Fallback dự đoán được, không vượt scope/budget |
| Synthesis sau follow-up nhiều lượt | Dựa current tool results |

### 5.3 Chỉ số và gate

- **Follow-up recall** = turn follow-up nhận đủ context đúng / turn được gán nhãn cần context. Chọn `recent` chưa đủ để tính đúng.
- **Missing-reference rate** = turn cần reference nhưng không resolve đúng / turn được gán nhãn cần reference. Tách absent/expired/ambiguous/router drop; từ chối reference hết hạn đúng chính sách không tự là lỗi router.
- **Contamination rate** = câu trả lời chứa history không được phép / câu trả lời được đánh giá; báo cáo riêng nhóm independent/topic-change.
- Theo dõi wrong-reference, invalid fact reuse, p50/p95 latency, model/embedding calls, token usage và timeout. Case chưa gán nhãn không được tính như không lỗi.
- Gate deterministic: regression scope/account/quality/grounding pass, không có contamination mới trên golden set cố định, recall cải thiện ở nhóm false-drop đã xác nhận. Báo cáo cả numerator/denominator.
- Gate bật mặc định summary/semantic: A/B cùng fixture/config, tăng recall mà không tăng wrong-reference/contamination trên tập kiểm thử, chi phí trong ngưỡng chốt sau baseline. Không suy rộng “0 lỗi fixture” thành bảo đảm production.

## 6. Lộ trình nghiệm thu

| Giai đoạn | Công việc | Điều kiện hoàn tất |
|---|---|---|
| 0 — Baseline | Runner nhiều lượt, audit hai nhánh chat, metric/shadow | Báo cáo tái lập, phân biệt heuristic/nhãn đúng; chưa đổi default |
| 1 — Routing/reference | Follow-up deterministic, scope filtering, entity, export intent, provenance | Regression pass; case mới chứng minh sửa false-drop/wrong-reference |
| 2 — Pending turn | API/state riêng, TTL/sanitize, metadata và collector/UI | Không promote invalid facts; hai route chat đúng; flag off giữ baseline |
| 3 — Budget/summary | Budget chung với master plan, recent có giới hạn, summary deterministic | Prompt trong budget; `none` rỗng; grounding/artifact giữ đúng |
| 4 — Semantic thử nghiệm | Async adapter/cache/deadline, embedding hiện có | Có A/B chất lượng/latency; chỉ bật nếu vượt gate |

Không gán số tuần cố định trước baseline và đánh giá phạm vi tích hợp. Eval/regression chạy từ giai đoạn 0 và mỗi bước, không để đến cuối.

## 7. Cấu hình, migration và rollback

Cờ **đã có**: `MEMORY_CORE_ENABLED`, `MEMORY_CORE_SHADOW_MODE`, `MEMORY_RECENT_MAX_MESSAGES`, `MEMORY_REFERENCE_TTL_MINUTES`, `MEMORY_PERSIST_PARTIAL`, `MEMORY_TRACE_ENABLED`; storage dùng `AI_MEMORY_MAX_MESSAGES`, `AI_MEMORY_MAX_SESSIONS`.

Cờ **đề xuất, chưa có tác dụng runtime**:

```env
MEMORY_PENDING_TURN_ENABLED=false
MEMORY_CONTEXT_BUDGET_ENABLED=false
MEMORY_SUMMARY_ENABLED=false
MEMORY_SEMANTIC_ROUTING_ENABLED=false
```

- Routing/reference có đổi hành vi cần cờ rollout riêng khi implement; không dùng shadow legacy để giả shadow v2.
- Khi implement, cập nhật `.env.example` và Settings/help: default, giới hạn, phụ thuộc. Summary cần budget; semantic không buộc bật summary/pending.
- Migration đọc session cũ không lỗi. `summary` string cũ không mặc nhiên trusted; reference thiếu provenance không tự điền bằng giả định. Flag off bỏ qua state v2 khi build prompt.
- Giới hạn kích thước state, kiểm tra persist/restart; sao lưu trước migration thay đổi storage. Rollback bằng flag giữ core hiện tại, không xóa audit.

## 8. Kiểm chứng và bước tiếp theo

Review này đối chiếu source và regression hiện có; chưa đo recall/contamination hoặc latency model live. Bước implement đầu là **giai đoạn 0**, không bật summary/thêm model ngay.

Lệnh regression liên quan với dữ liệu cô lập:

```powershell
node --require ./tests/helpers/setup_isolated_data.js --test tests/memory_core.test.js tests/training_core.test.js tests/local_harness.test.js tests/request_execution_budget.test.js
```

Khi triển khai runtime, chạy thêm tests tích hợp chat cho nhánh bị sửa và các check bắt buộc của repo. `eval:local` chỉ xác nhận format và `eval:retrieval` đo retrieval, không thay báo cáo memory nhiều lượt.

Kết quả kiểm tra ngày 12/09/2026: lệnh regression trên chạy **69 tests, 69 pass, 0 fail**. Đây là bằng chứng baseline hiện tại, không phải nghiệm thu các tính năng v2 chưa implement.
