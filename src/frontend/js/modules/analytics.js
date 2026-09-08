/**
 * Dashboard & Analytics Metrics Module
 */

window.khCharts = window.khCharts || {};
window.dashboardAnalyticsRange = window.dashboardAnalyticsRange || '7d';
window.dashboardAnalyticsHistory = window.dashboardAnalyticsHistory || [];
window.dashboardAnalyticsProviders = window.dashboardAnalyticsProviders || [];
window.dashboardFeedbackRange = window.dashboardFeedbackRange || '7d';
window.dashboardFeedbackData = window.dashboardFeedbackData || [];
window.dashboardActivityYear = window.dashboardActivityYear || new Date().getFullYear();

function findAnalyticsProvider(item = {}, providers = []) {
  const providerId = item.requestPayload?.providerId || null;
  return providers.find(candidate => providerId && candidate.id === providerId)
    || providers.find(candidate => candidate.name === item.providerName && candidate.model === item.modelName)
    || providers.find(candidate => candidate.name === item.providerName)
    || {};
}

function isLocalAnalyticsProvider(item = {}, providers = []) {
  const provider = findAnalyticsProvider(item, providers);
  const explicitClass = String(provider.executionClass || provider.harness || '').toLowerCase();
  if (explicitClass === 'local') return true;
  if (['remote', 'standard', 'cloud'].includes(explicitClass)) return false;
  const signature = [provider.apiFormat, provider.type, provider.baseUrl, item.providerName]
    .filter(Boolean).join(' ').toLowerCase();
  return /\bollama\b|\blm studio\b|\blocal ai\b|localhost|127\.0\.0\.1/.test(signature);
}

function parseViTimestamp(value) {
  if (!value) return null;
  const str = String(value).trim();
  const match = str.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*,?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const [, hh, mm, ss = '00', dd, mo, yyyy] = match;
    const iso = `${yyyy}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}T${String(hh).padStart(2, '0')}:${mm}:${ss}+07:00`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const parsed = new Date(str);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatMoney(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function getVietnamDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  return parts;
}

function vietnamDayKey(date) {
  const parts = getVietnamDateParts(date);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function groupHistoryByHour(history, providers = []) {
  const todayKey = vietnamDayKey(new Date());
  const buckets = Array.from({ length: 24 }, (_, hour) => ({
    key: `${todayKey}-${String(hour).padStart(2, '0')}`,
    label: `${String(hour).padStart(2, '0')}:00`, queries: 0, localQueries: 0, thirdPartyQueries: 0, errors: 0
  }));
  const bucketMap = new Map(buckets.map(bucket => [bucket.key, bucket]));
  (history || []).forEach(item => {
    const date = parseViTimestamp(item.timestamp);
    if (!date) return;
    const parts = getVietnamDateParts(date);
    const bucket = bucketMap.get(`${parts.year}-${parts.month}-${parts.day}-${parts.hour}`);
    if (!bucket) return;
    bucket.queries += 1;
    if (isLocalAnalyticsProvider(item, providers)) bucket.localQueries += 1;
    else bucket.thirdPartyQueries += 1;
    if (String(item.status || '').toUpperCase() === 'ERROR') bucket.errors += 1;
  });
  return buckets;
}

function estimateAuditCost(history, providers) {
  return (history || []).reduce((sum, item) => sum + estimateAuditRecordCost(item, providers), 0);
}

function estimateAuditRecordCost(item = {}, providers = []) {
  const provider = findAnalyticsProvider(item, providers);
  const costPer1k = Number(provider.tokenCost || 0);
  const reportedTokens = Number(item.requestPayload?.tokenUsage?.totalTokens || 0);
  const estimatedTokens = reportedTokens || Math.max(120, Math.round(((item.question || '').length + (item.replyText || '').length + (item.sqlQuery || '').length) / 4));
  return (estimatedTokens / 1000) * costPer1k;
}

function groupHistoryByDay(history, days = 7, providers = []) {
  const now = new Date();
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const key = vietnamDayKey(d);
    buckets.push({
      key,
      label: d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }),
      queries: 0,
      localQueries: 0,
      thirdPartyQueries: 0,
      errors: 0,
      latency: []
    });
  }
  const bucketMap = new Map(buckets.map(b => [b.key, b]));
  (history || []).forEach(item => {
    const date = parseViTimestamp(item.timestamp);
    if (!date) return;
    const key = vietnamDayKey(date);
    const bucket = bucketMap.get(key);
    if (!bucket) return;
    bucket.queries += 1;
    if (isLocalAnalyticsProvider(item, providers)) bucket.localQueries += 1;
    else bucket.thirdPartyQueries += 1;
    if (String(item.status || '').toUpperCase() === 'ERROR') bucket.errors += 1;
    if (Number(item.latencyMs)) bucket.latency.push(Number(item.latencyMs));
  });
  return buckets;
}

