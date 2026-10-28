// Admin page: token usage, limits and locks per account and per AI model.
(function initAiUsage() {
  let state = { accounts: [], providers: [] };
  const format = value => Number(value || 0).toLocaleString('vi-VN');
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

  async function request(url, options = {}) {
    const response = await fetch(url, { headers: { 'Content-Type': 'application/json' }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || data.message || 'Không thể tải hạn mức AI.');
    return data;
  }

  // Share of the limit used in the limit's own period; null when there is no limit.
  function ratio(item) {
    const limit = item.limit;
    if (!limit || limit.tokenLimit === null || limit.tokenLimit === undefined) return null;
    if (limit.tokenLimit === 0) return 1;
    return (item.usage[limit.period] || 0) / limit.tokenLimit;
  }

  function row(item, scope) {
    const limit = item.limit || { period: 'month', tokenLimit: null, locked: false };
    const share = ratio(item), level = share === null ? '' : share >= 1 ? 'is-over' : share >= 0.8 ? 'is-near' : '';
    const title = scope === 'account'
      ? `<strong>${escape(item.displayName || item.username)}</strong><small>${escape(item.username)} · ${escape(item.roleLabel || item.role)}${item.isActive === false ? ' · tài khoản đã khóa đăng nhập' : ''}</small>`
      : `<strong>${escape(item.name)}${item.isActive ? ' <span class="ai-usage-badge">Đang dùng</span>' : ''}</strong><small>${escape(item.model || item.type || '')}</small>`;
    const meter = share === null ? ''
      : `<div class="ai-usage-meter ${level}" role="img" aria-label="Đã dùng ${Math.round(share * 100)}% hạn mức"><span style="width:${Math.min(100, share * 100)}%"></span></div><small class="${level}">${format(item.usage[limit.period])} / ${format(limit.tokenLimit)} (${Math.round(share * 100)}%)</small>`;
    return `<tr data-scope="${scope}" data-id="${escape(item.id)}" class="${limit.locked ? 'is-locked' : ''}">
      <td class="ai-usage-name">${title}</td>
      <td><strong>${format(item.usage.day)}</strong><small>${format(item.usage.dayRequests)} lần gọi</small></td>
      <td><strong>${format(item.usage.week)}</strong><small>${format(item.usage.weekRequests)} lần gọi</small></td>
      <td><strong>${format(item.usage.month)}</strong><small>${format(item.usage.monthRequests)} lần gọi</small></td>
      <td class="ai-usage-limit"><div class="ai-usage-limit-inputs">
        <input type="number" min="0" step="1000" inputmode="numeric" class="form-control" data-field="tokenLimit" value="${limit.tokenLimit ?? ''}" placeholder="Không giới hạn" aria-label="Hạn mức token">
        <select class="form-control" data-field="period" aria-label="Chu kỳ hạn mức"><option value="day"${limit.period === 'day' ? ' selected' : ''}>/ ngày</option><option value="week"${limit.period === 'week' ? ' selected' : ''}>/ tuần</option><option value="month"${!['day', 'week'].includes(limit.period) ? ' selected' : ''}>/ tháng</option></select>
      </div>${meter}</td>
      <td><label class="ai-usage-switch"><input type="checkbox" data-field="locked"${limit.locked ? '' : ' checked'} aria-label="Cho phép sử dụng AI"><span>${limit.locked ? 'Đã khóa' : 'Đang mở'}</span></label></td>
      <td class="ai-usage-actions"><button type="button" class="btn-secondary-sm" data-action="save" disabled>Lưu</button><button type="button" class="btn-secondary-sm ai-usage-reset" data-action="reset" title="Đưa mức đã dùng hôm nay, tuần này và tháng này về 0" aria-label="Đặt lại mức đã dùng"${item.usage.day || item.usage.week || item.usage.month ? '' : ' disabled'}><i class="fa-solid fa-rotate-left" aria-hidden="true"></i> Đặt lại</button></td>
    </tr>`;
  }

  function matches(item) {
    const keyword = String(document.getElementById('ai-usage-account-search')?.value || '').trim().toLowerCase();
    const filter = document.getElementById('ai-usage-account-filter')?.value || '';
    if (keyword && !`${item.displayName} ${item.username}`.toLowerCase().includes(keyword)) return false;
    const share = ratio(item);
    if (filter === 'limited') return share !== null;
    if (filter === 'near') return share !== null && share >= 0.8;
    if (filter === 'locked') return Boolean(item.limit?.locked);
    return true;
  }

  window.filterAiUsageAccounts = function filterAiUsageAccounts() {
    const page = window.paginationState.ai_usage_accounts;
    if (page) page.currentPage = 1;
    window.renderAiUsageAccounts();
  };

  window.renderAiUsageAccounts = function renderAiUsageAccounts() {
    const body = document.getElementById('ai-usage-account-rows');
    if (!body) return;
    const visible = state.accounts.filter(matches);
    const page = window.getAdminListPage(visible, 'ai_usage_accounts');
    body.innerHTML = visible.length ? page.items.map(item => row(item, 'account')).join('') : '<tr><td colspan="7" class="ai-usage-empty">Không có tài khoản phù hợp.</td></tr>';
    window.renderPaginationControls('ai-usage-account-pagination', 'ai_usage_accounts', visible.length, window.renderAiUsageAccounts);
  };

  window.renderAiUsageProviders = function renderAiUsageProviders() {
    const body = document.getElementById('ai-usage-provider-rows');
    if (!body) return;
    const page = window.getAdminListPage(state.providers, 'ai_usage_providers');
    body.innerHTML = state.providers.length ? page.items.map(item => row(item, 'provider')).join('') : '<tr><td colspan="7" class="ai-usage-empty">Chưa cấu hình mô hình AI.</td></tr>';
    window.renderPaginationControls('ai-usage-provider-pagination', 'ai_usage_providers', state.providers.length, window.renderAiUsageProviders);
  };

  window.renderAiUsage = function renderAiUsage() {
    const accounts = document.getElementById('ai-usage-account-rows'), providers = document.getElementById('ai-usage-provider-rows');
    if (!accounts || !providers) return;
    window.renderAiUsageAccounts();
    window.renderAiUsageProviders();
    const all = [...state.accounts, ...state.providers];
    const summary = document.getElementById('ai-usage-summary');
    if (summary) {
      const total = bucket => state.providers.reduce((sum, item) => sum + (item.usage[bucket] || 0), 0);
      const locked = all.filter(item => item.limit?.locked).length, over = all.filter(item => (ratio(item) ?? 0) >= 1).length;
      summary.innerHTML = [['fa-sun', 'Token hôm nay', format(total('day'))], ['fa-calendar-week', 'Token tuần này', format(total('week'))], ['fa-calendar', 'Token tháng này', format(total('month'))],
        ['fa-lock', 'Đang khóa', format(locked)], ['fa-triangle-exclamation', 'Đã hết hạn mức', format(over)]]
        .map(([symbol, label, value]) => `<div class="ai-usage-stat"><i class="fa-solid ${symbol}" aria-hidden="true"></i><span>${label}</span><strong>${value}</strong></div>`).join('');
    }
  };

  window.loadAiUsage = async function loadAiUsage() {
    try {
      state = await request('/api/ai-usage'); window.renderAiUsage();
      if (state.setupRequired && typeof showToast === 'function') showToast('Chưa tạo bảng hạn mức AI. Hãy chạy "npm run db:migrate" rồi khởi động lại server; trong lúc đó AI vẫn dùng bình thường nhưng chưa đếm và chưa chặn.', 'warning');
    }
    catch (failure) { if (typeof showToast === 'function') showToast(failure.message, 'error'); }
  };

  // Enable Lưu only when a row changed; the lock switch saves immediately.
  document.addEventListener('input', event => {
    const tableRow = event.target.closest?.('#view-ai-usage tr[data-scope]');
    if (tableRow && event.target.dataset.field !== 'locked') tableRow.querySelector('[data-action="save"]').disabled = false;
  });
  document.addEventListener('change', event => {
    const tableRow = event.target.closest?.('#view-ai-usage tr[data-scope]');
    if (!tableRow) return;
    if (event.target.dataset.field === 'locked') save(tableRow);
    else tableRow.querySelector('[data-action="save"]').disabled = false;
  });
  document.addEventListener('click', event => {
    const target = event.target.closest?.('#view-ai-usage [data-action="save"], #view-ai-usage [data-action="reset"]');
    if (target) (target.dataset.action === 'reset' ? reset : save)(target.closest('tr'));
  });

  async function reset(tableRow) {
    const list = tableRow.dataset.scope === 'account' ? state.accounts : state.providers;
    const item = list.find(entry => entry.id === tableRow.dataset.id);
    if (!item) return;
    const name = tableRow.dataset.scope === 'account' ? (item.displayName || item.username) : `${item.name}${item.model ? ` - ${item.model}` : ''}`;
    const message = `Đưa mức đã dùng của “${name}” về 0: hôm nay ${format(item.usage.day)}, tuần này ${format(item.usage.week)}, tháng này ${format(item.usage.month)} token. Hạn mức và trạng thái khóa giữ nguyên. Không thể hoàn tác.`;
    const confirmed = typeof window.showUiConfirm === 'function'
      ? await window.showUiConfirm(message, { title: 'Đặt lại mức đã dùng?', confirmText: 'Đặt lại', tone: 'danger' })
      : window.confirm(message);
    if (!confirmed) return;
    tableRow.querySelectorAll('input, select, button').forEach(control => { control.disabled = true; });
    try {
      await request('/api/ai-usage/reset', { method: 'POST', body: JSON.stringify({ scope: tableRow.dataset.scope, targetId: tableRow.dataset.id }) });
      if (typeof showToast === 'function') showToast(`Đã đặt lại mức đã dùng của ${name}.`, 'success');
    } catch (failure) {
      if (typeof showToast === 'function') showToast(failure.message, 'error');
    }
    await window.loadAiUsage();
  }
  document.addEventListener('keydown', event => {
    if (event.key === 'Enter' && event.target.matches?.('#view-ai-usage [data-field="tokenLimit"]')) save(event.target.closest('tr'));
  });

  async function save(tableRow) {
    const value = tableRow.querySelector('[data-field="tokenLimit"]').value.trim();
    const body = { scope: tableRow.dataset.scope, targetId: tableRow.dataset.id, period: tableRow.querySelector('[data-field="period"]').value,
      tokenLimit: value === '' ? null : Number(value), locked: !tableRow.querySelector('[data-field="locked"]').checked };
    tableRow.querySelectorAll('input, select, button').forEach(control => { control.disabled = true; });
    try {
      await request('/api/ai-usage/limits', { method: 'PUT', body: JSON.stringify(body) });
      if (typeof showToast === 'function') showToast(body.locked ? 'Đã khóa sử dụng AI.' : 'Đã lưu hạn mức AI.', 'success');
      await window.loadAiUsage();
    } catch (failure) {
      if (typeof showToast === 'function') showToast(failure.message, 'error');
      tableRow.querySelectorAll('input, select').forEach(control => { control.disabled = false; });
      tableRow.querySelector('[data-action="save"]').disabled = false;
    }
  }
})();
