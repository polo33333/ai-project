# Kế hoạch triển khai Memory Core

## 1. Mục tiêu

Xây dựng một lớp `memory_core` kiểm soát việc sử dụng lịch sử hội thoại trước khi gửi context cho model local.

Mục tiêu chính:

- Ngăn thông tin của chủ đề cũ ảnh hưởng câu hỏi độc lập mới.
- Vẫn hỗ trợ câu hỏi nối tiếp như “người đó”, “dữ liệu trên”, “xuất file này”.
- Không đưa câu trả lời lỗi hoặc `PARTIAL` vào bộ nhớ dùng cho model.
- Cô lập bước tổng hợp cuối khỏi lịch sử không liên quan.
- Lưu reference có cấu trúc thay vì phụ thuộc hoàn toàn vào văn bản hội thoại.
- Ghi lại quyết định sử dụng memory vào trace để có thể kiểm tra trên Training Core.

## 2. Vấn đề hiện tại

Luồng hiện tại lấy tối đa 10 tin nhắn gần nhất từ `conversation_memory.json` và gửi vào model. Cách này có các rủi ro:

1. Chuyển từ chủ đề nhân viên sang điện nhưng model vẫn bám vào “Yên Duy”.
2. Câu trả lời `PARTIAL` hoặc sai vẫn có thể được lưu và tái sử dụng.
3. Model phải tự suy luận tin nhắn nào trong lịch sử còn liên quan.
4. Bước synthesis có thể nhận quá nhiều nội dung cũ.
5. Memory hiện chủ yếu là văn bản, chưa có reference nghiệp vụ có cấu trúc.

## 3. Phạm vi

### Trong phạm vi

- Routing memory theo câu hỏi hiện tại.
- Phát hiện câu hỏi nối tiếp và chuyển chủ đề.
- Lưu trạng thái nghiệp vụ có cấu trúc theo session.
- Lọc nội dung trước khi gửi model.
- Chỉ lưu câu trả lời đạt quality gate.
- Tích hợp với `training_core`, `local_model_harness` và trace.
- Hiển thị quyết định memory trong Training Core.

### Ngoài phạm vi

- Fine-tune trọng số model.
- Vector hóa toàn bộ lịch sử hội thoại.
- Tự động sửa source code trong runtime.
- Chia sẻ memory giữa các tài khoản.
- Thay thế hệ thống audit trong `chat_history.json`.

## 4. Kiến trúc đề xuất

```text
User request
     │
     v
Training Core tạo Request Plan
     │
     v
Memory Router
     ├── none: câu hỏi độc lập/chuyển chủ đề
     ├── recent: câu hỏi nối tiếp cần vài tin nhắn
     └── reference: chỉ lấy entity/dataset/file gần nhất
     │
     v
Local Model Harness → Tools → Response Evaluator
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
              hợp lệ                    không hợp lệ
                 │                           │
        cập nhật memory/reference       chỉ lưu audit
```

## 5. Cấu trúc thư mục

```text
src/backend/memory_core/
├── index.js
├── memory_service.js
├── memory_router.js
├── topic_detector.js
├── reference_store.js
├── memory_sanitizer.js
└── memory_policy.js
```

### `memory_router.js`

Quyết định chế độ memory:

```js
{
  mode: 'none', // none | recent | reference
  reason: 'topic_changed',
  maxMessages: 0,
  scope: 'electricity'
}
```

### `topic_detector.js`

So sánh request plan hiện tại và trạng thái trước:

- Bảng dữ liệu.
- Intent.
- Metric.
- Cột thời gian.
- Entity/filter.
- Từ tham chiếu như “đó”, “trên”, “này”, “người đó”.

### `reference_store.js`

Quản lý reference có cấu trúc:

```json
{
  "lastEntity": {
    "table": "M_Employee",
    "filters": {
      "EmployeeName": "Yên Duy"
    }
  },
  "lastDataset": {
    "table": "T_ElectricityOutput",
    "metric": "TotalQty",
    "timeColumn": "ElectricityOutputDate"
  },
  "lastExport": {
    "downloadUrl": "/api/exports/report.xlsx"
  }
}
```

### `memory_sanitizer.js`

- Loại SQL thô không cần thiết khỏi lịch sử tự nhiên.
- Loại câu trả lời `PARTIAL`, schema-only và SQL-only.
- Giới hạn độ dài.
- Không lưu dữ liệu nhạy cảm chưa được mask.

