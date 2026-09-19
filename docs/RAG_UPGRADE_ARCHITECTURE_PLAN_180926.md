# Kế hoạch nâng cấp kiến trúc RAG — KnowledgeHub AI

> Phân tích dựa trên đọc trực tiếp mã nguồn ngày 18/09/2026:
> `src/backend/knowledge_core/services/retrieval_service.js`,
> `src/backend/services/qdrant_service.js`,
> `src/backend/knowledge_core/services/library_service.js` (chunking, extractText),
> `src/backend/intelligent_core/core.js` (lắp ngữ cảnh vào prompt).
> Rà soát bổ sung ngày 19/09/2026. Đây là đánh giá tĩnh trên mã nguồn trong working tree,
> chưa xác nhận cấu hình dịch vụ đang chạy hoặc chất lượng retrieval live. Các thay đổi
> dưới đây ban đầu là đề xuất. Các hạng mục nền tảng đã triển khai ngày 20/09/2026 được
> ghi tại mục 4.4; các hạng mục chưa đạt gate vẫn giữ trạng thái chờ.
>
> Rà soát bổ sung ngày 20/09/2026: thêm mục 3.9 — trích dẫn nguồn (citation) cụ thể theo
> đoạn/chunk trong câu trả lời. Xác nhận trong `core.js` (dòng 264-269) hệ thống hiện chỉ
> yêu cầu model "nêu tên tài liệu nguồn", không yêu cầu nêu đoạn/chunk cụ thể; và frontend
> (`page_chat.js`) chưa có bất kỳ cơ chế hiển thị citation nào trong bong bóng chat.

Kế hoạch này chi tiết hóa C2/C3/C4 và D3 của
[NEXT_STEPS_PLAN_180926.md](NEXT_STEPS_PLAN_180926.md). Graph tài liệu ở đây khác graph
quan hệ SQL trong [plan JOIN](SQL_RELATIONSHIP_JOIN_PLAN_190926.md). Không đưa ảnh chat
tạm thời vào Library; [plan đọc ảnh](CHAT_IMAGE_UNDERSTANDING_PLAN_180926.md) có vòng đời
riêng. Dùng chung gate quyền A4, backup B3a và kiểm thử outbox B4 của kế hoạch tổng.

**Hướng triển khai đã chốt:** Qdrant là nơi tìm kiếm RAG chính, lưu vector và payload
chunk. PostgreSQL tiếp tục lưu metadata tài liệu, quyền, revision đang phục vụ và job;
không đưa text/chunk vào PostgreSQL chỉ để nâng cấp RAG. PostgreSQL FTS là phương án
tùy chọn sau đo lường, không phải điều kiện của parent-child, cache hoặc query rewrite.

## 1. Sơ đồ luồng RAG hiện tại (as-is)

```
Câu hỏi người dùng
   │
   ├─► buildCorpus(documentIds) ── đọc document thuộc danh sách được truyền vào, chunk lại
   │                                bằng chunkText() (paragraph-aware, 2200 ký tự,
   │                                overlap 250) — thực hiện MỖI LẦN gọi search();
   │                                danh sách rỗng hiện có nghĩa là toàn Library
   │
   ├─► qdrantService.searchDocuments() ── dense vector search trên collection
   │                                        'knowledge_documents', KHÔNG có filter
   │                                        documentId ở tầng Qdrant (lọc phía JS
   │                                        sau khi lấy top-K)
   │
   ├─► bm25(query, corpus) ── BM25 tự viết bằng JS, tính lại idf/tf trên
   │                            TOÀN BỘ corpus mỗi query, không có index bền
   │
   ├─► graphSearch(query, corpus) ── chỉ chạy khi regex từ khoá tiếng Việt không
   │                                   dấu khớp; "entity" = cụm từ viết hoa liên
   │                                   tiếp (regex), không có graph lưu trữ thật
   │
   ├─► fuse() ── Reciprocal Rank Fusion 3 nguồn trên
   │
   ├─► rerank() ── gọi HTTP tới BGE reranker nếu RERANKER_ENABLED=true
   │                (mặc định false)
   │
   └─► core.js ── join các chunk theo điểm, CẮT CỨNG bằng .slice(0, 12000) ký tự
                    (AI_DOCUMENT_CONTEXT_CHARS), không theo ranh giới chunk
```

## 2. Điểm yếu cụ thể đã xác nhận trong code (không phải suy đoán)

