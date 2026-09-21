# Kế hoạch sửa lỗi JOIN bị từ chối sai — Data Dictionary Relationships

> **Cập nhật rà soát 21/09/2026:** kế hoạch dưới đây đã bổ sung kiểm tra ON/alias,
> giới hạn context và phân loại lỗi. Chưa triển khai thay đổi runtime. Lần rà soát bổ sung
> không xác minh lại `.env` của dịch vụ đang chạy; các ca tái hiện chủ động bật planner
> trong tiến trình kiểm tra.

> Phân tích ngày 20/09/2026, dựa trên đọc trực tiếp mã nguồn và đối chiếu với `.env` thực
> tế đang chạy (`SQL_JOIN_PLANNER_ENABLED=true`, `SQL_RELATIONSHIP_DISCOVERY_ENABLED=true`).
> Phạm vi: `src/backend/intelligent_core/schema_context_service.js`,
> `src/backend/services/{relationship_service,join_planner_service,sql_join_validator,
> dictionary_service}.js`, `src/backend/agent_core/tools/builtins/index.js`.
>
> **Bối cảnh:** quy trình tạo/xác minh quan hệ trên UI Data Dictionary (real FK tự động,
> quan hệ quy ước tạo tay + bấm xác minh) đã đúng. Vấn đề trong tài liệu này xảy ra **ngay
> cả khi quy trình đó được làm đúng** — tức là bug kiến trúc, không phải lỗi thao tác.
>
> Rà soát bổ sung: thêm JOIN-5 cho pattern nhiều cột FK cùng trỏ một bảng lookup dùng
> chung (ví dụ `T_Contract` có 4 cột cùng trỏ `T_Constant` theo `constantId`) — đã xác
> nhận với người dùng: ID trong bảng lookup **duy nhất trên toàn bảng** (không theo
> loại/nhóm), nên quan hệ chỉ cần một cặp cột (`XId = Id`), không cần thêm cột phân loại
> vào `columnPairs`.

## 1. Nguyên nhân gốc — ngữ cảnh gửi model và bộ validate dùng hai tiêu chuẩn khác nhau

**Luồng dữ liệu đã xác nhận (JOIN-1, ưu tiên cao nhất):**

```
schema_context_service.js (dòng 166-203)
  planJoin(requestedIds) → nếu outcome !== 'ready' (no_path/ambiguous)
    → FALLBACK: relationships = lọc theo relationshipRelevant() (heuristic từ khoá),
      vẫn chỉ lấy quan hệ status==='verified', HIỂN THỊ cho model trong "Relationships:"
    → bổ sung bảng liên quan rồi THỬ LẬP LẠI plan với selected.slice(0, 4), maxEdges: 3
    → joinPlan trả về vẫn có thể KHÔNG phải 'ready'
        │
        ▼ (kết quả sau lần thử lập lại plan)
builtins/index.js dòng 213-215
  validateSqlAgainstJoinPlan(sql, context.joinPlan)
sql_join_validator.js dòng 122-130
  SQL_JOIN_PLANNER_ENABLED=true → enforcePlan=true
  → nếu plan.outcome !== 'ready' VÀ SQL có JOIN → TỪ CHỐI THẲNG,
    bất kể JOIN đó có dùng đúng quan hệ đã xác minh hay không
```

**Hậu quả cụ thể:** model được cho xem quan hệ đã xác minh (qua nhánh fallback), viết đúng
JOIN dùng quan hệ đó — nhưng bị từ chối vì `joinPlan` **tổng thể** (tính trên toàn bộ tập
bảng được chọn) không đạt `'ready'`, có thể do một bảng khác trong cùng câu hỏi gây
`ambiguous` hoặc vượt `maxEdges`, hoàn toàn không liên quan đến cặp bảng model vừa JOIN.
Với `LOCAL_MODEL_MAX_REPAIRS=1`, số lần repair hạn chế; sửa câu SQL không giải quyết được
một cách đáng tin cậy việc context và validator dùng tiêu chuẩn khác nhau.

## 1b. Trường hợp riêng — nhiều cột FK cùng trỏ một bảng lookup (`T_Contract` → `T_Constant`)

Khi chỉ một bảng gốc được chọn và quan hệ đủ điều kiện, pattern này đi qua
`automaticEnrichmentRelations()` + `planEnrichment()` thay vì `findPaths()`/`planJoin()`
(`schema_context_service.js` dòng 105-118, `join_planner_service.js` dòng 40-59) — cơ chế
này gán alias riêng cho mỗi quan hệ (`t2`, `t3`, `t4`...) nên nhiều quan hệ cùng trỏ một
bảng đích không bị coi là "ambiguous" ở bước lập enrichment plan. Tuy nhiên, validator
hiện tìm cột hiển thị theo tên bảng, có thể lấy nhầm alias khi nhiều vai trò dùng cùng
displayColumn; tạo alias riêng trong planner chưa bảo đảm SQL đúng được chấp nhận.