### `memory_policy.js`

Quality gate trước khi ghi memory:

```js
const canPersist =
  completionStatus === 'SUCCESS' &&
  responseEvaluation.valid &&
  !responseEvaluation.failures.length;
```

## 6. Mô hình dữ liệu mới

Mở rộng mỗi session trong `conversation_memory.json`:

```json
{
  "id": "session-...",
  "summary": "",
  "messages": [],
  "activeScope": "electricity",
  "lastPlan": {
    "intent": "aggregate_timeseries",
    "table": "T_ElectricityOutput",
    "metric": "TotalQty"
  },
  "references": {
    "lastEntity": null,
    "lastDataset": {},
    "lastExport": {}
  },
  "updatedAt": "..."
}
```

Yêu cầu tương thích ngược: session cũ không có các trường mới vẫn phải đọc được.

## 7. Quy tắc routing

### Chế độ `none`

Áp dụng khi:

- Câu hỏi có đủ bảng/cột/filter.
- Request plan hiện tại khác bảng với plan trước.
- Người dùng chuyển domain: nhân viên → điện → hợp đồng.
- Câu hỏi không chứa đại từ hoặc từ tham chiếu.

### Chế độ `recent`

Áp dụng khi:

- Câu hỏi dùng đại từ: “người đó”, “khách hàng đó”.
- Câu hỏi bổ sung filter: “chỉ lấy phòng kỹ thuật”.
- Câu hỏi hỏi tiếp cùng bảng/metric.
- Tối đa 2–4 tin nhắn gần nhất, không dùng mặc định 10 tin nhắn.

### Chế độ `reference`

Áp dụng khi:

- “Xuất file này”.
- “Vẽ biểu đồ dữ liệu trên”.
- “Tháng trước thì sao?”.
- Có thể giải quyết bằng `lastEntity`, `lastDataset` hoặc `lastExport`.

## 8. Thay đổi trong luồng backend

### `intelligent_core/core.js`

Hiện tại:

```js
const memoryHistory = conversationMemoryService.getContext(sessionId, history, 10);
```

Luồng mới:

```js
const requestPlan = trainingService.plan(...);
const memoryDecision = memoryService.route({
  sessionId,
  question,
  currentPlan: requestPlan,
  fallbackHistory: history
});
const memoryHistory = memoryService.getContext(memoryDecision);
```

### `local_model_harness.js`

- Nhận `memoryDecision` trong context.
- Ghi decision vào trace.
- Synthesis chỉ nhận câu hỏi hiện tại, request plan và SQL rows.
- Không sử dụng toàn bộ conversation cho synthesis.

### `router.js`

Chỉ persist exchange sau khi có kết quả quality gate:

```js
if (coreResult.trace?.completionStatus === 'SUCCESS' &&
    coreResult.trace?.training?.responseEvaluation?.valid) {
  memoryService.persistSuccessfulExchange(...);
}
```

Các câu trả lời không đạt vẫn được lưu trong `chat_history.json` để audit và Training Core phân tích.

## 9. Tích hợp Training Core UI

Thêm vào từng case/trace:

```json
{
  "memoryDecision": {
    "mode": "none",
    "reason": "topic_changed",
    "previousScope": "employee",
    "currentScope": "electricity"
  }
}
```

Training Core có thể hiển thị thêm các lỗi:

- `MEMORY_USED_FOR_INDEPENDENT_REQUEST`
- `TOPIC_CHANGE_NOT_DETECTED`
- `INVALID_RESPONSE_PERSISTED`
- `MISSING_REFERENCE`
- `STALE_REFERENCE_USED`

## 10. Kế hoạch triển khai

### Giai đoạn 1 — Quality gate khi lưu memory

- Truyền `completionStatus` và response evaluation tới memory service.
- Không lưu response `PARTIAL` hoặc không đạt evaluator.
- Giữ audit như hiện tại.
- Viết migration tương thích session cũ.

Tiêu chí nghiệm thu:

- Response sai vẫn có trong chat history.
- Response sai không xuất hiện trong conversation memory.
- Response hợp lệ tiếp tục được lưu.

### Giai đoạn 2 — Topic detector và memory router

