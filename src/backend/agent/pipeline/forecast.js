'use strict';

// Monthly forecast computed by code from the verified rows, never by the
// model. A short history gets the observed average (a trend fitted to two or
// three months extrapolates noise); six months or more get a least-squares
// trend over the last twelve. No seasonality is modelled and the answer says so.
const catalogApi = require('./query_catalog');

const METHOD = Object.freeze({ minHistory: 2, trendHistory: 6, window: 12, maxGap: 6, defaultHorizon: 3, maxHorizon: 12 });
const fold = value => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ');
const index = label => Number(label.slice(0, 4)) * 12 + Number(label.slice(5, 7)) - 1;
const label = value => `${Math.floor(value / 12)}-${String(value % 12 + 1).padStart(2, '0')}`;
const shown = value => `${value.slice(5, 7)}/${value.slice(0, 4)}`;
const number = value => new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 }).format(value);

function asked(question) {
  return /\b(du bao|du doan|forecast|predict)/.test(fold(question));
}

// The months a question asks to forecast, and the words that name them.
// "N tháng tới" counts from the request month; "tháng 3,4" without a year
// means the next March and April after the last month with data.
function targets(question) {
  const text = fold(question), phrases = [];
  const upcoming = text.match(/\b(\d{1,2}) ?thang ?(?:toi|tiep theo|ke tiep|sap toi|sau)\b/) || text.match(/\bnext (\d{1,2}) months?\b/);
  if (upcoming) phrases.push(upcoming[0]);
  const single = !upcoming && (text.match(/\bthang (?:toi|sau|ke tiep|tiep theo)\b/) || text.match(/\bnext month\b/));
  if (single) phrases.push(single[0]);
  const months = [];
  for (const match of text.matchAll(/\bthang ?(\d{1,2}(?: ?(?:,|va|-|den|toi) ?(?:thang ?)?\d{1,2}(?!\d))*)(?: ?(?:\/|nam) ?(\d{4}))?/g)) {
    const parts = [...match[1].matchAll(/(\d{1,2})|(-|den|toi)/g)];
    const list = [];
    for (let i = 0; i < parts.length; i++) {
      const value = Number(parts[i][1]);
      if (!parts[i][1]) continue;
      const previous = list.at(-1);
      if (parts[i - 1]?.[2] && previous && value > previous) for (let month = previous + 1; month < value; month++) list.push(month);
      list.push(value);
    }
    const valid = list.filter(month => month >= 1 && month <= 12);
    if (!valid.length) continue;
    phrases.push(match[0]);
    months.push(...valid.map(month => ({ month, year: match[2] ? Number(match[2]) : null })));
  }
  for (const match of text.matchAll(/\b(\d{4})-(\d{1,2})\b/g)) {
    if (Number(match[2]) < 1 || Number(match[2]) > 12) continue;
    phrases.push(match[0]); months.push({ month: Number(match[2]), year: Number(match[1]) });
  }
  return { upcoming: upcoming ? Number(upcoming[1]) : single ? 1 : null, months, phrases };
}

// Forecast months against the history: explicit ones first, then "N tháng
// tới" from today, else the months right after the data.
function resolveTargets(wanted, last, today) {
  let list;
  if (wanted.months.length) list = wanted.months.map(({ month, year }) => {
    if (year) return year * 12 + month - 1;
    let value = Math.floor(last / 12) * 12 + month - 1;
    while (value <= last) value += 12;
    return value;
  });
  else if (wanted.upcoming) {
    const now = index(String(today).slice(0, 7));
    list = Array.from({ length: wanted.upcoming }, (_, i) => now + 1 + i);
  } else list = Array.from({ length: METHOD.defaultHorizon }, (_, i) => last + 1 + i);
  return [...new Set(list)].sort((a, b) => a - b).slice(0, METHOD.maxHorizon);
}

// Changes a forecast contract needs before it is compiled: the forecast
// months are not a filter on the history, and the history is monthly.
function prepare(contract, catalog, texts) {
  const phrases = texts.flatMap(text => targets(text).phrases).filter(Boolean);
  const isTarget = filter => {
    const evidence = fold(filter.evidence);
    return evidence && phrases.some(phrase => phrase.includes(evidence) || evidence.includes(phrase));
  };
  const changes = [];
  const parts = [contract, ...(contract.also || [])];
  for (const part of parts) {
    const kept = (part.filters || []).filter(filter => !isTarget(filter));
    if (kept.length !== (part.filters || []).length) { changes.push(...part.filters.filter(isTarget).map(filter => `dropped:${filter.ref}`)); part.filters = kept; }
  }
  if (contract.measures?.length && contract.operation !== 'aggregate') { contract.operation = 'aggregate'; changes.push('operation:aggregate'); }
  const groups = contract.groupBy || [];
  if (groups.some(group => group.grain && group.grain !== 'month')) {
    contract.groupBy = groups.map(group => group.grain ? { ...group, grain: 'month' } : group); changes.push('grain:month');
  } else if (!groups.some(group => group.grain)) {
    const date = dateColumn(contract, catalog);
    if (date) { contract.groupBy = [{ ref: date, grain: 'month' }, ...groups]; changes.push(`groupBy:${date}`); }
  }
  return changes;
}

// The business date of a contract: its first metric's date, else the table's.
function dateColumn(contract, catalog) {
  const metric = contract.measures?.map(item => item.metric && catalogApi.metric(catalog, item.metric)).find(Boolean);
  const root = catalogApi.table(catalog, contract.root || metric?.table);
  const column = metric?.dateColumn || root?.dateColumn;
  return root && column ? `${root.tableName}.${column}` : null;
}

