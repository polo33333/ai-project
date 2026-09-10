# Kế hoạch nâng cấp Local Model Harness — Qwen3.5 9B

Ngày đánh giá: 2026-09-10. Trạng thái: khả thi, đề xuất triển khai theo giai đoạn; chưa thay đổi runtime hoặc cấu hình provider.

## 1. Kết luận và phạm vi

Nên thực hiện: thiết lập eval ngữ nghĩa và telemetry, tích hợp `skill_core` để quản lý quy trình nghiệp vụ và few-shot theo schema, nâng cấp embedding schema thật, sau đó mới thử cấu hình inference. Tận dụng harness hiện có và giữ các chốt kiểm tra SQL, giới hạn vòng lặp, chống gọi lặp, chart/export và local-only fallback.

`skill_core` trong kế hoạch này là module nội bộ của ứng dụng, gồm registry, bộ chọn skill và hợp đồng quy trình khai báo. Triển khai phiên bản nhỏ trong giai đoạn 2; không cần hệ thống plugin động, agent loop riêng hay cơ chế thực thi code từ file skill. Đây không phải các `SKILL.md` dành cho công cụ lập trình Codex.

Chưa đủ bằng chứng để khẳng định tăng context, bật thinking hoặc LoRA sẽ cải thiện chất lượng trên máy hiện tại. Đây là các thử nghiệm có điều kiện, không phải cấu hình mặc định mới.

Provider đang được chọn trong IDE `provider-1785683549410` là `gemini-3.5-flash-lite`, định dạng Gemini. Provider Qwen trong file hiện tại là `provider-1786452454946`, model `qwen3.5:9b`, định dạng Ollama, `supportsToolCalling: true`. Khi triển khai phải xác định provider bằng ID và kiểm tra loại/model; không sửa nhầm provider Gemini hoặc giả định mục đang chọn là local model.

## 2. Đối chiếu bản phân tích với code

| Nhận định | Kết quả kiểm tra | Hướng xử lý |
| --- | --- | --- |
| Eval local chỉ đo format | Đúng: `scripts/evaluate_local_harness.js` chạy 3 fixture, kiểm tra kind/tool, không gọi model | Giữ làm smoke test; thêm eval end-to-end độc lập |
| Chọn schema 100% regex, local tắt Qdrant | Chưa đúng: `core.js` gọi `buildSchemaContext`; service kết hợp lexical, glossary, Qdrant. Cờ `LOCAL_MODEL_SCHEMA_SELECTOR_ENABLED` chỉ điều khiển bước nhờ LLM chọn lại bảng | Không xây thêm pipeline trùng; cải thiện retrieval hiện có |
| Schema chưa dùng BGE-M3 như document search | Đúng về khoảng trống thực tế: `searchSchema` và index schema gọi `generateVector` deterministic; dịch vụ có `embedTexts` phục vụ embedding thật | Chuyển cả index và query schema sang cùng embedding model, có migration |
| Chưa có few-shot nghiệp vụ | Đúng với `local_prompt_builder.js`; đã có ví dụ JSON protocol chung | Bổ sung ví dụ chọn lọc, đúng schema, có ngân sách token |
| Mọi sửa lỗi đều deterministic | Chưa đúng: harness phản hồi lỗi tool, policy, bảng/cột cho model rồi tiếp tục vòng lặp | Đo hiệu quả repair hiện có trước; không thêm vòng retry trùng |
| Chưa có thống kê native/content JSON | Normalizer đã gắn `source`; trace tool đã lưu nguồn | Bổ sung thống kê cả lần bị từ chối và lỗi parse, không chỉ tool thực thi thành công |
| Context mặc định 16K | `.env.example` đặt 16384; adapter ưu tiên provider rồi env, không tự đặt 16K khi cả hai thiếu | Ghi nhận cấu hình hiệu lực khi benchmark |
| Context lớn luôn tốt hơn | Không có cơ sở kết luận trên máy hiện tại | Đo độ đúng, latency, RAM/VRAM và tỷ lệ cắt nội dung |

Điểm cần chú ý thêm trong `schema_context_service.js`: khi lexical score đủ lớn, bộ lọc có thể loại ứng viên chỉ có vector match; bước nhận diện hội thoại chung có thể bỏ qua retrieval cho câu ngắn; planner ưu tiên một bảng và evaluator có thể ép model theo lựa chọn sai ban đầu. Các điểm này cần fixture riêng, nhất là paraphrase và truy vấn JOIN.

