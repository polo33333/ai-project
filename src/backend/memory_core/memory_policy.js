'use strict';

const { normalize } = require('../training_core/request_planner');

// Keep Vietnamese diacritics here: stripping accents makes "đồ" in "biểu đồ"
// indistinguishable from the pronoun "đó".
const REFERENCE_PRONOUN_PATTERN = /(?:^|[\s,.!?])(?:đó|này|nay|trên|tren|vừa rồi|vua roi|đấy|day|người đó|nguoi do|nhân viên đó|nhan vien do|khách hàng đó|khach hang do|anh ấy|anh ay|cô ấy|co ay|cái đó|cai do|nó|tháng trước|thang truoc)(?=$|[\s,.!?])/iu;

const REFERENCE_KEYWORDS = Object.freeze({
  lastExport: ['xuat file', 'tai ve', 'download', 'file nay', 'bao cao nay'],
  lastDataset: ['bieu do', 'du lieu tren', 'so lieu do', 've', 'so sanh voi', 'thang truoc'],
  lastEntity: ['nguoi do', 'nhan vien do', 'khach hang do', 'anh ay', 'co ay']
});

// Backward-compatible fallback only. A table's Data Dictionary `domain` wins.
const FALLBACK_DOMAIN_RULES = Object.freeze([
  { domain: 'employee', pattern: /(?:employee|department|position|salary|staff|personnel|nhanvien|phongban)/i },
  { domain: 'electricity', pattern: /(?:electricity|power|dien)/i },
  { domain: 'contract', pattern: /(?:contract|agreement|hopdong)/i },
  { domain: 'customer', pattern: /(?:customer|client|company|khachhang)/i },
  { domain: 'water', pattern: /(?:water|nuoc)/i },
  { domain: 'waste', pattern: /(?:garbage|waste|rac)/i }
]);

function envNumber(name, fallback, minimum = 0) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function isEnabled() { return process.env.MEMORY_CORE_ENABLED !== 'false'; }
function isShadowMode() { return process.env.MEMORY_CORE_SHADOW_MODE === 'true'; }
function recentMaxMessages() { return Math.min(4, envNumber('MEMORY_RECENT_MAX_MESSAGES', 4, 1)); }
function referenceTtlMinutes() { return envNumber('MEMORY_REFERENCE_TTL_MINUTES', 120, 1); }
function traceEnabled() { return process.env.MEMORY_TRACE_ENABLED !== 'false'; }

function normalizeDomain(value) {
  return normalize(value).replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || null;
}

function getDictionaryTables(dictionaryTables) {
  if (Array.isArray(dictionaryTables)) return dictionaryTables;
  try {
    return require('../services/dictionary_service').getGroupedTables();
  } catch (_) {
    return [];
  }
}

function getDomain(table, dictionaryTables) {
  if (!table) return null;
  const tableName = String(table);
  const metadata = getDictionaryTables(dictionaryTables).find(item =>
    String(item?.tableName || '').toLowerCase() === tableName.toLowerCase()
  );
  const configuredDomain = normalizeDomain(metadata?.domain);
  if (configuredDomain) return configuredDomain;
  const matched = FALLBACK_DOMAIN_RULES.find(rule => rule.pattern.test(tableName));
  return matched?.domain || `table:${tableName.toLowerCase()}`;
}

function hasReferencePronoun(questionText) {
  return REFERENCE_PRONOUN_PATTERN.test(String(questionText || '').normalize('NFC').toLowerCase());
}

function matchesReferenceKeyword(questionText, type) {
  const text = normalize(questionText);
  return (REFERENCE_KEYWORDS[type] || []).some(keyword => text.includes(keyword));
}

function isExportOrChartIntent(questionText) {
  return matchesReferenceKeyword(questionText, 'lastExport') || matchesReferenceKeyword(questionText, 'lastDataset');
}

function isShortContextualFollowup(questionText) {
  const text = normalize(questionText).trim();
  if (!text || text.split(/\s+/).length > 8) return false;
  if (/^(?:hi|hello|hey|xin chao|chao|cam on|thanks?)\b/.test(text)) return false;
  return /\b(?:ntn|nhu the nao|the nao|ra sao|ket qua sao|ti so|ty so|bao nhieu|chi tiet|cu the|con hom nay|con hom qua|doi nao|tran nao)\b/.test(text)
    || /^(?:con|va|vay|vay con|the|the con)\b/.test(text);
}

function isPlanSelfContained(plan = {}) {
  if (!plan.table || !plan.intent) return false;
  const explicitSchema = Array.isArray(plan.requiredColumns) && plan.requiredColumns.length > 0;
  const explicitOutput = Boolean(plan.metric || plan.timeColumn || plan.temporalMonths || plan.outputs?.data);
  return explicitSchema || explicitOutput;
}

function canPersist({ completionStatus, responseEvaluation } = {}) {
  if (process.env.MEMORY_PERSIST_PARTIAL === 'true') return Boolean(responseEvaluation?.valid);
  return completionStatus === 'SUCCESS'
    && responseEvaluation?.valid === true
    && (!Array.isArray(responseEvaluation.failures) || responseEvaluation.failures.length === 0);
}

module.exports = {
  FALLBACK_DOMAIN_RULES,
  REFERENCE_KEYWORDS,
  canPersist,
  getDomain,
  hasReferencePronoun,
  isEnabled,
  isExportOrChartIntent,
  isShortContextualFollowup,
  isPlanSelfContained,
  isShadowMode,
  matchesReferenceKeyword,
  normalizeDomain,
  recentMaxMessages,
  referenceTtlMinutes,
  traceEnabled
};
