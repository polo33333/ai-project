# Plan: Hiểu câu hỏi theo ngữ nghĩa và chịu lỗi nhập liệu

Ngày: 22/09/2026  
Trạng thái: Đề xuất triển khai; chưa thay đổi runtime.

## 1. Mục tiêu

Hệ thống hiểu đúng yêu cầu khi người dùng gõ sai chính tả, thừa/thiếu ký tự hoặc từ, viết không dấu, viết tắt hay diễn đạt khác. Kết quả hiểu phải được dùng nhất quán để chọn tài liệu, schema, tool và tham số thực thi.

Giải pháp áp dụng cho nhiều lĩnh vực và nguồn dữ liệu. Thêm lĩnh vực, bảng hoặc tool mới bằng metadata và đăng ký capability, không sửa logic nhận diện trong mã nguồn.

Không cam kết khôi phục thông tin đã mất: thiếu đối tượng, phủ định hoặc điều kiện có thể làm câu hỏi mơ hồ. Khi không có đủ bằng chứng từ câu gốc và ngữ cảnh, hỏi lại thay vì tự bổ sung.

## 2. Ràng buộc không hard-code

- Không tạo bảng thay thế cố định kiểu `hhop → hợp`, danh sách từ nghiệp vụ trong regex, hoặc nhánh `if` theo tên bảng/tool/lĩnh vực.
- Không dùng bộ intent nghiệp vụ đóng như hợp đồng, nhân sự, doanh thu. Đối tượng và thao tác được suy ra từ yêu cầu và capability catalog hiện hành.
- Tên bảng/cột/tool và các giá trị enum thực thi phải lấy từ metadata/registry đã được lọc quyền. Model không được tự tạo định danh.
- Glossary/alias là dữ liệu quản trị tùy chọn, có nguồn và phiên bản; không phải điều kiện bắt buộc để hiểu một lĩnh vực mới. Không chuyển một danh sách hard-code sang JSON rồi coi là tổng quát.
- Prompt mô tả nguyên tắc và output contract chung; không nhúng ví dụ nghiệp vụ đặc biệt để quyết định routing.
- Ngưỡng điểm, số ứng viên, ngân sách model và timeout có cấu hình, được hiệu chỉnh bằng evaluation. Không coi điểm embedding hoặc confidence do model tự khai là xác suất đúng.
- Cho phép schema giao thức cố định, thuật toán tổng quát và kiểm tra quyền/schema xác định. Đây là hạ tầng, không phải quy tắc nghiệp vụ hard-code.
- Ví dụ tên miền cụ thể chỉ nằm trong fixtures kiểm thử, không tham gia quyết định runtime.

## 3. Hiện trạng đã kiểm tra

| Thành phần | Hiện trạng | Hướng thay đổi |
| --- | --- | --- |
| `src/backend/intelligent_core/core.js` | Chọn schema trước; routing tài liệu dựa vào `needsKnowledgeSearch`; có xử lý follow-up | Điều phối bước hiểu chung trước quyết định routing cuối cùng |
| `src/backend/intelligent_core/schema_context_service.js` | Đã có Qdrant, lexical matching, glossary; vẫn có regex intent và lexical gate | Tái sử dụng hybrid retrieval, bỏ các gate nghiệp vụ làm chặn truy hồi quá sớm |
| `src/backend/intelligent_core/knowledge_intent.js` | Từ khóa và token tiêu đề khớp chính xác | Không dùng làm quyết định loại trừ duy nhất trong luồng mới |
| `src/backend/knowledge_core/services/retrieval_service.js` | Đã có dense retrieval, BM25, fusion và rerank | Tái sử dụng cho câu gốc và các truy vấn diễn giải có kiểm soát |
| `src/backend/agent_core/harness/guarded_agent_harness.js` | Lập plan/policy từ câu hỏi; có budget, validator và repair | Nhận cùng understanding contract; không tự diễn giải lại độc lập |
| `src/backend/agent_core/harness/local_prompt_builder.js` | Hướng dẫn gọi tool và lập data plan | Cung cấp contract và candidate metadata cho local model |
| `src/backend/services/data_intent_service.js` | Kiểm tra data plan theo schema/relationship; có clarification | Ánh xạ hiểu tổng quát sang data plan; hỗ trợ hỏi lại khi chưa chọn được bảng |
| `src/backend/agent_core/harness/tool_argument_validator.js` | Kiểm tra tên tool và tham số | Giữ kiểm tra cấu trúc, bổ sung kiểm tra tương thích với yêu cầu |

