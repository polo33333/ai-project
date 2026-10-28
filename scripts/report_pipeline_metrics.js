'use strict';

// Pipeline metrics from the chat audit log, as JSON and a self-contained HTML
// page. Reads the configured application storage; never writes to it.
//
//   node scripts/report_pipeline_metrics.js [--days 14] [--out output/pipeline-metrics] [--input history.json]
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, list) =>
  value.startsWith('--') ? [...pairs, [value.slice(2), list[index + 1]?.startsWith('--') ? true : list[index + 1] ?? true]] : pairs, []));
const { computeMetrics } = require(path.join(root, 'src/backend/training/pipeline_metrics'));

async function loadHistory() {
  if (args.input) return JSON.parse(fs.readFileSync(path.resolve(String(args.input)), 'utf8'));
  const storage = require(path.join(root, 'src/backend/storage'));
  storage.loadEnvironment();
  if (!storage.enabled()) return JSON.parse(fs.readFileSync(path.join(root, 'data', 'chat_history.json'), 'utf8'));
  await storage.bootstrapStorage();
  try { return await storage.run(() => structuredClone(storage.read('chat_history.json', [])), { files: ['chat_history.json'] }); }
  finally { await storage.close(); }
}

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const percent = value => value === null || value === undefined ? '—' : `${(value * 100).toFixed(1).replace('.', ',')}%`;
const number = value => value === null || value === undefined ? '—' : new Intl.NumberFormat('vi-VN').format(value);
const seconds = value => value === null || value === undefined ? '—' : `${(value / 1000).toFixed(1).replace('.', ',')} s`;
const ROUTES = { v2: 'v2 trả lời trọn', v2_fallback: 'v2 chuyển sang vòng dự phòng', agent_loop: 'Vòng tác tử (không qua v2)',
  legacy: 'Đường cũ / chưa có vết', error: 'Lỗi', local_model: 'Vòng mô hình cục bộ' };

function tile(label, value, note = '') {
  return `<div class="tile"><div class="label">${escape(label)}</div><div class="value">${value}</div>${note ? `<div class="note">${escape(note)}</div>` : ''}</div>`;
}