function groupHistoryByMonth(history, months = 6, providers = []) {
  const now = new Date();
  const buckets = [];
  for (let index = 0; index < months; index += 1) {
    const d = months === 12
      ? new Date(now.getFullYear(), index, 1)
      : new Date(now.getFullYear(), now.getMonth() - (months - 1 - index), 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets.push({
      key,
      label: d.toLocaleDateString('vi-VN', { month: '2-digit', year: 'numeric' }),
      queries: 0,
      localQueries: 0,
      thirdPartyQueries: 0,
      estimatedCost: 0,
      latency: []
    });
  }
  const bucketMap = new Map(buckets.map(b => [b.key, b]));
  (history || []).forEach(item => {
    const date = parseViTimestamp(item.timestamp);
    if (!date) return;
    const parts = getVietnamDateParts(date);
    const key = `${parts.year}-${parts.month}`;
    const bucket = bucketMap.get(key);
    if (!bucket) return;
    bucket.queries += 1;
    if (isLocalAnalyticsProvider(item, providers)) bucket.localQueries += 1;
    else bucket.thirdPartyQueries += 1;
    bucket.estimatedCost += estimateAuditRecordCost(item, providers);
    if (Number(item.latencyMs)) bucket.latency.push(Number(item.latencyMs));
  });
  return buckets;
}

async function fetchAnalyticsSourceData() {
  const safeJson = async (url, fallback) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return fallback;
      return await res.json();
    } catch {
      return fallback;
    }
  };
  const [history, providersData, dictionary, sources, qdrant, feedback] = await Promise.all([
    safeJson('/api/chat-history', []),
    safeJson('/api/ai-providers', { providers: [] }),
    safeJson('/api/dictionary', []),
    safeJson('/api/sql/sources', []),
    safeJson('/api/qdrant/status', {}),
    safeJson('/api/chat-feedback', [])
  ]);
  return {
    history: Array.isArray(history) ? history : [],
    providers: Array.isArray(providersData) ? providersData : (providersData.providers || []),
    activeProvider: providersData.activeProvider || null,
    dictionary: Array.isArray(dictionary) ? dictionary : (dictionary.tables || []),
    sources: Array.isArray(sources) ? sources : [],
    qdrant: qdrant || {},
    feedback: Array.isArray(feedback) ? feedback : []
  };
}

function destroyChart(id) {
  if (window.khCharts[id]) {
    window.khCharts[id].destroy();
    delete window.khCharts[id];
  }
}

function animateDashboardCanvas(canvas) {
  if (!canvas?.animate) return;
  canvas.getAnimations().forEach(animation => animation.cancel());
  canvas.animate([
    { opacity: 0.2, transform: 'translateY(10px)', filter: 'blur(1.5px)' },
    { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }
  ], { duration: 620, easing: 'cubic-bezier(.22,.75,.25,1)', fill: 'both' });
}

