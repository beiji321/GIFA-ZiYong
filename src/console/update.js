'use strict';

(() => {
  const byId = (id) => document.getElementById(id);
  const api = window.api;
  const dialog = byId('updateDialog');
  const trigger = byId('btnUpdate');
  const action = byId('btnUpdateAction');
  const releases = byId('btnUpdateReleases');
  const transfer = byId('updateTransfer');
  const progress = byId('updateProgress');
  const notes = byId('updateNotes');

  const check = ['updateCheck', '检查更新'];
  const states = {
    idle: { label: '尚未检查更新', action: check },
    checking: { label: '正在检查更新…', action: [null, '检查中…'] },
    current: { label: '当前已是最新版本', action: check },
    available: { label: '发现新版本', trigger: '软件更新 · 有新版本', action: ['updateDownload', '下载更新'] },
    downloading: { label: '正在下载更新…', action: ['updateCancel', '取消下载'] },
    ready: { label: '更新已下载', trigger: '软件更新 · 已就绪', action: ['updateInstall', '重启并安装'] },
    installing: { label: '正在准备安装…', action: [null, '正在安装…'] },
    updated: { label: '更新完成', trigger: '软件更新 · 已更新', action: check },
    error: { label: '更新未完成', action: ['updateCheck', '重试检查'] },
    unsupported: { label: '不支持应用内更新' }
  };
  const requestErrors = {
    updateStatus: '无法读取更新状态，请重试。',
    updateCheck: '检查更新失败，请重试。',
    updateDownload: '无法下载更新，请重试。',
    updateCancel: '无法取消下载，请稍后重试。',
    updateInstall: '无法开始安装，请稍后重试。',
    updateOpenReleases: '无法打开官方发布页，请稍后重试。'
  };
  const bytes = new Intl.NumberFormat('zh-CN');
  const decimal = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  const pending = new Set();
  let snapshot = { phase: 'idle' };
  let requestError = '';
  let latestRevision = -1;
  let stateEpoch = 0;
  let actionSequence = 0;

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function formatVersion(version) {
    if (typeof version !== 'string' || !version) return '—';
    return version.startsWith('v') ? version : `v${version}`;
  }

  function formatSize(size) {
    if (size >= 1024 ** 3) return `${decimal.format(size / 1024 ** 3)} GiB`;
    if (size >= 1024 ** 2) return `${decimal.format(size / 1024 ** 2)} MiB`;
    if (size >= 1024) return `${decimal.format(size / 1024)} KiB`;
    return `${bytes.format(size)} 字节`;
  }

  function stateAction() {
    if (snapshot.phase === 'available' && snapshot.canDownload !== true) return ['updateCheck', '重新检查'];
    if (snapshot.phase === 'error' && snapshot.canDownload === true) return ['updateDownload', '重试下载'];
    if (snapshot.phase === 'downloading' && pending.has('updateCancel')) return [null, '正在取消…'];
    return states[snapshot.phase].action || [];
  }

  function canInvoke(method) {
    return typeof api?.[method] === 'function' && !pending.has(method);
  }

  function canAct(method) {
    return canInvoke(method) && (method === 'updateCancel' || ![...pending].some(isStateAction));
  }

  function isStateAction(method) {
    return method !== 'updateStatus' && method !== 'updateOpenReleases';
  }

  function render() {
    const { phase, mode, version, targetVersion, size, received } = snapshot;
    const state = states[phase];
    const manualOnly = phase === 'unsupported' || (phase === 'available' && snapshot.canDownload !== true);
    const total = Number.isSafeInteger(size) && size > 0 ? size : null;
    const downloaded = Number.isSafeInteger(received) && received >= 0 ? received : 0;
    const [method, label] = stateAction();

    trigger.dataset.phase = dialog.dataset.phase = phase;
    dialog.classList.toggle('has-request-error', !!requestError);
    setText(byId('updateTriggerText'), state.trigger || '软件更新');
    setText(byId('updateStatus'), state.label);
    const message = typeof snapshot.message === 'string' ? snapshot.message : '';
    setText(byId('updateMessage'), [message, requestError].filter(Boolean).join('\n'));
    setText(byId('updateHint'), manualOnly ? '请从官方发布页手动下载。'
      : phase === 'error' ? '也可以从官方发布页手动下载。'
      : phase === 'ready' ? '确认安装后，浮窗播放器将停止，助手将重启。' : '');
    setText(byId('updateCurrentVersion'), formatVersion(version));
    setText(byId('updateLatestVersion'), formatVersion(targetVersion));
    setText(byId('updateMode'), mode === 'installed' ? '安装版' : mode === 'portable' ? 'ZIP 解压绿色版' : '—');
    setText(byId('updateSize'), total === null ? '—' : total < 1024
      ? formatSize(total) : `${formatSize(total)}（${bytes.format(total)} 字节）`);

    transfer.hidden = phase !== 'downloading';
    if (!transfer.hidden) {
      if (total === null) {
        progress.removeAttribute('value');
        setText(byId('updateProgressText'), `已下载 ${formatSize(downloaded)}`);
      } else {
        const value = Math.min(downloaded, total);
        progress.max = total;
        progress.value = value;
        setText(byId('updateProgressText'), `${Math.floor(value * 100 / total)}% · ${formatSize(value)} / ${formatSize(total)}`);
      }
    }

    const releaseNotes = typeof snapshot.notes === 'string' ? snapshot.notes : '';
    notes.hidden = !releaseNotes.trim();
    setText(byId('updateNotesText'), releaseNotes);
    releases.setAttribute('aria-disabled', String(!canInvoke('updateOpenReleases')));
    releases.classList.toggle('primary', manualOnly);
    releases.classList.toggle('ghost', !manualOnly);
    action.classList.toggle('primary', !manualOnly && phase !== 'downloading');
    if (!label && document.activeElement === action) releases.focus();
    action.hidden = !label;
    setText(action, label || '');
    action.setAttribute('aria-disabled', String(!method || !canAct(method)));
  }

  function accept(next) {
    if (!Object.hasOwn(states, next?.phase)) return false;
    if (Number.isSafeInteger(next.revision)) {
      if (next.revision < latestRevision) return true;
      latestRevision = next.revision;
    }
    snapshot = next;
    stateEpoch += 1;
    return true;
  }

  async function request(method) {
    if (!canInvoke(method)) return;
    const passive = !isStateAction(method);
    const sequence = passive ? actionSequence : ++actionSequence;
    const initialEpoch = stateEpoch;
    const stillRelevant = () => sequence === actionSequence && (!passive || stateEpoch === initialEpoch);
    pending.add(method);
    requestError = '';
    render();
    try {
      const next = await api[method]();
      if (Number.isSafeInteger(next?.revision) || stillRelevant()) {
        if (!accept(next)) requestError = requestErrors[method];
      }
    } catch {
      if (method === 'updateOpenReleases' || stillRelevant()) requestError = requestErrors[method];
    } finally {
      pending.delete(method);
      render();
    }
  }

  trigger.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
  });
  dialog.addEventListener('close', () => trigger.focus());
  byId('btnUpdateClose').addEventListener('click', () => dialog.close());
  releases.addEventListener('click', () => request('updateOpenReleases'));
  action.addEventListener('click', () => {
    const [method] = stateAction();
    if (method && canAct(method)) request(method);
  });
  api?.onUpdateState?.((next) => {
    if (accept(next)) render();
  });
  if (canInvoke('updateStatus')) request('updateStatus');
  else {
    requestError = requestErrors.updateStatus;
    render();
  }
})();