Không xây một hệ thống vector search mới song song. Khảo sát tiếp provider embedding, index lifecycle và các entry point trước khi quyết định phần nào mở rộng.

## 4. Luồng xử lý đề xuất

```text
Câu gốc + lịch sử liên quan + phạm vi được phép
    ↓
Chuẩn hóa kỹ thuật; giữ nguyên bản gốc và literal
    ↓
Truy hồi sơ bộ metadata/capability bằng câu gốc
    ↓
AI diễn giải yêu cầu dựa trên ngữ cảnh và ứng viên
    ↓
Validate interpretation; truy hồi bổ sung nếu cần, có giới hạn
    ↓
Đủ bằng chứng? ── Không → Hỏi lại / báo thiếu khả năng xử lý
    ↓ Có
Execution plan dùng định danh thật từ catalog
    ↓
Kiểm tra quyền, schema, điều kiện và tool arguments
    ↓
Thực thi → Trả lời dựa trên kết quả
```

Truy hồi sơ bộ giúp model thấy thuật ngữ thực tế trước khi diễn giải. Truy hồi bổ sung giúp khắc phục trường hợp câu gõ sai khiến lần đầu không tìm đủ ứng viên. Không để việc chọn schema bắt buộc phải thành công trước khi được hiểu câu hỏi.

### 4.1. Chuẩn hóa đầu vào

- Chuẩn hóa Unicode và khoảng trắng trên bản dùng để tìm kiếm; tạo biến thể không dấu nếu cần, không ghi đè câu gốc.
- Giữ nguyên giá trị literal và vị trí trong câu: tên, mã, email, URL, số, ngày, đoạn trích. Kết hợp bộ nhận diện tổng quát, model và metadata; regex không đủ để nhận diện mọi tên riêng.
- Fuzzy matching ở mức ký tự/token chỉ tạo ứng viên từ catalog hiện hành. Không tự thay tên riêng/mã định danh bằng ứng viên gần nhất.
- Lịch sử chỉ dùng phần liên quan; đánh dấu thông tin lấy từ lượt trước. Không mang bộ lọc cũ sang yêu cầu mới khi không có căn cứ.

### 4.2. Capability catalog động

Tổng hợp từ dictionary, quan hệ đã xác minh, nguồn tài liệu và tool registry:

- ID ổn định, loại tài nguyên, mô tả, input/output schema, quyền và phạm vi nguồn.
- Tên hiển thị, mô tả nghiệp vụ, glossary được quản trị và quan hệ giữa tài nguyên.
- Phiên bản metadata, phiên bản embedding và trạng thái index.

Metadata thiếu mô tả phải được báo chất lượng thấp; có thể tạo mô tả nháp từ schema nhưng không coi suy luận đó là nghiệp vụ đã xác minh. Không đọc dữ liệu nhạy cảm chỉ để làm giàu catalog.

Lọc quyền trước khi đưa ứng viên vào prompt; kiểm tra quyền lại trước thực thi. Search scope và cache không được mở rộng nguồn người dùng đã chọn.

### 4.3. Semantic retrieval chịu lỗi nhập liệu

