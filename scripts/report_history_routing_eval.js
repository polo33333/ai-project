'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../src/backend/automation/contract');
const root = path.resolve(__dirname, '../artifacts');
const file = path.join(root, 'history-routing-evaluation.private.json');
const report = JSON.parse(fs.readFileSync(file, 'utf8'));
const p = (values, fraction) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] || 0;
for (const item of report.results) {
  item.routePassed = item.decision?.route === item.expected.route && item.decision?.workflowId === (item.expected.workflowId || null);
  item.inputsPassed = item.decision ? hash(item.decision.inputs) === hash(item.expected.inputs || {}) : false;
  item.passed = item.routePassed && item.inputsPassed;
}
for (const mode of ['off', 'on']) {
  const group = report.results.filter(item => item.mode === mode);
  if (!group.length) continue;
  const recalls = group.filter(item => item.recall);
  const stages = group.flatMap(item => item.trace.stages || []);
  const categories = Object.fromEntries([...new Set(group.map(item => item.category))].map(category => {
    const items = group.filter(item => item.category === category);
    return [category, { passed: items.filter(item => item.passed).length, total: items.length }];
  }));
  report.summaries[mode] = { passed: group.filter(item => item.passed).length, total: group.length,
    routePassed: group.filter(item => item.routePassed).length,
    directTev1: group.filter(item => item.trace.decisionSource === 'local_tev1').length,
    escalated: group.filter(item => item.trace.escalated).length,
    recallFound: recalls.filter(item => item.recall.found).length, recallMeasured: recalls.length,
    top1Found: recalls.filter(item => item.recall.candidates[0] === item.expected.workflowId).length,
    averageCandidateCount: recalls.length ? recalls.reduce((sum, item) => sum + item.recall.candidateCount, 0) / recalls.length : null,
    p50WallMs: p(group.map(item => item.wallMs), 0.5), p95WallMs: p(group.map(item => item.wallMs), 0.95),
    modelEvaluations: stages.reduce((sum, stage) => sum + (stage.calls || 0), 0),
    modelInputTokens: stages.reduce((sum, stage) => sum + (stage.inputTokens || 0), 0),
    modelOutputTokens: stages.reduce((sum, stage) => sum + (stage.outputTokens || 0), 0), categories };
}
const paired = report.results.filter(item => item.mode === 'on').map(after => ({ after, before: report.results.find(item => item.mode === 'off' && item.id === after.id) }));
report.comparison = { improved: paired.filter(item => item.before && !item.before.passed && item.after.passed).map(item => item.after.id),
  regressed: paired.filter(item => item.before?.passed && !item.after.passed).map(item => item.after.id),
  bothFailed: paired.filter(item => item.before && !item.before.passed && !item.after.passed).map(item => item.after.id) };
fs.writeFileSync(file, JSON.stringify(report, null, 2));
const escape = value => String(value).replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ');
const rows = ['# Đánh giá routing bằng lịch sử chat', '',
  `Nguồn: ${report.sourceTurns} lượt hỏi, ${report.uniqueQuestions} câu khác nhau; catalog ${report.catalogCount} nghiệp vụ.`, '',
  'Nhãn được rà theo ý định và catalog hiện tại, không lấy quyết định cũ làm đáp án. Replay router với lịch sử đã lưu và metadata workflow hoàn thành thuộc tài khoản. Không chạy workflow/SQL nghiệp vụ.', '',
  '| Chỉ số | Catalog đầy đủ | Retrieval + TEV1 |', '|---|---:|---:|'];