## 3. Giai đoạn 0 — Baseline và quan sát (ưu tiên P0)

Các file chính: `scripts/evaluate_local_harness.js`, `tool_call_normalizer.js`, `local_model_harness.js`, `adapters/ollama.js`.

- Giữ eval format hiện tại; bổ sung script benchmark live riêng, chọn rõ provider và không tự chuyển sang cloud.
- Ghi model tag/digest nếu API cung cấp, phiên bản Ollama, tool capability, cấu hình hiệu lực, phần cứng và concurrency. Kiểm chứng một chu trình native đầy đủ: model gọi tool → nhận kết quả tool → trả lời.
- Telemetry theo request: native/content_json/invalid/final, số model call, số repair theo loại, SQL attempt/success, fallback, thời gian end-to-end, token, done reason và số lần retry empty response. Usage phải tính cả lần gọi đầu khi adapter retry.
- Đếm lỗi ngay sau normalization/validation để tránh thống kê chỉ nhìn thấy tool thành công. Không ghi nội dung thinking; log vận hành mặc định chỉ giữ metadata và thông tin đã che dữ liệu nhạy cảm.
- Ghi rõ retrieval dùng embedding thật, deterministic hay lexical fallback; không coi vector match là bằng chứng semantic retrieval hoạt động.

Hoàn thành khi: có báo cáo baseline tái chạy được, ghi rõ cấu hình và phân biệt benchmark live với test mock. Chưa thay đổi mặc định inference.

## 4. Giai đoạn 1 — Eval ngữ nghĩa (P0, trước tối ưu)

File dự kiến: `tests/fixtures/local_sql_golden.json`, `scripts/evaluate_local_sql.js`, fixture SQL Server riêng; thêm npm script `eval:local:semantic` khi triển khai.

- Xây tối thiểu 60 câu đã kiểm duyệt: tên bảng/cột rõ ràng; paraphrase tiếng Việt có/không dấu; entity lookup; tổng hợp thời gian; JOIN; chart/export; không có dữ liệu; câu mơ hồ; không cần SQL; SQL bị cấm.
- Mỗi case có schema/db snapshot version, bảng/cột cần dùng, filter, phép tổng hợp, quy tắc thời gian, expected rows hoặc expected clarification/refusal và artifact bắt buộc. Tách tập phát triển với tập đánh giá giữ kín; few-shot không lấy từ tập đánh giá.
- Chạy qua retrieval → chọn skill (khi bật) → planner → adapter → harness → SQL fixture → câu trả lời/artifact. Có chế độ offline để kiểm tra oracle và chế độ live để đo Qwen; không dùng kết quả mock làm điểm chất lượng model.
- Bổ sung nhãn `expectedSkillId` hoặc `no_skill`, đầu vào còn thiếu và điều kiện hoàn thành cho case liên quan. Đo tỷ lệ chọn đúng skill, chọn nhầm ở câu ngoài phạm vi, làm rõ đúng và hoàn thành quy trình. Tách ảnh hưởng của skill routing với few-shot bằng các lượt A/B riêng.
- Ưu tiên execution-match với dữ liệu fixture có khả năng phân biệt SQL sai: trùng tên khác DB, NULL, JOIN nhân bản dòng, biên tháng/năm, tháng thiếu dữ liệu, thứ tự và ties. Chuẩn hóa Decimal/Date; so sánh unordered chỉ khi thứ tự không thuộc yêu cầu. SQL exact-match chỉ là chỉ số phụ.
- SQL candidate vẫn đi qua kiểm tra hiện tại; chạy bằng tài khoản chỉ đọc trên DB fixture, timeout và row limit. Chart/export dùng thư mục tạm và kiểm tra nội dung thực tế; không tạo artifact benchmark trong dữ liệu người dùng.
- Báo cáo schema recall@k, table top-1, execution accuracy, task success, artifact success, repair/fallback rate, latency p50/p95 và token. Tách điểm SQL với điểm hoàn thành toàn tác vụ.
- Chạy mỗi cấu hình live ít nhất 3 lần; báo cả số lượng thành công/tổng và độ dao động. Case thiếu dịch vụ phải là skipped/incomplete, không được tính pass.