| # | Vấn đề | Vị trí | Vì sao ảnh hưởng độ chính xác/khả năng mở rộng |
|---|---|---|---|
| R1 | `buildCorpus()` đọc và chunk lại tài liệu thuộc phạm vi truyền vào; mảng rỗng mở toàn Library | `retrieval_service.js`, `buildCorpus` | Công việc tăng theo tổng lượng text trong scope mỗi query; chưa có contract phân biệt không chọn tài liệu với không có quyền |
| R2 | BM25 tính lại idf/tf trên toàn corpus mỗi query, không có index bền | `retrieval_service.js:45-65` | Cần tránh dựng lại lexical index mỗi query; chưa đủ bằng chứng để quyết định thay bằng PostgreSQL FTS |
| R3 | Lọc theo `documentIds` (phạm vi tài liệu người dùng chọn) thực hiện **sau khi** lấy top-K từ Qdrant, không phải filter tại Qdrant | `retrieval_service.js:118-121`, `qdrant_service.js:357-368` (`searchDocuments` không nhận filter) | Nếu tài liệu đúng phạm vi không lọt vào top-K toàn cục (candidateLimit=30 mặc định), kết quả đúng phạm vi có thể bị bỏ sót hoàn toàn dù tồn tại trong Qdrant |
| R4 | GraphRAG: "entity" = regex cụm từ viết hoa liên tiếp; không có graph lưu trữ, không có quan hệ có kiểu (typed relation), không multi-hop | `retrieval_service.js:67-81` | Dễ bỏ sót entity viết thường/tiếng Việt không viết hoa theo quy tắc tiếng Anh; dễ bắt nhầm (danh từ riêng ngẫu nhiên đầu câu); không trả lời được câu hỏi cần suy luận nhiều bước qua quan hệ |
| R5 | Cắt ngữ cảnh cuối cùng bằng `.slice(0, 12000)` ký tự trên chuỗi đã join, không theo ranh giới chunk | `core.js:237` | Có thể cắt giữa câu/giữa đoạn của chunk cuối cùng, đưa vào prompt một đoạn văn bản dở dang gây model hiểu sai; ngưỡng theo ký tự chứ không theo token nên không khớp chính xác với giới hạn ngữ cảnh model |
| R6 | Document collection chưa có payload index cho các trường lọc | `qdrant_service.js`, `ensureDocumentCollection` | Thiếu index có thể làm filtered search kém hiệu quả; không kết luận mọi query đều quét toàn bộ payload, cần đo theo filter và kích thước collection |
| R7 | Reranker gửi toàn bộ `fullText` của mọi candidate (tối đa 2200 ký tự × 30 candidate) mà không giới hạn tổng độ dài | `retrieval_service.js:100-103` | Có thể vượt giới hạn ngữ cảnh của reranker model, hoặc làm chậm đáng kể một bước vốn cần nhanh |
| R8 | Không có bước biến đổi câu hỏi (query rewrite/expansion) trước khi embed | toàn bộ `search()` | Câu hỏi ngắn/mơ hồ/viết tắt sẽ embed trực tiếp, giảm recall của tầng dense so với khi có câu hỏi được viết lại rõ nghĩa hơn |
| R9 | Không có cache cho embedding của câu hỏi lặp lại | `qdrant_service.js:100-121`, `357-368` | Mỗi câu hỏi trùng lặp (ví dụ câu hỏi phổ biến) đều gọi lại embedding model, tốn thời gian không cần thiết |
| R10 | Lexical chunk lại từ file, dense dùng payload đã index; chưa có contract chunk/revision thống nhất | library/retrieval services, Qdrant | Cần dùng chung chunk ID/revision và bản chunk tạo khi ingest; không bắt buộc có bảng chunk PostgreSQL |
| R11 | Eval hiện ghi `recallAtK = số câu có ít nhất một hit / số câu` | `scripts/evaluate_retrieval.js` | Thực chất là HitRate@K; với nhiều tài liệu đúng, chưa đo mức bao phủ đáp án; chunk cùng document có thể chiếm nhiều vị trí |
| R12 | `embedTexts` có deterministic fallback khi cấu hình cho phép; index hiện xóa chunk cũ trước khi upsert mới | `qdrant_service.js`, `embedTexts/indexDocumentChunks` | Có thể trộn hai không gian vector hoặc mất kết quả trong lúc reindex; cần version, trạng thái và cách chuyển revision |
| R13 | Context gửi model đã có nhãn `[Tài liệu N: title · đoạn K]` cho từng chunk, nhưng chỉ thị hệ thống chỉ yêu cầu "nêu tên tài liệu nguồn", không yêu cầu nêu đoạn K; frontend không hiển thị citation nào trong câu trả lời | `core.js:264-269` (chỉ thị), `page_chat.js` (không có UI citation) | Người dùng không thể tự kiểm tra câu trả lời lấy từ đoạn nào trong tài liệu; không phân biệt được "model tóm tắt đúng" với "model bịa nhưng nêu đúng tên tài liệu" |

## 3. Kiến trúc đề xuất (target architecture)

### 3.1. Giữ Qdrant làm nơi tìm kiếm chính, đo nhu cầu lexical trước khi thay

Luồng mặc định mục tiêu: resolve quyền/scope → embed query → Qdrant filtered search →
kiểm tra revision/quyền → rerank nếu bật → đóng gói evidence theo budget → trả lời/citation.
Đo dense-only đã sửa filter so với hybrid hiện tại trên cùng snapshot; không tự bỏ lexical
nếu làm giảm recall mã hợp đồng, từ viết tắt hoặc truy vấn từ khóa chính xác.

