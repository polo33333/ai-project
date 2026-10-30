'use strict';

const TIMEZONE = 'Asia/Ho_Chi_Minh';
const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
const error = code => Object.assign(new Error(code), { code });
function shift(date, days) {
  const parsed = new Date(date + 'T00:00:00.000Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || !Number.isInteger(days)) throw error('TEMPORAL_DATE_INVALID');
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}
// Same day N calendar months later, clamped to the month's last day (31/01 + 1 = 28/02).
function addMonths(date, months) {
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
function hasExplicitScope(question) {
  const text = normalize(question);
  return /\b\d+\s*(?:ngay|days?|thang|months?|nam|years?)\b|\b\d{4}[-/]\d{1,2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b(?:nam|year)\s+\d{4}\b|\b(hien tai|hom nay|hom qua|ngay mai|thang nay|thang truoc|nam nay|nam truoc|today|yesterday|tomorrow|this month|last month)\b/.test(text);
}
function create(question, now = new Date(), upcomingDays = process.env.AI_UPCOMING_WINDOW_DAYS) {
  const today = require('../agent/tools/date_range').resolve({ unit: 'day', timezone: TIMEZONE }, now).start;
  const text = normalize(question);
  const current = /\b(hien tai|hom nay|bay gio|hnay|h nay|today|currently|now)\b/.test(text);
  const due = /\b(het han|qua han|sap den han|sap het han|den han|expired|overdue|expiring|due soon)\b/.test(text);
  const soon = /\b(sap|soon|upcoming|expiring)\b/.test(text);
  const duration = [...new Set([...text.matchAll(/\b(\d+)\s*(?:ngay|days?)\b/g)].map(match => Number(match[1])))];
  const configured = Number(upcomingDays);
  const horizon = duration.length ? duration.length === 1 && duration[0] > 0 && duration[0] <= 36600 ? duration[0] : null
    : Number.isInteger(configured) && configured > 0 && configured <= 36600 ? configured : null;
  const relativePeriod = /\b(hom qua|ngay mai|yesterday|tomorrow|(?:tuan|thang|quy|nam) (?:nay|truoc)|nam ngoai|this (?:week|month|quarter|year)|last (?:week|month|quarter|year)|next \d+ days?)\b/.test(text);
  const relativeDays = duration.length > 0 && /\b(toi|tiep|qua|gan|truoc|next|last|ago)\b/.test(text);
  const explicitOnly = !current && !relativePeriod && !relativeDays && /\b\d{4}[-/]\d{1,2}|\b\d{1,2}\/\d{1,2}\/\d{4}\b|\b(?:nam|year|truoc|sau|before|after)\s+\d{4}\b/.test(text);
  const monthCount = Number(text.match(/\b(\d+)\s*(?:thang|months?)\b/)?.[1]) || null;
  const latestAvailable = /\b(gan nhat|co du lieu|du lieu san co|latest available)\b/.test(text);
  // "3 tháng tới" looks ahead from today; it is not the past window "3 tháng".
  const ahead = monthCount && /\b\d+\s*thang\s*(?:toi|tiep theo|ke tiep|sap toi|sau)\b|\bnext \d+ months?\b/.test(text);
  const monthWindow = monthCount && monthCount <= 120 && !explicitOnly && !latestAvailable && !ahead
    ? require('../agent/tools/date_range').resolve({ unit: 'month', count: monthCount }, now) : null;
  const upcomingMonths = ahead && monthCount <= 120 ? { start: today, end: addMonths(today, monthCount), count: monthCount } : null;
  const relative = current || relativePeriod || relativeDays || due && !explicitOnly || Boolean(monthWindow) || Boolean(upcomingMonths);
  const dates = new Set([today]);
  if (monthWindow) { dates.add(monthWindow.start); dates.add(monthWindow.end); }
  if (upcomingMonths) dates.add(upcomingMonths.end);
  const add = days => dates.add(shift(today, days));
  if (/\b(ngay mai|tomorrow)\b/.test(text)) { add(1); add(2); }
  if (/\b(hom qua|yesterday)\b/.test(text)) add(-1);
  if (/\b(hom nay|today)\b/.test(text)) add(1);
  for (const days of duration.filter(days => days <= 36600)) {
    if (/\b(truoc|ago)\b/.test(text)) { add(-days); add(1-days); }
    else if (/\b(qua|gan|last)\b/.test(text)) { add(1-days); add(1); }
    else add(days);
  }
  if (soon && horizon) add(horizon);
  const units = { tuan: 'week', thang: 'month', quy: 'quarter', nam: 'year', week: 'week', month: 'month', quarter: 'quarter', year: 'year' };
  for (const [word, unit] of Object.entries(units)) {
    if (!new RegExp(`\\b${word}\\b`).test(text) || !relativePeriod) continue;
    const offset = new RegExp(`\\b${word} (?:truoc|ngoai)\\b|\\blast ${word}\\b`).test(text) ? -1 : 0;
    const range = require('../agent/tools/date_range').resolve({ unit, offset }, now);
    dates.add(range.start); dates.add(range.end);
  }
  // Explicit dates remain valid alongside relative predicates. Never replace
  // an explicitly requested historical date with today's date.
  for (const match of String(question).matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const date = match[0]; try { shift(date, 0); dates.add(date); } catch {}
  }
  for (const match of String(question).matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    const date = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    try { shift(date, 0); dates.add(date); } catch {}
  }
  for (const match of text.matchAll(/\b(?:nam|year|truoc|sau|before|after)\s+(\d{4})\b/g)) {
    dates.add(`${match[1]}-01-01`); dates.add(`${Number(match[1])+1}-01-01`);
  }
  for (const match of text.matchAll(/\b(\d{4})-(\d{2})(?!-\d{2})\b/g)) {
    const start = `${match[1]}-${match[2]}-01`;
    try { shift(start, 0); dates.add(start); const end = new Date(start+'T00:00:00Z'); end.setUTCMonth(end.getUTCMonth()+1); dates.add(end.toISOString().slice(0,10)); } catch {}
  }
  return { today, timezone: TIMEZONE, resolvedAt: now.toISOString(), relative,
    dateScoped: relative && (Boolean(monthWindow) || due || relativePeriod || relativeDays || /\b(hom nay|today|hom qua|yesterday|ngay mai|tomorrow)\b/.test(text)),
    ...(monthWindow ? { monthWindow: { start: monthWindow.start, end: monthWindow.end, count: monthCount, includesCurrentMonth: true } } : {}),
    ...(upcomingMonths ? { upcomingMonths } : {}),
    horizonDays: soon ? horizon : null, horizonSource: soon && horizon ? duration.length === 1 ? 'user' : 'configuration' : null,
    needsHorizon: relative && soon && !horizon, allowedDates: [...dates] };
}
function instruction(time) {
  return `Authoritative backend request clock: ${JSON.stringify(time)}. This clock is fixed for this entire request. Never infer today's date from training data, conversation history, database MAX dates, examples or metadata. For a current/relative date question use only these grounded dates. In dataQuery calendar offsets use {anchorDate:"today",offsetDays:N}; backend resolves today. Use the business date actually requested (expiry versus invoice/document versus service period), not a convenient unrelated date. Filtering stored future dates is a record lookup, not a forecast: use analysis=none unless the user actually requests inference/prediction or analysis. Expired means date < today; ending today belongs to the not-yet-expired group. Upcoming N calendar days means date >= today AND date < today+N. Past N calendar days includes today: date >= today-(N-1) AND date < tomorrow. NULL date is unknown, not expired. If needsHorizon=true, do not invent a window: query the expired group if requested, omit the unsupported upcoming query and backend asks for the number of days. Do not guess status IDs or exclude renewed/terminated records without verified metadata. If monthWindow is supplied, use its start inclusive/end exclusive as direct date literals on the requested business date. It represents N calendar months including the current month; disclose this range and the current partial month. Do not query all history or replace this with latest available data. For an explicit historical question retain its explicit dates.`;
}

function validateSql(sql, time, tables = []) {
  if (!time?.relative) return { valid: true, violations: [] };
  const violations = new Set();
  let statement;
  try { const ast = new (require('node-sql-parser').Parser)().astify(sql, { database: 'TransactSQL' }); statement = Array.isArray(ast) ? ast[0] : ast; }
  catch { return { valid: false, violations: ['TEMPORAL_SQL_UNVERIFIED'] }; }
  const key = value => String(value || '').toLowerCase();
  const walk = (node, visit) => { if (!node || typeof node !== 'object') return; visit(node); Object.values(node).forEach(value => Array.isArray(value) ? value.forEach(item => walk(item, visit)) : walk(value, visit)); };
  const sources = statement.from || [];
  const dateColumn = node => {
    let found = false;
    walk(node, ref => {
      if (ref.type !== 'column_ref') return;
      const matches = sources.filter(source => !ref.table || key(source.as || source.table) === key(ref.table));
      if (matches.length !== 1) return;
      const source = matches[0];
      const table = tables.find(table => key(table.tableName) === key(source.table) && key(table.schemaName || 'dbo') === key(source.db || 'dbo'));
      const column = table?.columns?.find(column => column.isVisible !== false && key(column.columnName || column.name) === key(ref.column));
      if (/^(date|datetime|datetime2|smalldatetime|datetimeoffset)(?:\(|$)/i.test(column?.dataType || column?.type || '')) found = true;
    }); return found;
  };
  let grounded = false;
  const monthBounds = { start: false, end: false };
  const conjuncts = node => node?.type === 'binary_expr' && node.operator === 'AND'
    ? [...conjuncts(node.left), ...conjuncts(node.right)] : node ? [node] : [];
  for (const node of conjuncts(statement.where)) {
    if (node.type === 'binary_expr' && ['OR', 'BETWEEN', 'NOT BETWEEN', 'IN', 'NOT IN'].includes(String(node.operator).toUpperCase()) && dateColumn(node)) violations.add('TEMPORAL_PREDICATE_UNVERIFIED');
    if (node.type !== 'binary_expr' || !['=', '<', '<=', '>', '>='].includes(node.operator) || !dateColumn(node)) continue;
    const leftDate = node.left?.type === 'column_ref' && dateColumn(node.left);
    const rightDate = node.right?.type === 'column_ref' && dateColumn(node.right);
    const value = leftDate ? node.right : rightDate ? node.left : null;
    let literalFound = false;
    if (value && ['single_quote_string', 'var_string', 'string'].includes(value.type) && typeof value.value === 'string') {
      const date = value.value.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
      if (date) {
        literalFound = true;
        if (time.needsHorizon && date >= time.today && (leftDate && ['>', '>='].includes(node.operator) || rightDate && ['<', '<='].includes(node.operator))) violations.add('TEMPORAL_HORIZON_REQUIRED');
        if (!time.allowedDates.includes(date)) violations.add(time.needsHorizon && date > time.today ? 'TEMPORAL_HORIZON_REQUIRED' : 'TEMPORAL_REFERENCE_MISMATCH');
        else grounded = true;
        if (time.monthWindow) {
          if (date === time.monthWindow.start && (leftDate && node.operator === '>=' || rightDate && node.operator === '<=')) monthBounds.start = true;
          if (date === time.monthWindow.end && (leftDate && node.operator === '<' || rightDate && node.operator === '>')) monthBounds.end = true;
        }
      }
    }
    if (!literalFound) violations.add('TEMPORAL_PREDICATE_UNVERIFIED');
  }
  if (time.dateScoped && !grounded) violations.add('TEMPORAL_DATE_FILTER_REQUIRED');
  if (time.monthWindow && (!monthBounds.start || !monthBounds.end)) violations.add('TEMPORAL_MONTH_WINDOW_REQUIRED');
  return { valid: violations.size === 0, violations: [...violations] };
}
module.exports = { create, instruction, validateSql, shift, TIMEZONE, hasExplicitScope };