for (const [label, key] of [['Đúng route, workflow và input', 'passed'], ['Đúng route và workflow', 'routePassed'],
  ['TEV1 quyết định cuối', 'directTev1'], ['Escalation', 'escalated'], ['p50 routing (ms)', 'p50WallMs'], ['p95 routing (ms)', 'p95WallMs'],
  ['Model evaluations', 'modelEvaluations'], ['Model input tokens', 'modelInputTokens'], ['Model output tokens', 'modelOutputTokens']]) {
  rows.push(`| ${label} | ${report.summaries.off?.[key] ?? '-'} | ${report.summaries.on?.[key] ?? '-'} |`);
}
const on = report.summaries.on;
rows.push('', `Recall sau packing: ${on.recallFound}/${on.recallMeasured}; top-1: ${on.top1Found}/${on.recallMeasured}; nhóm ứng viên trung bình ${on.averageCandidateCount?.toFixed(2)}. Chỉ đo khi retrieval thực sự chạy trên câu kỳ vọng workflow.`, '',
  'Các câu trùng vẫn được replay riêng vì ngữ cảnh khác nhau. Độ trễ là chạy tuần tự off rồi on, gồm cache miss/cold embedding khi có; chưa tách warm/cold, không phải SLA hoặc benchmark tải. Đây là một lượt so sánh, chưa có lặp để kết luận độ ổn định hoặc quan hệ nhân quả. Token trong bảng lấy usage routing model; chưa cộng embedding và có thể không có đủ usage từ provider.', '',
  `Trong lượt so sánh này: ${report.comparison.improved.length} ca cải thiện, ${report.comparison.regressed.length} ca giảm chất lượng (${report.comparison.regressed.join(', ')}), ${report.comparison.bothFailed.length} ca lỗi ở cả hai chế độ.`, '',
  '## Các ca không đạt với retrieval', '', '| ID | Câu hỏi | Kỳ vọng | Thực tế |', '|---|---|---|---|');
for (const item of report.results.filter(item => item.mode === 'on' && !item.passed)) {
  rows.push(`| ${item.id} | ${escape(item.question)} | ${escape(JSON.stringify({ route: item.expected.route, workflowId: item.expected.workflowId || null, inputs: item.expected.inputs || {} }))} | ${escape(JSON.stringify(item.decision || { errorCode: item.errorCode }))} |`);
}
rows.push('', '## Giới hạn', '',
  '- Chỉ đánh giá định tuyến và tham số; không đánh giá câu trả lời, dữ liệu, biểu đồ hoặc export.',
  '- Có 3 nghiệp vụ thật: recall shortlist cao chưa chứng minh khả năng xử lý 100 nghiệp vụ.',
  '- Ngữ cảnh lấy từ HTML/lịch sử đã lưu; không có snapshot đầy đủ của pending/form ở từng thời điểm. Metadata completed được đối chiếu run thuộc tài khoản; không đưa các hàng dữ liệu vào model.',
  '- Gọi trực tiếp router; các lối tắt explicit entity list của orchestrator và bước memory/context khác của core không được replay. Lỗi list ở đây cần phân biệt với kết quả toàn luồng.',
  '- Một số câu trong lịch sử có thể trùng examples đã lập chỉ mục; đây là bộ regression thực tế, không phải tập holdout độc lập.', '');
rows.push('## Ưu tiên xử lý từ các lỗi quan sát', '',
  '1. Phân biệt câu hỏi giải thích khả năng tổng hợp với yêu cầu chạy báo cáo; shortlist đúng không bảo đảm route đúng.',
  '2. Input đã được nói rõ phải được lấy hoặc đánh giá lại: tên nhân viên và drawChart=true đang bị bỏ trống trong một số quyết định TEV1.',
  '3. Yêu cầu danh sách không được chọn lookup targeted. Kiểm tra thêm toàn luồng để xác định lối tắt reviewed schema hiện tại đã xử lý các câu viết tắt này chưa.',
  '4. Rerun tập này sau sửa và mở rộng catalog 20/50/100 để đo lợi ích retrieval; hiện nhóm 2,89/3 nên chưa giảm nhiều context.', '');
const markdown = path.join(root, 'history-routing-evaluation.md');
fs.writeFileSync(markdown, rows.join('\n'));
console.log(JSON.stringify({ summaries: report.summaries, comparison: report.comparison, report: markdown }));
