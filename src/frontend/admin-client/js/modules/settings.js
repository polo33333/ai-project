(() => {
  let loading = false;
  let saving = false;
  let currentRevision = '';
  let pendingRestart = false;
  let activeGroup = '';
  let activePane = 'config';
  const el = id => document.getElementById(id);
  const PANE_STORAGE_KEY = 'knowledgehub.settingsPane';
  // Sidebar sections in reading order: infrastructure first, then AI, data and integrations.
  const NAV_SECTIONS = [
    ['Hạ tầng', [['Máy chủ', 'fa-server'], ['Lưu trữ PostgreSQL', 'fa-database']]],
    ['AI & Agent', [['AI và model local', 'fa-microchip'], ['AI provider bên thứ ba', 'fa-cloud'], ['Điều phối agent và giới hạn', 'fa-diagram-project'], ['Bộ nhớ hội thoại', 'fa-brain']]],
    ['Dữ liệu & tri thức', [['Kho tri thức và embedding', 'fa-book-bookmark'], ['Ngữ cảnh và quan hệ CSDL', 'fa-sitemap'], ['Tìm kiếm web', 'fa-globe']]],
    ['Tích hợp', [['MCP và công cụ', 'fa-plug'], ['Mẫu nghiệp vụ', 'fa-briefcase']]]
  ];
  const groupIcon = group => NAV_SECTIONS.flatMap(([, items]) => items).find(([name]) => name === group)?.[1] || 'fa-sliders';
  function panelToggle(panel, heading, targets) {
    if (!panel || !heading || heading.querySelector('.settings-panel-toggle')) return;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'settings-panel-toggle';
    const update = collapsed => {
      button.setAttribute('aria-expanded', String(!collapsed));
      button.setAttribute('aria-label', collapsed ? 'Mở rộng panel' : 'Thu gọn panel');
      button.innerHTML = `<i class="fa-solid fa-chevron-${collapsed ? 'down' : 'up'}" aria-hidden="true"></i>`;
      panel.classList.toggle('is-collapsed', collapsed);
      targets.forEach(target => { target.hidden = collapsed; });
    };
    button.onclick = () => update(button.getAttribute('aria-expanded') === 'true');
    heading.append(button); update(false);
  }
  function navButton({ label, icon, count, onClick, dataset }) {
    const button = document.createElement('button'); button.type = 'button';
    Object.assign(button.dataset, dataset);
    const symbol = document.createElement('i'); symbol.className = `fa-solid ${icon}`; symbol.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span'); title.className = 'settings-nav-label'; title.textContent = label;
    button.append(symbol, title);
    if (count !== undefined) { const badge = document.createElement('span'); badge.className = 'settings-nav-count'; badge.textContent = count; button.append(badge); }
    button.onclick = onClick;
    return button;
  }
  const navHeading = text => { const heading = document.createElement('small'); heading.textContent = text; return heading; };

  // The app header sticks over the scrolling page; measure it so the sidebar sticks just below it.
  function syncStickyTop() {
    const view = el('view-settings'), header = document.querySelector('header.top-bar'), main = view?.closest('main');
    if (!view || !header || !main) return;
    const paddingTop = parseFloat(getComputedStyle(main).paddingTop) || 0;
    view.style.setProperty('--settings-sticky-top', `${Math.max(12, header.offsetHeight - paddingTop + 12)}px`);
  }
  window.addEventListener('resize', syncStickyTop);

  // One pane is visible at a time: configuration, service status or backup.
  window.showSettingsPane = function (pane) {
    syncStickyTop();
    activePane = ['config', 'status', 'backup'].includes(pane) ? pane : 'config';
    try { localStorage.setItem(PANE_STORAGE_KEY, activePane); } catch (_) { /* The pane still opens; it is just not remembered. */ }
    document.querySelectorAll('#view-settings .settings-pane').forEach(node => { node.hidden = node.dataset.pane !== activePane; });
    syncNav();
  };
  function syncNav() {
    const query = el('settings-search')?.value.trim();
    el('settings-nav')?.querySelectorAll('button').forEach(button => {
      const active = button.dataset.pane ? activePane === button.dataset.pane
        : activePane === 'config' && (query ? button.dataset.group === '' : button.dataset.group === activeGroup);
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    // On narrow screens the categories become a horizontal strip; keep the current one in view.
    const nav = el('settings-nav'), current = nav?.querySelector('.is-active');
    if (nav && current && nav.scrollWidth > nav.clientWidth) nav.scrollLeft += current.getBoundingClientRect().left - nav.getBoundingClientRect().left - 12;
  }
  const normalize = text => String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  const showMessage = (text, tone = '') => { const node = el('settings-message'); if (node) { node.textContent = text; node.dataset.tone = tone; } };

  function createValue(field) {
    if (field.readOnly) {
      const value = document.createElement('div'); value.className = 'settings-value';
      value.textContent = field.value || 'Chưa cấu hình'; if (!field.value) value.classList.add('is-empty');
      return value;
    }
    if (field.type === 'boolean') {
      const wrapper = document.createElement('label'); wrapper.className = 'settings-switch';
      const control = document.createElement('input'); control.type = 'checkbox'; control.className = 'settings-input';
      control.dataset.key = field.key; control.dataset.initial = field.value; control.checked = field.value === 'true'; control.setAttribute('aria-label', field.label);
      const track = document.createElement('span'); track.className = 'settings-switch-track'; track.append(document.createElement('i'));
      const status = document.createElement('span'); status.className = 'settings-switch-status';
      control.addEventListener('change', updateDirtyState); wrapper.append(control, track, status);
      return wrapper;
    }
    const control = field.type === 'select' ? document.createElement('select') : document.createElement('input');
    control.className = 'form-control settings-input'; control.dataset.key = field.key; control.dataset.initial = field.value;
    control.setAttribute('aria-label', field.label);
    if (control.tagName === 'SELECT') {
      const labels = {auto:'Tự động · TEV1 trước, model chat dự phòng',local_tev1:'TEV1 local · không dự phòng routing',chat_model:'Model chat · quyết định trực tiếp',ollama:'Ollama · chạy nội bộ',openai:'API tương thích OpenAI',error:'Dừng và báo lỗi',deterministic:'Vector dự phòng',production:'Production · vận hành',development:'Development · phát triển',test:'Test · kiểm thử',postgres:'PostgreSQL',json:'JSON file'};
      const optionLabels = field.key === 'HARNESS_PIPELINE'
        ? { v1: 'V1 · Vòng lặp công cụ hiện tại', v2: 'V2 · Lập kế hoạch dữ liệu trước' } : labels;
      const options = (field.options || []).map(option => [option, optionLabels[option] || option]);
      options.forEach(([optionValue, label]) => { const option = document.createElement('option'); option.value = optionValue; option.textContent = label; control.append(option); });
    } else {
      control.type = field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text';
      if (field.type === 'number') control.step = ['LOCAL_MODEL_TEMPERATURE', 'AI_DOCUMENT_MIN_SCORE', 'MEMORY_TOKEN_CHARS_PER_TOKEN', 'CHAT_ROUTING_MIN_PROBABILITY', 'CHAT_ROUTING_MIN_MARGIN'].includes(field.key) ? 'any' : '1';
    }
    control.value = field.value; control.addEventListener('input', updateDirtyState); control.addEventListener('change', updateDirtyState);
    return control;
  }

  function changedValues() {
    return Object.fromEntries([...document.querySelectorAll('.settings-input')]
      .map(control => [control, control.type === 'checkbox' ? String(control.checked) : control.value])
      .filter(([control, value]) => value !== control.dataset.initial)
      .map(([control, value]) => [control.dataset.key, value]));
  }

  function updateDirtyState() {
    document.querySelectorAll('.settings-property').forEach(item=>{
      const control=item.querySelector('.settings-input');
      const dirty=control&&(control.type==='checkbox'?String(control.checked):control.value)!==control.dataset.initial;
      item.classList.toggle('is-dirty',Boolean(dirty));
      const reset=item.querySelector('.settings-field-reset');if(reset)reset.hidden=!dirty;
    });
    const button = el('settings-save'); if (button) button.disabled = saving || Object.keys(changedValues()).length === 0;
    const restartButton = el('settings-save-restart'); if (restartButton) restartButton.disabled = saving;
    const count = Object.keys(changedValues()).length;
    if (el('settings-dirty-count')) { el('settings-dirty-count').textContent = count ? `${count} thay đổi chưa lưu` : 'Không có thay đổi chưa lưu'; el('settings-dirty-count').classList.toggle('is-dirty', count > 0); }
    document.querySelector('#view-settings .settings-savebar')?.classList.toggle('is-dirty', count > 0);
    if (el('settings-discard')) el('settings-discard').hidden = count === 0 || saving;
  }

  window.discardSettingsChanges = function () {
    document.querySelectorAll('#view-settings .settings-input').forEach(control => {
      if (control.type === 'checkbox') control.checked = control.dataset.initial === 'true'; else control.value = control.dataset.initial;
    });
    updateDirtyState();
  };

  // The sidebar shows the Qdrant result as a coloured dot, so the status is visible from any pane.
  function updateQdrantNav() {
    const button = el('settings-nav')?.querySelector('[data-pane="status"]');
    if (!button) return;
    const state = document.querySelector('#view-settings .settings-qdrant-card')?.dataset.state || '';
    let dot = button.querySelector('.settings-nav-status');
    if (!dot) { dot = document.createElement('span'); dot.className = 'settings-nav-status'; dot.setAttribute('role', 'img'); button.append(dot); }
    dot.dataset.state = state;
    dot.title = { online: 'Đã kết nối', offline: 'Mất kết nối', disabled: 'Không sử dụng', checking: 'Đang kiểm tra' }[state] || 'Chưa kiểm tra';
    dot.setAttribute('aria-label', dot.title);
  }

  function renderSettings(data) {
    currentRevision = data.revision;
    const known = NAV_SECTIONS.flatMap(([, items]) => items.map(([name]) => name));
    const present = new Set(data.fields.map(field => field.group));
    const groups = [...known.filter(group => present.has(group)), ...[...present].filter(group => !known.includes(group))];
    if (!groups.includes(activeGroup)) activeGroup = groups[0] || '';
    const nav = el('settings-nav');
    if (nav) {
      const openGroup = group => () => { activeGroup = group; el('settings-search').value = ''; window.showSettingsPane('config'); window.filterSettings(''); };
      const countOf = group => data.fields.filter(field => field.group === group).length;
      nav.replaceChildren(navButton({ label: 'Tất cả thuộc tính', icon: 'fa-list-ul', count: data.fields.length, onClick: openGroup(''), dataset: { group: '' } }));
      const sections = [...NAV_SECTIONS.map(([title, items]) => [title, items.map(([name]) => name).filter(name => present.has(name))]),
        ['Khác', groups.filter(group => !known.includes(group))]];
      for (const [title, items] of sections) {
        if (!items.length) continue;
        nav.append(navHeading(title), ...items.map(group => navButton({ label: group, icon: groupIcon(group), count: countOf(group), onClick: openGroup(group), dataset: { group } })));
      }
      nav.append(navHeading('Vận hành'),
        navButton({ label: 'Trạng thái Qdrant', icon: 'fa-heart-pulse', onClick: () => window.showSettingsPane('status'), dataset: { pane: 'status' } }),
        navButton({ label: 'Sao lưu & khôi phục', icon: 'fa-box-archive', onClick: () => window.showSettingsPane('backup'), dataset: { pane: 'backup' } }));
      updateQdrantNav();
    }
    const root = el('settings-fields');
    root.replaceChildren();
    groups.forEach(group => {
      const groupFields = data.fields.filter(field => field.group === group);
      const section = document.createElement('section'); section.className = 'settings-section'; section.dataset.group = group;
      const header = document.createElement('header'); const heading = document.createElement('h3');
      const icon = document.createElement('i'); icon.className = `fa-solid ${groupIcon(group)}`; icon.setAttribute('aria-hidden', 'true');
      heading.append(icon, document.createTextNode(group));
      const summary = document.createElement('span'); summary.textContent = `${groupFields.length} thuộc tính`;
      header.append(heading, summary); section.append(header);
      const list = document.createElement('div'); list.className = 'settings-list'; section.append(list);
      panelToggle(section, header, [list]);
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
        if(!field.readOnly) {
          const reset=document.createElement('button');reset.type='button';reset.className='settings-field-reset';reset.hidden=true;reset.textContent='Hoàn tác';reset.setAttribute('aria-label',`Hoàn tác ${field.label}`);
          reset.onclick=()=>{const control=result.querySelector('.settings-input');if(control.type==='checkbox')control.checked=control.dataset.initial==='true';else control.value=control.dataset.initial;updateDirtyState();};
          result.append(reset);
        }
        result.append(meta); item.append(information, result); list.append(item);
      });
      root.append(section);
    });
    filterSettings(el('settings-search').value);
    updateDirtyState();
    let remembered = 'config';
    try { remembered = localStorage.getItem(PANE_STORAGE_KEY) || 'config'; } catch (_) { /* Default pane. */ }
    window.showSettingsPane(remembered);
  }

  window.fetchSettings = async function (force = false) {
    if (loading && !force) return;
    loading = true; showMessage('Đang tải cấu hình…');
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' }); const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Không thể tải cấu hình.');
      renderSettings(data); showMessage('Có thể chỉnh sửa các thuộc tính bên dưới. Các thay đổi sẽ có hiệu lực sau khi khởi động lại.', 'success');
      window.checkSettingsConnection(true);
      window.loadStorageBackups();
    } catch (error) { el('settings-fields')?.replaceChildren(); showMessage(error.message, 'error'); return false; }
    finally { loading = false; }
  };

  window.filterSettings = function (value) {
    const query = normalize(value.trim());
    if (query && activePane !== 'config') window.showSettingsPane('config');
    let matches = 0;
    document.querySelectorAll('#view-settings .settings-section').forEach(section => {
      section.querySelectorAll('.settings-property').forEach(item => { item.hidden = Boolean(query) && !item.dataset.search.includes(query); });
      section.hidden = (!query && Boolean(activeGroup) && section.dataset.group !== activeGroup) || !section.querySelector('.settings-property:not([hidden])');
      if (!section.hidden) matches += section.querySelectorAll('.settings-property:not([hidden])').length;
      if (query && !section.hidden && section.classList.contains('is-collapsed')) section.querySelector('.settings-panel-toggle')?.click();
    });
    // A single group shows its title in the pane header, so its own section header would repeat it.
    el('settings-form')?.classList.toggle('is-single-group', !query && Boolean(activeGroup));
    if (el('settings-pane-title')) el('settings-pane-title').textContent = query ? 'Kết quả tìm kiếm' : activeGroup || 'Tất cả thuộc tính';
    if (el('settings-total')) el('settings-total').textContent = `${matches} thuộc tính`;
    syncNav();
    el('settings-empty').hidden = Boolean(document.querySelector('#view-settings .settings-section:not([hidden])'));
  };
  window.reloadSettings = () => window.fetchSettings(true);

  window.requestSettingsSave = function (restart = false) {
    if (saving) return;
    pendingRestart = Boolean(restart);
    const count = Object.keys(changedValues()).length;
    const title = el('settings-confirm-title');
    const message = el('settings-confirm-message');
    const icon = el('settings-confirm-icon');
    const submit = el('settings-confirm-submit');
    if (title) title.textContent = pendingRestart ? 'Lưu và khởi động lại server?' : 'Xác nhận lưu cấu hình?';
    if (message) message.textContent = pendingRestart
      ? `${count ? `${count} thay đổi sẽ được lưu. ` : ''}Server sẽ ngắt kết nối trong giây lát rồi tự khởi động lại với cấu hình mới.`
      : `${count} thay đổi sẽ được ghi vào file .env và có hiệu lực sau lần khởi động lại tiếp theo.`;
    icon?.classList.toggle('is-restart', pendingRestart);
    const iconNode = icon?.querySelector('i'); if (iconNode) iconNode.className = pendingRestart ? 'fa-solid fa-power-off' : 'fa-solid fa-floppy-disk';
    if (submit) submit.innerHTML = pendingRestart ? '<i class="fa-solid fa-power-off"></i> Lưu & restart' : '<i class="fa-solid fa-check"></i> Xác nhận lưu';
    if (typeof openModal === 'function') openModal('settings-confirm-modal');
  };

  window.closeSettingsConfirm = function () {
    if (typeof closeModal === 'function') closeModal('settings-confirm-modal');
  };

  window.handleSettingsConfirmBackdrop = function (event) {
    if (event.target.id === 'settings-confirm-modal') window.closeSettingsConfirm();
  };

  window.confirmSettingsSave = function () {
    const restart = pendingRestart;
    window.closeSettingsConfirm();
    window.saveSettings(restart);
  };

  window.saveSettings = async function (restart = false) {
    const values = changedValues();
    if (saving || (!restart && !Object.keys(values).length)) return;
    saving = true; updateDirtyState(); showMessage('Đang lưu cấu hình…');
    const idle = window.busyButton?.(el(restart ? 'settings-save-restart' : 'settings-save'), 'Đang lưu…');
    try {
      let changed = 0;
      if (Object.keys(values).length) {
        const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: currentRevision, values }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Không thể lưu cấu hình.');
        changed = data.changed || 0;
      }
      if (restart) {
        const response = await fetch('/api/settings/restart', { method: 'POST' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Không thể khởi động lại ứng dụng.');
        showMessage(`Đã lưu ${changed} thay đổi. Server đang khởi động lại, trang sẽ tự kết nối lại…`, 'success');
        setTimeout(() => window.location.reload(), 1800);
        return;
      }
      await window.fetchSettings(true);
      showMessage(`Đã lưu ${changed} thay đổi. Hãy khởi động lại ứng dụng để áp dụng.`, 'success');
    } catch (error) {
      showMessage(error.message, 'error');
      if (/thay đổi|changed/i.test(error.message)) await window.fetchSettings(true);
    } finally { idle?.(); saving = false; updateDirtyState(); }
  };

  window.checkSettingsConnection = async function (silent = false) {
    const button = el('settings-check'); const card = document.querySelector('.settings-qdrant-card');
    if (!button || !card || button.disabled) return;
    const buttonIcon = button.querySelector('i'); const buttonLabel = button.querySelector('span');
    button.disabled = true; card.dataset.state = 'checking'; updateQdrantNav();
    if (buttonIcon) buttonIcon.className = 'fa-solid fa-spinner fa-spin';
    if (buttonLabel) buttonLabel.textContent = 'Đang kiểm tra';
    el('settings-qdrant-state').textContent = 'Đang kiểm tra'; el('settings-qdrant-message').textContent = 'Đang kết nối tới Qdrant theo cấu hình của tiến trình hiện tại.';
    const minimumAnimation = new Promise(resolve => setTimeout(resolve, 1100));
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/api/qdrant/status', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`); const data = await response.json();
      await minimumAnimation;
      card.dataset.state = data.disabled ? 'disabled' : data.connected ? 'online' : 'offline';
      el('settings-qdrant-state').textContent = data.disabled ? 'Không sử dụng' : data.connected ? 'Đã kết nối' : 'Mất kết nối';
      el('settings-qdrant-collection').textContent = data.collectionName || '—';
      el('settings-qdrant-points').textContent = Number.isFinite(Number(data.pointsCount)) ? Number(data.pointsCount).toLocaleString('vi-VN') : '—';
      el('settings-qdrant-message').textContent = data.disabled ? 'Embedding đang tắt. Schema và tài liệu được tìm bằng từ khóa; không cần kết nối Qdrant cho tìm kiếm.' : data.connected ? `Dịch vụ phản hồi bình thường tại ${data.url || 'URL đã cấu hình'}.` : `Không thể truy cập ${data.url || 'Qdrant'}. ${data.error || 'Kiểm tra dịch vụ và cấu hình.'}`;
    } catch (error) {
      await minimumAnimation;
      card.dataset.state = 'offline'; el('settings-qdrant-state').textContent = 'Kiểm tra thất bại';
      el('settings-qdrant-collection').textContent = '—'; el('settings-qdrant-points').textContent = '—';
      el('settings-qdrant-message').textContent = error.name === 'AbortError' ? 'Qdrant không phản hồi sau 10 giây.' : `Không thể kiểm tra Qdrant: ${error.message}`;
    } finally {
      clearTimeout(timeout); updateQdrantNav();
      const checkedAt = el('settings-qdrant-checked-at');
      if (checkedAt) checkedAt.textContent = `Cập nhật ${new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}`;
      button.disabled = false;
      if (buttonIcon) buttonIcon.className = 'fa-solid fa-rotate';
      if (buttonLabel) buttonLabel.textContent = 'Kiểm tra lại';
    }
  };

  let backupJobTimer, backupClock, backupBusy = false;
  const backupMessage = (message, error = false) => { const node = el('settings-backup-message'); if (node) { node.textContent = message; node.dataset.tone = error ? 'error' : ''; } };
  const backupResult = value => { const node = el('settings-backup-result'); if (node) node.textContent = value ? JSON.stringify(value, null, 2) : ''; };
  async function backupApi(route, body) {
    const response = await fetch(`/api/backups${route}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    return data;
  }

  // One action at a time: every backup control is disabled while a job or request is running.
  const backupControls = () => document.querySelectorAll('.settings-backup-card button:not(.page-panel-toggle), .settings-backup-card select, .settings-backup-card input[type="file"]');
  function setBackupBusy(busy) {
    backupBusy = busy;
    for (const control of backupControls()) {
      if (busy && !control.disabled) { control.dataset.backupBusy = '1'; control.disabled = true; }
      else if (!busy && control.dataset.backupBusy) { delete control.dataset.backupBusy; control.disabled = false; }
    }
    const mode = el('settings-backup-mode');
    if (mode) { mode.classList.toggle('is-busy', busy); if (busy) mode.textContent = 'Đang chạy'; }
  }

  const formatElapsed = ms => { const seconds = Math.max(0, Math.floor(ms / 1000)); return seconds < 60 ? `${seconds} giây` : `${Math.floor(seconds / 60)} phút ${seconds % 60} giây`; };
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const jobTitles = { backup: 'Tạo bản sao lưu', verify: 'Kiểm tra gói backup', import: 'Khôi phục vào database mới' };
  const stepIcons = { pending: 'fa-regular fa-circle', running: 'fa-solid fa-spinner fa-spin', done: 'fa-solid fa-circle-check', failed: 'fa-solid fa-circle-xmark' };

  // Checklist of steps with the running one highlighted, a bar for counted steps and elapsed time.
  function renderBackupProgress({ title, steps, state = 'running', startedAt = Date.now(), error = '' }) {
    let host = el('settings-backup-progress');
    if (!host) {
      host = document.createElement('section'); host.id = 'settings-backup-progress'; host.className = 'settings-backup-progress';
      host.setAttribute('aria-live', 'polite'); el('settings-backup-message')?.after(host);
    }
    const started = new Date(startedAt).getTime(), done = steps.filter(step => step.state === 'done').length;
    const summary = state === 'running' ? `Bước ${Math.min(done + 1, steps.length)}/${steps.length} · <span class="settings-backup-progress-clock"></span>` : state === 'complete' ? 'Hoàn tất' : 'Thất bại';
    host.dataset.state = state; host.hidden = false;
    host.innerHTML = `<header><strong>${escapeHtml(title)}</strong><span>${summary}</span></header><ol>${steps.map(step => {
      const counted = step.state === 'running' && step.total, share = counted ? Math.round(step.current / step.total * 100) : null;
      return `<li class="is-${step.state}"><i class="${stepIcons[step.state] || stepIcons.pending}" aria-hidden="true"></i><div><span>${escapeHtml(step.label)}${counted ? ` <em>${step.current}/${step.total}</em>` : ''}</span>${step.detail && step.state === 'running' ? `<small>${escapeHtml(step.detail)}</small>` : ''}${share !== null ? `<div class="settings-backup-progress-bar"><span style="width:${share}%"></span></div>` : ''}</div></li>`;
    }).join('')}</ol>${error ? `<p class="settings-backup-progress-error">${escapeHtml(error)}</p>` : ''}`;
    clearInterval(backupClock);
    if (state === 'running') {
      const tick = () => { const clock = host.querySelector('.settings-backup-progress-clock'); if (clock) clock.textContent = formatElapsed(Date.now() - started); };
      tick(); backupClock = setInterval(tick, 1000);
    }
  }
  // Steps for requests that answer in one go (upload, plan) or end with a server restart.
  const localSteps = labels => labels.map((label, index) => ({ label, state: index === 0 ? 'running' : 'pending' }));
  function advance(steps, index, extra = {}) {
    steps.forEach((step, position) => { step.state = position < index ? 'done' : position === index ? 'running' : 'pending'; });
    Object.assign(steps[index] || {}, extra);
  }
  function failRunning(steps) { const running = steps.find(step => step.state === 'running'); if (running) running.state = 'failed'; }

  window.loadStorageBackups = async function (preserveMessage = false) {
    try {
      const data = await backupApi('');
      const select = el('settings-backup-select'); const selected = select.value;
      select.replaceChildren();
      for (const item of data.packages) { const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.id} · ${item.components} thành phần`; select.append(option); }
      if (data.packages.some(item => item.id === selected)) select.value = selected;
      el('settings-backup-target').value = data.currentDatabase || 'Chưa xác định';
      const status = await backupApi('/status');
      // A job started earlier (or from another tab) is still running: show it instead of an idle form.
      if (status.job?.state === 'running') { watchBackupJob(); return; }
      el('settings-backup-mode').textContent = data.available ? 'Sẵn sàng' : 'Cần PostgreSQL';
      el('settings-backup-create').disabled = !data.available;
      el('settings-backup-import').disabled = !data.available || data.packages.length === 0;
      if (!preserveMessage) backupMessage(data.available ? 'Có thể tạo backup ngay. Tác vụ sẽ tạm dừng ghi trong lúc chụp dữ liệu.' : 'Chức năng này cần APP_STORAGE_BACKEND=postgres.');
      if (status.job && !preserveMessage) { backupResult(status.job); if (status.job.state === 'failed') backupMessage(status.job.error || 'Tác vụ thất bại.', true); }
    } catch (error) { backupMessage(error.message, true); }
  };
  async function startBackupAction(route, body) {
    setBackupBusy(true);
    try {
      const data = await backupApi(route, body);
      backupResult(data.job);
      watchBackupJob();
    } catch (error) { setBackupBusy(false); backupMessage(error.message, true); }
  }
  // Server jobs (backup, verify) report their steps; poll every second while one runs.
  function watchBackupJob() {
    clearTimeout(backupJobTimer);
    if (!backupBusy) setBackupBusy(true);
    const poll = async () => {
      try {
        const { job } = await backupApi('/status');
        backupResult(job);
        if (job?.steps) renderBackupProgress({ title: jobTitles[job.action] || 'Tác vụ backup', steps: job.steps, state: job.state, startedAt: job.startedAt, error: job.state === 'failed' ? job.error : '' });
        if (job?.state === 'running') { backupMessage('Đang chạy. Có thể chuyển sang trang khác, tiến độ vẫn được giữ.'); backupJobTimer = setTimeout(poll, 1000); return; }
        setBackupBusy(false);
        const finished = job?.state === 'complete';
        const took = formatElapsed(new Date(job?.finishedAt) - new Date(job?.startedAt));
        backupMessage(finished
          ? (job.action === 'backup' ? `Đã tạo gói ${job.result?.backupId || ''} (${job.result?.components || 0} thành phần) trong ${took}.` : `Gói backup toàn vẹn, mọi checksum đều khớp (${took}).`)
          : job?.error || 'Tác vụ thất bại.', !finished);
        await window.loadStorageBackups(true);
        if (finished && job.result?.backupId && el('settings-backup-select')) el('settings-backup-select').value = job.result.backupId;
      } catch (error) { setBackupBusy(false); backupMessage(error.message, true); }
    };
    poll();
  }
  window.startStorageBackup = async () => {
    if (!await window.showUiConfirm('Tạo bản sao PostgreSQL, các collection Qdrant và file thư viện? Ứng dụng sẽ tạm dừng ghi dữ liệu trong lúc tạo gói.', { title: 'Xác nhận tạo backup', confirmText: 'Tạo backup', icon: 'fa-database' })) return;
    await startBackupAction('/create', {});
  };
  window.downloadStorageBackup = async () => {
    const id = el('settings-backup-select').value;
    if (!id || !await window.showUiConfirm(`Tải gói backup "${id}" về máy?`, { title: 'Xác nhận tải backup', confirmText: 'Tải về', icon: 'fa-download' })) return;
    backupMessage('Máy chủ đang đóng gói file .khbackup; trình duyệt sẽ bắt đầu tải về ngay khi có dữ liệu.');
    window.location.href = `/api/backups/download/${encodeURIComponent(id)}`;
  };
  window.updateStorageBackupFileName = () => { const file = el('settings-backup-file').files[0]; el('settings-backup-file-name').textContent = file ? file.name : 'Chưa chọn file .khbackup'; };
  window.uploadStorageBackup = async () => {
    const file = el('settings-backup-file').files[0];
    if (!file || !file.name.endsWith('.khbackup')) { backupMessage('Chọn file .khbackup để tải lên.', true); return; }
    if (!await window.showUiConfirm(`Tải file "${file.name}" lên máy chủ và kiểm tra gói backup?`, { title: 'Xác nhận tải lên backup', confirmText: 'Tải lên & kiểm tra', icon: 'fa-upload' })) return;
    const title = `Tải lên ${file.name}`, startedAt = Date.now(), size = file.size / 1048576;
    const steps = localSteps(['Tải file lên máy chủ', 'Giải nén và kiểm tra checksum', 'Thêm vào danh sách gói']);
    const show = (state = 'running', error = '') => renderBackupProgress({ title, steps, state, startedAt, error });
    show(); setBackupBusy(true); backupMessage('Đang tải file lên…');
    try {
      // XMLHttpRequest reports upload progress; fetch does not.
      const result = await new Promise((resolve, reject) => {
        const request = new XMLHttpRequest();
        request.open('POST', '/api/backups/upload');
        request.setRequestHeader('Content-Type', 'application/octet-stream');
        request.upload.onprogress = event => {
          if (!event.lengthComputable) return;
          advance(steps, 0, { current: Math.round(event.loaded / event.total * 100), total: 100, detail: `${(event.loaded / 1048576).toFixed(1)} / ${size.toFixed(1)} MB` }); show();
        };
        request.upload.onload = () => { advance(steps, 1, { detail: 'Máy chủ đang giải nén và so khớp checksum từng thành phần' }); show(); };
        request.onload = () => { let data = {}; try { data = JSON.parse(request.responseText); } catch (_) {} if (request.status < 300) resolve(data); else reject(new Error(data.message || `HTTP ${request.status}`)); };
        request.onerror = () => reject(new Error('Mất kết nối khi tải file lên.'));
        request.send(file);
      });
      advance(steps, 2); show();
      setBackupBusy(false);
      await window.loadStorageBackups(true);
      el('settings-backup-select').value = result.id;
      steps.forEach(step => { step.state = 'done'; }); show('complete');
      backupResult(result);
      backupMessage(`Đã tải lên và kiểm tra gói ${result.id} (${result.components} thành phần).`);
    } catch (error) {
      failRunning(steps); show('failed', error.message);
      setBackupBusy(false); backupMessage(error.message, true);
    }
  };
  window.verifyStorageBackup = async () => {
    const id = el('settings-backup-select').value;
    if (!id || !await window.showUiConfirm(`Kiểm tra tính toàn vẹn của gói backup "${id}"?`, { title: 'Xác nhận kiểm tra backup', confirmText: 'Kiểm tra', icon: 'fa-check' })) return;
    await startBackupAction('/verify', { id });
  };
  window.importStorageBackup = async dryRun => {
    const id = el('settings-backup-select').value; const database = el('settings-backup-target').value.trim();
    if (!id || !database || database === 'Chưa xác định') { backupMessage('Chọn gói backup hợp lệ.', true); return; }
    if (dryRun) {
      if (!await window.showUiConfirm(`Xem kế hoạch khôi phục gói "${id}" vào database ${database}?`, { title: 'Xem kế hoạch khôi phục', confirmText: 'Xem kế hoạch', icon: 'fa-database' })) return;
      const steps = localSteps(['Kiểm tra checksum gói backup', 'Lập kế hoạch ghi đè']), startedAt = Date.now();
      const show = (state = 'running', error = '') => renderBackupProgress({ title: 'Xem kế hoạch khôi phục', steps, state, startedAt, error });
      show(); setBackupBusy(true); backupMessage('Đang kiểm tra gói và lập kế hoạch…');
      try {
        const result = await backupApi('/restore-current', { id, dryRun: true });
        steps.forEach(step => { step.state = 'done'; }); show('complete');
        backupResult(result); if (el('settings-backup-details')) el('settings-backup-details').open = true;
        backupMessage('Đã kiểm tra kế hoạch ghi đè DB hiện tại. Xem chi tiết trong Kết quả tác vụ.');
      } catch (error) { failRunning(steps); show('failed', error.message); backupMessage(error.message, true); }
      finally { setBackupBusy(false); }
      return;
    }
    const confirm = await window.showUiPrompt(
      `Thao tác này sẽ ghi đè database ${database} và các collection Qdrant trong gói backup. Nhập chính xác tên database để xác nhận:`,
      '',
      { title: 'Xác nhận khôi phục Database', confirmText: 'Khôi phục DB hiện tại', icon: 'fa-database', tone: 'danger', requiredValue: database }
    );
    if (confirm !== database) { if (confirm !== null) backupMessage('Tên xác nhận không khớp; chưa khôi phục.', true); return; }
    const steps = localSteps(['Gửi yêu cầu khôi phục', 'Máy chủ dừng, tạo backup an toàn và khôi phục dữ liệu', 'Khởi động lại ứng dụng']), startedAt = Date.now();
    const show = (state = 'running', error = '') => renderBackupProgress({ title: `Khôi phục ${database}`, steps, state, startedAt, error });
    show(); setBackupBusy(true);
    try {
      const result = await backupApi('/restore-current', { id, confirm });
      backupResult(result); backupMessage('Máy chủ đang dừng để khôi phục. Trang sẽ tự tải lại khi hoàn tất, đừng đóng trang.');
      advance(steps, 1, { detail: 'Có thể mất vài phút tùy dung lượng dữ liệu' }); show();
      await new Promise(resolve => setTimeout(resolve, 2000));
      const deadline = Date.now() + 5 * 60 * 1000;
      let sawServerStop = false;
      while (Date.now() < deadline) {
        try {
          const response = await fetch('/health/ready', { cache: 'no-store' });
          if (!response.ok) sawServerStop = true;
          else if (sawServerStop) { steps.forEach(step => { step.state = 'done'; }); show('complete'); backupMessage('Khôi phục xong, đang tải lại trang…'); window.location.reload(); return; }
        } catch (_) { sawServerStop = true; }
        if (sawServerStop && steps[1].state === 'running' && !steps[1].stopped) { steps[1].stopped = true; steps[1].detail = 'Máy chủ đã dừng; chờ khôi phục xong và khởi động lại'; show(); }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      failRunning(steps); show('failed', 'Quá 5 phút chưa thấy máy chủ khởi động lại.');
      setBackupBusy(false);
      backupMessage('Chưa thấy máy chủ khởi động lại. Kiểm tra log supervisor và báo cáo restore trên máy chủ.', true);
    } catch (error) { failRunning(steps); show('failed', error.message); setBackupBusy(false); backupMessage(error.message, true); }
  };
})();
