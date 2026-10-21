(function () {
  'use strict';
  let resources = [];
  const fields = ['subjects', 'roles', 'embedIds', 'modelDestinations', 'allowedTables', 'blockedColumns'];
  const el = id => document.getElementById(id);
  window.loadGovernanceResources = async function () {
    if (!el('governance-resource')) return;
    // Operations are independent of resource/metric selection.
    const operationsRequest = window.loadAgentOperations();
    try {
      const response = await fetch('/api/governance/resources', { cache: 'no-store' }), data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Không tải được chính sách.');
      resources = (data.resources || []).sort((a, b) => Number(a.type !== 'sql') - Number(b.type !== 'sql'));
      el('governance-mode').textContent = data.externalReadOnly ? 'SQL và API chỉ đọc' : 'SQL chỉ đọc · API theo cấu hình';
      el('governance-resource').replaceChildren(...['sql', 'document'].map(type => {
        const group = document.createElement('optgroup'); group.label = type === 'sql' ? 'Nguồn SQL' : 'Tài liệu';
        resources.forEach((resource, index) => { if (resource.type !== type) return; const option = document.createElement('option'); option.value = index; option.textContent = resource.name; group.append(option); });
        return group;
      }).filter(group => group.children.length));
      el('governance-providers').replaceChildren(...(data.providers || []).map(provider => { const option = document.createElement('option'); option.value = provider.id; option.label = `${provider.name} · ${provider.model}`; return option; }));
      el('governance-form').hidden = !resources.length;
      if (!resources.length) el('governance-mode').textContent += ' · Chưa có nguồn để cấu hình.';
      window.selectGovernanceResource();
      el('metric-source').replaceChildren(...resources.filter(resource => resource.type === 'sql').map(resource => { const option = document.createElement('option'); option.value = resource.id; option.textContent = resource.name; return option; }));
      await Promise.all([window.loadGovernedMetrics(), operationsRequest]);
    } catch (error) { el('governance-message').textContent = error.message; return false; }
  };
  window.selectGovernanceResource = function () {
    const resource = resources[Number(el('governance-resource')?.value)]; if (!resource) return;
    el('governance-visibility').value = resource.policy.visibility;
    el('governance-sensitivity').value = resource.policy.sensitivity;
    fields.forEach(field => { el(`governance-${field}`).value = (resource.policy[field] || []).join(', '); });
    for (const field of ['allowedTables', 'blockedColumns']) el(`governance-${field}`).closest('label').hidden = resource.type !== 'sql';
    el('governance-message').textContent = `Phiên bản chính sách: ${resource.policy.revision}`;
  };
  window.saveGovernanceResource = async function (event) {
    event.preventDefault();
    const resource = resources[Number(el('governance-resource').value)]; if (!resource) return;
    const button = event.currentTarget.querySelector('button[type="submit"]'); button.disabled = true;
    try {
      const policy = { visibility: el('governance-visibility').value, sensitivity: el('governance-sensitivity').value };
      fields.forEach(field => { policy[field] = [...new Set(el(`governance-${field}`).value.split(',').map(value => value.trim()).filter(Boolean))]; });
      const response = await fetch('/api/governance/resources', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: resource.type, id: resource.id, expectedRevision: resource.policy.revision, policy }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Không lưu được chính sách.');
      Object.assign(resource, data.resource); el('governance-message').textContent = `Đã lưu phiên bản ${resource.policy.revision}. Chính sách có hiệu lực cho yêu cầu tiếp theo.`;
    } catch (error) { el('governance-message').textContent = error.message; }
    finally { button.disabled = false; }
  };
  let metrics = [];
  window.loadGovernedMetrics = async function () {
    try {
      const response = await fetch('/api/governance/metrics', { cache: 'no-store' }), data = await response.json();
      if (!response.ok) throw new Error(data.message);
      metrics = (data.metrics || []).filter(metric => metric.sourceId === el('metric-source').value);
      const fresh = document.createElement('option'); fresh.value = ''; fresh.textContent = 'Tạo mới';
      el('metric-existing').replaceChildren(fresh, ...metrics.map(metric => { const option = document.createElement('option'); option.value = metric.metricId; option.textContent = `${metric.metricId} · v${metric.version} · ${metric.approved ? 'Đã duyệt' : 'Bản nháp'}`; return option; }));
      window.selectGovernedMetric();
    } catch (error) { el('metric-message').textContent = error.message; }
  };
  window.selectGovernedMetric = function () {
    const existing = metrics.find(metric => metric.metricId === el('metric-existing').value);
    const sample = { metricId: 'new_metric', owner: '', definition: '', table: 'dbo.Table', valueColumn: 'Amount', aggregation: 'SUM', unit: '', grain: '', timeColumn: 'CreatedAt', timezone: 'Asia/Ho_Chi_Minh', dimensions: [], nullRule: 'exclude', rounding: 2, approved: false };
    const definition = existing ? Object.fromEntries(Object.keys(sample).map(key => [key, existing[key]])) : sample;
    el('metric-definition').value = JSON.stringify(definition, null, 2);
    el('metric-message').textContent = existing ? `Phiên bản ${existing.version} · Chủ nghiệp vụ: ${existing.owner}` : 'Chưa có chỉ tiêu nghiệp vụ mặc định. Điền định nghĩa trước khi lưu.';
  };
  window.saveGovernedMetric = async function (event) {
    event.preventDefault(); const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      const definition = JSON.parse(el('metric-definition').value), existing = metrics.find(metric => metric.metricId === definition.metricId);
      const response = await fetch('/api/governance/metrics', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: el('metric-source').value, definition, expectedRevision: existing?.version || 0 }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.message);
      await window.loadGovernedMetrics(); el('metric-existing').value = data.metric.metricId; window.selectGovernedMetric();
    } catch (error) { el('metric-message').textContent = error.message; }
    finally { button.disabled = false; }
  };
  window.loadAgentOperations = async function () {
    if (!el('operations-summary')) return;
    const button = el('operations-refresh');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    el('operations-summary').setAttribute('aria-busy', 'true');
    el('operations-message').textContent = 'Đang cập nhật báo cáo vận hành…';
    try {
      const response = await fetch('/api/governance/operations', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Chưa tải được báo cáo vận hành.');
      const measured = value => value === null || value === undefined ? 'Chưa đo' : `${Number(value).toLocaleString('vi-VN')} ms`;
      const count = value => value == null ? 'Chưa có dữ liệu' : Number(value).toLocaleString('vi-VN');
      const summary = [
        ['Lượt đã lưu', count(data.requests), 'Tổng lượt trong lịch sử', 'layer-group', 'indigo'],
        ['Kết quả một phần', count(data.statuses.PARTIAL || 0), 'Chưa hoàn tất toàn bộ yêu cầu', 'circle-half-stroke', 'amber'],
        ['Lượt lỗi', count((data.statuses.ERROR || 0) + (data.statuses.FAILED || 0)), 'Trạng thái lỗi hoặc thất bại', 'circle-exclamation', 'red'],
        ['Thiếu tiêu chí', count(data.missingCriteria), 'Chưa đáp ứng đủ tiêu chí kiểm tra', 'list-check', 'amber'],
        ['Độ trễ P50', measured(data.latency.p50Ms), '50% lượt có độ trễ không vượt mức này', 'gauge', 'indigo'],
        ['Độ trễ P95', measured(data.latency.p95Ms), '95% lượt có độ trễ không vượt mức này', 'stopwatch', 'indigo'],
        ['Chi phí (USD)', data.cost.total == null ? 'Chưa đủ dữ liệu' : (Number(data.cost.total) / 1000000).toLocaleString('vi-VN', { maximumFractionDigits: 6 }), 'Tính từ mức sử dụng và bảng giá', 'coins', 'indigo']
      ];
      el('operations-summary').replaceChildren(...summary.map(([name, value, hint, icon, tone], index) => {
        const card = document.createElement('div'); card.className = `operations-stat ${index >= 4 ? 'operations-stat-secondary' : ''}`;
        const label = document.createElement('dt'), detail = document.createElement('dd'), note = document.createElement('span');
        const symbol = document.createElement('i'); symbol.className = `fa-solid fa-${icon}`; symbol.setAttribute('aria-hidden', 'true');
        const badge = document.createElement('span'); badge.className = `operations-stat-icon ${tone}`; badge.append(symbol);
        label.append(badge, document.createTextNode(name)); detail.textContent = String(value);
        if (value === 'Chưa đủ dữ liệu' || value === 'Chưa đo' || value === 'Chưa có dữ liệu') detail.className = 'operations-stat-unavailable';
        note.className = 'operations-stat-hint'; note.textContent = hint; detail.append(note); card.append(label, detail); return card;
      }));
      const labels = { OPERATIONS_POLICY_UNCONFIGURED: 'Chưa thiết lập ngưỡng cảnh báo vận hành.', COST_EVIDENCE_INCOMPLETE: 'Chưa đủ dữ liệu sử dụng hoặc bảng giá để tính chi phí.',
        ERROR_RATE_HIGH: 'Tỷ lệ lỗi vượt ngưỡng.', LATENCY_P95_HIGH: 'Độ trễ P95 vượt ngưỡng.', COST_BUDGET_EXCEEDED: 'Chi phí vượt ngân sách.' };
      el('operations-alerts').replaceChildren(...(data.alerts || []).map(alert => { const li = document.createElement('li');
        const icon = document.createElement('i'); icon.className = 'fa-solid fa-circle-info'; icon.setAttribute('aria-hidden', 'true');
        li.append(icon, document.createTextNode(labels[alert.code] || 'Có cảnh báo cần kiểm tra.')); return li; }));
      el('operations-alerts').hidden = !(data.alerts || []).length;
      el('operations-message').textContent = 'Thống kê từ lịch sử đã lưu; trạng thái hoàn tất không thay cho nghiệm thu chất lượng nghiệp vụ.';
    } catch (error) { el('operations-message').textContent = error.message; }
    finally { if (button) button.disabled = false; el('operations-summary').setAttribute('aria-busy', 'false'); }
  };
})();
