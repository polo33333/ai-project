'use strict';
function format(value, label = '', unit = '') {
  const text = String(label) + ' ' + String(unit || '');
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').replace(/\bhop dong\b/gi, '');
  // "hợp đồng" means contract, not the currency; identifier columns are never money.
  if (/\bid\b|^\s*ma\b/i.test(normalized) || /[a-z]ID\b/.test(text)) return value;
  const currency = /\b(?:VND|VNd|dong)\b|₫/i.test(normalized) ? 'VND'
    : /\b(USD|EUR|GBP|JPY)\b/i.exec(text)?.[1]?.toUpperCase();
  const monetary = currency || /amount|money|price|balance|\b(?:tien|gia|cong no|doanh thu|chi phi)\b/i.test(normalized);
  if (!monetary || value === null || value === undefined || value === ''
    || !(typeof value === 'number' || typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value))
    || !Number.isFinite(Number(value))) return value;
  return new Intl.NumberFormat('vi-VN', { ...(currency ? { style: 'currency', currency } : {}),
    minimumFractionDigits: 0, maximumFractionDigits: 20 }).format(value);
}
module.exports = { format };