function renderDashboardActivity(history = []) {
  const chart = document.getElementById('dashboard-activity-chart');
  const peakLabel = document.getElementById('dashboard-activity-peak');
  const periodLabel = document.getElementById('dashboard-activity-period');
  if (!chart || !peakLabel) return;

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const currentYear = today.getFullYear();
  const availableYears = new Set([currentYear]);
  (history || []).forEach(item => {
    const date = parseViTimestamp(item.timestamp);
    if (!date) return;
    availableYears.add(Number(getVietnamDateParts(date).year));
  });
  const years = [...availableYears].filter(Number.isInteger).sort((a, b) => b - a);
  const requestedYear = Number(window.dashboardActivityYear);
  const year = availableYears.has(requestedYear) ? requestedYear : currentYear;
  window.dashboardActivityYear = year;
  if (periodLabel) {
    periodLabel.innerHTML = years.map(value => `<option value="${value}"${value === year ? ' selected' : ''}>Năm ${value}</option>`).join('');
  }
  const yearStart = new Date(year, 0, 1, 12);
  const yearEnd = new Date(year, 11, 31, 12);
  const firstDay = new Date(yearStart);
  firstDay.setDate(firstDay.getDate() - firstDay.getDay());
  const lastDay = new Date(yearEnd);
  lastDay.setDate(lastDay.getDate() + (6 - lastDay.getDay()));
  const activity = new Map();
  let successfulQueries = 0;

  (history || []).forEach(item => {
    const date = parseViTimestamp(item.timestamp);
    if (!date) return;
    const key = vietnamDayKey(date);
    const entry = activity.get(key) || { queries: 0, tokens: 0 };
    const reported = Number(item.requestPayload?.tokenUsage?.totalTokens || 0);
    const estimated = Math.max(120, Math.round(((item.question || '').length + (item.replyText || '').length + (item.sqlQuery || '').length) / 4));
    entry.queries += 1;
    entry.tokens += reported || estimated;
    activity.set(key, entry);
    if (key.startsWith(`${year}-`) && !['ERROR', 'FAILED', 'FAILURE'].includes(String(item.status || '').toUpperCase())) successfulQueries += 1;
  });

  const days = [];
  for (const cursor = new Date(firstDay); cursor <= lastDay; cursor.setDate(cursor.getDate() + 1)) {
    const date = new Date(cursor);
    const key = vietnamDayKey(date);
    days.push({ date, key, ...(activity.get(key) || { queries: 0, tokens: 0 }) });
  }
  const visibleDays = days.filter(day => day.date >= yearStart && day.date <= yearEnd && (year < currentYear || day.date <= today));
  const peak = visibleDays.reduce((best, day) => day.tokens > best.tokens ? day : best, { tokens: 0, queries: 0, date: null });
  const totalTokens = visibleDays.reduce((sum, day) => sum + day.tokens, 0);
  const totalQueries = visibleDays.reduce((sum, day) => sum + day.queries, 0);
  const activeDays = visibleDays.filter(day => day.queries > 0).length;
  const monthlyTokens = Array(12).fill(0);
  visibleDays.forEach(day => { monthlyTokens[day.date.getMonth()] += day.tokens; });
  const bestMonthIndex = monthlyTokens.reduce((best, value, index) => value > monthlyTokens[best] ? index : best, 0);
  const peakTokens = peak.tokens || 0;
  const levelFor = tokens => !tokens || !peakTokens ? 0 : tokens / peakTokens <= .15 ? 1 : tokens / peakTokens <= .35 ? 2 : tokens / peakTokens <= .65 ? 3 : 4;
  const weeks = Math.ceil(days.length / 7);
  chart.style.setProperty('--activity-weeks', weeks);
  const monthNames = Array(weeks).fill('');
  for (let month = 0; month < 12; month += 1) {
    const monthStart = new Date(year, month, 1, 12);
    const weekIndex = Math.floor((monthStart - firstDay) / 604800000);
    monthNames[weekIndex] = `Thg ${month + 1}`;
  }
  const formatNumber = value => new Intl.NumberFormat('vi-VN', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
  const monthHtml = monthNames.map(name => `<span>${name}</span>`).join('');
  const cellsHtml = days.map(day => {
    const outsideRange = day.date < yearStart || day.date > yearEnd;
    const level = outsideRange ? 0 : levelFor(day.tokens);
    const label = `${day.date.toLocaleDateString('vi-VN')}: ${formatNumber(day.tokens)} tokens · ${day.queries} lượt gọi`;
    return `<span class="dashboard-activity-cell" data-level="${level}" title="${label}" aria-label="${label}"${outsideRange ? ' style="visibility:hidden"' : ''}></span>`;
  }).join('');
  chart.innerHTML = `<div class="dashboard-activity-months">${monthHtml}</div><div class="dashboard-activity-weekdays"><span>CN</span><span>T2</span><span>T3</span><span>T4</span><span>T5</span><span>T6</span><span>T7</span></div><div class="dashboard-activity-cells">${cellsHtml}</div>`;
  peakLabel.textContent = peak.date
    ? `Cao nhất: ${formatNumber(peak.tokens)} tokens (${peak.date.toLocaleDateString('vi-VN')})`
    : `Chưa có dữ liệu hoạt động trong năm ${year}`;
  const setSummary = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
  setSummary('dashboard-activity-total-tokens', formatNumber(totalTokens));
  setSummary('dashboard-activity-total-queries', formatNumber(totalQueries));
  setSummary('dashboard-activity-active-days', formatNumber(activeDays));
  setSummary('dashboard-activity-success-rate', totalQueries ? `${Math.round(successfulQueries / totalQueries * 100)}%` : '0%');
  setSummary('dashboard-activity-best-month', monthlyTokens[bestMonthIndex] ? `Tháng ${bestMonthIndex + 1} · ${formatNumber(monthlyTokens[bestMonthIndex])} tokens` : 'Chưa có dữ liệu');
}

function changeDashboardActivityYear(year) {
  const parsedYear = Number(year);
  if (!Number.isInteger(parsedYear)) return;
  window.dashboardActivityYear = parsedYear;
  renderDashboardActivity(window.dashboardAnalyticsHistory || []);
}

function renderDashboardChart(history, providers = window.dashboardAnalyticsProviders || []) {
  const canvas = document.getElementById('analyticsChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const range = window.dashboardAnalyticsRange || '7d';
  const buckets = range === 'today'
    ? groupHistoryByHour(history, providers)
    : range === '30d'
      ? groupHistoryByDay(history, 30, providers)
      : range === '12m'
        ? groupHistoryByMonth(history, 12, providers)
        : groupHistoryByDay(history, 7, providers);
  destroyChart('analyticsChart');
  window.khCharts.analyticsChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [
        {
          label: 'AI local',
          data: buckets.map(b => b.localQueries),
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.10)',
          fill: false,
          tension: 0.35
        },
        {
          label: 'AI bên thứ ba',
          data: buckets.map(b => b.thirdPartyQueries),
          borderColor: '#4f46e5',
          backgroundColor: 'rgba(79, 70, 229, 0.12)',
          fill: false,
          tension: 0.35
        },
        {
          label: 'Lỗi',
          data: buckets.map(b => b.errors),
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239, 68, 68, 0.08)',
          borderDash: [6, 4],
          tension: 0.35
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 900,
        easing: 'easeOutQuart'
      },
      animations: {
        y: {
          duration: 900,
          easing: 'easeOutQuart',
          from: context => context.chart.scales.y?.getPixelForValue(0)
        },
        radius: { duration: 500, easing: 'easeOutBack', from: 0 }
      },
      plugins: { legend: { position: 'bottom' } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
    }
  });
  requestAnimationFrame(() => animateDashboardCanvas(canvas));
}

