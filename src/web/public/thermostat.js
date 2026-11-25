'use strict';

(() => {
  const get = id => document.getElementById(id);
  const dialog = get('thermostat-dialog');
  const form = get('thermostat-form');
  const modeSelect = get('thermostat-mode');
  const valueRow = get('thermostat-value-row');
  const autoNote = get('thermostat-auto-note');
  const valueInput = get('thermostat-value');
  const unitLabel = get('thermostat-unit');
  const presetsBox = get('thermostat-presets');
  const notifyCheck = get('thermostat-notify');
  const saveButton = get('thermostat-save');
  const closeButtons = [get('thermostat-cancel'), get('thermostat-close')];

  const PRESETS = {
    tokens: [
      ['50万', 500000],
      ['100万', 1000000],
      ['300万', 3000000],
      ['500万', 5000000]
    ],
    cny: [
      ['¥20', 20],
      ['¥50', 50],
      ['¥100', 100],
      ['¥200', 200]
    ],
    usd: [
      ['$3', 3],
      ['$10', 10],
      ['$20', 20],
      ['$50', 50]
    ]
  };

  let saved;
  let saving = false;
  let loading;

  function feedback(message = '') {
    const status = get('thermostat-feedback');
    status.textContent = message;
    status.hidden = !message;
  }

  function currentPayload() {
    const mode = modeSelect.value;
    const raw = Number(valueInput.value);
    const value = mode === 'auto' ? 0 : mode === 'tokens' ? Math.round(raw) : Math.round(raw * 100) / 100;
    return {
      mode,
      value: Number.isFinite(value) ? value : 0,
      notify: Boolean(notifyCheck.checked)
    };
  }

  function isValidPayload(payload) {
    if (payload.mode === 'auto') return true;
    if (!Number.isFinite(payload.value) || payload.value <= 0) return false;
    if (payload.mode === 'tokens') return Number.isInteger(payload.value) && payload.value <= 1e12;
    return payload.value <= 1e6;
  }

  function renderPresets(mode) {
    const list = PRESETS[mode] || [];
    presetsBox.replaceChildren(...list.map(([label, amount]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'action-button';
      button.textContent = label;
      button.disabled = saving;
      button.addEventListener('click', () => {
        valueInput.value = String(amount);
        updateControls();
      });
      return button;
    }));
  }

  function updateControls() {
    const mode = modeSelect.value;
    const isAuto = mode === 'auto';
    autoNote.hidden = !isAuto;
    valueRow.hidden = isAuto;
    valueInput.disabled = isAuto || saving || !saved;
    modeSelect.disabled = saving || !saved;
    notifyCheck.disabled = saving || !saved;
    if (!isAuto) {
      unitLabel.textContent = mode === 'tokens' ? '(Token)' : mode === 'cny' ? '(CNY ¥)' : '(USD $)';
      valueInput.min = mode === 'tokens' ? '1' : '0.01';
      valueInput.step = mode === 'tokens' ? '1' : '0.01';
      valueInput.max = mode === 'tokens' ? '1000000000000' : '1000000';
      renderPresets(mode);
    }
    const next = currentPayload();
    const changed = saved && (
      next.mode !== saved.mode
      || next.value !== saved.value
      || next.notify !== saved.notify
    );
    saveButton.disabled = !saved || saving || !changed || !isValidPayload(next);
    saveButton.textContent = saving ? '正在保存' : '保存设置';
    get('thermostat-status').textContent = saved ? `修订 #${saved.revision}` : '读取中';
    for (const button of closeButtons) button.disabled = saving;
  }

  async function open() {
    saved = undefined;
    feedback();
    updateControls();
    const request = new AbortController();
    loading = request;
    dialog.showModal();
    try {
      const response = await fetch('/api/v1/thermostat', { signal: request.signal });
      if (!response.ok) throw new Error('Load failed');
      const settings = await response.json();
      if (request.signal.aborted || loading !== request) return;
      saved = settings;
      modeSelect.value = settings.mode;
      valueInput.value = settings.value > 0 ? String(settings.value) : '';
      notifyCheck.checked = Boolean(settings.notify);
    } catch {
      if (!request.signal.aborted) feedback('无法读取温控设置，关闭后可重试。');
    } finally {
      if (loading === request) {
        loading = undefined;
        updateControls();
      }
    }
  }

  for (const id of ['manage-thermostat', 'heat-pill']) {
    get(id)?.addEventListener('click', open);
  }
  for (const button of closeButtons) button.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    loading?.abort();
    loading = undefined;
  });

  modeSelect.addEventListener('change', () => {
    if (modeSelect.value !== 'auto' && (!valueInput.value || Number(valueInput.value) <= 0)) {
      const defaults = { tokens: 1000000, cny: 50, usd: 10 };
      valueInput.value = String(defaults[modeSelect.value]);
    }
    feedback();
    updateControls();
  });
  valueInput.addEventListener('input', () => {
    feedback();
    updateControls();
  });
  notifyCheck.addEventListener('change', () => {
    if (notifyCheck.checked && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
    updateControls();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!saved || saveButton.disabled) return;
    const payload = currentPayload();
    if (!isValidPayload(payload)) {
      feedback('请输入有效的阈值。');
      return;
    }
    saving = true;
    feedback();
    updateControls();
    try {
      const response = await fetch('/api/v1/thermostat', {
        method: 'PUT',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: saved.revision, ...payload })
      });
      if (response.status === 409) {
        feedback('温控设置已在其他窗口变更，请关闭后重新打开。');
        return;
      }
      if (!response.ok) throw new Error('Save failed');
      const updated = await response.json();
      dialog.close();
      document.dispatchEvent(new CustomEvent('thermostat-saved', { detail: updated }));
    } catch {
      feedback('保存失败，请重试。');
    } finally {
      saving = false;
      if (dialog.open) updateControls();
    }
  });
})();
