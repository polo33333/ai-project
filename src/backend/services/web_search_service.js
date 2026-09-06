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

module.exports = { search, parseResults };