- So sánh current plan với last plan.
- Nhận diện câu hỏi độc lập/nối tiếp.
- Hỗ trợ `none`, `recent`, `reference`.
- Giảm recent window mặc định từ 10 xuống tối đa 4 khi cần.

Tiêu chí nghiệm thu:

- Hỏi nhân viên rồi chuyển sang điện: memory mode là `none`.
- “Người đó thuộc phòng nào?”: memory mode là `recent` hoặc `reference`.
- Quyết định được ghi trong trace.

### Giai đoạn 3 — Structured reference

- Lưu `lastEntity`, `lastDataset`, `lastExport`.
- Resolve từ tham chiếu trước khi gọi model.
- Không đưa toàn bộ câu trả lời cũ nếu reference đã đủ.

Tiêu chí nghiệm thu:

- “Xuất file này” sử dụng đúng dataset gần nhất.
- “Người đó” sử dụng đúng nhân viên gần nhất.
- Reference không vượt qua ranh giới session/account.

### Giai đoạn 4 — Cô lập synthesis

- Tạo message list mới cho synthesis.
- Chỉ truyền current question, plan, rows, chart status và export URL.
- Không tái sử dụng lịch sử cũ trong bước này.

Tiêu chí nghiệm thu:

- Câu trả lời điện không chứa tên nhân viên từ lịch sử.
- Giá trị trong câu trả lời phải có trong current SQL rows.

### Giai đoạn 5 — UI và regression

- Hiển thị memory decision trên Training Core.
- Thêm failure classifier cho lỗi memory.
- Chuyển feedback `needs_review` liên quan thành regression test.

Tiêu chí nghiệm thu:

- Có thể xem lý do dùng/bỏ memory trên UI.
- Các lỗi từng gặp có regression test.

## 11. Kiểm thử bắt buộc

1. Cùng chủ đề, câu hỏi nối tiếp hợp lệ.
2. Chuyển chủ đề giữa hai bảng.
3. Chat mới không dùng session cũ.
4. Response `PARTIAL` không được persist.
5. Response `SUCCESS` được persist.
6. Reference entity được resolve đúng.
7. Reference dataset được resolve đúng.
8. Reference file không bị dùng sang session khác.
9. Synthesis không bị nhiễm lịch sử.
10. Session JSON cũ vẫn đọc được.
11. Dữ liệu nhạy cảm được mask trước khi lưu.
12. Khi Memory Core lỗi, hệ thống fallback an toàn sang `mode: none`.

## 12. Cấu hình đề xuất

```env
MEMORY_CORE_ENABLED=true
MEMORY_RECENT_MAX_MESSAGES=4
MEMORY_REFERENCE_TTL_MINUTES=120
MEMORY_PERSIST_PARTIAL=false
MEMORY_TRACE_ENABLED=true
```

Feature flag cho phép tắt Memory Core và quay lại hành vi cũ trong giai đoạn thử nghiệm.

## 13. Rủi ro và biện pháp giảm thiểu

| Rủi ro | Biện pháp |
|---|---|
| Router bỏ memory cho một câu hỏi nối tiếp | Reference detector và fallback recent có giới hạn |
| Plan chọn sai bảng làm đổi scope | Chỉ coi là chuyển chủ đề khi có confidence đủ cao |
| Mất tương thích session cũ | Dùng giá trị mặc định và migration khi đọc |
| Reference lưu dữ liệu nhạy cảm | Mask và chỉ lưu field cần thiết |
| Tăng latency | Routing và topic detection chạy deterministic, không gọi thêm LLM |
| Training evaluator lỗi làm mất memory | Chỉ bỏ persist response, không ảnh hưởng audit |

## 14. Rollout

1. Bật Memory Core trong môi trường phát triển.
2. Chạy toàn bộ unit test và regression suite.
3. Shadow mode: ghi decision nhưng chưa áp dụng trong 1–2 ngày kiểm thử.
4. So sánh kết quả legacy và Memory Core trên Training UI.
5. Bật routing thật cho local model.
6. Theo dõi `HISTORY_CONTAMINATION` và `MISSING_REFERENCE`.
7. Giữ feature flag để rollback nhanh.

## 15. Điều kiện phê duyệt trước khi triển khai