**Điều kiện để enrichment kích hoạt đúng (cần rà trên Dictionary):**
1. Cardinality mỗi quan hệ là `many-to-one`/`one-to-one`.
2. Mỗi cột nguồn FK phải có `description` không rỗng — thiếu thì quan hệ đó bị loại khỏi
   enrichment **âm thầm**, có thể khiến kết quả vẫn trả ID thô cho cột đó.
3. Câu hỏi phải khiến hệ thống chọn **duy nhất bảng gốc** (`T_Contract`) làm bảng chính ban
   đầu (`selected.length === 1`). Nếu bảng lookup (`T_Constant`) cũng bị chọn làm bảng chính
   thứ hai ngay từ đầu, nhánh enrichment bị bỏ qua hoàn toàn, rơi xuống JOIN-5 dưới đây.
4. Quan hệ phải active, verified và bảng lookup nằm trong tập bảng active. Số quan hệ
   chịu giới hạn `SQL_AUTO_ENRICH_MAX_RELATIONSHIPS` (mặc định 6).

Vì ID trong bảng lookup đã xác nhận **duy nhất toàn bảng**, quan hệ chỉ cần một cặp cột
(`XId = Id`) — không cần thêm cột phân loại/nhóm vào `columnPairs`.

## 2. Kế hoạch sửa (thay thế phương án ban đầu)

| Mã | Việc cần làm | File | Tiêu chí nghiệm thu |
|---|---|---|---|
| JOIN-1 | Thay chặn theo plan tổng bằng xác minh **từng JOIN/alias/ON** trên tập quan hệ đủ điều kiện do backend cung cấp. Siết logic predicate cho cả plan ready và fallback; không tái sử dụng nguyên trạng `equalityPairs`/`applicableEdges` | Validator, relationship service, schema context, builtins | JOIN hợp lệ không bị từ chối lây bởi bảng thứ ba; OR vô hiệu khóa, thiếu khóa ghép và alias phụ JOIN sai đều bị chặn |
| JOIN-2 | Đưa ba chỗ `maxEdges: 3` vào `SQL_JOIN_MAX_EDGES` (mặc định 3); đồng bộ `slice(0, 4)`, `AI_SCHEMA_MAX_TABLES`, bảng trung gian và ngân sách context | Schema context, planner, cấu hình mẫu/tài liệu | 5 cạnh/6 bảng hoạt động khi ngân sách đủ; vượt giới hạn báo đúng nguyên nhân, không nhầm thiếu quan hệ |
| JOIN-3 | Cân nhắc thêm `preferred` sau JOIN-1/5; vai trò được hỏi phải được xét trước ưu tiên mặc định. Không dùng confidenceScore làm căn cứ duy nhất để tự chọn khi vẫn mơ hồ | Planner, mô hình/lưu trữ quan hệ, Dictionary API/UI | Preferred giải quyết được lựa chọn mặc định có quy tắc rõ ràng; không ghi đè vai trò người dùng yêu cầu; còn mơ hồ thì yêu cầu làm rõ |
| JOIN-4 | Trả mã lỗi có cấu trúc xuyên suốt planner/validator/tool/harness, phân biệt thiếu quan hệ, mơ hồ vai trò, vượt giới hạn, ON sai và ngoài phạm vi | Planner, validator, builtins, harness và lớp chuyển tiếp tool | Gợi ý đúng hành động theo nguyên nhân; lỗi SQL sửa được vẫn repair, lỗi metadata không lặp SQL vô ích |
| JOIN-5 | Chọn quan hệ theo bảng gốc và vai trò cần hỏi, tạo ref/alias riêng cho từng lookup; đồng bộ planner, builder và validator theo quan hệ → alias → displayColumn → businessRole | Planner, schema context, SQL enrichment builder, validator, caller trong harness | Hỏi chi tiết cần bốn vai trò tạo bốn alias đúng kể cả khi lookup được chọn từ đầu; hỏi một vai trò không bị ép JOIN cả bốn; tiêu đề/bộ lọc đúng alias |

**Thứ tự triển khai:** JOIN-1 kèm siết ON/alias → JOIN-5 xuyên suốt planner/builder/validator
→ JOIN-2 → JOIN-4 tích hợp harness → JOIN-3. Xác định hợp đồng mã lỗi từ JOIN-1.
Không đưa fallback vào sử dụng trước khi các test từ chối JOIN sai đạt. JOIN-1 không phải
nguyên nhân duy nhất khiến quan hệ verified vẫn không hoạt động: alias, giới hạn và lựa
chọn vai trò cũng cần xử lý.