- Trước mắt sửa filter/budget/reranker, giữ nhánh lexical hiện tại để so baseline. Sau đó
  chunk một lần khi ingest và lưu manifest theo revision bên cạnh file text; Qdrant giữ
  fullText cùng identity/revision/offset trong payload để phục vụ retrieval.
- Nếu lexical vẫn cần: thử giữ BM25 index trong bộ nhớ, dựng từ manifest và cập nhật khi
  ingest/delete/đổi revision, không dựng lại mỗi query. Cache/index phải có giới hạn RAM,
  version và cơ chế kiểm tra thay đổi giữa các process; cold start dựng lại có trạng thái
  rõ ràng. Lọc quyền trước top-K; thống kê corpus theo scope nếu cần giữ nghĩa điểm baseline.
- Nếu Qdrant dense-only đạt gate chất lượng thì có thể tắt BM25 và graph regex trên đường
  phục vụ. Nếu chưa đạt, giữ hybrid đã tối ưu; quyết định bằng số liệu, không ép dense-only.
- Nếu BM25 trong bộ nhớ không đạt budget ở quy mô thật, mở thử nghiệm lexical/sparse
  ngay trên Qdrant trước; kiểm tra API/version, model/tokenizer và cách tạo sparse vector
  lúc triển khai. Không mặc định payload text filter là BM25 hoặc code hiện tại đã có hybrid.
- Giữ chuẩn hóa query/index cùng version; test tiếng Việt có/không dấu, `đ/d`, mã và phủ
  định. Giữ text gốc để trích dẫn. Khi fuse các nhánh dùng thứ hạng RRF, không cộng trực
  tiếp điểm lexical và cosine.
- Graph regex không được tiếp tục dựng toàn corpus ở mỗi query sau RAG-4: tắt theo flag
  hoặc chỉ chạy trên candidate giới hạn đã lọc scope, rồi đo lại chất lượng.