- Đồng ý không lưu response `PARTIAL` vào model memory.
- Đồng ý giảm recent history từ 10 xuống tối đa 4 khi câu hỏi nối tiếp.
- Đồng ý dùng structured reference trong `conversation_memory.json`.
- Đồng ý bật shadow mode trước khi áp dụng routing thật.
- Xác nhận reference TTL mặc định là 120 phút.

## 16. Kết quả mong đợi

- Giảm lỗi nhiễm lịch sử giữa các domain.
- Model local nhận prompt ngắn và đúng trọng tâm hơn.
- Câu hỏi nối tiếp vẫn hoạt động nhờ structured reference.
- Response lỗi phục vụ audit/training nhưng không làm ô nhiễm memory.
- Mọi quyết định memory có thể kiểm tra trên Training Core UI.



# Phụ lục: Thuật toán Topic Detection và Reference Resolution

> Tài liệu này bổ sung chi tiết kỹ thuật cho `MEMORY_CORE_IMPLEMENTATION_PLAN.md`, cụ thể hóa mục 5 (`topic_detector.js`, `reference_store.js`) và mục 7 (Quy tắc routing) để có thể implement trực tiếp mà không cần suy diễn thêm.

---

## A. Topic Detector — quy tắc quyết định (deterministic)

Thay vì một công thức "điểm số" trừu tượng, dùng **cây quyết định tường minh** (dễ test, dễ review, không có vùng xám mơ hồ). Input là `currentPlan` (từ Training Core), `lastPlan` (lưu trong session), và `questionText` gốc.

### A.1. Các tín hiệu đầu vào

| Tín hiệu | Cách xác định |
|---|---|
| `tableChanged` | `currentPlan.table !== lastPlan.table` |
| `domainChanged` | `getDomain(currentPlan.table) !== getDomain(lastPlan.table)` — domain là nhóm nghiệp vụ tĩnh, cấu hình sẵn (vd: `M_Employee` → `employee`, `T_ElectricityOutput` → `electricity`) |
| `hasPronoun` | regex tham chiếu khớp trong `questionText`: `/(đó|này|trên|vừa rồi|đấy)\b/i` |
| `isSelfContained` | `currentPlan` có đủ `table`, `metric`/`intent`, và filter tường minh (không phải suy ra từ ngữ cảnh) |
| `isExportOrChartIntent` | `questionText` khớp từ khóa xuất/biểu đồ (xem mục B.2) |

`getDomain()` là bảng ánh xạ tĩnh, cấu hình cùng schema — **không** suy luận bằng LLM, giữ đúng cam kết "deterministic, không gọi thêm LLM" ở mục 13 của plan gốc.

### A.2. Cây quyết định

```js
function detectTopic({ currentPlan, lastPlan, questionText }) {
  // Không có plan trước (phiên mới hoặc chưa từng hỏi) => không có gì để kế thừa
  if (!lastPlan) {
    return { mode: 'none', reason: 'no_prior_context' };
  }

  const tableChanged = currentPlan.table !== lastPlan.table;
  const domainChanged = getDomain(currentPlan.table) !== getDomain(lastPlan.table);
  const hasPronoun = REFERENCE_PRONOUN_REGEX.test(questionText);
  const isSelfContained = isPlanSelfContained(currentPlan);

  // Rule 1 — câu hỏi tự đủ thông tin, không có đại từ, đổi bảng
  //          => chắc chắn đổi chủ đề, không cần xét thêm
  if (isSelfContained && !hasPronoun && tableChanged) {
    return { mode: 'none', reason: 'topic_changed', confidence: 'high' };
  }

  // Rule 2 — có đại từ + ý định xuất file/biểu đồ/dữ liệu cụ thể
  //          => ưu tiên reference store trước, không cần lịch sử hội thoại
  if (hasPronoun && isExportOrChartIntent(questionText)) {
    return { mode: 'reference', reason: 'reference_pronoun_detected' };
  }

  // Rule 3 — cùng bảng (dù có/không đại từ) => hỏi tiếp cùng chủ đề
  if (!tableChanged) {
    return { mode: 'recent', reason: 'same_table_followup', maxMessages: 4 };
  }

  // Rule 4 — đổi bảng NHƯNG có đại từ tham chiếu => trường hợp mơ hồ nhất.
  //          Đại từ có thể chỉ một entity (vd "người đó") vẫn còn hợp lệ
  //          dù bảng dữ liệu đang hỏi đã khác (vd đang hỏi lương của "người đó").
  if (tableChanged && hasPronoun) {
    if (domainChanged) {
      // Thử resolve qua reference store trước khi kết luận đổi chủ đề
      const resolved = tryResolveEntityReference(currentPlan, questionText);
      return resolved
        ? { mode: 'reference', reason: 'cross_domain_entity_reference' }
        : { mode: 'none', reason: 'topic_changed_ambiguous_pronoun', confidence: 'medium' };
    }
    // Cùng domain, khác bảng => có thể là bảng liên quan (vd nhân viên -> phòng ban)
    return { mode: 'recent', reason: 'related_table_followup', maxMessages: 2 };
  }

  // Fallback an toàn — không rơi vào rule nào rõ ràng
  return { mode: 'none', reason: 'default_fallback', confidence: 'low' };
}
```

