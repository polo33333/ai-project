'use strict';
// Token limits and locks for AI calls, per account and per AI provider.
// Every call is counted in the current day, week (Monday–Sunday) and month bucket, so any
// period can be enforced and an admin always sees all three.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const storage = require('../storage');
const StorageHelper = require('../utils/storage_helper');

const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const SCOPES = new Set(['account', 'provider']);
const PERIODS = new Set(['day', 'week', 'month']);
const BUCKETS = ['day', 'week', 'month'];
const LABELS = { day: ['hôm nay', 'vào 0 giờ ngày mai'], week: ['tuần này', 'vào 0 giờ thứ Hai tuần sau'], month: ['tháng này', 'vào ngày 1 tháng sau'] };
const CACHE_MS = 3000;

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const MISSING_TABLE = '42P01';
const MIGRATE_HINT = 'Chưa tạo bảng hạn mức AI trong PostgreSQL. Hãy chạy "npm run db:migrate" rồi khởi động lại server.';
const formatTokens = value => Number(value).toLocaleString('vi-VN');

function periodKeys(date = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  // A week is named after its Monday (Vietnam time, UTC+7 without daylight saving).
  const local = new Date(date.getTime() + 7 * 3600000);
  const monday = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (local.getUTCDay() + 6) % 7));
  return { day: `d:${day}`, week: `w:${monday.toISOString().slice(0, 10)}`, month: `m:${day.slice(0, 7)}` };
}

class AiUsageService {
  constructor({ directory = StorageHelper.getDataDirectory(), pool = null } = {}) {
    this.directory = directory; this.pool = pool; this.state = null; this.cached = null;
  }
  database() { return this.pool || (storage.enabled() ? storage.getPool() : null); }
  // Before "npm run db:migrate" the tables do not exist. Limits must never block AI because of that:
  // reads act as "no limits", counting is skipped, and only the admin page reports the problem.
  async query(sql, values, fallback) {
    try { const result = await this.database().query(sql, values); this.missing = false; return result; }
    catch (error) {
      if (error.code !== MISSING_TABLE) throw error;
      if (!this.missing) console.warn(`[AI usage] ${MIGRATE_HINT}`);
      this.missing = true; return fallback;
    }
  }
  file() { return path.join(this.directory, 'ai_usage.json'); }
  readFile() {
    if (!this.state) {
      const file = this.file();
      this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
      this.state.limits ||= {}; this.state.counters ||= {};
    }
    return this.state;
  }
  writeFile() {
    const state = this.readFile(), keys = periodKeys(), keepMonths = new Set([keys.month.slice(2), previousMonth(keys.month.slice(2))]);
    // Old buckets are never shown or enforced; keep the file small.
    for (const key of Object.keys(state.counters)) if (!keepMonths.has(key.split('|')[2].slice(2, 9))) delete state.counters[key];
    fs.mkdirSync(this.directory, { recursive: true });
    const file = this.file(), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(temporary, file);
  }