- Kết hợp dense retrieval, lexical retrieval và fuzzy candidate retrieval; hợp nhất theo rank, không cộng trực tiếp các score khác thang đo.
- Dùng câu gốc cùng số lượng giới hạn truy vấn diễn giải. Bản diễn giải hỗ trợ tìm kiếm, không thay đổi giá trị filter được thực thi.
- Rerank ứng viên theo toàn bộ yêu cầu, bao gồm phủ định và điều kiện; vector similarity đơn thuần không chứng minh đúng ý định.
- Không dùng short-query/keyword gate để bỏ qua retrieval chỉ vì câu thiếu từ khóa quen thuộc.
- Với mã hoặc tên cần khớp chính xác, giữ nhánh exact lookup. Kết quả gần đúng chỉ là gợi ý nếu chưa xác định duy nhất.
- Reindex khi metadata hoặc embedding model thay đổi; không trộn vector khác model/dimension. Cache gắn phiên bản và phạm vi quyền.

### 4.4. Understanding contract chung

Đề xuất contract có phiên bản, được validate ở server:

```text
version
originalQuery
interpretedQuery
retrievalQueries[]
requestedOperations[]  // mô tả thao tác + capability ID hợp lệ nếu tìm được
resourceCandidates[]  // resource ID + bằng chứng liên quan
constraints[]         // giá trị gốc, operator, target ID nếu resolve được
literalSpans[]        // offset/value cần bảo toàn
contextReferences[]   // nguồn từ lượt hội thoại nào
ambiguities[]
decision              // proceed | clarify | unsupported
clarificationQuestion
catalogVersion
```

Chỉ `decision` và cấu trúc giao thức là enum cố định. Operations và resource IDs đến từ registry; adapter cho từng capability chuyển sang schema thực thi tương ứng. Không dùng field văn bản tự do làm SQL hoặc tên tool.

Mỗi constraint cần có nguồn: đoạn câu gốc, lượt trước hoặc default nghiệp vụ đã cấu hình. Điều kiện không có nguồn không được tự đưa vào execution plan. Giá trị confidence nếu có chỉ phục vụ đánh giá, không tự cấp quyền thực thi.

### 4.5. Routing và execution nhất quán

- Cùng contract đi qua schema selection, knowledge retrieval, request planner, prompt builder và local/remote harness.
- Hỗ trợ yêu cầu cần nhiều nguồn/capability; không ép mọi câu vào lựa chọn duy nhất giữa tài liệu và database.
- Tôn trọng `useTools`, nguồn được chọn và chế độ web hiện có. Hiểu ngữ nghĩa không tự bật quyền hoặc tính năng bị tắt.
- Thay các nhánh nghiệp vụ hiện có dần theo feature flag. Không chỉ sửa câu rồi đưa lại qua toàn bộ regex routing cũ.
- Clarification là kết quả hợp lệ, không bị completion repair ép chạy SQL. Phải hỏi lại được khi chưa biết root table; validator hiện tại kiểm tra root trước nhánh clarification nên cần điều chỉnh luồng này.
- Request planner/completion policy chỉ yêu cầu output khi đã có plan thực thi hợp lệ.

### 4.6. Xử lý lỗi và ngân sách

- Phân biệt lỗi hiểu ý, thiếu metadata, tool/schema không hợp lệ và lỗi hạ tầng.
- Repair nhận lỗi cụ thể cùng schema/candidate hiện hành; không yêu cầu model đoán lại không giới hạn.
- Mọi model/retrieval/repair call cùng dùng deadline, cancellation và ngân sách request. Cache chỉ tái sử dụng khi ngữ cảnh, catalog và phạm vi quyền tương thích.
- Khi embedding/reranker không khả dụng, dùng lexical/fuzzy và model theo cấu hình, đánh dấu degraded. Nếu vẫn thiếu căn cứ thì hỏi lại hoặc báo chưa xử lý được.
- Không âm thầm gửi dữ liệu sang cloud khi cấu hình chỉ cho local.
- Kết quả 0 dòng là hợp lệ; không sửa tên, bỏ phủ định hoặc nới bộ lọc để tạo kết quả.

## 5. Các giai đoạn triển khai

### P0 — Baseline và bản đồ tích hợp

