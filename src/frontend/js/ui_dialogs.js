(function () {
  'use strict';

  let activeDialog = null;

  function closeDialog(result) {
    if (!activeDialog) return;
    const { backdrop, resolve, previousFocus, keyHandler } = activeDialog;
    activeDialog = null;
    document.removeEventListener('keydown', keyHandler);
    backdrop.classList.remove('show');
    setTimeout(() => backdrop.remove(), 160);
    previousFocus?.focus?.();
    resolve(result);
  }

  function openDialog(options) {
    if (activeDialog) closeDialog(null);
    const isPrompt = options.kind === 'prompt';
    const backdrop = document.createElement('div');
    backdrop.className = 'ui-dialog-backdrop';
    backdrop.innerHTML = `
      <div class="ui-dialog" role="dialog" aria-modal="true" aria-labelledby="ui-dialog-title" aria-describedby="ui-dialog-message">
        <button type="button" class="ui-dialog-close" aria-label="Đóng"><i class="fa-solid fa-xmark"></i></button>
        <div class="ui-dialog-icon ${options.tone === 'danger' ? 'is-danger' : ''}"><i class="fa-solid ${options.icon || (isPrompt ? 'fa-pen' : 'fa-triangle-exclamation')}"></i></div>
        <h3 id="ui-dialog-title"></h3>
        <p id="ui-dialog-message"></p>
        ${isPrompt ? '<input class="ui-dialog-input" type="text" maxlength="200">' : ''}
        <div class="ui-dialog-actions">
          <button type="button" class="ui-dialog-cancel">${options.cancelText || 'Hủy'}</button>
          <button type="button" class="ui-dialog-submit ${options.tone === 'danger' ? 'is-danger' : ''}">${options.confirmText || 'Xác nhận'}</button>
        </div>
      </div>`;
    backdrop.querySelector('#ui-dialog-title').textContent = options.title || 'Xác nhận thao tác';
    backdrop.querySelector('#ui-dialog-message').textContent = options.message || '';
    const input = backdrop.querySelector('.ui-dialog-input');
    if (input) input.value = options.defaultValue || '';
    const submit = backdrop.querySelector('.ui-dialog-submit');

    return new Promise(resolve => {
      const finish = confirmed => closeDialog(confirmed ? (input ? input.value : true) : null);
      const keyHandler = event => {
        if (event.key === 'Escape') finish(false);
        if (event.key === 'Enter' && (!input || !event.shiftKey)) { event.preventDefault(); finish(true); }
      };
      activeDialog = { backdrop, resolve, previousFocus: document.activeElement, keyHandler };
      backdrop.querySelector('.ui-dialog-close').onclick = () => finish(false);
      backdrop.querySelector('.ui-dialog-cancel').onclick = () => finish(false);
      submit.onclick = () => finish(true);
      backdrop.onclick = event => { if (event.target === backdrop) finish(false); };
      document.addEventListener('keydown', keyHandler);
      document.body.appendChild(backdrop);
      requestAnimationFrame(() => {
        backdrop.classList.add('show');
        (input || submit).focus();
        input?.select();
      });
    });
  }

  window.showUiConfirm = (message, options = {}) => openDialog({ ...options, message, kind: 'confirm' });
  window.showUiPrompt = (message, defaultValue = '', options = {}) => openDialog({ ...options, message, defaultValue, kind: 'prompt' });
})();
