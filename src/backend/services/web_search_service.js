'use strict';

function decodeHtml(value = '') {
  return String(value).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/\s+/g, ' ').trim();
}

function unwrapUrl(value = '') {
  try {
    const parsed = new URL(value.startsWith('//') ? `https:${value}` : value, 'https://duckduckgo.com');
    return parsed.searchParams.get('uddg') || parsed.href;
  } catch (_) { return value; }
}

function buildContextualQuery(query, history = [], contextualize = false) {
  const current = String(query || '').trim();
  if (!contextualize) return current;
  const previousUserMessage = [...(Array.isArray(history) ? history : [])]
    .reverse()
    .find(item => item?.role === 'user' && String(item.content || '').trim())?.content;
  const previous = String(previousUserMessage || '').trim();
  return previous && previous !== current ? `${previous}\n${current}` : current;
}

function getVietnamDateContext(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const value = type => parts.find(part => part.type === type)?.value || '';
  return { year: Number(value('year')), month: Number(value('month')), day: Number(value('day')), timezone: 'Asia/Ho_Chi_Minh' };
}

function getTemporalGrounding(query, now = new Date()) {
  const current = getVietnamDateContext(now);
  const text = String(query || '');
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  const relativeYear = /\bnam nay\b/.test(normalized);
  const relativeMonth = /\bthang nay\b/.test(normalized);
  const relativeDay = /\b(?:hom nay|h nay|hnay)\b/.test(normalized);
  return { ...current, relativeYear, relativeMonth, relativeDay, required: relativeYear || relativeMonth || relativeDay };
}

function groundTemporalQuery(query, grounding) {
  if (!grounding?.required) return String(query || '').trim();
  let result = String(query || '').trim();
  if (grounding.relativeYear) result = result.replace(/năm nay/giu, `năm ${grounding.year}`);
  if (grounding.relativeMonth) result = result.replace(/tháng này/giu, `tháng ${grounding.month} năm ${grounding.year}`);
  if (grounding.relativeDay) {
    const date = `${String(grounding.day).padStart(2, '0')}/${String(grounding.month).padStart(2, '0')}/${grounding.year}`;
    result = result.replace(/(?:hôm nay|h nay|hnay)/giu, `ngày ${date}`);
  }
  return result;
}

function rankResultsForTemporalGrounding(results = [], grounding = {}) {
  if (!grounding?.required || !grounding.year) return results;
  const target = String(grounding.year);
  const score = item => {
    const text = `${item?.title || ''} ${item?.snippet || ''}`;
    if (new RegExp(`\\b${target}\\b`).test(text)) return 2;
    if (/\b20\d{2}\b/.test(text)) return 0;
    return 1;
  };
  return results.map((item, index) => ({ item, index, score: score(item) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(entry => entry.item);
}

function parseResults(html = '', limit = 5) {
  return String(html).split(/class="result\s+results_links[^\"]*"/i).slice(1).map(block => {
    const link = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
      || block.match(/href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) return null;
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
    return { title: decodeHtml(link[2]), url: unwrapUrl(decodeHtml(link[1])), snippet: decodeHtml(snippet?.[1] || '') };
  }).filter(item => item?.title && /^https?:\/\//i.test(item.url)).slice(0, limit);
}

async function search(query, { signal = null } = {}) {
  const endpoint = process.env.WEB_SEARCH_ENDPOINT;
  const timeoutMs = Number(process.env.WEB_SEARCH_TIMEOUT_MS || process.env.AI_DEFAULT_TIMEOUT_MS);
  const limit = Math.max(1, Math.min(10, Number(process.env.WEB_SEARCH_MAX_RESULTS) || 5));
  if (!endpoint) throw new Error('WEB_SEARCH_ENDPOINT chưa được cấu hình.');
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0 ? setTimeout(abort, timeoutMs) : null;
  try {
    const separator = endpoint.includes('?') ? '&' : '?';
    const response = await fetch(`${endpoint}${separator}q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KnowledgeHub/1.0)' }, signal: controller.signal
    });
    if (!response.ok) throw new Error(`Web search HTTP ${response.status}`);
    return parseResults(await response.text(), limit);
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = {
  search, parseResults, buildContextualQuery, getVietnamDateContext,
  getTemporalGrounding, groundTemporalQuery, rankResultsForTemporalGrounding
};
