# Chọn nhóm nghiệp vụ trước TEV1

Triển khai bản đầu ngày 07/10/2026. Page/popup/embed dùng chung `chat_router.decide` sau các lối tắt hiện có.

## Luồng

Catalog published được phép → kiểm tra model embedding và vector hiện có → embedding câu hỏi → Qdrant search có bộ lọc point ID hiện hành → BM25 trên routing card → RRF → đóng gói theo token/evaluation → TEV1 route/scope/input trong cùng request → kiểm tra backend → runtime.

Tác vụ đang chờ được giữ trong nhóm nếu vẫn nằm trong catalog được phép. Probe greeting/memory chạy trước retrieval theo luồng hiện có. Qdrant không cấp quyền hoặc chọn thao tác để thực thi.

## Cấu hình và lập chỉ mục

`CHAT_ROUTING_RETRIEVAL_MODE=off|shadow|on`, mặc định code/example là off. Cấu hình máy hiện tại đặt on để có hiệu lực ở lần restart tiếp theo. `shadow` vẫn chờ retrieval trong deadline nhưng dùng catalog cũ cho quyết định; đây là shadow đồng bộ để kiểm chứng, chưa phải worker shadow nền.

Collection mặc định `workflow_routing_v1`; `CHAT_ROUTING_RETRIEVAL_TOP_K=15` là giới hạn ban đầu, không phải số mục cố định đưa vào TEV1. Task target 1700 token, deadline retrieval 15000 ms và deadline request được áp dụng cùng nhau. Packing giảm nhóm theo thứ hạng khi cần, giữ pending và từ chối cắt nhóm đồng điểm ở nguồn vector/lexical. Chưa hiệu chỉnh ngưỡng cạnh tranh gần nhau hoặc cosine thấp trên bộ test lớn: không xem ranking là confidence.

Chạy `npm run index:workflows` để nhúng metadata published hiện có trong PostgreSQL, gồm các overlay còn hiệu lực; không chạy workflow hoặc SQL nghiệp vụ. Publish/overlay khi retrieval bật phải có routingScope và lập chỉ mục trước khi lưu published. Lỗi embedding/Qdrant sẽ làm bước publish đó thất bại; có thể khôi phục mode off khi cần. Runtime kiểm tra và bổ sung point thiếu để phục hồi chỉ mục.

Routing card có name, routingDescription (hoặc description), routingExamples (hoặc examples), aliases, domain, routingScope và nhãn slot. Metadata routing tùy chọn được validate cùng package. Giữ schema input của ứng viên để extract/validate; prompt shortlist không gửi instructions thực thi. Không tự sửa scope của bản published cũ.

Embedding bản đầu hỗ trợ Ollama `/api/embed`, xác minh digest qua `/api/tags`, dimension và vector hữu hạn khác 0; không dùng deterministic fallback. Point ID dựa trên hash card/version/definition/model digest/format. Hash thay đổi tạo point mới; search chỉ cho phép ID tương ứng snapshot hiện tại, nên disabled/deleted/stale/ngoài quyền không tham gia. Point cũ được giữ, chưa có garbage collection tự động.

## Chuyển sang Mac mini

Máy chạy độc lập không có embedding dùng `CHAT_ROUTING_RETRIEVAL_MODE=on` và `CHAT_ROUTING_RETRIEVAL_METHOD=lexical`. Phương pháp này tìm BM25 trên tên, mô tả, alias, ví dụ và nhãn slot; không gọi Ollama/Qdrant để chọn nhóm nghiệp vụ. TEV1/model chat vẫn cần endpoint hoạt động. Chế độ này chỉ áp dụng workflow routing, không thay đổi yêu cầu embedding của RAG tài liệu/schema.

Máy có embedding dùng `CHAT_ROUTING_RETRIEVAL_METHOD=hybrid` (mặc định). Sau restore chạy `npm run index:workflows -- --check` để kiểm tra collection, dimension, digest và đủ point đúng version/hash. Lệnh check chỉ đọc; nếu báo thiếu/stale thì chạy `npm run index:workflows` trên máy có embedding để lập chỉ mục. Chat không tạo collection, ghi point hoặc embedding workflow nữa; chỉ embedding câu truy vấn khi cache miss. Hybrid publish/overlay phải sync thành công trước khi lưu published; lexical publish không gọi embedding nhưng vẫn yêu cầu `routingScope`. Không có worker index nền ở phiên bản này.

