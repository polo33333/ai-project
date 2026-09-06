(() => {
  let loading = false;
  const el = id => document.getElementById(id);
  const normalize = text => String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const showMessage = (text, tone = '') => { const node = el('settings-message'); if (node) { node.textContent = text; node.dataset.tone = tone; } };

  function createValue(field) {
    const value = document.createElement('div'); value.className = 'settings-value';
    if (field.type === 'boolean') {
      const enabled = field.value === 'true'; value.classList.add('is-status', enabled ? 'enabled' : 'disabled');
      const dot = document.createElement('i'); dot.className = 'fa-solid fa-circle';
      const text = document.createElement('span'); text.textContent = enabled ? 'Bật' : 'Tắt'; value.append(dot, text);
    } else { value.textContent = field.value || 'Chưa cấu hình'; if (!field.value) value.classList.add('is-empty'); }
    return value;
  }

  function renderSettings(data) {
    const groups = [...new Set(data.fields.map(field => field.group))];
    el('settings-total').textContent = `${data.fields.length} thuộc tính`;
    const root = el('settings-fields');
    root.replaceChildren();
    groups.forEach(group => {
      const groupFields = data.fields.filter(field => field.group === group);
      const section = document.createElement('section'); section.className = 'settings-section'; section.dataset.group = group;
      const header = document.createElement('header'); const heading = document.createElement('h3'); heading.textContent = group;
      const summary = document.createElement('span'); summary.textContent = `${groupFields.length} thuộc tính cấu hình`;
      header.append(heading, summary); section.append(header);
      const list = document.createElement('div'); list.className = 'settings-list'; section.append(list);
      groupFields.forEach(field => {
        const item = document.createElement('article'); item.className = 'settings-property';
        item.dataset.search = normalize(`${group} ${field.key} ${field.label} ${field.description}`);
        const information = document.createElement('div'); information.className = 'settings-property-info';
        const name = document.createElement('strong'); name.textContent = field.label;
        const key = document.createElement('code'); key.textContent = field.key;
        const description = document.createElement('p'); description.textContent = field.description;
        information.append(name, key, description);
        const result = document.createElement('div'); result.className = 'settings-property-result'; result.append(createValue(field));
        const meta = document.createElement('small'); meta.textContent = `${field.source}${field.environmentOverride ? ' · Tiến trình đang chạy dùng giá trị khác' : ''}`;
        result.append(meta); item.append(information, result); list.append(item);
      });
      root.append(section);
    });
    filterSettings(el('settings-search').value);
  }

  window.fetchSettings = async function (force = false) {
    if (loading && !force) return;
    loading = true; showMessage('Đang tải cấu hình…');
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' }); const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Không thể tải cấu hình.');
      renderSettings(data); showMessage('Cấu hình đang hiển thị ở chế độ chỉ xem.', 'success');
      window.checkSettingsConnection(true);
    } catch (error) { el('settings-fields')?.replaceChildren(); showMessage(error.message, 'error'); }
    finally { loading = false; }
  };

  window.filterSettings = function (value) {
    const query = normalize(value.trim());
    document.querySelectorAll('.settings-section').forEach(section => {
      section.querySelectorAll('.settings-property').forEach(item => { item.hidden = Boolean(query) && !item.dataset.search.includes(query); });
      section.hidden = !section.querySelector('.settings-property:not([hidden])');
    });
    el('settings-empty').hidden = Boolean(document.querySelector('.settings-section:not([hidden])'));
  };
  window.reloadSettings = () => window.fetchSettings(true);

  window.checkSettingsConnection = async function (silent = false) {
    const button = el('settings-check'); const card = document.querySelector('.settings-qdrant-card');
    if (!button || !card || button.disabled) return;
    const buttonIcon = button.querySelector('i'); const buttonLabel = button.querySelector('span');
    button.disabled = true; card.dataset.state = 'checking';
    if (buttonIcon) buttonIcon.className = 'fa-solid fa-spinner fa-spin';
    if (buttonLabel) buttonLabel.textContent = 'Đang kiểm tra';
    el('settings-qdrant-state').textContent = 'Đang kiểm tra'; el('settings-qdrant-message').textContent = 'Đang kết nối tới Qdrant theo cấu hình của tiến trình hiện tại.';
    const minimumAnimation = new Promise(resolve => setTimeout(resolve, 1100));
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/qdrant/status', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`); const data = await response.json();
      await minimumAnimation;
      card.dataset.state = data.connected ? 'online' : 'offline';
      el('settings-qdrant-state').textContent = data.connected ? 'Đã kết nối' : 'Mất kết nối';
      el('settings-qdrant-collection').textContent = data.collectionName || '—';
      el('settings-qdrant-points').textContent = Number.isFinite(Number(data.pointsCount)) ? Number(data.pointsCount).toLocaleString('vi-VN') : '—';
      el('settings-qdrant-message').textContent = data.connected ? `Dịch vụ phản hồi bình thường tại ${data.url || 'URL đã cấu hình'}.` : `Không thể truy cập ${data.url || 'Qdrant'}. ${data.error || 'Kiểm tra dịch vụ và cấu hình.'}`;
    } catch (error) {
      await minimumAnimation;
      card.dataset.state = 'offline'; el('settings-qdrant-state').textContent = 'Kiểm tra thất bại';
      el('settings-qdrant-collection').textContent = '—'; el('settings-qdrant-points').textContent = '—';
      el('settings-qdrant-message').textContent = error.name === 'AbortError' ? 'Qdrant không phản hồi sau 10 giây.' : `Không thể kiểm tra Qdrant: ${error.message}`;
    } finally {
      clearTimeout(timeout);
      const checkedAt = el('settings-qdrant-checked-at');
      if (checkedAt) checkedAt.textContent = `Cập nhật ${new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}`;
      button.disabled = false;
      if (buttonIcon) buttonIcon.className = 'fa-solid fa-rotate';
      if (buttonLabel) buttonLabel.textContent = 'Kiểm tra lại';
    }
  };
})();
