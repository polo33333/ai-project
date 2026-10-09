/* Shared tool activity UI for page chat, copilot popup and standalone embed. */
(function (root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const meta = {
    execute_sql_query: ['Truy vấn dữ liệu', 'fa-database', 'database'],
    render_chart: ['Vẽ biểu đồ', 'fa-chart-column', 'chart'],
    export_data: ['Xuất file', 'fa-file-arrow-down', 'file'],
    validate_sql: ['Kiểm tra truy vấn', 'fa-shield-halved', 'check'],
    repair_sql: ['Sửa truy vấn', 'fa-wrench', 'tool'],
    search_schema: ['Tìm cấu trúc dữ liệu', 'fa-magnifying-glass', 'search'],
    calculate_stats: ['Tính thống kê', 'fa-calculator', 'chart'],
    get_current_datetime: ['Thời gian hệ thống', 'fa-clock', 'clock']
  };
  const paths = {
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
    chart: '<path d="M4 3v17h17M8 16v-5m5 5V6m5 10V9"/>',
    file: '<path d="M14 2H5v20h14V7l-5-5v5h5M12 10v8m-3-3 3 3 3-3"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    tool: '<path d="M14 4a6 6 0 0 0-7 7l-5 5 4 4 5-5a6 6 0 0 0 7-7l-4 4-4-4 4-4Z"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>'
  };
  function icon(fa, svg, vector) {
    return vector ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[svg]}</svg>`
      : `<i class="fa-solid ${fa}" aria-hidden="true"></i>`;
  }
  function duration(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '';
    return number < 1000 ? `${Math.round(number)} ms` : `${new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(number / 1000)} giây`;
  }
  function render(toolCalls, options = {}) {
    if (!Array.isArray(toolCalls)) return '';
    const calls = toolCalls.filter(item => item && typeof item === 'object');
    if (!calls.length) return '';
    const vector = options.vectorIcons === true;
    const failures = calls.filter(item => item.success === false || item.error).length;
    const steps = calls.map((item, index) => {
      const name = String(item.name || item.toolName || 'tool');
      const [label, fa, svg] = meta[name] || ['Công cụ', 'fa-wrench', 'tool'];
      const failed = item.success === false || Boolean(item.error);
      const time = item.durationMs == null ? '' : duration(item.durationMs);
      const rowCount = Number(item.rowCount);
      const rows = item.rowCount != null && Number.isSafeInteger(rowCount) && rowCount >= 0 ? `${new Intl.NumberFormat('vi-VN').format(rowCount)} dòng` : '';
      return `<li class="kai-tool-step${failed ? ' is-error' : ''}">
        <span class="kai-tool-icon">${icon(fa, svg, vector)}</span>
        <div class="kai-tool-info kai-tool-balanced"><div class="kai-tool-identity"><strong><span class="kai-tool-step-number" aria-label="Bước ${index + 1}">${index + 1}.</span> ${escape(label)}</strong><div class="kai-tool-subtitle"><code class="kai-tool-name">${escape(name)}</code>${rows ? `<span class="kai-tool-chip">${icon('fa-list-ul', 'layers', vector)}${escape(rows)}</span>` : ''}</div></div>
          <div class="kai-tool-metrics">${time ? `<time class="kai-tool-chip">${icon('fa-clock', 'clock', vector)}${escape(time)}</time>` : ''}<span class="kai-tool-state">${icon(failed ? 'fa-circle-exclamation' : 'fa-circle-check', failed ? 'tool' : 'check', vector)}${failed ? 'Không thành công' : 'Thành công'}</span></div>
          ${item.error ? `<p class="kai-tool-error">${escape(item.error)}</p>` : ''}
        </div></li>`;
    }).join('');
    return `<details class="kai-tool-panel" open><summary><span class="kai-tool-summary-icon">${icon('fa-layer-group', 'layers', vector)}</span><span class="kai-tool-summary-title">Công cụ đã sử dụng</span><span class="kai-tool-count">${calls.length} bước</span>${failures ? `<span class="kai-tool-failures">${failures} lỗi</span>` : ''}<span class="kai-tool-chevron">${icon('fa-chevron-down', 'chevron', vector)}</span></summary><ol class="kai-tool-list">${steps}</ol></details>`;
  }
  const styles = `
    .kai-tool-panel{--kt-bg:#fff;--kt-surface:#f7f8fc;--kt-border:#e4e9f2;--kt-text:#334155;--kt-muted:#7b8799;--kt-accent:#735bd4;--kt-icon:#f0edfc;--kt-success:#19734c;--kt-success-bg:#edf8f1;--kt-error:#b34242;--kt-error-bg:#fff0ef;margin:12px 0;border:1px solid var(--kt-border);border-radius:12px;background:var(--kt-bg);color:var(--kt-text);overflow:hidden;font:400 12px/1.6 Inter,system-ui,sans-serif;min-width:0;box-sizing:border-box}
    .kai-tool-panel>summary{display:flex;align-items:center;gap:9px;padding:12px 14px;cursor:pointer;list-style:none;background:var(--kt-surface);user-select:none}
    .kai-tool-panel>summary::-webkit-details-marker{display:none}.kai-tool-panel>summary:focus-visible{outline:2px solid var(--kt-accent);outline-offset:-3px;border-radius:10px}
    .kai-tool-summary-icon{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;background:var(--kt-icon);color:var(--kt-accent);flex-shrink:0}
    .kai-tool-summary-title{font-weight:600}.kai-tool-count,.kai-tool-failures{font-size:10px;font-weight:600;padding:2px 7px;border-radius:5px;background:var(--kt-icon);color:var(--kt-accent);white-space:nowrap}.kai-tool-failures{background:var(--kt-error-bg);color:var(--kt-error)}
    .kai-tool-chevron{margin-left:auto;display:flex;color:var(--kt-muted);transition:transform .15s}.kai-tool-panel[open] .kai-tool-chevron{transform:rotate(180deg)}
    .kai-tool-panel .kai-tool-list{list-style:none;margin:0;padding:0 14px;border-top:1px solid var(--kt-border)}
    .kai-tool-panel .kai-tool-step{display:flex;align-items:flex-start;gap:12px;padding:14px 0;margin:0;border-bottom:1px solid var(--kt-border)}.kai-tool-step:last-child{border-bottom:0}
    .kai-tool-icon{display:grid;place-items:center;flex:0 0 34px;height:34px;border:1px solid var(--kt-border);border-radius:10px;color:var(--kt-accent);background:var(--kt-surface)}
    .kai-tool-info{flex:1;min-width:0}.kai-tool-title{display:flex;align-items:center;justify-content:flex-start;gap:10px;flex-wrap:wrap}.kai-tool-title>strong{font-weight:600;font-size:13px;color:var(--kt-text)}
    .kai-tool-state{display:inline-flex;align-items:center;gap:5px;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:500;color:var(--kt-success);background:var(--kt-success-bg)}.kai-tool-state::before{content:"";height:5px;width:5px;background:currentColor;border-radius:50%;flex-shrink:0}.is-error .kai-tool-state{color:var(--kt-error);background:var(--kt-error-bg)}
    .kai-tool-meta{display:flex;align-items:center;gap:8px 16px;flex-wrap:wrap;margin:6px 0 0;color:var(--kt-text);font-size:11px;font-variant-numeric:tabular-nums}.kai-tool-meta>time{display:inline-flex;align-items:center;gap:5px}.kai-tool-meta>span{display:inline-flex;align-items:center;gap:5px}.kai-tool-meta-label,.kai-tool-meta>time>i,.kai-tool-meta>time>svg,.kai-tool-order{color:var(--kt-muted)}.kai-tool-meta:empty{display:none}
    .kai-tool-panel .kai-tool-name{display:block;width:fit-content;max-width:100%;background:transparent;color:var(--kt-muted);padding:0;border:0;font:10px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}
    .kai-tool-info{display:grid;grid-template-columns:minmax(160px,1fr) minmax(140px,1fr) auto;align-items:center;gap:12px 24px}
    .kai-tool-title{display:contents}.kai-tool-title>strong{grid-column:1;grid-row:1}.kai-tool-title>.kai-tool-state{grid-column:3;grid-row:1;justify-self:end;white-space:nowrap}
    .kai-tool-meta{grid-column:2;grid-row:1;margin:0;justify-content:flex-start}
    .kai-tool-info>.kai-tool-name{display:block;grid-column:1;grid-row:2;margin:0}
    .kai-tool-elapsed{grid-column:3;grid-row:2;justify-self:end;display:inline-flex;align-items:center;gap:5px;color:var(--kt-muted);font-size:11px;font-variant-numeric:tabular-nums}
    .kai-tool-elapsed svg{width:12px;height:12px}.kai-tool-error{grid-column:1 / -1}
    .kai-tool-panel .kai-tool-step{align-items:center}
    .kai-tool-error{margin:8px 0 0;padding:8px 10px;border-radius:7px;background:var(--kt-error-bg);color:var(--kt-error);font-size:11px;line-height:1.6;overflow-wrap:anywhere}
    .kai-tool-panel svg{width:15px;height:15px;flex-shrink:0}.kai-tool-meta svg{width:12px;height:12px}.kai-tool-icon svg{width:17px;height:17px}
    :root[data-theme="dark"] .kai-tool-panel,.kh-embed-root.dark .kai-tool-panel{--kt-bg:#182438;--kt-surface:#1d2a3e;--kt-border:#334158;--kt-text:#e2e8f0;--kt-muted:#9aa8bc;--kt-accent:#b7a5f3;--kt-icon:#302b49;--kt-success:#8bd8b0;--kt-success-bg:#203d33;--kt-error:#f3a3ad;--kt-error-bg:#3e2932}
    .kai-tool-panel{container-type:inline-size}
    @container(max-width:560px){.kai-tool-info{grid-template-columns:minmax(0,1fr) auto;gap:6px 10px}.kai-tool-title>.kai-tool-state{grid-column:2}.kai-tool-elapsed{grid-column:2}.kai-tool-meta{grid-column:1 / -1;grid-row:3}.kai-tool-panel .kai-tool-step{align-items:flex-start}}
    @media(max-width:500px){.kai-tool-panel>summary{gap:7px;padding:10px}.kai-tool-summary-title{font-size:11px}.kai-tool-panel .kai-tool-list{padding:0 10px}.kai-tool-panel .kai-tool-step{gap:9px}.kai-tool-state{font-size:9px}.kai-tool-title{gap:5px}}
    .kai-tool-balanced.kai-tool-info{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px 24px;align-items:center}
    .kai-tool-identity{min-width:0}.kai-tool-identity>strong{font-size:14px;font-weight:600;color:var(--kt-text)}
    .kai-tool-step-number{color:var(--kt-muted);font-variant-numeric:tabular-nums;margin-right:3px}
    .kai-tool-subtitle{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:5px}
    .kai-tool-panel .kai-tool-subtitle .kai-tool-name{font-size:11px;margin:0}
    .kai-tool-metrics{display:grid;grid-template-columns:90px 140px;align-items:center;gap:12px}
    .kai-tool-metrics>time{grid-column:1;justify-self:end;min-height:30px;box-sizing:border-box}
    .kai-tool-metrics>.kai-tool-state{grid-column:2;grid-row:1;justify-content:center;width:100%;min-height:30px;box-sizing:border-box}
    .kai-tool-chip{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:999px;background:var(--kt-surface);color:var(--kt-muted);font-size:11px;font-weight:500;white-space:nowrap;font-variant-numeric:tabular-nums}
    .kai-tool-metrics .kai-tool-state{padding:6px 10px;border-radius:999px;font-size:11px;gap:7px;white-space:nowrap}
    .kai-tool-metrics .kai-tool-state::before{display:none}
    .kai-tool-balanced>.kai-tool-error{grid-column:1 / -1}
    @container(max-width:560px){.kai-tool-balanced.kai-tool-info{grid-template-columns:minmax(0,1fr);gap:10px}.kai-tool-metrics{justify-content:start;grid-template-columns:90px 140px;gap:12px}.kai-tool-chip,.kai-tool-metrics .kai-tool-state{padding:4px 8px}}
    @container(max-width:300px){.kai-tool-metrics{grid-template-columns:70px minmax(0,140px);gap:8px}}
    @media(prefers-reduced-motion:reduce){.kai-tool-chevron{transition:none}}
  `;
  root.ChatToolUI = { render, styles };
  if (typeof document !== 'undefined' && !document.getElementById('kai-tool-ui-styles')) {
    const style = document.createElement('style'); style.id = 'kai-tool-ui-styles'; style.textContent = styles; document.head.appendChild(style);
  }
})(typeof window === 'undefined' ? globalThis : window);
