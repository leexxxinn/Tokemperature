'use strict';

(() => {
  const get = id => document.getElementById(id);
  const dialog = get('tool-dialog');
  const form = get('tool-form');
  const search = get('tool-search');
  const enabledOnly = get('tool-enabled-only');
  const bulk = get('tool-select-results');
  const list = get('tool-list');
  const save = get('tool-save');
  const closeButtons = [get('tool-cancel'), get('tool-close')];
  let saved;
  let selected = new Set();
  let visible = [];
  let loading;
  let saving = false;

  function feedback(message = '') {
    const status = get('tool-feedback');
    status.textContent = message;
    status.hidden = !message;
  }

  function controls() {
    get('tool-count').textContent = saved ? `已选择 ${selected.size} / ${saved.tools.length} 个工具` : '';
    const changed = saved && (selected.size !== saved.clients.length || saved.clients.some(id => !selected.has(id)));
    save.disabled = !changed || saving;
    save.textContent = saving ? '正在保存' : '保存设置';
    search.disabled = !saved || saving;
    enabledOnly.disabled = !saved || saving;
    bulk.disabled = saving || !visible.length;
    bulk.textContent = visible.length && visible.every(tool => selected.has(tool.id)) ? '取消全选' : '全选结果';
    for (const button of closeButtons) button.disabled = saving;
  }

  function renderList() {
    const query = search.value.trim().toLowerCase();
    visible = (saved?.tools || []).filter(tool => (!enabledOnly.checked || selected.has(tool.id))
      && `${tool.label} ${tool.id}`.toLowerCase().includes(query));
    if (!visible.length) {
      const message = document.createElement('p');
      message.className = 'empty tool-empty';
      message.textContent = loading ? '正在加载工具列表' : saved ? '没有匹配的工具' : '工具列表未加载';
      list.replaceChildren(message);
    } else {
      list.replaceChildren(...visible.map(tool => {
        const row = document.createElement('label');
        row.className = 'tool-choice';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = tool.id;
        checkbox.checked = selected.has(tool.id);
        checkbox.disabled = saving;
        const name = document.createElement('span');
        name.className = 'tool-choice-name';
        name.textContent = tool.label;
        const id = document.createElement('span');
        id.className = 'tool-choice-id';
        id.textContent = tool.id;
        row.append(checkbox, name, id);
        return row;
      }));
    }
    controls();
  }

  async function open() {
    saved = undefined;
    selected = new Set();
    search.value = '';
    enabledOnly.checked = false;
    feedback();
    const request = new AbortController();
    loading = request;
    renderList();
    dialog.showModal();
    try {
      const response = await fetch('/api/v1/tools', { signal: request.signal });
      if (!response.ok) throw new Error('Load failed');
      const settings = await response.json();
      if (request.signal.aborted || loading !== request) return;
      saved = settings;
      selected = new Set(settings.clients);
    } catch (error) {
      if (!request.signal.aborted) feedback('无法加载工具列表，关闭后可重新打开。');
    } finally {
      if (loading === request) {
        loading = undefined;
        renderList();
        if (saved && dialog.open) search.focus();
      }
    }
  }

  get('manage-tools').addEventListener('click', open);
  for (const button of closeButtons) button.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    loading?.abort();
    loading = undefined;
  });
  list.addEventListener('change', event => {
    const checkbox = event.target;
    if (checkbox.checked) selected.add(checkbox.value);
    else selected.delete(checkbox.value);
    if (enabledOnly.checked) {
      renderList();
      (list.querySelector('input') || enabledOnly).focus();
    } else controls();
  });
  search.addEventListener('input', renderList);
  enabledOnly.addEventListener('change', renderList);
  bulk.addEventListener('click', () => {
    const remove = visible.every(tool => selected.has(tool.id));
    for (const { id } of visible) {
      if (remove) selected.delete(id);
      else selected.add(id);
    }
    renderList();
    if (bulk.disabled) enabledOnly.focus();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!saved || save.disabled) return;
    saving = true;
    feedback();
    renderList();
    try {
      const response = await fetch('/api/v1/tools', {
        method: 'PUT',
        signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: saved.revision, clients: Array.from(selected) })
      });
      if (response.status === 409) {
        feedback('设置已变更，请重新打开工具管理后再编辑。');
        return;
      }
      if (!response.ok) throw new Error('Save failed');
      dialog.close();
      document.dispatchEvent(new Event('tools-saved'));
    } catch (error) {
      feedback('保存失败，可以重试。');
    } finally {
      saving = false;
      if (dialog.open) renderList();
      else controls();
    }
  });
})();