### 2.1. Yêu cầu chi tiết cho JOIN-1

- Dùng chung chính sách lọc quan hệ cho context/planner/validator: active, verified,
  đúng dbSourceId/database/schema, bảng được phép truy cập và cột được phép hiển thị.
  Không đọc toàn bộ Dictionary rồi chỉ lọc verified. Backend truyền phạm vi xác thực,
  model/SQL không được tự mở rộng phạm vi đó; xét revision khi Dictionary thay đổi.
- Phân giải bảng bằng định danh đầy đủ, alias trong đúng phạm vi SELECT/CTE/subquery.
  Không gom predicate của nhiều SELECT để thỏa một quan hệ. Cấu trúc chưa hỗ trợ phải
  báo rõ, không mặc nhiên cho qua.
- Mỗi JOIN có bằng chứng riêng, đủ columnPairs nối cùng một cặp alias. Chỉ dùng equality
  bắt buộc đúng theo biểu thức boolean; giai đoạn đầu có thể từ chối ON chứa OR chưa
  chứng minh được, bằng mã lỗi không hỗ trợ.
- Dùng tập edge thực sự được SQL sử dụng để kiểm tra grain; đảo columnPairs/cardinality
  khi đảo chiều. Giữ các kiểm tra scope, CROSS JOIN và projection enrichment.
- Đồng bộ cả `buildSchemaContext()` và `refineSchemaContext()`. Không yêu cầu mọi quan hệ
  cùng trỏ một bảng phải xuất hiện chỉ vì SQL có bảng đó. Tuy nhiên, SQL đúng quan hệ
  chưa chứng minh đã trả lời đủ yêu cầu nghiệp vụ; fallback không được bỏ qua yêu cầu này.

### 2.2. Yêu cầu chi tiết cho JOIN-5

- Nhiều đường trực tiếp khác relationshipId chỉ là dấu hiệu, không chứng minh cần JOIN
  tất cả. Hỏi danh sách chi tiết thì áp chính sách enrichment; hỏi một vai trò thì chọn
  vai trò đó; không đủ căn cứ thì giữ ambiguous và yêu cầu làm rõ.
- Mỗi lần dùng lookup có tableRefId riêng; mỗi edge có fromTableRefId/toTableRefId.
  Thống nhất hợp đồng này ở cả planJoin và planEnrichment: SQL builder đang tra ref bằng
  `edge.*TableRefId || edge.*TableId`.
- Validator ánh xạ alias SQL từ ON tới đúng edge rồi kiểm tra displayColumn/businessRole
  trên alias đó, không tìm cột chỉ theo tên bảng. Cho phép tên alias khác tên trong plan.
- Builder phải dùng đúng alias ở JOIN/SELECT/bộ lọc lookup. Kiểm tra LEFT JOIN cho
  enrichment để không làm mất dòng có FK NULL ngoài dự kiến.
- Ghi rõ lý do quan hệ bị loại khỏi enrichment (metadata, cardinality, lookup inactive,
  vượt giới hạn), không quy tất cả thành thiếu quan hệ.

### 2.3. Giới hạn, lỗi và lựa chọn đường nối

- JOIN-2: kiểm tra cấu hình số nguyên dương, quy định giới hạn trên; phân biệt số bảng
  vật lý, alias, số cạnh đường đi và tổng cạnh plan. Bốn vai trò lookup không được vô tình
  bị giới hạn ba cạnh của JOIN thường chặn. Giữ schema/khóa/quan hệ bắt buộc trong context,
  không chỉ cắt chuỗi khiến plan ready nhưng model thiếu thông tin. Đo độ trễ khi tăng giới hạn.
- JOIN-4: đề xuất mã `JOIN_RELATIONSHIP_MISSING`, `JOIN_ROLE_AMBIGUOUS`,
  `JOIN_LIMIT_EXCEEDED`, `JOIN_PREDICATE_INVALID`, `JOIN_SCOPE_DENIED`,
  `JOIN_UNSUPPORTED_SQL`. Giữ mã lỗi qua lớp tool tới harness; kiểm tra cả SQL do model
  sinh, deterministic và recovery. Chỉ nêu bảng/vai trò trong phạm vi người dùng được biết.
- JOIN-3: nếu thêm preferred, mặc định false, cập nhật persistence/API/UI và revision.
  Quy định cách ưu tiên cả đường đi, xử lý nhiều đường preferred; confidence phát hiện
  quan hệ không đồng nghĩa với đúng vai trò nghiệp vụ. Khi còn hòa, không tự chọn.