function project(points, at) {
  const values = points.map(point => point.value);
  if (points.length < METHOD.trendHistory) {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return { method: 'mean', value: mean, low: Math.min(...values), high: Math.max(...values) };
  }
  const n = points.length, xs = points.map(point => point.x);
  const meanX = xs.reduce((a, b) => a + b, 0) / n, meanY = values.reduce((a, b) => a + b, 0) / n;
  const slope = points.reduce((sum, point) => sum + (point.x - meanX) * (point.value - meanY), 0) / points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  const fit = x => meanY + slope * (x - meanX);
  const spread = Math.sqrt(points.reduce((sum, point) => sum + (point.value - fit(point.x)) ** 2, 0) / (n - 2));
  const value = Math.max(0, fit(at));
  return { method: 'trend', value, low: Math.max(0, value - spread), high: value + spread, slope };
}

// The forecast answer. `actual` is the table of the history rows.
function reply({ call, compiled, question, today, actual }) {
  const bound = require('../harness/chart_evidence').bindMonthly({ type: 'line' }, call);
  const history = actual ? `\n\n**Số liệu thực tế dùng để dự báo:**\n\n${actual}` : '';
  if (!bound) return `**Chưa dự báo được:** kết quả không phải một chuỗi số liệu theo tháng (mỗi tháng một dòng, giá trị đầy đủ).${history}`;
  const labels = bound.labels;
  if (labels.length < METHOD.minHistory)
    return `**Chưa đủ dữ liệu để dự báo:** mới có ${labels.length} tháng có số liệu (${labels.map(shown).join(', ')}); cần ít nhất ${METHOD.minHistory} tháng.${history}`;
  const last = index(labels.at(-1));
  let months = resolveTargets(targets(question), last, today);
  const notes = [];
  const known = months.filter(month => month <= last);
  if (known.length) notes.push(`${known.map(month => shown(label(month))).join(', ')} đã có số liệu thực tế (xem bảng bên dưới), không dự báo lại.`);
  months = months.filter(month => month > last);
  if (months.length && months[0] - last > METHOD.maxGap) {
    const count = months.length;
    notes.push(`Dữ liệu chỉ có đến ${shown(labels.at(-1))}, cách ${shown(label(months[0]))} ${months[0] - last} tháng, quá xa để dự báo trực tiếp. Dưới đây là ước tính cho ${count} tháng ngay sau tháng có số liệu cuối cùng.`);
    months = Array.from({ length: count }, (_, i) => last + 1 + i);
  }
  if (!months.length) return `${notes.join(' ')}${history}`;
  const units = new Map(compiled.outputs.filter(item => item.kind === 'measure').map(item => [item.alias, item.unit]));
  const window = labels.slice(-METHOD.window);
  const series = bound.datasets.map(dataset => {
    const points = labels.map((period, i) => ({ x: index(period), value: dataset.data[i] })).slice(-METHOD.window);
    return { name: dataset.label, unit: units.get(dataset.label) || '', points, forecasts: months.map(month => project(points, month)) };
  });
  const head = `| Tháng | ${series.map(item => `${item.name}${item.unit ? ` (${item.unit})` : ''}`).join(' | ')} |\n| --- |${series.map(() => ' --- |').join('')}`;
  const lines = months.map((month, i) => `| ${shown(label(month))} | ${series.map(item => {
    const value = item.forecasts[i];
    return `${number(value.value)} (${number(value.low)} – ${number(value.high)})`;
  }).join(' | ')} |`);
  const trend = series[0].forecasts[0].method === 'trend';
  const missing = [];
  for (let month = index(window[0]); month <= index(window.at(-1)); month++) if (!window.includes(label(month))) missing.push(shown(label(month)));
  const range = `${shown(window[0])} – ${shown(window.at(-1))}`;
  const method = trend
    ? `xu hướng tuyến tính theo ${window.length} tháng có số liệu (${range}); khoảng trong ngoặc là ± độ lệch chuẩn của số liệu thực tế quanh đường xu hướng. `
      + series.map(item => `${item.name} ${item.forecasts[0].slope < 0 ? 'giảm' : 'tăng'} khoảng ${number(Math.abs(item.forecasts[0].slope))}${item.unit ? ` ${item.unit}` : ''} mỗi tháng`).join('; ') + '.'
    : `trung bình ${window.length} tháng có số liệu (${range}); khoảng trong ngoặc là mức thấp nhất – cao nhất đã ghi nhận. Chuỗi mới có ${window.length} tháng nên chưa tính xu hướng (cần ít nhất ${METHOD.trendHistory} tháng).`;
  const confidence = trend && window.length >= METHOD.window ? 'trung bình' : 'thấp';
  return (notes.length ? `**Lưu ý:** ${notes.join(' ')}\n\n` : '')
    + `**Dự báo ${months.length === 1 ? shown(label(months[0])) : `${shown(label(months[0]))} – ${shown(label(months.at(-1)))}`}** (số ước tính, không phải số liệu thực tế):\n\n${head}\n${lines.join('\n')}`
    + `\n\n**Cách ước tính:** ${method}`
    + (missing.length ? ` Không có số liệu ở ${missing.join(', ')}; các tháng này không được tính là 0.` : '')
    + `\n\n**Độ tin cậy:** ${confidence}. Chưa tính yếu tố mùa vụ, giá hay thay đổi hoạt động; chỉ nên dùng để tham khảo.`
    + history;
}

module.exports = { asked, targets, resolveTargets, prepare, dateColumn, project, reply, METHOD };