Gate đề xuất: không tăng lỗi SQL nguy hiểm hoặc regression trong nhóm bắt buộc; task success tăng ít nhất 5 điểm phần trăm hoặc giảm ít nhất 20% số lỗi trên tập giữ kín. Latency p95 tăng tối đa 20% ở profile mặc định. Đây là ngưỡng nghiệm thu đề xuất, không phải kết quả đã đạt.

## 5. Giai đoạn 2 — Tích hợp skill_core và few-shot theo schema (P1)

### 5.1. Kiến trúc và trách nhiệm

Luồng đề xuất:

```text
Câu hỏi + ngữ cảnh hội thoại
  → schema_context_service: truy xuất schema được phép
  → skill_core: chọn quy trình phù hợp hoặc no_skill
  → request_planner: gắn đầu vào với schema và tạo request plan
  → local_prompt_builder: đưa hướng dẫn và few-shot phù hợp vào prompt
  → local_model_harness: điều phối model/tool và kiểm tra hoàn thành
  → kết quả dữ liệu, chart/export hoặc yêu cầu làm rõ
```

| Thành phần | Trách nhiệm |
| --- | --- |
| `skill_core` | Lưu định nghĩa/version, chọn skill, mô tả đầu vào, các bước phụ thuộc, tool cần dùng và tiêu chí hoàn thành; cung cấp ví dụ đã kiểm duyệt |
| `schema_context_service` | Chọn schema, cung cấp phạm vi DB và bằng chứng retrieval; skill không tự đặt tên bảng/cột |
| `request_planner` | Kết hợp yêu cầu người dùng, ngữ cảnh hợp lệ và skill để tạo một request plan duy nhất; xử lý thông tin thiếu và ràng buộc nghiệp vụ |
| `tool_registry` | Nguồn định nghĩa tool và handler thực thi; skill chỉ tham chiếu tên tool đã đăng ký |
| `local_model_harness` | Sở hữu vòng lặp, budget, retry, dedup, abort và trạng thái hoàn thành; gọi các validator hiện có trước thực thi |
| `training_core` | Thu thập kết quả, đánh giá và hồi quy theo skill/version; không tự xuất bản skill từ hội thoại |

Skill chỉ được thu hẹp quyền sử dụng tool theo policy hiện tại. Yêu cầu rõ ràng của người dùng ưu tiên hơn giá trị mặc định trong skill; policy bảo mật và quyền truy cập luôn phải được giữ. Không để skill tự thêm chart/export khi người dùng không yêu cầu hoặc không chấp nhận đầu ra đó.

### 5.2. Cấu trúc module và hợp đồng dữ liệu

Các file dự kiến:

```text
src/backend/skill_core/
  index.js                 # API resolveSkill cho luồng ứng dụng
  skill_registry.js        # Load và validate định nghĩa/version
  skill_selector.js        # Chọn skill từ intent và context
  skill_contract.js        # Validate contract và kết quả hoàn thành
  definitions/             # Định nghĩa khai báo, quản lý cùng source code
  examples/                # Ví dụ theo skill, có schema compatibility
tests/skill_core.test.js
```

Mỗi định nghĩa gồm `id`, `version`, `description`, `supportedIntents`, `requiredInputs`, `schemaRequirements`, `allowedTools`, `steps`, `completionCriteria` và `exampleIds`. `steps` mô tả bước cùng phụ thuộc và điều kiện áp dụng; không chứa JavaScript, shell hoặc SQL tùy ý để thực thi trực tiếp. Các tiêu chí hoàn thành dùng loại kiểm tra đã lập trình sẵn, không dùng `eval`.

Kết quả lựa chọn gồm `status` (`matched`, `no_match`, `ambiguous`), `skillId`, `skillVersion` và bằng chứng khớp. Planner bổ sung `resolvedInputs`, `missingInputs`, `requiredOutputs` và ràng buộc schema vào request plan; tránh một bản kế hoạch riêng trong skill bị lệch với planner. Skill thiếu đầu vào không đồng nghĩa luôn hỏi lại: ưu tiên dữ kiện rõ ràng trong hội thoại và default nghiệp vụ hợp lệ, chỉ hỏi khi còn mơ hồ làm thay đổi kết quả.