function renderDashboardFeedbackChart(feedback = []) {
  const canvas = document.getElementById('dashboardFeedbackChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const now = new Date();
  const todayKey = vietnamDayKey(now);
  const range = window.dashboardFeedbackRange || '7d';
  const cutoff = new Date(now);
  if (range === '7d') cutoff.setDate(cutoff.getDate() - 6);
  else if (range === '30d') cutoff.setDate(cutoff.getDate() - 29);
  else if (range === '12m') cutoff.setFullYear(now.getFullYear(), 0, 1);
  cutoff.setHours(0, 0, 0, 0);
  const filteredFeedback = feedback.filter(item => {
    const date = parseViTimestamp(item.updatedAt || item.createdAt || item.audit?.timestamp);
    if (!date) return false;
    return range === 'today' ? vietnamDayKey(date) === todayKey : date >= cutoff;
  });
  const likes = filteredFeedback.filter(item => item.rating === 'like').length;
  const dislikes = filteredFeedback.filter(item => item.rating === 'dislike').length;
  const total = likes + dislikes;
  const satisfaction = total ? Math.round((likes / total) * 100) : 0;
  const summary = document.getElementById('dashboard-feedback-summary');
  if (summary) summary.textContent = total
    ? `${total} lượt đánh giá · ${satisfaction}% hài lòng`
    : 'Chưa có đánh giá';

  canvas.setAttribute(
    'aria-label',
    total
      ? `${total} lượt đánh giá, ${satisfaction}% hài lòng, ${likes} thích và ${dislikes} không thích`
      : 'Chưa có đánh giá câu trả lời AI'
  );

  const feedbackPercentLabels = {
    id: 'feedbackPercentLabels',
    afterDatasetsDraw(chartInstance) {
      const values = chartInstance.data.datasets[0]?.data || [];
      const valueTotal = values.reduce((sum, value) => sum + Number(value || 0), 0);
      if (!valueTotal) return;
      const meta = chartInstance.getDatasetMeta(0);
      const ctx = chartInstance.ctx;
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.font = '700 10.5px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(15,23,42,.28)';
      ctx.shadowBlur = 3;
      meta.data.forEach((arc, index) => {
        const value = Number(values[index] || 0);
        const percentage = value / valueTotal * 100;
        if (!value || percentage < 7) return;
        const angle = (arc.startAngle + arc.endAngle) / 2;
        const radius = (arc.innerRadius + arc.outerRadius) / 2;
        ctx.fillText(`${percentage.toFixed(1)}%`, arc.x + Math.cos(angle) * radius, arc.y + Math.sin(angle) * radius);
      });
      ctx.restore();
    }
  };

  const feedbackCenterLabel = {
    id: 'feedbackCenterLabel',
    afterDatasetsDraw(chartInstance) {
      const arc = chartInstance.getDatasetMeta(0)?.data?.[0];
      if (!arc) return;
      const ctx = chartInstance.ctx;
      const primaryColor = document.documentElement.dataset.theme === 'dark' ? '#e2e8f0' : '#2563a5';
      const secondaryColor = document.documentElement.dataset.theme === 'dark' ? '#94a3b8' : '#64748b';

      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = primaryColor;
      ctx.font = '700 18px Inter, sans-serif';
      ctx.fillText(`${satisfaction}%`, arc.x, arc.y - 8);
      ctx.fillStyle = secondaryColor;
      ctx.font = '500 12px Inter, sans-serif';
      ctx.fillText(total ? 'Hài lòng' : 'Chưa có dữ liệu', arc.x, arc.y + 13);
      ctx.restore();
    }
  };

  destroyChart('dashboardFeedbackChart');
  window.khCharts.dashboardFeedbackChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Thích', 'Không thích'],
      datasets: [{
        data: [likes, dislikes],
        backgroundColor: ['#10b981', '#ef4444'],
        borderColor: 'transparent',
        borderWidth: 0,
        borderRadius: 12,
        spacing: 4,
        hoverOffset: 8
      }]
    },
    plugins: [feedbackPercentLabels, feedbackCenterLabel],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '56%',
      rotation: 0,
      layout: { padding: { top: 2 } },
      animation: { duration: 700, easing: 'easeOutQuart', animateRotate: true, animateScale: true },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, padding: 18, font: { weight: '700' } } },
        tooltip: { callbacks: { label: context => `${context.label}: ${context.raw} lượt (${total ? (Number(context.raw) / total * 100).toFixed(1) : '0.0'}%)` } }
      }
    }
  });
}