**PostgreSQL FTS — phương án dự phòng ngoài đường triển khai mặc định:** chỉ mở khi báo
cáo cho thấy các phương án trên chưa đạt chất lượng/chi phí vận hành và có quyết định
thiết kế riêng. Khi đó mới đề xuất bảng chunk, GIN/tsvector, backfill, đồng bộ revision và
rollback; so shadow với baseline trước khi chuyển. `ts_rank_cd` là cover-density ranking,
không phải BM25 ([tài liệu PostgreSQL](https://www.postgresql.org/docs/17/textsearch-controls.html)).
Không tạo `app.document_chunks` hoặc FTS migration trong phạm vi mặc định của plan này.

### 3.2. Filter theo document scope ngay tại Qdrant

Backend resolve scope từ quyền hiện tại và lựa chọn người dùng, rồi truyền cùng scope
cho dense, lexical, graph, parent expansion và citation. Lựa chọn tài liệu không cấp quyền.

- Contract phân biệt `scopeMode=all_authorized`, `selected`, `none`; danh sách effective
  rỗng trả rỗng, tuyệt đối không bỏ filter để mở rộng Library. Document ID giả/ngoài quyền
  không được truy xuất. Áp cho chat, embed, tools và evaluator qua entrypoint chung.
- Qdrant nhận filter document ID đã resolve **trước top-K**, kết hợp revision/type và
  scope cần thiết. Giữ kiểm tra quyền/trạng thái từ storage trước reranker/prompt như
  lớp bảo vệ khi payload ACL hoặc index cập nhật chậm; không gửi candidate trái quyền
  sang dịch vụ rerank. Scope lớn phải có thiết kế payload ACL/index hoặc batch có giới
  hạn và phép hợp nhất đúng, không âm thầm cắt danh sách document.
- Tạo payload index idempotent cả collection mới lẫn hiện hữu, trước ingest khi có thể;
  ưu tiên trường thực sự lọc, kiểu khớp payload. Index không thay thế kiểm tra quyền.
  Đo lại collection hiện hữu và ghi rõ version Qdrant/chiến lược rebuild nếu cần.
  [Tài liệu Qdrant về indexing](https://qdrant.tech/documentation/manage-data/indexing/).

### 3.3. Chunking: chuyển sang chiến lược "small-to-big" (parent-child)

Hiện tại một chunk vừa dùng để tính điểm liên quan, vừa là toàn bộ nội dung đưa vào prompt
(2200 ký tự). Đề xuất tách hai vai trò:
- **Chunk nhỏ** dùng để embed/rank; 400–600 ký tự chỉ là một cấu hình thử, không bảo đảm
  chính xác hơn. Thử nhiều kích thước theo token/đoạn, giữ tiêu đề và cấu trúc bảng.
- **Chunk cha (đoạn/section gốc)** được trả về làm ngữ cảnh thật đưa vào prompt khi chunk
  con đó được chọn.

Lưu `parentChunkId` và offset trong Qdrant payload; lưu parent text trong manifest chunk
theo revision bên cạnh file text đã extract, không cần bảng chunk PostgreSQL. Backend
resolve đường dẫn từ metadata tin cậy, không nhận đường dẫn file do client cung cấp.
Rerank child trước, đọc parent cùng revision/scope từ manifest sau;
dedupe parent khi nhiều child cùng trỏ đến, giữ vị trí child làm bằng chứng trích dẫn.
Giới hạn kích thước parent; parent quá lớn thì lấy đoạn con/đoạn lân cận nguyên vẹn có
offset rõ ràng. Không lấy toàn section vô hạn hoặc trộn cha cũ với con mới.

### 3.4. Ngân sách ngữ cảnh theo chunk, không cắt ký tự thô

Thay `.slice(0, N)` sau khi join, duyệt danh sách chunk đã rerank theo thứ tự điểm, cộng dồn
độ dài (ước lượng theo token, không phải ký tự) và **dừng ở ranh giới chunk** — chunk nào
làm vượt ngân sách thì bỏ nguyên chunk đó, không cắt giữa chừng. Khắc phục R5.

Budget tính sau khi trừ system prompt, lịch sử/memory, schema SQL, tools, output reserve
và safety margin của provider thực tế. Dùng chung context budget hiện có ở agent harness,
không tạo riêng một con số cho RAG rồi cộng vượt cửa sổ model. Nếu một chunk quá lớn,
thử chunk nhỏ hơn kế tiếp; không dừng sớm làm bỏ các chunk còn vừa. Giữ citation marker
đi cùng evidence; provider fallback có cửa sổ khác phải đóng gói lại hoặc báo không đủ.
Token estimator phải ghi rõ là ước lượng; ưu tiên tokenizer đúng model nếu khả dụng.

### 3.5. GraphRAG: xây dựng graph thật thay vì regex tại thời điểm truy vấn

Thay vì trích entity bằng regex mỗi lần query, tách thành pipeline offline:
1. Khi tài liệu được ingest, chạy một bước trích xuất entity/relation bằng chính LLM cục bộ
   đang dùng cho chat (few-shot prompt yêu cầu JSON `{entities, relations}`).
2. Chỉ sau khi thử nghiệm chứng minh lợi ích mới chọn nơi lưu entity/relation bền vững.
   Bảng PostgreSQL là một phương án trong thiết kế graph riêng, không phải phần bắt buộc
   của RAG Qdrant hoặc lý do tạo bảng chunk/FTS.
3. `graphSearch()` truy vấn quan hệ đã trích, giới hạn số hop/fan-out và trả về evidence;
   chưa chốt backend graph trước khi có nhu cầu được đo.

Chỉ là thử nghiệm sau baseline: extraction dùng job outbox riêng, có retry/idempotency,
không chặn trạng thái sẵn sàng của dense/lexical. Node/cạnh cần scope, kiểu, revision và
evidence chunk/offset; không hợp nhất entity chỉ vì cùng tên, không coi cạnh do LLM trích
là sự thật đã xác minh. Mọi hop và evidence phải thuộc quyền đọc; giới hạn hop/fan-out,
xóa hoặc vô hiệu hóa cạnh khi tài liệu bị xóa/đổi. Câu trả lời phải truy được về văn bản
nguồn, không chỉ dựa vào đường graph. Không dùng graph này để tự tạo quan hệ SQL.

Đây là việc tốn công nhất trong kế hoạch này — nên làm sau khi đã có golden set để đo được
graph có thực sự cải thiện câu trả lời quan hệ/tổng hợp hay không (tránh xây một hệ thống
phức tạp mà không đo được lợi ích).

### 3.6. Query transformation trước khi retrieval

Thử tối đa 1–2 biến thể khi thiếu ngữ cảnh/tham chiếu hội thoại hoặc baseline recall thấp;
câu ngắn như mã hợp đồng có thể đã rõ, nên độ dài không phải tiêu chí duy nhất. Giữ query
gốc, ID/số/ngày tháng và phủ định; chỉ dùng lịch sử được phép theo memory policy. Rewrite
không đổi scope. Fan-out có tổng budget/timeout, dedupe cùng chunk trước fuse để không
tăng điểm chỉ do lặp biến thể; timeout thì dùng query gốc và ghi trạng thái suy giảm.

### 3.7. Cache embedding câu hỏi

Thêm LRU có TTL, giới hạn số entry/byte và gộp request trùng đang chạy. Key gồm hash input
thực sự gửi embed, endpoint/provider, model revision, dimension và preprocessing version;
phân vùng account/tenant theo chính sách dữ liệu. Không cache lỗi hoặc deterministic
fallback như vector model thật. Cache vector khác cache kết quả retrieval: nếu cache kết
quả phải thêm scope quyền, revision corpus và cấu hình retrieval; revoke quyền phải có
hiệu lực ngay. Không ghi query nhạy cảm vào log cache. Cache tài liệu khi reingest theo
content hash là tối ưu riêng, không giả định tài liệu không bao giờ lặp lại.

### 3.8. Vòng đời chunk và index trên hạ tầng hiện có

- Chunk một lần ở ingest; manifest theo revision lưu text, chunk ID, thứ tự/offset và
  parent khi cần, từ đó tạo Qdrant payload và lexical index nếu bật. PostgreSQL chỉ lưu
  metadata về revision đang phục vụ, vị trí manifest, model/dimension/chunker version,
  trạng thái index và job; có thể cần mở rộng metadata nhưng không lưu bản sao text/chunk.
- Manifest là artifact dẫn xuất có checksum, ghi file tạm rồi publish hoàn chỉnh; giữ
  nguồn gốc để dựng lại. Qdrant giữ vector/fullText/chunk identity cho truy vấn. Không
  scroll toàn bộ Qdrant hoặc đọc tất cả manifest mỗi lần search để thay `buildCorpus`.
- Tạo revision mới ở trạng thái staging, upsert với ID xác định để retry không trùng.
  Chỉ chuyển active sau khi các nhánh bắt buộc hoàn tất; lookup candidate phải khớp
  active revision. Qdrant/PG không có transaction chung: cần retry/reconciliation, xử lý
  candidate stale và bù top-K có giới hạn trong lúc chuyển, không tuyên bố atomic toàn hệ.
- Giữ revision cũ còn hợp lệ trong lúc build, dọn sau chuyển thành công. Xóa tài liệu hoặc
  revoke quyền thì chặn đọc ngay tại storage; job xóa index có thể chạy sau và phải retry.
- Backfill theo batch có checkpoint, báo missing/failed, giới hạn tải; thử kill/restart như
  B4. Backup/restore B3a bao phủ metadata/job PostgreSQL, file nguồn/text/manifest và
  snapshot Qdrant hoặc quy trình reindex đã thử; không chỉ backup metadata rồi coi đủ.
- Đổi embedding model/dimension/chunker dùng collection/version mới và reindex; không
  trộn vector deterministic với vector semantic dù cùng dimension. Chỉ fallback lỗi dense
  sang lexical nếu nhánh này đã được triển khai, sẵn sàng và cùng scope/revision, báo
  `degraded`; nếu chỉ có Qdrant thì báo dịch vụ truy xuất chưa sẵn sàng, không bịa kết quả.
- Contract kết quả dự kiến gồm document/chunk/revision, evidence offset, nguồn retrieval,
  scope revision và trạng thái degraded. Citation chỉ tham chiếu evidence thực sự vào
  prompt; thiếu chứng cứ thì trả lời không đủ thông tin. Nội dung tài liệu là dữ liệu,
  không được nâng thành chỉ thị gọi tool hay mở rộng quyền.

### 3.9. Trích dẫn nguồn theo đoạn/chunk trong câu trả lời (citation)

Khắc phục R13. Mục tiêu: người đọc câu trả lời phải tự kiểm tra được thông tin lấy từ tài
liệu nào, đoạn nào — không chỉ tin vào tên tài liệu do model tự nêu bằng lời.

**Vì sao không dùng JSON có cấu trúc cho toàn bộ câu trả lời:** model cục bộ (local model)
có độ tin cậy tuân theo format thấp hơn model lớn; bắt buộc toàn bộ câu trả lời ở dạng JSON
có rủi ro hỏng format, làm hại trải nghiệm đọc. Đề xuất dùng **marker số nội tuyến**, tận
dụng đúng số thứ tự đã có sẵn trong context (`Tài liệu N`), không cần model tự sinh tên
tài liệu hay số đoạn:

- **Chỉ thị hệ thống (`core.js`):** thay yêu cầu "phải nêu tên tài liệu nguồn" bằng yêu cầu
  cụ thể hơn: sau mỗi câu/đoạn lấy thông tin từ nguồn, chèn marker `[N]` đúng bằng số thứ
  tự `Tài liệu N` tương ứng đã có trong context; nếu một câu tổng hợp từ nhiều tài liệu,
  chèn nhiều marker liền nhau `[N][M]`. Không yêu cầu model tự gõ lại tên tài liệu hay số
  đoạn bằng chữ — số đã có sẵn, model chỉ cần chọn đúng số.
- **Backend xử lý sau khi model trả lời:** quét toàn bộ marker `[N]` trong câu trả lời,
  đối chiếu N với danh sách `relevant` (kết quả retrieval đã dùng cho lượt này). Trả về
  cùng response một mảng `citations: [{ marker: N, title, chunkIndex, documentId }]` để
  frontend render, **không** để model tự mô tả nguồn bằng lời tự do.
- **Kiểm tra hợp lệ (bắt buộc, chống bịa citation):** marker có N nằm ngoài phạm vi số
  lượng tài liệu đã đưa vào context (ví dụ context chỉ có 4 tài liệu nhưng model chèn
  `[7]`) phải bị loại khỏi phần hiển thị citation và ghi nhận vào metric riêng
  (`invalid_citation_index`) — không hiển thị nhầm, không throw lỗi làm hỏng câu trả lời.
  Việc kiểm tra "câu có marker N có thực sự khớp nội dung đoạn N hay không" là bài toán
  khó hơn (cần NLP/verification riêng), **không** thuộc phạm vi MVP; MVP chỉ đảm bảo
  marker trỏ đúng tài liệu có tồn tại trong context đã dùng, không đảm bảo model diễn giải
  đúng 100% nội dung đoạn đó.
- **Frontend (`page_chat.js`):** hiển thị marker `[N]` trong câu trả lời dưới dạng số nhỏ
  (superscript/badge) khác màu với text thường; dưới câu trả lời hiển thị danh sách nguồn
  dạng chú thích: `[1] Tên tài liệu — đoạn 3`, `[2] Tên tài liệu khác — đoạn 1`. MVP không
  cần điều hướng tới đúng vị trí trong tài liệu gốc (đó là cải tiến sau); có danh sách rõ
  ràng đã là cải thiện lớn so với hiện trạng (không có gì cả).
- **Trường hợp không có citation:** nếu câu trả lời dùng `documentContext` nhưng không có
  marker `[N]` nào, ghi nhận vào metric `missing_citation_rate` — đây là tín hiệu chỉ thị
  hệ thống chưa đủ mạnh hoặc model bỏ qua yêu cầu, không phải lỗi cứng chặn câu trả lời
  (không nên chặn trả lời chỉ vì thiếu citation, tránh làm giảm tính khả dụng).
- **Không áp dụng cho SQL/schema hoặc web search** trong phạm vi mục này — đó là nguồn dữ
  liệu khác cơ chế (SQL đã có bảng/cột hiển thị riêng, web search đã có URL nêu trong chỉ
  thị dòng 305-306 của `core.js`); phạm vi 3.9 chỉ áp dụng cho nhánh RAG tài liệu doanh
  nghiệp (`documentContext`).

**Phụ thuộc:** cần RAG-2 (ngân sách theo chunk, không cắt ký tự thô) hoàn thành trước, vì
nếu chunk cuối bị cắt giữa chừng, số `Tài liệu N` hiển thị cho model có thể không khớp với
nội dung thật đã bị cắt — citation trỏ đúng số nhưng nội dung sau lưng marker đã sai lệch.

## 4. Lộ trình theo giai đoạn

| Giai đoạn | Nội dung | Ưu tiên | Điều kiện tiên quyết |
|---|---|---|---|
| RAG-0 | Baseline, sửa metric evaluator, contract scope và thiết kế revision/chunk | Nền tảng | C2 và A4; prototype có thể dùng fixture quyền giả lập |
| RAG-1 | R3 + R6: filter scope tại Qdrant, thêm payload index và kiểm tra quyền mọi nhánh | Cao | Contract scope RAG-0; gate A4 trước phát hành nhiều người dùng |
| RAG-2 | R5: ngân sách ngữ cảnh theo chunk thay vì cắt ký tự | P0 | Không |
| RAG-2b | 3.9: citation marker `[N]` — sửa chỉ thị hệ thống, kiểm tra hợp lệ backend, hiển thị frontend | P0 | RAG-2 (chunk không bị cắt giữa chừng trước khi đánh số) |
| RAG-3 | R7: giới hạn tổng độ dài gửi reranker, log khi vượt | P0 | Không |
| RAG-4 | 3.8 + 3.1: manifest/revision, Qdrant reindex có kiểm soát; bỏ rechunk mỗi query, đo dense-only so hybrid và tối ưu lexical nếu cần | P1 | RAG-0/1, fixture thật, outbox/reconciliation; không phụ thuộc bảng chunk/FTS PostgreSQL |
| RAG-5 | 3.3: thử chunking small-to-big (parent-child) | P1 | Manifest/revision và payload Qdrant ở RAG-4, bộ eval C2; không cần PostgreSQL FTS |
| RAG-6 | 3.7: cache embedding câu hỏi | P1 | Không |
| RAG-7 | 3.6: query rewrite/expansion có điều kiện | P2 | Baseline retrieval ổn định và scope/budget; không bắt buộc bật RAG-5 |
| RAG-8 | 3.5: thử graph có evidence, chọn storage trong thiết kế riêng nếu hiệu quả | P2, tùy chọn | RAG-4; C4 chứng minh thiếu evidence quan hệ và thử nghiệm cải thiện retrieval/answer, router sai đơn thuần chưa đủ |

**Nguyên tắc xuyên suốt:** mọi thay đổi RAG-1 trở đi phải chạy qua bộ eval retrieval
(`npm run eval:retrieval`, sau khi đã điền dữ liệu thật theo `NEXT_STEPS_PLAN_180926.md`
mục C2) **trước và sau** khi đổi, để biết thay đổi có thực sự cải thiện Recall@K/MRR hay
không — tránh lặp lại tình trạng hiện tại là có nhiều cơ chế (reranker, GraphRAG) đã viết
nhưng chưa có số liệu để biết nên bật hay không.

Ưu tiên: RAG-0 → RAG-1/2/3 → RAG-4; RAG-6 có thể làm sớm sau khi chốt embedding identity.
RAG-5/7/8 là thử nghiệm độc lập trên baseline ổn định, không gộp bật cùng lúc. RAG-7 không
bắt buộc parent-child được chấp nhận. Các mức P0 trong bảng là ưu tiên nội bộ RAG, không
thay gate bảo mật trong plan tổng. Thử nghiệm local có thể song song C6 JOIN/C7 ảnh.

Điểm hoàn thành bản nâng cấp nền tảng: RAG-0–4 đạt gate trên Qdrant và hạ tầng metadata
hiện có. Không chờ triển khai FTS, parent-child hoặc persistent graph mới nghiệm thu.

### 4.1. Giới hạn reranker và hành vi lỗi

Giới hạn số candidate, token của từng cặp query/document theo model, tổng byte payload,
concurrency và deadline toàn request. Không chỉ giới hạn tổng ký tự. Map index kết quả về
candidate gốc; kiểm tra index nguyên/hợp lệ/không trùng và score hữu hạn. Khi lỗi, kết quả
thiếu hoặc timeout, fallback RRF đã lọc quyền theo chính sách rõ ràng, ghi degraded; không
để lỗi một dịch vụ làm mở rộng scope. Log kích thước/thời gian/mã lỗi, không fullText.

### 4.2. Bộ đo và gate nghiệm thu

- Sửa evaluator trước khi dùng làm gate: giữ metric hiện tại dưới tên **HitRate@K**.
  Document Recall@K = số document đúng khác nhau tìm được / tổng document đúng của case,
  rồi macro-average; dedupe document trước tính document MRR. Chunk Recall/MRR là phép
  đo riêng, phải có nhãn chunk/evidence và revision. Không so số mới với nhãn cũ như cùng metric.
- Bổ sung ít nhất 30 câu hỏi có đáp án evidence trên snapshot cố định: tiếng Việt có/không
  dấu, mã chính xác, nhiều tài liệu cần kết hợp, scope hẹp, không có đáp án và tài liệu mới
  cập nhật. Holdout tách khỏi tuning/prompt. Case no-answer không chia Recall cho 0; chấm
  riêng khả năng không bịa câu trả lời. Fixture không tồn tại/placeholder làm eval thất bại.
- Thêm trường scope/quyền cho evaluator và kiểm thử: không có quyền, document ID giả,
  revoke trong lúc xử lý, parent/citation ngoài scope, deleted/stale revision, batch scope
  lớn. Tất cả case quyền phải không lộ nội dung, tiêu đề hoặc citation trái quyền.
- Đánh giá cả truy xuất và câu trả lời: HitRate, Recall, MRR, mức bao phủ bằng chứng, câu
  trả lời sai tự tin, p50/p95 từng bước, RAM và chi phí ingest/reindex. Dedupe/parent
  expansion không được làm biến mất bằng chứng cần thiết của nhiều tài liệu.
- **Độ đúng citation** (theo thiết kế 3.9), đo trên cùng bộ 30+ case ở trên: (a)
  `invalid_citation_index_rate` — tỷ lệ marker `[N]` trỏ ra ngoài phạm vi tài liệu đã dùng;
  (b) `missing_citation_rate` — tỷ lệ câu trả lời có dùng `documentContext` nhưng không có
  marker nào; (c) tỷ lệ câu trả lời có ít nhất 1 citation hợp lệ trên tổng câu trả lời có
  dùng RAG. Không cần (chưa có công cụ) đo "citation có khớp ngữ nghĩa với đoạn được trỏ
  tới hay không" trong gate MVP — ghi rõ đây là giới hạn đã biết, không tự nhận là đã kiểm
  chứng độ chính xác nội dung citation.
- Chốt ngưỡng chất lượng và budget độ trễ theo baseline **trước** chạy holdout. Không có
  lỗi scope/lifecycle hoặc citation bịa trong bộ nghiệm thu; optimization không được đạt
  latency bằng cách trả rỗng. Muốn đổi dense-only/hybrid hoặc bật parent-child/rewrite/graph
  phải có báo cáo ablation; FTS nếu được chọn sau này có gate riêng tương đương.
- Test unit/contract không thay thế integration Qdrant + embedding thật và PostgreSQL
  cho metadata/quyền/job; không yêu cầu PostgreSQL FTS trong integration mặc định.
  Chạy kiểm thử outbox retry/kill, mất Qdrant, lỗi rerank, backfill dang dở và rollback;
  báo rõ cấu hình model/version/data snapshot dùng trong `npm run eval:retrieval`.

### 4.3. Rollout và rollback

Flag mới dự kiến cho lexical backend, parent-child, query rewrite, embedding cache và graph
persistent; chưa coi là biến môi trường đã tồn tại. Chạy shadow so kết quả trên cùng scope
và snapshot trước, không gửi câu trả lời shadow cho người dùng. Giữ index/version cũ đủ thời
gian rollback, nhưng vẫn kiểm tra quyền/deletion hiện tại; không hồi sinh tài liệu đã xóa.
Tắt flag tối ưu không được tắt scope filter. Khi backend mới lỗi, chỉ fallback đường cũ nếu
đường đó đã áp cùng quyền và revision; nếu không thì báo không thể truy xuất an toàn.

### 4.4. Trạng thái triển khai ngày 20/09/2026

| Giai đoạn | Trạng thái | Kết quả / phần còn thiếu |
|---|---|---|
| RAG-0 | Đang thực hiện | Đã tách `HitRate@K`, `Document Recall@K`, `Document MRR`; đã có contract `all_authorized` / `selected` / `none`. Chưa có golden set thật 30+ case và baseline live nên chưa đạt gate. |
| RAG-1 | Đã triển khai kỹ thuật, chờ gate ACL | Dense search đã filter `documentId` và `type` ngay trong Qdrant trước top-K; collection tạo payload index idempotent cho `documentId`, `type`, `chunkIndex`; lexical/graph dùng cùng effective scope. Hiện metadata chưa có ACL theo từng tài liệu, vì vậy `all_authorized` vẫn tương ứng toàn Library đối với tài khoản có `knowledge:read`; không được coi là hoàn tất phát hành đa người dùng cho đến khi A4 cung cấp ACL tài liệu. |
| RAG-2 | Hoàn thành | Bỏ cắt chuỗi `.slice(0, 12000)`; context được đóng gói theo token ước lượng và chỉ nhận nguyên chunk. Budget trừ output reserve, câu hỏi, schema, history và margin. |
| RAG-2b | Hoàn thành MVP | Prompt yêu cầu marker số thực `[1]`, `[2]`; backend chỉ dựng metadata từ chunk thực sự đã đóng gói vào prompt, loại marker ngoài phạm vi, chọn excerpt gần nội dung câu hỏi/nhận định và ghi nhận thiếu citation. UI dùng nhãn “Đoạn nguồn theo trích dẫn”, không tuyên bố đã kiểm chứng ngữ nghĩa. Kiểm tra semantic entailment và revision tài liệu tiếp tục thuộc RAG-4. |
| RAG-3 | Hoàn thành | Reranker giới hạn candidate, ký tự mỗi document và tổng payload; kiểm tra index/score hợp lệ và fallback RRF trong cùng scope. |
| RAG-4–8 | Chưa triển khai | Giữ nguyên điều kiện tiên quyết và rollout trong kế hoạch; không tự bật graph persistent, parent-child hay query rewrite trước khi có baseline. |

Cấu hình mới:

```env
AI_DOCUMENT_CONTEXT_TOKENS=3000
RERANKER_MAX_CANDIDATES=20
RERANKER_MAX_DOCUMENT_CHARS=1600
RERANKER_MAX_TOTAL_CHARS=24000
```

`AI_DOCUMENT_CONTEXT_CHARS` đã bị loại bỏ vì không còn cắt context theo ký tự. Kiểm thử
toàn dự án tại thời điểm cập nhật: 257 test, 255 đạt, 0 lỗi, 2 chủ động bỏ qua.

## 5. Rủi ro / đánh đổi cần lưu ý

- **RAG-4:** đổi vòng đời manifest/index cần backfill và kiểm chứng revision nhất quán.
  BM25 trong bộ nhớ có chi phí RAM/cold start; dense-only có thể giảm recall từ khóa.
  So shadow trước khi chuyển, không tạo thêm search backend PostgreSQL mặc định.
- **FTS tùy chọn:** nếu sau này chọn PostgreSQL FTS, phải tính thêm chi phí đồng bộ/xóa
  text giữa hai nơi, migration, backup và rollback trong thiết kế riêng.
- **RAG-5** (small-to-big chunking) làm tăng số điểm trong Qdrant (nhiều chunk con hơn) —
  cần theo dõi dung lượng và thời gian index lại khi ingest tài liệu lớn.
- **RAG-8** (GraphRAG thật) phụ thuộc chất lượng trích xuất entity/relation của local model
  — cần review thủ công một mẫu trước khi tin tưởng hoàn toàn kết quả trích xuất tự động.

## 6. Tài liệu tham chiếu

- `src/backend/knowledge_core/services/retrieval_service.js`
- `src/backend/services/qdrant_service.js`
- `src/backend/knowledge_core/services/library_service.js`
- `src/backend/intelligent_core/core.js` (chỉ thị hệ thống, dòng 264-269 — cần sửa cho 3.9)
- `src/frontend/js/modules/page_chat.js` (chưa có UI citation — cần thêm cho 3.9)
- `docs/NEXT_STEPS_PLAN_180926.md` (mục C — chất lượng câu trả lời AI, điều kiện đo lường)
- `scripts/evaluate_retrieval.js`, `tests/fixtures/retrieval_golden.sample.json`
- `migrations/postgres/`, outbox trong `src/backend/storage/`
- `LOCAL_MODEL_OPTIMIZATION_MASTER_PLAN_v2.md` là tham chiếu lịch sử hiện không còn trong
  working tree; không coi là điều kiện triển khai, tra Git history khi cần.