Registry kiểm tra ID/version trùng, tool không tồn tại, dependency vòng, example không tồn tại và loại tiêu chí không hỗ trợ. Định nghĩa lỗi bị vô hiệu hóa và ghi chẩn đoán; request trở về luồng hiện tại khi chưa có lựa chọn đáng tin cậy. Thông tin mơ hồ đã xác định là thiết yếu vẫn phải được làm rõ, không dùng fallback để bỏ qua.

### 5.3. Skill đầu tiên và cách tích hợp

- `record_lookup`: tìm bản ghi theo tiêu chí đã xác định; hoàn thành khi truy vấn hợp lệ và câu trả lời bám rows, bao gồm trường hợp không có dữ liệu.
- `monthly_report`: tổng hợp metric theo tháng, phân biệt latest available với calendar-relative; hoàn thành khi có kết quả đúng phạm vi thời gian. Chart và export là bước tùy chọn phụ thuộc yêu cầu thực tế.
- Bắt đầu với tối đa một skill mỗi request; câu hỏi tổng hợp ngoài khả năng mô tả trở về harness hiện tại. Chưa xây cơ chế tự ghép nhiều skill hoặc để skill gọi skill.
- `core.js` gọi resolver sau retrieval và trước khi chốt request plan; truyền selection vào planner và harness. Bộ chọn ban đầu dùng intent, đầu vào và context đã có, không thêm lượt gọi LLM riêng. Dùng kết quả `no_match`/`ambiguous` khi bằng chứng yếu thay vì ép chọn.
- `local_prompt_builder.js` lấy hướng dẫn và ví dụ từ skill đã chọn. Harness nhận contract qua request plan và dùng chung logic chart/export, policy và validator hiện tại; không sao chép recovery vào module skill.
- Completion checker đọc kết quả tool thực tế: SQL hợp lệ, trạng thái empty rows, chart/export thành công và artifact tồn tại. Nếu đầu ra bắt buộc lỗi hoặc chưa hoàn thành, trả trạng thái partial/failure phù hợp; không báo thành công chỉ vì model nói đã làm xong.
- Mỗi request giữ nguyên snapshot skill/version; việc reload định nghĩa chỉ áp dụng cho request mới. Giới hạn thực thi vẫn dùng budget chung của harness, không reset budget theo bước.
- Thêm `LOCAL_MODEL_SKILL_CORE_ENABLED=false` và `LOCAL_MODEL_FEW_SHOT_ENABLED=false` như cờ dự kiến, bật trong eval trước. Đợt đầu chỉ tích hợp vào local harness; chưa thay đổi hành vi cloud provider.
- Trace bổ sung skill ID/version, lý do chọn/no-match, input thiếu, trạng thái từng bước và completion violations. Chỉ ghi metadata cần thiết và che giá trị nhạy cảm.

### 5.4. Few-shot trong skill

- Chọn tối đa 2–3 ví dụ theo intent và schema đang được phép sử dụng, giới hạn tổng khoảng 1.000–1.500 token; số thực tế điều chỉnh theo baseline.
- Ưu tiên lookup có filter, tổng hợp tháng theo quy tắc thời gian và SQL → chart/export. Phân biệt “tháng gần nhất có dữ liệu” với khoảng lịch tính đến hôm nay.
- Chỉ đưa ví dụ có bảng/cột hợp lệ trong context hiện tại; không có ví dụ phù hợp thì bỏ qua. Không hardcode bảng phổ biến của một DB vào mọi request.
- Không nhồi rows dài hoặc lấy nguyên hội thoại chứa thông tin nhạy cảm. Format ví dụ phải khớp native tool protocol hoặc JSON fallback được chọn.
- Ví dụ nằm trong kho của `skill_core`, có skill ID/version và điều kiện tương thích schema; không tạo kho few-shot nghiệp vụ song song trong prompt builder.
- So sánh ba cấu hình trên cùng golden set: baseline; skill bật nhưng few-shot tắt; skill và few-shot cùng bật. Khi skill tắt, giữ prompt hiện tại; khi không có skill phù hợp, không chèn ví dụ của skill khác.

### 5.5. Kiểm thử và điều kiện hoàn thành

