'use strict';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const safeCell = value => typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(value) ? `'${value}` : value;
const safeRows = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [String(safeCell(key)), safeCell(value)])));
function toCsv(rows) {
  const data = safeRows(rows), keys = Object.keys(data[0] || {}), quote = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return '\uFEFF' + [keys.map(quote).join(','), ...data.map(row => keys.map(key => quote(row[key])).join(','))].join('\n');
}
module.exports = { safeCell, safeRows, toCsv, escapeHtml };