Metadata tùy chọn `routingGroup` là mã nhóm dùng chung, ví dụ `contract`, cho các template lookup/list/aggregate của cùng đối tượng. Mã gồm chữ/số/`_`/`.`/`-`, tối đa 100 ký tự. Khai báo trong template qua draft/publish hoặc overlay hiện có; chỉ các template được phép mới được bổ sung vào nhóm. Nếu nhóm không vừa topK/context/budget thì fallback, không bỏ riêng một template trong nhóm. Catalog cũ chưa khai báo vẫn chạy nhưng chưa có bảo đảm giữ nhóm theo đối tượng.

Dùng cùng Qdrant hoặc snapshot/restore collection `workflow_routing_v1`, cùng catalog published và cùng model embedding/digest/dimension. Vector đã tồn tại đúng hash được dùng lại, không embedding lại workflow. URL embedding có thể là máy khác; mỗi câu chat mới vẫn cần embedding (trừ cache). Thay đổi model digest hoặc workflow version/hash sẽ lập chỉ mục mới.

## Fallback và quan sát

Router dùng contract `purpose=explain|execute|unclear|none` chung cho TEV1 và model chat. `explain` trả `route=chat` kèm ID nghiệp vụ liên quan và bằng chứng câu hiện tại; chỉ gọi model trả lời từ metadata đã kiểm tra lại quyền, không tạo/sửa/hủy run hoặc gọi tool/SQL. `execute` mới được đi vào runtime. `none` là chat thông thường hoặc hỏi về kết quả đã có. Chưa rõ mục đích thì hỏi làm rõ, không tự thực thi.

Template có thể khai báo metadata công khai:

```json
{
  "capabilities": {
    "summary": "Mô tả ngắn dành cho người dùng",
    "timeGranularities": ["Khoảng thời gian thực tế được hỗ trợ"],
    "units": ["Đơn vị thực tế"],
    "limitations": ["Giới hạn đã được xác minh"]
  }
}
```

Các trường là dữ liệu do người quản trị khai báo qua draft/publish hoặc overlay; không hardcode theo ID nghiệp vụ. Khi chưa có `capabilities`, model dùng mô tả và schema input published hiện có và phải nói rõ những khả năng chưa được tài liệu hóa. Prompt giải thích không chứa workflow steps, SQL hay instructions thực thi. Lựa chọn nghiệp vụ trên UI chỉ hiển thị mô tả công khai `capabilities.summary` nếu có. Lỗi router không còn hiển thị toàn catalog: hỏi lại bằng văn bản để tránh gợi ý nghiệp vụ không liên quan.

`node --require ./tests/helpers/setup_isolated_data.js scripts/evaluate_workflow_purpose.js` đo phân biệt explain/execute bằng các câu sinh từ tên template và câu capability trong lịch sử; có sinh câu giải thích từ metadata, không gọi runtime hoặc SQL. Report private có timestamp. Một câu hỏi purpose thêm vào task TEV1 nên vẫn cần đo budget/context, không tăng giới hạn model để ép vừa.

Trong auto, lỗi retrieval/packing chuyển model chat; uncertain sau shortlist cũng đánh giá lại catalog được phép đầy đủ để tránh bỏ sót. Prompt fallback bỏ instructions thực thi, giữ mô tả routing, scope và schema input. Tối đa một model-chat escalation. Full catalog vượt context thì dùng cơ chế SELECT_TEMPLATE/hỏi rõ hiện có; chưa triển khai bộ chọn tìm kiếm/phân trang hoặc fallback catalog rộng dạng card một dòng.

Trong local_tev1, lỗi retrieval không gọi model chat. chat_model dùng nhóm ứng viên mà không kiểm tra ngân sách TEV1. Query embedding cache 5 phút, tối đa 256 entry, key có model digest; quyền luôn lọc lại mỗi lần search, không cache quyết định chat.

Diagnostics có `workflowRouting.retrieval`: status/mode/errorCode, catalogCount/candidateCount/candidateIds, taskTokens/evaluations, model digest/catalog hash và phương pháp gộp. Không ghi câu chat hay dữ liệu nghiệp vụ trong retrieval trace. Chưa có queue/concurrency controller riêng hoặc toàn bộ stage timings.

## Kiểm chứng

- `node scripts/evaluate_workflow_retrieval.js`: đo riêng BM25/hybrid với K=5/8/10/12/15 trên corpus lịch sử và nhãn private sẵn có; không gọi TEV1, không ghi chỉ mục hoặc thực thi workflow. Thêm `--lexical-only` khi không có embedding. Báo lỗi retrieval thành ca cần fallback, không tự tính là chat đúng.
- `node --require ./tests/helpers/setup_isolated_data.js scripts/evaluate_history_routing.js --retrieval-only --lexical`: replay router bằng BM25; lưu report có timestamp riêng, giữ báo cáo baseline cũ.