- Unit test cho registry, chọn đúng/no-match/ambiguous, hợp đồng lỗi, thiếu input và default mâu thuẫn với yêu cầu người dùng.
- Integration test cho lookup, báo cáo tháng có/không chart/export, empty rows, SQL bị chặn, artifact lỗi, hết budget, abort và cờ tắt khôi phục luồng cũ.
- Kiểm tra skill không mở rộng quyền tool/DB, không vượt budget, không chạy lặp SQL hoặc tạo lại artifact đã thành công; câu hội thoại chung không bị chuyển thành truy vấn dữ liệu.
- Thêm `tests/fixtures/skill_cases.json` để kiểm tra định tuyến offline; eval live vẫn dùng golden set của giai đoạn 1, có báo cáo theo skill/version.

Hoàn thành khi: hai skill đầu đi qua harness hiện có và đạt gate giai đoạn 1; nhóm case bắt buộc không hồi quy, telemetry phân biệt routing với execution failure và hai cờ tắt hoạt động độc lập. Chỉ mở mặc định sau khi có báo cáo A/B đạt yêu cầu.

## 6. Giai đoạn 3 — Semantic schema retrieval thật (P1)

Các file chính: `services/qdrant_service.js`, `schema_context_service.js`, `request_planner.js`, `sql_evaluator.js`; bổ sung kiểm thử retrieval và migration.

- Tái sử dụng `embedTexts` cho cả index và query schema. Đo dimension thực tế của model; không đưa embedding mới vào collection deterministic 384 chiều và không trộn hai không gian vector dù cùng dimension.
- Tạo collection schema có version mới, lưu embedding model/dimension/schema revision. Index bảng, cột, glossary, relationships cùng metadata `dbName`; kiểm tra trạng thái trước khi chuyển cấu hình/alias. Giữ collection cũ để rollback, tránh gọi nguyên luồng sync đang xóa collection đang phục vụ.
- Khi embedding service hỏng: dùng lexical fallback có trạng thái rõ ràng; không hash query rồi tìm trên collection embedding thật. Kiểm tra đường fallback hiện có của `embedTexts` trước khi tái sử dụng.
- Filter theo DB và đối chiếu bảng đang active trước khi xếp hạng. Dùng định danh gồm DB và table để tránh trùng tên bảng. Bảo toàn khóa JOIN, metric và cột thời gian cần thiết trong giới hạn context.
- Điều chỉnh kết hợp lexical/vector để ứng viên semantic tốt không bị loại chỉ vì bảng khác có lexical match. Dùng eval để chọn trọng số và confidence threshold.
- Planner cần phân biệt bảng do người dùng chỉ rõ với bảng suy ra confidence thấp. Khi mơ hồ, làm rõ hoặc chọn lại trong tập schema hợp lệ; không ép sửa SQL về một bảng chỉ vì đứng đầu retrieval. Với JOIN, thống nhất allowed tables/columns giữa planner và evaluator trước khi nới lựa chọn.
- Test: paraphrase, câu dữ liệu ngắn, schema inactive, DB trùng tên bảng, mất Qdrant/embedding, dimension mismatch, index cũ và JOIN nhiều bảng.

Hoàn thành khi: semantic retrieval có provenance đúng, cải thiện nhóm paraphrase trên golden set, giữ nguyên ràng buộc DB/schema và rollback index đã được thử.

## 7. Giai đoạn 4 — Thử nghiệm inference có điều kiện (P2)

Chỉ bắt đầu sau baseline/eval. Mỗi lần đổi một yếu tố; giữ cấu hình thành công theo provider/request, không mutate provider dùng chung trong request.

| Thử nghiệm | Thiết kế và điều kiện chấp nhận |
| --- | --- |
| Context | So 16K → 32K; chỉ thử 64K nếu tài nguyên đủ. Đo prompt thực tế, RAM/VRAM, throughput và p95 ở concurrency thực. Không tự nới tool-result chars cùng lúc |
| Compaction | Đo trường thông tin bị mất trước; giữ full rows cho chart/export, chỉ compact phần đưa vào model. Có tín hiệu truncation rõ ràng |
| Thinking | So bật/tắt ở nhóm khó đã gán nhãn, không chỉ dựa vào có số tháng. Đặt token/time budget, giữ retry empty-content và abort; tính tổng chi phí mọi lượt gọi |
| Structured output | Chỉ thử khi đo được lỗi protocol đáng kể. Adapter hiện chưa truyền `format`; cần schema envelope có cả tool call và final answer, validation và test vòng nhiều lượt. Không mặc định ghép `tools` + `format` sẽ hoạt động tốt |
| Repair sampling | Đo repair hiện có trước; nếu cần, thử một cấu hình sampling khác trong cùng budget tổng. Không thêm vòng lặp độc lập, không thực thi lại SQL giống nhau, không coi SQL chạy được là SQL đúng |