function barTable(title, items, columns = [], max = Math.max(1, ...items.map(item => item.count))) {
  if (!items.length) return `<section><h2>${escape(title)}</h2><p class="muted">Chưa có dữ liệu.</p></section>`;
  return `<section><h2>${escape(title)}</h2><div class="tablewrap"><table><thead><tr><th>Mục</th><th class="num">Số lượt</th>${columns.map(column => `<th class="num">${escape(column.label)}</th>`).join('')}</tr></thead><tbody>${
    items.map(item => `<tr><td><div class="name">${escape(item.label || item.name)}</div><div class="bar"><span style="width:${(item.count / max * 100).toFixed(1)}%"></span></div></td><td class="num">${number(item.count)}</td>${
      columns.map(column => `<td class="num">${column.format(item)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>`;
}

// Document questions (RAG): retrieval health and citation quality.
function ragSection(rag) {
  if (!rag?.total) return '<section><h2>Hỏi đáp tài liệu (RAG)</h2><p class="muted">Chưa có lượt hỏi tài liệu trong kỳ.</p></section>';
  return `<section><h2>Hỏi đáp tài liệu (RAG)</h2><div class="tiles">
${tile('Lượt hỏi tài liệu', number(rag.total))}
${tile('PARTIAL', percent(rag.partialRate), 'mục tiêu ≤ 5%')}
${tile('Phải sửa trích dẫn', percent(rag.citationRepairRate), 'thêm một lần gọi mô hình')}
${tile('Truy hồi rỗng', percent(rag.emptyRetrievalRate))}
${tile('Suy giảm (mất vector)', percent(rag.degradedRate), 'chỉ còn tìm từ khóa')}
${tile('Trích dẫn sai nội dung', percent(rag.unsupportedClaimRate), `số, ngày, mã không có trong đoạn · ${number(rag.claimsChecked)} lượt đã kiểm`)}
${tile('Thời gian p50 / p90', `${seconds(rag.latencyMs.p50)} / ${seconds(rag.latencyMs.p90)}`, 'mục tiêu p90 ≤ 6 s')}
</div></section>
<div class="grid">${barTable('Chế độ truy hồi', rag.modes)}${barTable('Cách hiểu câu hỏi tài liệu', rag.methods)}</div>`;
}

// Where v2 sent each question: documents, data or conversation, and how often the document signal changed it.
function routingSection(routing) {
  if (!routing?.total) return '<section><h2>Định tuyến tài liệu / dữ liệu / trò chuyện</h2><p class="muted">Chưa có lượt nào ghi quyết định định tuyến.</p></section>';
  return `<section><h2>Định tuyến tài liệu / dữ liệu / trò chuyện</h2><div class="tiles">
${tile('Lượt có ghi định tuyến', number(routing.total))}
${tile('Tín hiệu tài liệu đổi đường', percent(routing.overrideRate), `${number(routing.overrides)} lượt chuyển sang tài liệu`)}
${tile('Bất đồng với mô hình', number(routing.conflicts), 'mô hình chọn dữ liệu, tín hiệu tài liệu mạnh; giữ dữ liệu')}
${tile('Tín hiệu tài liệu mạnh', percent(routing.strongSignalRate))}
${tile('Khớp tài liệu chưa được phép gửi', number(routing.blocked), 'người dùng nhận thông báo cấp quyền')}
</div></section>
<div class="grid">${barTable('Đường cuối cùng', routing.finals)}${barTable('Cách quyết định', routing.paths)}</div>`;
}

function render(metrics, { days }) {
  const v2 = metrics.v2Era;
  const routeColumns = [{ label: 'Thành công', format: item => percent(item.successRate) },
    { label: 'Gọi mô hình p50 / p95', format: item => `${number(item.modelCalls.p50)} / ${number(item.modelCalls.p95)}` },
    { label: 'Thời gian p50 / p95', format: item => `${seconds(item.latencyMs.p50)} / ${seconds(item.latencyMs.p95)}` },
    { label: 'Token vào TB', format: item => number(item.inputTokens.mean) }];
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chỉ số đường xử lý</title>
<style>
:root{--bg:#f6f7f9;--surface:#fff;--surface-2:#f0f2f5;--border:#e2e5ea;--text:#1b1f27;--muted:#5d6675;--accent:#2f5bd3}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#111318;--surface:#181b22;--surface-2:#1f232c;--border:#2b303b;--text:#e6e8ec;--muted:#9aa3b2;--accent:#7c9cf5}}
:root[data-theme="dark"]{--bg:#111318;--surface:#181b22;--surface-2:#1f232c;--border:#2b303b;--text:#e6e8ec;--muted:#9aa3b2;--accent:#7c9cf5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 16px 64px}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 10px}
.muted{color:var(--muted)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:18px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px}.tile .label{font-size:12.5px;color:var(--muted)}
.tile .value{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}.tile .note{font-size:12px;color:var(--muted)}
.tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px;background:var(--surface)}
table{width:100%;border-collapse:collapse}th,td{padding:8px 10px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}
th{font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);background:var(--surface-2)}tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.bar{height:5px;background:var(--surface-2);border-radius:3px;margin-top:4px;min-width:120px}
.bar span{display:block;height:100%;background:var(--accent);border-radius:3px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 20px}
@media (max-width:820px){.grid{grid-template-columns:minmax(0,1fr)}}
</style></head><body><main>
<h1>Chỉ số đường xử lý câu hỏi</h1>
<p class="muted">Từ nhật ký chat ${escape(metrics.window.from?.slice(0, 10) || '—')} → ${escape(metrics.window.to?.slice(0, 10) || '—')} (${days ? `${days} ngày gần nhất` : 'toàn bộ'}), bỏ các phiên đánh giá tự động. v2 bắt đầu xuất hiện: ${escape(metrics.window.firstV2?.slice(0, 10) || 'chưa có')}.</p>
<div class="tiles">
${tile('Số lượt', number(metrics.overall.total))}
${tile('Thành công (toàn kỳ)', percent(metrics.overall.successRate), `PARTIAL ${number(metrics.overall.byStatus.PARTIAL)} · lỗi ${number(metrics.overall.byStatus.ERROR)}`)}
${tile('v2 trả lời trọn', percent(v2.deterministicShare), 'trong các câu đi vào v2')}
${tile('v2 chuyển dự phòng', percent(v2.fallbackShare))}
${tile('Hỏi lại người dùng (từ v2)', percent(v2.clarifyRate))}
${tile('Câu tổng hợp qua chỉ tiêu', percent(v2.metricShare), 'chỉ tiêu nghiệp vụ đã duyệt')}
${tile('Gọi mô hình p50 / p95', `${number(v2.modelCalls.p50)} / ${number(v2.modelCalls.p95)}`, 'từ khi có v2')}
${tile('Thời gian p50 / p95', `${seconds(v2.latencyMs.p50)} / ${seconds(v2.latencyMs.p95)}`, 'từ khi có v2')}
${tile('Token đọc từ bộ đệm', percent(metrics.overall.cache.cachedShare), `${number(metrics.overall.cache.cachedInputTokens)} / ${number(metrics.overall.cache.inputTokens)} token vào`)}
</div>
${ragSection(metrics.rag)}
${routingSection(metrics.routing)}
${barTable('Theo đường xử lý', metrics.routes.map(item => ({ ...item, label: ROUTES[item.name] || item.name })), routeColumns)}
<div class="grid">
${barTable('Lý do v2 chuyển sang vòng dự phòng', metrics.fallbackCodes)}
${barTable('Lỗi đánh giá câu trả lời hay gặp', metrics.failures)}
${barTable('Loại hợp đồng v2', metrics.contractKinds)}
${barTable('Thao tác', metrics.operations)}
${barTable('Chỉ tiêu dùng trong câu tổng hợp v2', metrics.metrics)}
${barTable('Lần gọi mô hình theo bước', metrics.stages, [{ label: 'Token vào TB', format: item => number(item.inputTokens.mean) }])}
${barTable('Nhà cung cấp', metrics.providers)}
</div>
<section><h2>Theo ngày</h2><div class="tablewrap"><table><thead><tr><th>Ngày</th><th class="num">Lượt</th><th class="num">Thành công</th><th class="num">v2 trả lời trọn</th><th class="num">Thời gian p50</th><th class="num">Gọi mô hình p50</th><th class="num">Token vào TB</th></tr></thead><tbody>
${metrics.daily.slice().reverse().map(day => `<tr><td>${escape(day.day)}</td><td class="num">${number(day.total)}</td><td class="num">${percent(day.successRate)}</td><td class="num">${percent(day.v2Share)}</td><td class="num">${seconds(day.latencyP50)}</td><td class="num">${number(day.modelCallsP50)}</td><td class="num">${number(day.inputTokensMean)}</td></tr>`).join('')}
</tbody></table></div></section>
<p class="muted" style="margin-top:28px">"Thành công" là trạng thái hoàn tất do backend tự đánh giá, chưa phải độ đúng nghiệp vụ; độ đúng đo bằng bộ câu hỏi chuẩn (npm run eval:live). Lượt trước khi có v2 không có vết đường xử lý và được xếp vào "Đường cũ / chưa có vết".</p>
</main></body></html>`;
}

if (require.main === module) (async () => {
  const days = args.days === undefined ? 14 : Number(args.days) || null;
  const history = await loadHistory();
  const since = days ? new Date(Date.now() - days * 86400000) : null;
  const metrics = computeMetrics(history, { since });
  const outDir = path.resolve(root, String(args.out || 'output/pipeline-metrics'));
  fs.mkdirSync(outDir, { recursive: true });
  const now = new Date(), stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  fs.writeFileSync(path.join(outDir, `pipeline-metrics-${stamp}.json`), JSON.stringify(metrics, null, 2));
  fs.writeFileSync(path.join(outDir, `pipeline-metrics-${stamp}.html`), render(metrics, { days }));
  console.log(JSON.stringify({ out: path.relative(root, path.join(outDir, `pipeline-metrics-${stamp}.html`)), total: metrics.overall.total,
    successRate: metrics.overall.successRate, v2: { deterministicShare: metrics.v2Era.deterministicShare, fallbackShare: metrics.v2Era.fallbackShare,
      clarifyRate: metrics.v2Era.clarifyRate, metricShare: metrics.v2Era.metricShare, modelCalls: metrics.v2Era.modelCalls, latencyMs: metrics.v2Era.latencyMs } }, null, 2));
})().catch(error => { console.error('METRICS_FAILED', error.message); process.exitCode = 1; });

module.exports = { render };