Unit/integration tests giả lập catalog 100 mục kiểm tra shortlist, ACL, pending, cache, digest/version, lỗi vector, packing và fallback. Đây không phải benchmark recall ngữ nghĩa của 100 nghiệp vụ thật.

Đánh giá model thật: `CHAT_ROUTING_RETRIEVAL_MODE=on node --require ./tests/helpers/setup_isolated_data.js scripts/evaluate_tev1_live_catalog.js [--local-only]`. PowerShell đặt biến môi trường bằng `$env:CHAT_ROUTING_RETRIEVAL_MODE='on'` trước lệnh. Script chỉ inference/read catalog, không thực thi nghiệp vụ. Report retrieval riêng nằm ở `artifacts/tev1-live-catalog-retrieval-*.json`.

Rollback bằng mode off và restart theo cách vận hành hiện có; không sửa published catalog hoặc pending run. Không coi rollback là giải pháp cho full catalog vượt context. Các mục rollout/capacity còn lại xem [plan](CHAT_WORKFLOW_VECTOR_ROUTING_PLAN.md).

## Bộ regression từ lịch sử tài khoản

`node scripts/prepare_history_routing_eval.js` đọc các phiên UI thuộc tài khoản, lấy catalog đã lọc quyền và khôi phục lịch sử text/metadata completed từ run thuộc cùng tài khoản. Nếu có nhiều owner, phải đặt `HISTORY_EVAL_ACCOUNT_ID`; script không tự gom lịch sử mọi tài khoản. Không lấy output routing cũ làm nhãn đúng và không export credentials provider.

Corpus và nhãn rà soát nằm trong `artifacts/history-routing-{corpus,labels}.private.json`, được Git ignore. Nhãn gồm câu gốc, route/workflow, input kỳ vọng và nhóm tình huống. Script dừng nếu còn câu chưa có nhãn; cần rà nhãn theo catalog/ý định trước khi đánh giá.

`npm run eval:routing:history` replay từng lượt với ngữ cảnh, lần lượt retrieval off/on; `--retrieval-only` chỉ chạy on. Chỉ gọi `router.decide`, không gọi core/runtime và không chạy workflow/SQL nghiệp vụ. Report tiến độ lưu mỗi ca vào `artifacts/history-routing-evaluation.private.json`. `node scripts/report_history_routing_eval.js` đối chiếu input chính xác, tổng hợp so sánh, recall/top-1/latency/usage và tạo `artifacts/history-routing-evaluation.md`.

Các câu trùng được giữ vì context khác nhau. Đây là regression từ dữ liệu thực tế đã dùng, không mặc định là holdout: một số câu có thể trùng examples trong chỉ mục. Pending/form transitions không có snapshot lịch sử đầy đủ; lối tắt explicit list của orchestrator cũng không chạy trong bài replay router. Không suy điểm routing thành độ đúng của câu trả lời hay dữ liệu cuối.
# Backup và dọn collection

Nút backup admin và `npm run backup:all` lưu PostgreSQL, file thư viện và ba collection cấu hình bởi `QDRANT_COLLECTION`, `QDRANT_DOCUMENT_COLLECTION`, `CHAT_ROUTING_RETRIEVAL_COLLECTION` (mặc định `workflow_routing_v1`). Restore hiện tại phục hồi cả ba snapshot; import sang database mới trả thêm `configuration` để cấu hình tên collection có tiền tố. Vector workflow được phục hồi từ snapshot, không cần embedding lại để restore.

Gói cũ có hai collection vẫn được đọc và restore, nhưng kế hoạch báo `workflowRoutingRestored: false` cùng cảnh báo cần lập lại chỉ mục workflow. Gói mới khai báo ba collection nhưng thiếu snapshot workflow sẽ bị từ chối.

`node scripts/cleanup_legacy_qdrant.js` chỉ xem kế hoạch. Thêm `--apply` để lưu snapshot có checksum rồi xóa hai collection legacy nếu chúng không phải collection đang cấu hình; đồng thời dọn point workflow không còn khớp catalog published và digest model hiện tại. Script dừng nếu thiếu vector hiện hành. Snapshot dọn dẹp trong `backups/qdrant-cleanup-*` là bản an toàn riêng của Qdrant, không phải gói backup PostgreSQL đầy đủ.

