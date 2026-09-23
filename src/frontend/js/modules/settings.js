(() => {
  let loading = false;
  let saving = false;
  let currentRevision = '';
  let pendingRestart = false;
  const el = id => document.getElementById(id);
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
      const labels = {ollama:'Ollama · chạy nội bộ',openai:'API tương thích OpenAI',error:'Dừng và báo lỗi',deterministic:'Vector dự phòng',production:'Production',development:'Development',test:'Test',postgres:'PostgreSQL',json:'JSON file'};
      const options = (field.options || []).map(option => [option, labels[option] || option]);
      options.forEach(([optionValue, label]) => { const option = document.createElement('option'); option.value = optionValue; option.textContent = label; control.append(option); });
    } else {
      control.type = field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text';
      if (field.type === 'number') control.step = ['LOCAL_MODEL_TEMPERATURE', 'AI_DOCUMENT_MIN_SCORE', 'MEMORY_TOKEN_CHARS_PER_TOKEN'].includes(field.key) ? 'any' : '1';
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
  }

  function renderSettings(data) {
    currentRevision = data.revision;
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
    } finally { saving = false; updateDirtyState(); }
  };

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

  let backupJobTimer;
  const backupMessage = (message, error = false) => { const node = el('settings-backup-message'); if (node) { node.textContent = message; node.dataset.tone = error ? 'error' : ''; } };
  const backupResult = value => { const node = el('settings-backup-result'); if (node) node.textContent = value ? JSON.stringify(value, null, 2) : ''; if (value && el('settings-backup-details')) el('settings-backup-details').open = true; };
  async function backupApi(route, body) {
    const response = await fetch(`/api/backups${route}`, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `HTTP ${response.status}`);
    return data;
  }
  window.loadStorageBackups = async function (preserveMessage = false) {
    try {
      const data = await backupApi('');
      const select = el('settings-backup-select'); const selected = select.value;
      select.replaceChildren();
      for (const item of data.packages) { const option = document.createElement('option'); option.value = item.id; option.textContent = `${item.id} · ${item.components} thành phần`; select.append(option); }
      if (data.packages.some(item => item.id === selected)) select.value = selected;
      el('settings-backup-mode').textContent = data.available ? 'Sẵn sàng' : 'Cần PostgreSQL';
      el('settings-backup-target').value = data.currentDatabase || 'Chưa xác định';
      el('settings-backup-create').disabled = !data.available;
      el('settings-backup-import').disabled = !data.available || data.packages.length === 0;
      if (!preserveMessage) backupMessage(data.available ? 'Có thể tạo backup ngay. Tác vụ sẽ tạm dừng ghi trong lúc chụp dữ liệu.' : 'Chức năng này cần APP_STORAGE_BACKEND=postgres.');
      const status = await backupApi('/status');
      if (status.job?.state === 'running') watchBackupJob();
      else if (status.job) { backupResult(status.job); if (status.job.state === 'failed') backupMessage(status.job.error || 'Tác vụ thất bại.', true); }
    } catch (error) { backupMessage(error.message, true); }
  };
  async function startBackupAction(route, body) {
    try {
      const data = await backupApi(route, body);
      backupResult(data.job);
      backupMessage('Tác vụ đang chạy. Kết quả sẽ cập nhật tự động.');
      watchBackupJob();
    } catch (error) { backupMessage(error.message, true); }
  }
  function watchBackupJob() {
    clearTimeout(backupJobTimer);
    const poll = async () => {
      try {
        const { job } = await backupApi('/status');
        backupResult(job);
        if (job?.state === 'running') { backupJobTimer = setTimeout(poll, 1500); return; }
        backupMessage(job?.state === 'complete' ? 'Tác vụ hoàn tất. Xem kết quả bên dưới.' : job?.error || 'Tác vụ thất bại.', job?.state !== 'complete');
        if (job?.state === 'complete') await window.loadStorageBackups(true);
      } catch (error) { backupMessage(error.message, true); }
    };
    poll();
  }
  window.startStorageBackup = () => startBackupAction('/create', {});
  window.downloadStorageBackup = () => { const id = el('settings-backup-select').value; if (id) window.location.href = `/api/backups/download/${encodeURIComponent(id)}`; };
  window.updateStorageBackupFileName = () => { const file = el('settings-backup-file').files[0]; el('settings-backup-file-name').textContent = file ? file.name : 'Chưa chọn file .khbackup'; };
  window.uploadStorageBackup = async () => {
    const file = el('settings-backup-file').files[0];
    if (!file || !file.name.endsWith('.khbackup')) { backupMessage('Chọn file .khbackup để tải lên.', true); return; }
    backupMessage('Đang tải file lên và kiểm tra checksum…');
    try {
      const response = await fetch('/api/backups/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || `HTTP ${response.status}`);
      await window.loadStorageBackups();
      el('settings-backup-select').value = result.id;
      backupResult(result);
      backupMessage('Đã tải lên và kiểm tra gói. Có thể xem kế hoạch rồi restore vào đích mới.');
    } catch (error) { backupMessage(error.message, true); }
  };
  window.verifyStorageBackup = () => { const id = el('settings-backup-select').value; if (id) startBackupAction('/verify', { id }); };
  window.importStorageBackup = async dryRun => {
    const id = el('settings-backup-select').value; const database = el('settings-backup-target').value.trim();
    if (!id || !database || database === 'Chưa xác định') { backupMessage('Chọn gói backup hợp lệ.', true); return; }
    if (dryRun) {
      try { const result = await backupApi('/restore-current', { id, dryRun: true }); backupResult(result); backupMessage('Đã kiểm tra kế hoạch ghi đè DB hiện tại.'); }
      catch (error) { backupMessage(error.message, true); }
      return;
    }
    const confirm = await window.showUiPrompt(
      `Thao tác này sẽ ghi đè database ${database} và hai collection Qdrant hiện tại. Nhập chính xác tên database để xác nhận:`,
      '',
      { title: 'Xác nhận khôi phục Database', confirmText: 'Khôi phục DB hiện tại', icon: 'fa-database', tone: 'danger', requiredValue: database }
    );
    if (confirm !== database) { if (confirm !== null) backupMessage('Tên xác nhận không khớp; chưa khôi phục.', true); return; }
    try {
      const result = await backupApi('/restore-current', { id, confirm });
      backupResult(result); backupMessage('Máy chủ đang dừng để khôi phục. Trang sẽ tải lại khi hoàn tất.');
      await new Promise(resolve => setTimeout(resolve, 2000));
      const deadline = Date.now() + 5 * 60 * 1000;
      let sawServerStop = false;
      while (Date.now() < deadline) {
        try { const response = await fetch('/health/ready', { cache: 'no-store' }); if (!response.ok) sawServerStop = true; else if (sawServerStop) { window.location.reload(); return; } }
        catch (_) { sawServerStop = true; }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      backupMessage('Chưa thấy máy chủ khởi động lại. Kiểm tra log supervisor và báo cáo restore trên máy chủ.', true);
    } catch (error) { backupMessage(error.message, true); }
  };
})();