- [ ] Trace các entry point chat, local/remote harness và Text2SQL độc lập để tránh luồng bỏ qua understanding.
- [ ] Lập danh sách gate/regex nghiệp vụ ảnh hưởng routing, schema selection và completion policy.
- [ ] Tạo tập câu chuẩn, biến thể lỗi và câu mơ hồ; gắn expected operation, nguồn, constraints và hành vi hỏi lại.
- [ ] Đo baseline đúng ý, chọn nguồn/tool, bảo toàn điều kiện, tool errors, latency và model calls.

Đầu ra: fixtures, evaluation report và vị trí tích hợp chính xác.

### P1 — Catalog và contract

- [ ] Tạo adapter catalog từ các registry/dictionary đang có; không sao chép catalog tĩnh vào code.
- [ ] Tạo schema validator cho understanding contract, provenance và literal preservation.
- [ ] Bổ sung quản lý metadata/index version, invalidation và lọc quyền.

Đầu ra: catalog dùng được cho lĩnh vực mới chỉ bằng metadata.

### P2 — Hiểu và truy hồi ở shadow mode

- [ ] Thêm service điều phối understanding và prompt tổng quát, dùng provider adapter hiện có.
- [ ] Mở rộng hybrid retrieval cho câu gốc, biến thể và fuzzy candidates; giới hạn fan-out.
- [ ] Chạy luồng mới để so sánh plan, chưa thực thi thêm tool và chưa đổi câu trả lời người dùng.
- [ ] Đánh giá lỗi sửa nhầm và điều chỉnh ngưỡng theo tập validation độc lập.

Đầu ra: báo cáo so sánh baseline/shadow và cấu hình rollout đề xuất.

### P3 — Tích hợp thực thi

- [ ] Truyền contract vào core, planner, schema/knowledge services và cả hai harness.
- [ ] Kiểm tra tương thích plan–tool–constraints trước thực thi.
- [ ] Sửa clarification lifecycle, bao gồm trường hợp chưa resolve được bảng.
- [ ] Thay thế các gate hard-code liên quan trong luồng mới; legacy chỉ dùng khi flag tắt.
- [ ] Kiểm thử các entry point và lựa chọn nguồn/quyền/chế độ hiện có.

Đầu ra: luồng đầy đủ bật được bằng cấu hình.

### P4 — Rollout và quan sát

- [ ] Bật theo nhóm cấu hình nhỏ; so sánh với baseline trước khi mở rộng.
- [ ] Trace quyết định, catalog version, candidate IDs, constraint provenance, failure category, latency và chi phí.
- [ ] Giảm thiểu/redact dữ liệu trong trace; không lưu bí mật hoặc toàn bộ nội dung riêng tư mặc định.
- [ ] Chuẩn bị rollback feature flag; dữ liệu index/version vẫn tương thích với luồng cũ.
- [ ] Khi ổn định, gỡ các nhánh nghiệp vụ cũ đã được thay thế.

## 6. Phạm vi file dự kiến

Tên module mới là đề xuất, xác nhận lại sau P0:

| File/module | Vai trò |
| --- | --- |
| `services/query_understanding_service.js` (mới) | Điều phối diễn giải, retrieval bổ sung, quyết định hỏi lại |
| `services/capability_catalog_service.js` (mới) | Catalog động và phạm vi truy cập |
| `services/query_understanding_validator.js` (mới) | Contract, provenance, literals và ID hợp lệ |
| `intelligent_core/core.js` | Gắn luồng mới trước routing cuối cùng |
| `intelligent_core/schema_context_service.js` | Dùng ứng viên semantic, giảm gate lexical |
| `intelligent_core/knowledge_intent.js` | Loại khỏi vai trò gate duy nhất khi flag bật |
| `knowledge_core/services/retrieval_service.js` | Tái sử dụng fusion/rerank, truy vấn bổ sung có giới hạn |
| `training_core/request_planner.js` | Nhận understanding đã validate |
| `agent_core/harness/*` | Dùng contract chung, clarification và budget |
| `services/data_intent_service.js` | Adapter data plan và clarification không phụ thuộc root table |
| `services/text2sql_agent.js` | Tích hợp nếu entry point này còn độc lập |
| `tests/` và `scripts/evaluate_*.js` | Regression, fault injection và evaluation live |

