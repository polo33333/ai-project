'use strict';

// Expand only standalone list requests, never identifiers or record values.
module.exports = function entityListQuery(value, glossary) {
  const text = require('./lexical_normalize')(value).trim().replace(/[?.!]+$/g, '').trim();
  const match = text.match(/^(?:ds|danh sach|liet ke)\s+(.+)$/);
  if (!match) return String(value || '');
  const normalize = require('./lexical_normalize');
  const entries = glossary || require('../services/dictionary_service').getGlossary();
  const exactKey = input => String(input || '').normalize('NFC').toLocaleLowerCase('vi').trim();
  const originalTail = String(value || '').trim().replace(/[?.!]+$/g, '').trim()
    .replace(/^(?:ds|danh sách|danh sach|liệt kê|liet ke)\s+/iu, '');
  const active = entries.filter(item => item.isActive !== false);
  const exact = active.filter(item => exactKey(item.term) === exactKey(originalTail));
  const candidates = exact.length ? exact : active.filter(item => normalize(item.term).trim() === match[1]);
  const meanings = [...new Set(candidates
    .map(item => normalize(item.fullMeaning).trim()).filter(Boolean))];
  // Conflicting definitions must not silently select the first meaning.
  return meanings.length === 1 ? `danh sach ${meanings[0]}` : String(value || '');
};