## 3. Rủi ro / lưu ý khi sửa

- **JOIN-1** phải chuyển sang bằng chứng trên từng JOIN, không nới lỏng xác thực. Logic
  cũ đã chấp nhận sai ON chứa OR và alias phụ ON 1=1; cần sửa trước khi mở fallback.
- **JOIN-2** cần thử với số bảng lớn hơn để đo lại độ trễ dựng context (nhiều bảng hơn =
  nhiều dòng "Relationships:" hơn trong prompt, ảnh hưởng ngân sách ngữ cảnh).
- **JOIN-3** thêm trường `preferred` là thay đổi schema Dictionary — cần migration/mặc định
  `false` cho dữ liệu hiện có, không tự suy luận preferred cho quan hệ cũ.
- **JOIN-5** cần phân biệt đúng hai tình huống dễ nhầm: "nhiều quan hệ khác `relationshipId`
  cùng trỏ 1 bảng" (nên tách thành nhiều edge, như `T_Contract`↔`T_Constant`) khác với
  "thật sự có 2 cách hợp lý để nối 2 thực thể nghiệp vụ khác nhau" (nên giữ `ambiguous`,
  thuộc JOIN-3) — không gộp chung logic, tránh biến mọi trường hợp ambiguous thành tự động
  join hết, có thể tạo SQL sai ý người hỏi (join thừa cột không liên quan tới câu hỏi).

## 4. Kiểm thử và bằng chứng rà soát

Ngày 21/09/2026 đã chạy 24 test trong `tests/sql_join_validator.test.js`,
`tests/join_planner_service.test.js`, `tests/schema_context_service.test.js`: tất cả pass.
Qdrant local không kết nối được; kết quả không xác nhận vector retrieval hoạt động.
Chưa kiểm tra end-to-end với SQL Server hoặc xác minh metadata lookup thực tế.

Tái hiện riêng bằng lời gọi validator, không thực thi SQL: với quan hệ
`Orders.CustomerID → Customers.ID`, cả `ON o.CustomerID=c.ID OR 1=1` và JOIN đúng alias
`c` rồi thêm `JOIN Customers c2 ON 1=1` đều trả `valid: true`. JOIN đúng với plan ambiguous
bị chặn. Bộ test hiện có chưa bao phủ các ca này.

| Nhóm | Ca nghiệm thu bắt buộc |
|---|---|
| Fallback | Plan null/no_path/ambiguous; SQL dùng phần quan hệ hợp lệ; bảng thứ ba không liên quan; giữ yêu cầu nghiệp vụ |
| ON | Khóa đơn/ghép, đảo vế equality, thiếu khóa, OR 1=1, alias phụ ON 1=1, CROSS JOIN và thiếu ON |
| Scope | Trùng tên bảng khác schema/nguồn, inactive/unverified, cột/bảng ngoài phạm vi, alias trùng giữa SELECT/CTE/subquery, self JOIN |
| Lookup | Bốn FK cùng lookup/cùng displayColumn, alias đổi tên, hoán đổi tiêu đề, lọc đúng vai trò, FK NULL, hỏi một vai trò và hỏi chi tiết |
| Giới hạn | 5 cạnh/6 bảng, 5–6 bảng đầu vào, bảng trung gian, thiếu context, bốn lookup edge với mặc định JOIN thường |
| Grain/projection | SUM/COUNT phía một qua một-nhiều, đảo chiều quan hệ, COUNT DISTINCT, không lộ ID đã map trong enrichment |
| Tích hợp | Context → planner → builder/model → tool → validator → harness; mã lỗi được giữ, repair đúng loại, kết quả không nhân bản/mất dòng ngoài dự kiến |

Trước nghiệm thu cuối, chạy SQL Server với dữ liệu kiểm soát được và đối chiếu kết quả
đúng từng vai trò; không chỉ dựa vào `outcome: ready` hoặc `valid: true`.

## 5. Tài liệu tham chiếu

- `src/backend/intelligent_core/schema_context_service.js` (dòng 164-203, 242-270)
- `src/backend/services/join_planner_service.js`
- `src/backend/services/sql_join_validator.js` (dòng 121-162)
- `src/backend/services/sql_enrichment_builder.js`
- `src/backend/services/relationship_service.js`
- `src/backend/services/dictionary_service.js` (`importForeignKeyRelationships`,
  `discoverRelationshipCandidates`, `addRelationship`, `setTableRelationshipStatus`)
- `src/backend/agent_core/tools/builtins/index.js` (dòng 207-225)
- `src/backend/agent_core/harness/local_model_harness.js` (`maxRepairs`, xử lý lỗi tool)