### A.3. Vì sao thứ tự rule quan trọng

- Rule 1 đặt đầu tiên vì đây là tín hiệu mạnh nhất và rẻ nhất để tính — loại nhanh phần lớn case rõ ràng (ví dụ chính trong plan gốc: nhân viên → điện).
- Rule 2 đặt trước Rule 3 vì ý định export/chart nên luôn ưu tiên reference store thay vì kéo cả `recent` history — đúng tinh thần mục 7 "reference" của plan gốc.
- Rule 4 (trường hợp mơ hồ nhất) cố tình xử lý sau cùng, và **thiên về an toàn**: nếu không resolve được, trả về `none` thay vì đoán — tránh lỗi `MEMORY_USED_FOR_INDEPENDENT_REQUEST` đã liệt kê trong mục 9 của plan gốc.

### A.4. Test case bổ sung cho Giai đoạn 2

| Input | Kỳ vọng |
|---|---|
| "Lương nhân viên A là bao nhiêu?" → "Sản lượng điện tháng 8?" | `none / topic_changed` (Rule 1) |
| "Xuất file này ra Excel" (sau khi vừa xem dataset điện) | `reference / reference_pronoun_detected` (Rule 2) |
| "Chỉ lấy phòng kỹ thuật thôi" (sau câu hỏi nhân viên) | `recent / same_table_followup` (Rule 3) |
| "Người đó ở phòng nào?" (sau khi hỏi lương, giờ hỏi tổ chức) | `reference / cross_domain_entity_reference` nếu resolve được `lastEntity`, ngược lại `none / topic_changed_ambiguous_pronoun` (Rule 4) |

---

## B. Reference Resolution — quy tắc ưu tiên khi có nhiều candidate

Khi `mode: 'reference'`, có thể có tối đa 3 candidate cùng còn hiệu lực trong TTL: `lastEntity`, `lastDataset`, `lastExport`. Cần một rule tường minh để chọn, tránh phụ thuộc suy luận ngầm của model.

### B.1. Nguyên tắc

1. **Ưu tiên theo từ khóa ý định trong câu hỏi hiện tại**, không phải theo thứ tự lưu.
2. Nếu nhiều candidate cùng khớp từ khóa (hiếm, nhưng có thể xảy ra) → chọn theo `updatedAt` mới nhất.
3. Nếu không khớp từ khóa nào (đại từ chung chung như "cái đó", "nó") → chọn candidate có `updatedAt` mới nhất trong số còn hiệu lực.
4. Nếu tất cả candidate đã hết TTL (120 phút) → coi như không tìm thấy, **không** suy đoán tiếp.

### B.2. Bảng từ khóa theo loại reference

| Loại reference | Từ khóa nhận diện (ví dụ) |
|---|---|
| `lastExport` | "xuất file", "tải về", "download", "file này", "báo cáo này" |
| `lastDataset` | "biểu đồ", "dữ liệu trên", "số liệu đó", "vẽ", "so sánh với" |
| `lastEntity` | "người đó", "nhân viên đó", "khách hàng đó", "anh ấy", "cô ấy" |

Danh sách này cấu hình được (không hard-code trong logic), để dễ mở rộng khi có domain mới.

### B.3. Thuật toán

