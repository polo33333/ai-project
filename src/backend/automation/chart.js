'use strict';
const { ensure } = require('./contract');

// Keep chart data declarative so the browser renders labels as text, never HTML.
function createChart(config) {
  ensure(Array.isArray(config.data) && config.data.length <= 100, 'Biểu đồ cần tối đa 100 dòng.');
  const points = config.data.map(row => {
    const value = row[config.y];
    ensure(typeof value === 'number' && Number.isFinite(value) && value >= 0, 'Sản lượng biểu đồ phải là số không âm.');
    ensure(typeof row[config.x] === 'string', 'Nhãn biểu đồ phải là chuỗi.');
    return { label: row[config.x], value };
  });
  return { kind: 'bar-chart', title: String(config.title || ''), unit: String(config.unit || ''), points };
}
module.exports = { createChart };