function changeDashboardFeedbackRange(range) {
  window.dashboardFeedbackRange = ['today', '7d', '30d', '12m'].includes(range) ? range : '7d';
  renderDashboardFeedbackChart(window.dashboardFeedbackData || []);
}

function changeDashboardAnalyticsRange(range) {
  window.dashboardAnalyticsRange = ['today', '7d', '30d', '12m'].includes(range) ? range : '7d';
  renderDashboardChart(window.dashboardAnalyticsHistory || [], window.dashboardAnalyticsProviders || []);
}

function renderAnalyticsChart(history, providers) {
  const canvas = document.getElementById('pageAnalyticsChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const buckets = groupHistoryByMonth(history, 6, providers);
  destroyChart('pageAnalyticsChart');
  window.khCharts.pageAnalyticsChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [
        {
          type: 'bar',
          label: 'AI local',
          data: buckets.map(b => b.localQueries),
          backgroundColor: 'rgba(16, 185, 129, 0.78)',
          order: 1,
          borderRadius: 6,
          stack: 'aiCalls',
          yAxisID: 'y'
        },
        {
          type: 'bar',
          label: 'AI bên thứ ba',
          data: buckets.map(b => b.thirdPartyQueries),
          backgroundColor: 'rgba(79, 70, 229, 0.78)',
          order: 1,
          borderRadius: 6,
          stack: 'aiCalls',
          yAxisID: 'y'
        },
        {
          type: 'line',
          label: 'Chi phí ước tính',
          data: buckets.map(b => Number(b.estimatedCost.toFixed(4))),
          borderColor: '#c2410c',
          backgroundColor: '#c2410c',
          borderWidth: 4,
          pointRadius: 5,
          pointHoverRadius: 7,
          pointBackgroundColor: '#ffffff',
          pointBorderColor: '#c2410c',
          pointBorderWidth: 3,
          fill: false,
          order: 0,
          tension: 0.35,
          yAxisID: 'y1'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { stacked: true },
        y: { beginAtZero: true, stacked: true, ticks: { precision: 0 } },
        y1: {
          beginAtZero: true,
          position: 'right',
          grid: { drawOnChartArea: false },
          border: { color: '#c2410c' },
          ticks: { color: '#9a3412', font: { weight: '700' } }
        }
      }
    }
  });
}

