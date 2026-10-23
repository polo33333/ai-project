'use strict';
const { normalize } = require('../training_core/request_planner');
function dependsOnPrevious(question) {
  // normalize() drops accents, so "biểu đồ" would read as "đó" ("that"): keep "đồ" distinct.
  const text = normalize(String(question).replace(/đồ/giu, 'đồx'));
  return /\b(?:ds|danh sach|ket qua|du lieu|bang|nhom|ban ghi|nguoi|nhan vien|khach hang|hop dong|file|bao cao)\b.{0,65}\b(?:tren(?!\s*\d)|do|nay|vua roi)\b/.test(text)
    || /\b(?:them|bo sung|giu nguyen|sap xep|dinh dang|xuat lai)\b.{0,50}\b(?:tren|do|nay|vua roi)\b/.test(text)
    || /^(?:vay|the con|vay con|con)\b(?!\s+so\b)/.test(text) || /\bthi sao\s*\??$/.test(text);
}
function preserving(question, resolution) {
  const addingFields = /\b(?:hien thi them|bo sung (?:cot|truong|thong tin)|them (?:cot|truong|ten|ma))\b/.test(normalize(question)) && dependsOnPrevious(question);
  return resolution.relation === 'followup' && (resolution.scopeAction !== 'revise' || addingFields)
    && (['list', 'detail', 'attribute', 'chart', 'export'].includes(resolution.operation) || addingFields && resolution.operation === 'continuation');
}
module.exports = { dependsOnPrevious, preserving };