Không thay cấu hình Postgres hoặc provider credentials chỉ để thực hiện tính năng này. Tái sử dụng hạ tầng hiện có; migration chỉ đề xuất nếu P0 chứng minh cần lưu metadata mới.

## 7. Kiểm thử và tiêu chí nghiệm thu

### Bộ dữ liệu

- Nhiều lĩnh vực độc lập; có lĩnh vực chỉ xuất hiện ở tập test và được nạp bằng metadata.
- Biến thể thiếu/thừa/đảo ký tự, thiếu dấu, lặp từ, thiếu từ, viết tắt, paraphrase và follow-up.
- Câu đúng nhưng gần một thuật ngữ khác, tên riêng hiếm, mã khác nhau một ký tự, số/ngày, phủ định và điều kiện kết hợp.
- Câu không đủ thông tin, nhiều nguồn cùng tên, metadata thiếu và tool không hỗ trợ yêu cầu.
- Đổi tên bảng/tool và thêm capability qua registry để chứng minh không phụ thuộc tên cụ thể.
- Dùng cả ví dụ thực tế đã làm sạch và biến thể sinh tự động được rà soát. Không mặc định câu bị xóa từ vẫn giữ nguyên nhãn, nhất là xóa phủ định.

### Kiểm tra

- Unit: contract, literal/provenance validation, fusion, scope và cache invalidation.
- Integration: typo → hiểu → chọn nguồn → plan → đúng tool/arguments; clarification không thực thi tool nghiệp vụ.
- Regression: câu gốc đúng vẫn đúng, không thêm bộ lọc, không làm mất constraint.
- Fault injection: embedding/reranker/model timeout, JSON sai schema, stale index, hết budget và hủy request.
- Live evaluation riêng cho các provider được triển khai. Mock test chứng minh plumbing, không chứng minh model hiểu ngôn ngữ.
- Dùng các lệnh evaluation/test hiện có phù hợp; bổ sung evaluator understanding, không thay toàn bộ bộ kiểm thử.

### Điều kiện phát hành

- Tỷ lệ hoàn thành đúng yêu cầu trên nhóm typo/paraphrase tăng so với baseline; báo riêng từng nhóm lỗi/provider/lĩnh vực.
- Không có hồi quy trên tập regression quan trọng: literals, phủ định, phạm vi quyền và hỏi lại.
- Câu chuẩn không bị giảm chất lượng quá ngưỡng cho phép đã chốt từ P0.
- Lĩnh vực holdout chạy được bằng thay metadata, không đổi code hoặc prompt nghiệp vụ.
- Latency p95, model calls và chi phí nằm trong ngân sách được chốt sau baseline.
- Ngưỡng chất lượng định lượng được ghi vào cấu hình evaluation trước rollout, không điều chỉnh theo tập test để đạt kết quả đẹp.

## 8. Definition of Done

- [ ] Câu gõ sai có thể đi hết luồng đến kết quả đúng, không chỉ tạo câu viết lại đẹp hơn.
- [ ] Toàn bộ bước quyết định dùng cùng interpretation đã kiểm tra.
- [ ] Không bổ sung hard-code nghiệp vụ, typo map hoặc tên bảng/tool trong runtime.
- [ ] Thêm domain/capability bằng metadata được chứng minh qua test holdout.
- [ ] Có báo cáo baseline và kết quả mới, tách rõ lỗi retrieval, understanding và execution.
- [ ] Có degraded mode, giới hạn budget, trace phù hợp và rollback flag.
- [ ] Tài liệu cấu hình và vận hành được cập nhật sau khi triển khai.