  async limits() {
    if (this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.items;
    const db = this.database();
    const items = db
      ? (await this.query('SELECT scope, target_id AS "targetId", period, token_limit AS "tokenLimit", locked, updated_by AS "updatedBy", updated_at AS "updatedAt" FROM app.ai_usage_limits', [], { rows: [] })).rows
        .map(row => ({ ...row, tokenLimit: row.tokenLimit === null ? null : Number(row.tokenLimit) }))
      : Object.values(this.readFile().limits);
    this.cached = { at: Date.now(), items };
    return items;
  }

  async setLimit(input, actorId) {
    const scope = input?.scope, targetId = typeof input?.targetId === 'string' ? input.targetId.trim() : '';
    if (!SCOPES.has(scope) || !targetId || targetId.length > 200) throw fail('Đối tượng hạn mức không hợp lệ.');
    const period = PERIODS.has(input.period) ? input.period : 'month';
    const raw = input.tokenLimit;
    const tokenLimit = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (tokenLimit !== null && (!Number.isSafeInteger(tokenLimit) || tokenLimit < 0)) throw fail('Hạn mức token phải là số nguyên không âm, hoặc để trống nếu không giới hạn.');
    const item = { scope, targetId, period, tokenLimit, locked: input.locked === true, updatedBy: actorId || null, updatedAt: new Date().toISOString() };
    const db = this.database();
    if (db) {
      const saved = await this.query(`INSERT INTO app.ai_usage_limits(scope, target_id, period, token_limit, locked, updated_by, updated_at) VALUES($1,$2,$3,$4,$5,$6,now())
        ON CONFLICT(scope, target_id) DO UPDATE SET period=excluded.period, token_limit=excluded.token_limit, locked=excluded.locked, updated_by=excluded.updated_by, updated_at=now()`,
      [scope, targetId, period, tokenLimit, item.locked, item.updatedBy], null);
      if (!saved) throw fail(MIGRATE_HINT, 503);
    } else {
      this.readFile().limits[`${scope}|${targetId}`] = item; this.writeFile();
    }
    this.cached = null;
    return item;
  }

  // Returns { "scope|target": { day, week, month, dayRequests, weekRequests, monthRequests } } for the current buckets.
  async usage() {
    const keys = periodKeys(), result = {}, current = BUCKETS.map(bucket => keys[bucket]);
    const add = (scope, targetId, periodKey, tokens, requests) => {
      const entry = result[`${scope}|${targetId}`] ||= emptyUsage();
      const bucket = BUCKETS.find(name => keys[name] === periodKey);
      entry[bucket] += Number(tokens) || 0; entry[`${bucket}Requests`] += Number(requests) || 0;
    };
    const db = this.database();
    if (db) {
      for (const row of (await this.query('SELECT scope, target_id, period_key, tokens, requests FROM app.ai_usage_counters WHERE period_key = ANY($1::text[])', [current], { rows: [] })).rows)
        add(row.scope, row.target_id, row.period_key, row.tokens, row.requests);
    } else {
      for (const [key, value] of Object.entries(this.readFile().counters)) {
        const [scope, targetId, periodKey] = key.split('|');
        if (current.includes(periodKey)) add(scope, targetId, periodKey, value.tokens, value.requests);
      }
    }
    return result;
  }

  // Throws before an AI call when the account or the provider is locked or out of tokens.
  // "admitted" (one Set per user request) makes this a check at the start of a question only:
  // once a question is let in, its remaining model calls finish even if they pass the limit,
  // and the next question is blocked.
  async check({ accountId, provider, admitted = null }) {
    const accountKey = accountId ? `account|${accountId}` : null, providerKey = provider?.id ? `provider|${provider.id}` : null;
    const limits = await this.limits();
    const accountLimit = accountId && !admitted?.has(accountKey) && limits.find(item => item.scope === 'account' && item.targetId === accountId);
    const providerLimit = provider?.id && !admitted?.has(providerKey) && limits.find(item => item.scope === 'provider' && item.targetId === provider.id);
    this.assertAllowed({ accountId, provider, accountLimit, providerLimit, usage: (accountLimit?.tokenLimit ?? providerLimit?.tokenLimit) == null ? {} : await this.usage() });
    [accountKey, providerKey].forEach(key => { if (key) admitted?.add(key); });
  }

  assertAllowed({ accountId, provider, accountLimit, providerLimit, usage }) {
    if (!accountLimit && !providerLimit) return;
    const name = provider?.name ? `“${provider.name}${provider.model ? ` - ${provider.model}` : ''}”` : 'này';
    if (accountLimit?.locked) throw Object.assign(fail('Tài khoản của bạn đang bị khóa sử dụng AI. Vui lòng liên hệ quản trị viên.', 429), { code: 'AI_ACCOUNT_LOCKED' });
    if (providerLimit?.locked) throw Object.assign(fail(`Mô hình AI ${name} đang bị quản trị viên khóa.`, 429), { code: 'AI_PROVIDER_LOCKED' });
    if (accountLimit?.tokenLimit == null && providerLimit?.tokenLimit == null) return;
    const reached = (limit, key) => limit && limit.tokenLimit !== null && (usage[key]?.[limit.period] || 0) >= limit.tokenLimit;
    const when = period => (LABELS[period] || LABELS.month)[0];
    const reset = period => (LABELS[period] || LABELS.month)[1];
    if (reached(accountLimit, `account|${accountId}`))
      throw Object.assign(fail(`Bạn đã dùng hết hạn mức AI ${when(accountLimit.period)} (${formatTokens(accountLimit.tokenLimit)} token). Hạn mức sẽ được đặt lại ${reset(accountLimit.period)}, hoặc liên hệ quản trị viên để nâng hạn mức.`, 429), { code: 'AI_ACCOUNT_QUOTA' });
    if (reached(providerLimit, `provider|${provider.id}`))
      throw Object.assign(fail(`Mô hình AI ${name} đã dùng hết hạn mức ${when(providerLimit.period)} (${formatTokens(providerLimit.tokenLimit)} token). Hạn mức sẽ được đặt lại ${reset(providerLimit.period)}, hoặc liên hệ quản trị viên.`, 429), { code: 'AI_PROVIDER_QUOTA' });
  }

  // Clears what one account or model has used today, this week and this month, so it can use AI
  // again right away. Older periods are untouched. Returns what was cleared, for the audit log.
  async resetUsage(input) {
    const scope = input?.scope, targetId = typeof input?.targetId === 'string' ? input.targetId.trim() : '';
    if (!SCOPES.has(scope) || !targetId) throw fail('Đối tượng cần đặt lại không hợp lệ.');
    const keys = periodKeys(), current = BUCKETS.map(bucket => keys[bucket]);
    const cleared = (await this.usage())[`${scope}|${targetId}`] || emptyUsage();
    const db = this.database();
    if (db) {
      const removed = await this.query('DELETE FROM app.ai_usage_counters WHERE scope=$1 AND target_id=$2 AND period_key = ANY($3::text[])', [scope, targetId, current], null);
      if (!removed) throw fail(MIGRATE_HINT, 503);
    } else {
      const counters = this.readFile().counters;
      for (const periodKey of current) delete counters[`${scope}|${targetId}|${periodKey}`];
      this.writeFile();
    }
    return { scope, targetId, cleared };
  }

  // What the signed-in user needs for the chat banner: their own limit, use and reset time.
  async accountStatus(accountId) {
    const limit = (await this.limits()).find(item => item.scope === 'account' && item.targetId === accountId);
    if (!limit) return { limited: false, locked: false };
    const period = PERIODS.has(limit.period) ? limit.period : 'month';
    const used = (await this.usage())[`account|${accountId}`]?.[period] || 0;
    return { limited: limit.tokenLimit !== null, locked: limit.locked === true, period, tokenLimit: limit.tokenLimit, used,
      ratio: limit.tokenLimit === null ? null : limit.tokenLimit === 0 ? 1 : used / limit.tokenLimit,
      periodKey: periodKeys()[period], resetAt: resetTime(period) };
  }

  async record({ accountId, providerId, tokens }) {
    const amount = Math.max(0, Math.round(Number(tokens) || 0));
    const keys = periodKeys(), targets = [['provider', providerId], ['account', accountId]].filter(([, id]) => id);
    if (!targets.length) return;
    const db = this.database();
    if (db) {
      const values = [], rows = [];
      for (const [scope, targetId] of targets) for (const periodKey of BUCKETS.map(bucket => keys[bucket])) {
        values.push(scope, targetId, periodKey, amount);
        const base = values.length - 4;
        rows.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},1,now())`);
      }
      await this.query(`INSERT INTO app.ai_usage_counters(scope, target_id, period_key, tokens, requests, updated_at) VALUES ${rows.join(',')}
        ON CONFLICT(scope, target_id, period_key) DO UPDATE SET tokens=app.ai_usage_counters.tokens+excluded.tokens, requests=app.ai_usage_counters.requests+1, updated_at=now()`, values, null);
    } else {
      const counters = this.readFile().counters;
      for (const [scope, targetId] of targets) for (const periodKey of BUCKETS.map(bucket => keys[bucket])) {
        const entry = counters[`${scope}|${targetId}|${periodKey}`] ||= { tokens: 0, requests: 0 };
        entry.tokens += amount; entry.requests += 1;
      }
      this.writeFile();
    }
  }
}

// Next 00:00 (day), next Monday 00:00 (week) or the 1st of next month (month) in Vietnam time (UTC+7, no daylight saving).
function resetTime(period, now = new Date()) {
  const local = new Date(now.getTime() + 7 * 3600000);
  const next = period === 'day' ? Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1)
    : period === 'week' ? Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 7 - (local.getUTCDay() + 6) % 7)
    : Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1);
  return new Date(next - 7 * 3600000).toISOString();
}

function emptyUsage() { return { day: 0, week: 0, month: 0, dayRequests: 0, weekRequests: 0, monthRequests: 0 }; }

function previousMonth(month) {
  const [year, value] = month.split('-').map(Number);
  return value === 1 ? `${year - 1}-12` : `${year}-${String(value - 1).padStart(2, '0')}`;
}

// The signed-in account of the current request or background run, if any.
function currentAccountId() {
  const subject = require('../governance/context').current()?.principal?.subject;
  return typeof subject === 'string' && subject.startsWith('account:') ? subject.slice(8) : null;
}

const service = new AiUsageService();
module.exports = { service, AiUsageService, currentAccountId, periodKeys, resetTime, emptyUsage, TIME_ZONE };