```js
function resolveReference(questionText, references, now) {
  const candidates = [];

  if (matchesKeyword(questionText, EXPORT_KEYWORDS) && isValid(references.lastExport, now)) {
    candidates.push({ type: 'lastExport', data: references.lastExport });
  }
  if (matchesKeyword(questionText, DATASET_KEYWORDS) && isValid(references.lastDataset, now)) {
    candidates.push({ type: 'lastDataset', data: references.lastDataset });
  }
  if (matchesKeyword(questionText, ENTITY_KEYWORDS) && isValid(references.lastEntity, now)) {
    candidates.push({ type: 'lastEntity', data: references.lastEntity });
  }

  if (candidates.length === 1) return candidates[0];

  if (candidates.length > 1) {
    // Nhiều từ khóa cùng khớp — chọn cái cập nhật gần nhất
    return candidates.sort((a, b) => b.data.updatedAt - a.data.updatedAt)[0];
  }

  // Không khớp từ khóa cụ thể nào — đại từ chung chung
  const generic = [
    { type: 'lastEntity', data: references.lastEntity },
    { type: 'lastDataset', data: references.lastDataset },
    { type: 'lastExport', data: references.lastExport },
  ].filter(r => isValid(r.data, now));

  if (generic.length === 0) return null; // không tìm thấy gì hợp lệ

  return generic.sort((a, b) => b.data.updatedAt - a.data.updatedAt)[0];
}

function isValid(ref, now) {
  if (!ref || !ref.updatedAt) return false;
  const ttlMs = MEMORY_REFERENCE_TTL_MINUTES * 60 * 1000;
  return (now - ref.updatedAt) <= ttlMs;
}
```

### B.4. Xử lý khi `resolveReference` trả về `null`

Đây là case **hết TTL hoặc chưa từng có reference**. Quy tắc:

- `memory_router` set `mode: 'none'`, `reason: 'reference_expired'` (nếu từng có nhưng hết hạn) hoặc `reason: 'missing_reference'` (nếu chưa từng có).
- Ghi cả hai lý do này vào trace để Training Core phân biệt được — khác với lỗi thật sự (`STALE_REFERENCE_USED` là khi resolve nhầm reference đã cũ nhưng vẫn trong TTL, còn `MISSING_REFERENCE` là khi không resolve được gì).
- **Memory Core không tự hỏi lại người dùng để làm rõ** — quyết định có hỏi lại hay không (ví dụ "Bạn muốn xuất file nào?") thuộc về lớp response/synthesis phía trên, nằm ngoài phạm vi của `memory_core` theo đúng ranh giới đã định trong mục 3 (Phạm vi) của plan gốc. Memory Core chỉ có trách nhiệm cung cấp `mode: none` + lý do rõ ràng trong decision object để lớp trên quyết định.

### B.5. Test case bổ sung cho Giai đoạn 3

| Tình huống | Kỳ vọng |
|---|---|
| Vừa xem dataset điện, hỏi "xuất file này" | Resolve `lastExport` nếu có; nếu chưa từng export, `lastDataset` không được dùng nhầm làm export — trả `missing_reference` |
| Vừa hỏi nhân viên A, sau đó hỏi dataset điện, rồi hỏi "người đó lương bao nhiêu" | Ưu tiên `lastEntity` (khớp từ khóa "người đó") dù `lastDataset` mới hơn về thời gian |
| Reference còn hiệu lực nhưng câu hỏi dùng đại từ chung chung "cái đó thì sao" | Chọn theo `updatedAt` mới nhất trong 3 loại |
| Reference đã quá 120 phút | `mode: none`, `reason: reference_expired`, ghi trace, không dùng dữ liệu cũ |

---

## C. Ghi chú tích hợp

- Cả hai thuật toán trên đều **thuần rule-based**, không gọi model — giữ đúng yêu cầu latency ở mục 13 (rủi ro) của plan gốc.
- `getDomain()`, danh sách từ khóa (`EXPORT_KEYWORDS`, `DATASET_KEYWORDS`, `ENTITY_KEYWORDS`), và regex đại từ nên đặt trong `memory_policy.js` hoặc một file config riêng (`memory_keywords.config.js`) để không hard-code rải rác, dễ mở rộng khi thêm domain nghiệp vụ mới.
- Toàn bộ nhánh quyết định (Rule 1–4, và nhánh `resolveReference`) nên có unit test 1-1, vì đây là phần logic dễ bị thay đổi ngầm và gây regression khó phát hiện nếu không có test bao phủ từng nhánh.