Mỗi profile phải qua gate chất lượng và độ trễ; profile không đạt vẫn giữ tắt. Không triển khai self-consistency nhiều candidate ở đợt đầu.

## 8. LoRA — để sau (P3)

`training_core` có thu thập và đánh giá case nhưng không đồng nghĩa đã có pipeline SFT/LoRA. Chỉ lập đợt riêng khi còn nhóm lỗi model ổn định sau các bước trên, có dữ liệu đã kiểm duyệt, phần cứng huấn luyện và đường deploy adapter/quantization được xác minh. Không dùng SQL chỉ vượt qua rule evaluator làm nhãn đúng. Cần dedup, tách train/holdout, xử lý dữ liệu nhạy cảm và benchmark so với model gốc. Chưa cam kết lợi ích hoặc số lượng mẫu đủ để đạt hiệu quả.

## 9. Thứ tự triển khai và kiểm tra

1. PR baseline/telemetry và eval ngữ nghĩa.
2. PR `skill_core` registry/contract/selector và tích hợp hai skill đầu với feature flag; kiểm tra luồng bật/tắt, chưa chèn few-shot.
3. PR few-shot từ kho skill, báo cáo A/B tách ảnh hưởng routing và ví dụ.
4. PR embedding schema + migration; PR ranking/planner tiếp theo để tách nguyên nhân thay đổi chất lượng. Chạy lại eval theo skill để phát hiện ảnh hưởng tới lựa chọn và binding schema.
5. PR inference profiles nếu benchmark chứng minh lợi ích.

Mỗi PR chạy test liên quan và các kiểm tra CI của repo. Cuối đợt chạy `npm run test:ci`; eval live chạy riêng, không bắt CI thông thường phải có Ollama/SQL Server/GPU. Các cờ mới cần được mô tả trong `.env.example` và chỉ nối vào settings/UI nếu thực sự đưa ra cho người dùng cấu hình.

Rollback: tắt từng feature flag, phục hồi profile provider và chuyển lại collection schema cũ. Với skill, tắt `LOCAL_MODEL_FEW_SHOT_ENABLED` để bỏ ví dụ hoặc `LOCAL_MODEL_SKILL_CORE_ENABLED` để request mới trở về luồng harness cũ; request đang chạy giữ snapshot và budget ban đầu. Có thể phục hồi version định nghĩa qua source control. Không thay đổi model/provider mặc định hoặc index đang dùng trước khi có báo cáo nghiệm thu tương ứng.

## 10. Bằng chứng kiểm tra và giới hạn

Các kết quả test dưới đây thuộc lần đánh giá ban đầu, trước khi triển khai `skill_core`; không phải bằng chứng module skill đã được xây dựng hoặc kiểm thử. Lần cập nhật này chỉ sửa kế hoạch tích hợp.

- Đã chạy `node --test tests/local_harness.test.js tests/schema_context_service.test.js`: **48/48 pass**.
- Đã chạy `node scripts/evaluate_local_harness.js`: **3/3 pass**; đây là fixture format, không phải model benchmark.
- Chưa chạy Qwen live, chưa xác minh Ollama/GPU/VRAM, index thực tế hoặc execution accuracy. Chưa chạy toàn bộ CI vì thay đổi hiện tại chỉ là tài liệu.
- Workspace có các thay đổi khác từ trước; kế hoạch này chỉ bổ sung file tài liệu, không sửa các thay đổi đó.

## 11. Tài liệu chính thức đối chiếu

- [Qwen3.5-9B model card](https://huggingface.co/Qwen/Qwen3.5-9B): công bố context native 262.144 token. Giới hạn kiến trúc không chứng minh máy hiện tại chạy context đó hiệu quả; cần benchmark.
- [Ollama tool calling](https://docs.ollama.com/capabilities/tool-calling): mô tả giao thức gọi tool; khả năng hoạt động của tag local cụ thể vẫn cần probe end-to-end.
- [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs): hỗ trợ schema qua `format`; đúng cấu trúc không chứng minh SQL đúng nghiệp vụ.
- [Ollama context length](https://docs.ollama.com/context-length): context lớn cần thêm bộ nhớ; cấu hình phải phù hợp tài nguyên triển khai.
