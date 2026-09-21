# Kế hoạch sửa lỗi JOIN bị từ chối sai — Data Dictionary Relationships

> **Trạng thái triển khai 21/09/2026:** đã triển khai JOIN-1 đến JOIN-5, kiểm tra ON/alias,
> AVG/fan-out, bằng chứng cardinality, giới hạn context và mã lỗi có cấu trúc. `.env` đang
> dùng đặt `SQL_JOIN_MAX_EDGES=5`, `SQL_AUTO_ENRICH_MAX_RELATIONSHIPS=6`. Toàn bộ test tự
> động pass; chưa nghiệm thu end-to-end trên SQL Server thật và Qdrant local không hoạt động
> trong lần kiểm tra schema context.

> Phân tích ngày 20/09/2026, dựa trên đọc trực tiếp mã nguồn và đối chiếu với `.env` thực
> tế đang chạy (`SQL_JOIN_PLANNER_ENABLED=true`, `SQL_RELATIONSHIP_DISCOVERY_ENABLED=true`).
> Phạm vi: `src/backend/intelligent_core/schema_context_service.js`,
> `src/backend/services/{relationship_service,join_planner_service,sql_join_validator,
> dictionary_service}.js`, `src/backend/agent_core/tools/builtins/index.js`.
>
> **Bối cảnh:** quy trình tạo/xác minh quan hệ trên UI Data Dictionary (real FK tự động,
> quan hệ quy ước tạo tay + bấm xác minh) đã đúng. Vấn đề trong tài liệu này xảy ra **ngay
> cả khi quy trình đó được làm đúng**. Ngoài lỗi kiến trúc này, kế hoạch cũng phải xử lý
> rủi ro người tạo quan hệ tay khai sai cardinality; bấm xác minh không tự chứng minh
> cardinality đúng với ràng buộc và dữ liệu thực tế.
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
  khi đảo chiều. Kiểm tra SUM/COUNT/**AVG** và cả SELECT liệt kê không aggregate theo
  yêu cầu ở mục 2.4. Giữ các kiểm tra scope, CROSS JOIN và projection enrichment.
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

### 2.4. Grain kết quả, fan-out và độ tin cậy của cardinality

**Phạm vi triển khai:** JOIN-1 chịu trách nhiệm xác thực grain; JOIN-5/builder phải giữ
grain khi enrichment; Dictionary API/UI và luồng xác minh quan hệ kiểm tra cardinality;
JOIN-4 chuyển tiếp lỗi có cấu trúc. Đây là yêu cầu nghiệm thu bắt buộc, không phải cải
thiện tùy chọn sau khi mở fallback.

- **AVG sau JOIN một-nhiều:** khi yêu cầu trung bình theo thực thể phía một, AVG cột
  phía một trên các dòng đã JOIN có thể bị tính trọng số theo số bản ghi con. Ví dụ hai
  hợp đồng có giá trị 100 và 300, lần lượt có 1 và 3 dòng con: trung bình hợp đồng là
  200 nhưng AVG sau JOIN là 250. Validator phải phát hiện nguy cơ cùng với SUM/COUNT,
  yêu cầu SQL giữ một dòng mỗi thực thể trước khi tính AVG (hoặc dùng EXISTS nếu chỉ
  lọc theo sự tồn tại của dòng con). Không sửa bằng `AVG(DISTINCT value)`: hai thực thể
  khác nhau có cùng giá trị vẫn phải được tính riêng. Aggregate bảng con trước chỉ phù
  hợp khi thực sự bảo đảm grain mong muốn; không lấy trung bình các trung bình một cách
  máy móc. AVG theo dòng con vẫn hợp lệ nếu đó là grain người dùng yêu cầu.
- **SELECT thường cũng có fan-out:** yêu cầu “danh sách hợp đồng, mỗi hợp đồng một dòng”
  không được âm thầm thành nhiều dòng mỗi hợp đồng sau JOIN một-nhiều, dù không có hàm
  aggregate. Truyền grain mong muốn và khóa thực thể từ request plan tới builder/validator;
  xét cả chuỗi JOIN và nhiều nhánh con có thể nhân chéo số dòng. Nếu chỉ lọc theo bảng con,
  ưu tiên EXISTS; nếu cần dữ liệu con trên một dòng cha, phải tổng hợp hoặc chọn dòng con
  theo quy tắc nghiệp vụ rõ ràng trước khi JOIN. Không tự thêm DISTINCT/TOP để che lỗi:
  DISTINCT có thể gộp các thực thể khác nhau, TOP/phân trang có thể cắt thiếu thực thể.
  Nếu người dùng yêu cầu danh sách chi tiết từng dòng con, cho phép grain cha–con tương
  ứng. Chưa xác định được grain thì yêu cầu làm rõ, không tự chặn mọi JOIN một-nhiều.
- **Cardinality khai tay có thể sai:** phân biệt việc code đảo chiều cạnh đúng với việc
  người dùng chọn sai many-to-one/one-to-many/one-to-one trên UI. UI phải ghi rõ chiều
  nguồn → đích và ví dụ; backend kiểm tra cardinality khi tạo/sửa/xác minh quan hệ, không
  chỉ tin giá trị gửi lên hoặc trạng thái verified. Với many-to-one, bộ khóa đích phải
  duy nhất; one-to-many yêu cầu bộ khóa nguồn duy nhất; one-to-one yêu cầu cả hai phía.
  Đối chiếu toàn bộ khóa ghép và ngữ nghĩa NULL/điều kiện JOIN, không xét từng cột riêng lẻ.
- Ưu tiên bằng chứng PK/UNIQUE phù hợp với khóa JOIN. Nếu không có ràng buộc bảo đảm,
  kiểm tra dữ liệu để phát hiện khóa trùng và ghi nguồn bằng chứng, thời điểm, revision;
  dữ liệu hiện tại hoặc một mẫu không có trùng không bảo đảm dữ liệu tương lai. Tách trạng
  thái xác minh quan hệ khỏi mức độ xác minh cardinality. Metadata mâu thuẫn phải được
  đánh dấu và yêu cầu sửa/xác minh lại, không tự đổi chiều hoặc tiếp tục enrichment với
  giả định “không fan-out”. Khi chưa đủ bằng chứng, xử lý như có nguy cơ fan-out và chỉ
  cho phép kế hoạch chứng minh được grain; không mặc nhiên coi là many-to-one an toàn.
- Khi cardinality hoặc bằng chứng thay đổi, tăng revision và vô hiệu hóa plan/cache liên
  quan. JOIN-4 bổ sung `JOIN_GRAIN_UNSAFE`, `JOIN_CARDINALITY_MISMATCH` và
  `JOIN_CARDINALITY_UNCONFIRMED`; phân biệt SQL cần sửa, metadata cần sửa và thiếu bằng
  chứng xác minh để tránh vòng repair vô ích.

### 2.5. Model phân loại ý định dữ liệu trước khi sinh SQL

Đã bổ sung `plan_data_query`, bật bằng `MODEL_DATA_INTENT_PLANNER_ENABLED=true` cho local
model. Với truy vấn dữ liệu, model phải chọn `rootTable`, `intent`, `entityLookup`,
`relationshipFilters`, `requestedFields` và `resultGrain` trước khi gọi SQL. Backend đối
chiếu lựa chọn này với bảng/cột/quan hệ trong context; SQL sau đó phải áp dụng đúng lookup
và mọi bộ lọc quan hệ đã được model chọn.

`entityLookup` chỉ dùng khi model xác định người dùng đang chỉ rõ tên/mã. Các thuộc tính
nghiệp vụ như giới tính, phòng ban, trạng thái hoặc loại hợp đồng được biểu diễn bằng
`relationshipFilters` lấy từ `businessRole` trong Dictionary, không phụ thuộc danh sách
từ khóa thuộc tính viết cứng. Khi không đủ căn cứ, model trả intent `clarification` và
không chạy SQL. Regex lookup cũ chỉ còn là fallback khi feature flag tắt.

## 3. Rủi ro / lưu ý khi sửa

- **JOIN-1** phải chuyển sang bằng chứng trên từng JOIN, không nới lỏng xác thực. Logic
  cũ đã chấp nhận sai ON chứa OR và alias phụ ON 1=1; cần sửa trước khi mở fallback.
- **AVG và fan-out:** ON đúng vẫn có thể làm sai trung bình hoặc lặp thực thể trong SELECT
  không aggregate. Phải kiểm tra grain trước LIMIT/TOP/phân trang; không dùng DISTINCT
  hoặc AVG(DISTINCT) như cách sửa chung.
- **Cardinality do con người khai sai:** quan hệ verified không bảo đảm phía lookup duy
  nhất. Khai nhầm many-to-one có thể bỏ lọt cả lỗi aggregate lẫn lặp dòng enrichment.
  Kiểm tra code đảo chiều cạnh không thay thế kiểm tra metadata nhập từ UI; bằng chứng
  từ dữ liệu có thể hết hiệu lực khi dữ liệu thay đổi dù định nghĩa quan hệ không đổi.
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
| Grain/projection | SUM/COUNT/AVG phía một qua một-nhiều, đảo chiều quan hệ trong code, COUNT DISTINCT, không lộ ID đã map trong enrichment |
| AVG | Hai cha giá trị 100/300 với 1/3 con: phát hiện AVG 250 sai grain, SQL sửa trả 200; thêm hai cha có cùng giá trị để bác cách sửa AVG(DISTINCT); AVG theo grain con vẫn được phép |
| Liệt kê không aggregate | SELECT thường sau one-to-many JOIN: yêu cầu một dòng/cha không được lặp; EXISTS giữ đúng tập cha; yêu cầu chi tiết cha–con được phép; kiểm tra hai nhánh con nhân chéo, LEFT JOIN với cha không có con, TOP/phân trang và hai cha khác khóa nhưng cùng giá trị hiển thị |
| Cardinality nhập tay | Qua API/UI khai many-to-one nhưng khóa đích trùng; khai one-to-many sai chiều; khai one-to-one khi một phía không unique; khóa ghép/NULL; quan hệ đã verified vẫn phải phát hiện mâu thuẫn. Đây là test dữ liệu nhập sai, độc lập với test code đảo cạnh |
| Bằng chứng cardinality | Có/không có PK/UNIQUE phù hợp; dữ liệu mẫu không trùng nhưng chưa chứng minh unique; thêm khóa trùng sau lần kiểm tra dữ liệu; sửa metadata làm đổi revision/vô hiệu hóa plan; không tiếp tục enrichment dựa trên giả định cardinality sai |
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