function renderProviderBreakdown(history) {
  const container = document.getElementById('analytics-provider-breakdown');
  if (!container) return;
  const counts = new Map();
  (history || []).forEach(item => {
    const key = item.modelName || item.providerName || 'Unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const total = Math.max(1, history.length);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (rows.length === 0) {
    container.innerHTML = `<div class="analytics-empty">Chưa có dữ liệu gọi AI.</div>`;
    return;
  }
  container.innerHTML = rows.map(([name, count], index) => {
    const pct = Math.round((count / total) * 100);
    const rank = index + 1;
    return `
      <div class="provider-usage-row">
        <div class="provider-usage-head">
          <div class="provider-usage-name">
            <span class="provider-usage-rank provider-usage-rank-${rank}">${rank}</span>
            <strong>${name}</strong>
          </div>
          <span>${count} lượt • ${pct}%</span>
        </div>
        <div class="provider-usage-bar"><span style="width:${pct}%"></span></div>
      </div>
    `;
  }).join('');
}

function updateMetricText(data) {
  const history = data.history || [];
  const dictionary = data.dictionary || [];
  const providers = data.providers || [];
  const totalTables = dictionary.length;
  const totalColumns = dictionary.reduce((sum, t) => sum + (t.columns?.length || 0), 0);
  const avgLatency = history.length
    ? Math.round(history.reduce((sum, item) => sum + Number(item.latencyMs || 0), 0) / history.length)
    : 0;
  const estimatedCost = estimateAuditCost(history, providers);
  const activeProvider = data.activeProvider || providers.find(p => p.isActive) || providers[0];
  const fallbackProvider = providers.find(p => !p.isActive);

  const setText = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };

  setText('val-connectors', String((data.sources || []).length).padStart(2, '0'));
  setText('val-tables', String(totalTables));
  setText('val-queries', String(history.length));
  setText('val-cost', formatMoney(estimatedCost));
  setText('dash-router-primary', activeProvider ? `${activeProvider.name} (${activeProvider.model})` : 'Chưa cấu hình');
  setText('dash-router-fallback', fallbackProvider ? `${fallbackProvider.name} (${fallbackProvider.model})` : 'Chưa kích hoạt');
  setText('dash-router-vector', `Qdrant (${data.qdrant.pointsCount || totalColumns || 0} vectors)`);

  setText('analytics-total-cost', formatMoney(estimatedCost));
  setText('analytics-avg-latency', String(avgLatency));
  setText('analytics-total-queries', String(history.length));
  setText('analytics-health-qdrant', `${data.qdrant.pointsCount || totalColumns || 0} vectors indexed`);
}

async function refreshDashboardMetrics() {
  const data = await fetchAnalyticsSourceData();
  window.dashboardAnalyticsHistory = data.history;
  window.dashboardAnalyticsProviders = data.providers;
  window.dashboardFeedbackData = data.feedback;
  updateMetricText(data);
  renderDashboardChart(data.history, data.providers);
  renderDashboardFeedbackChart(data.feedback);
  renderDashboardActivity(data.history);
}

async function initPageAnalyticsCharts() {
  const data = await fetchAnalyticsSourceData();
  updateMetricText(data);
  renderAnalyticsChart(data.history, data.providers);
  renderProviderBreakdown(data.history);
}

window.refreshDashboardMetrics = refreshDashboardMetrics;
window.initPageAnalyticsCharts = initPageAnalyticsCharts;
window.changeDashboardAnalyticsRange = changeDashboardAnalyticsRange;
window.changeDashboardFeedbackRange = changeDashboardFeedbackRange;
window.changeDashboardActivityYear = changeDashboardActivityYear;
