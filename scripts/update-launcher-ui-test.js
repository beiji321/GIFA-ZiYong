'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const prefix = 'gifa-update-launcher-ui-';

if (process.versions.electron) {
  const { app } = require('electron');
  runElectron().then(() => app.exit(0), (error) => {
    console.error(error);
    app.exit(1);
  });
} else {
  const tempParent = path.resolve(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempParent, prefix));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(require('electron'), [__filename, profile, `--user-data-dir=${profile}`], { env, stdio: 'inherit', timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `隔离 Electron 测试未通过（${result.signal || result.status}）`);
  } finally {
    assert.equal(path.dirname(profile), tempParent);
    assert.ok(path.basename(profile).startsWith(prefix));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  const profile = path.resolve(process.argv[2]);
  assert.equal(path.dirname(profile), path.resolve(os.tmpdir()));
  assert.ok(path.basename(profile).startsWith(prefix));
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-background-networking');
  await app.whenReady();
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, reply) => reply({ cancel: true }));

  const src = path.resolve(__dirname, '../src');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(src, 'preload.js'), backgroundThrottling: false, contextIsolation: true, sandbox: false }
  });
  let bootCalled = false;
  ipcMain.handle('app:boot', () => {
    bootCalled = true;
    return new Promise(() => {});
  });

  let state = {
    phase: 'idle', mode: 'installed', version: '0.2.7', targetVersion: null, size: null,
    received: 0, notes: '', message: '', canDownload: false, revision: 0
  };
  const moved = (phase, fields) => {
    state = { ...state, ...fields, phase, revision: state.revision + 1 };
    return state;
  };
  const push = (phase, fields) => win.webContents.send('update:state', moved(phase, fields));
  const calls = [];
  let checkResult;
  let downloadResult;
  let lastDownloading;
  const size = 100 * 1024 ** 2 + 4;
  const handlers = {
    status: () => state,
    check: () => {
      checkResult = Promise.withResolvers();
      push('checking');
      return checkResult.promise;
    },
    download: () => {
      downloadResult = Promise.withResolvers();
      push('downloading', { size: null, received: 0 });
      lastDownloading = state;
      return downloadResult.promise;
    },
    cancel: () => {
      const result = moved('available', { size, received: 0 });
      downloadResult.resolve(lastDownloading);
      return result;
    },
    install: () => calls.filter((channel) => channel === 'install').length === 1 ? state : moved('installing'),
    'open-releases': () => state
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(`update:${channel}`, (event, ...payload) => {
      assert.equal(event.sender, win.webContents);
      assert.equal(event.senderFrame, event.sender.mainFrame);
      assert.deepEqual(payload, []);
      calls.push(channel);
      return handler();
    });
  }

  const execute = (script) => win.webContents.executeJavaScript(script);
  const click = (id) => execute(`document.getElementById(${JSON.stringify(id)}).click()`);
  const inspect = () => execute(`(() => {
    const byId = (id) => document.getElementById(id);
    const dialog = byId('updateDialog');
    const action = byId('btnUpdateAction');
    return {
      phase: dialog.dataset.phase, modal: dialog.matches(':modal'), focus: document.activeElement.id,
      action: action.textContent, enabled: action.getAttribute('aria-disabled') === 'false', actionHidden: action.hidden,
      releasesEnabled: byId('btnUpdateReleases').getAttribute('aria-disabled') === 'false',
      version: byId('updateCurrentVersion').textContent, latest: byId('updateLatestVersion').textContent,
      mode: byId('updateMode').textContent, size: byId('updateSize').textContent,
      message: byId('updateMessage').textContent, hint: byId('updateHint').textContent,
      notes: byId('updateNotesText').textContent, remoteElements: dialog.querySelectorAll('img, a').length,
      progress: byId('updateProgress').position, transferHidden: byId('updateTransfer').hidden,
      progressText: byId('updateProgressText').textContent
    };
  })()`);
  async function waitFor(phase, matches = () => true) {
    const deadline = Date.now() + 3000;
    let view;
    do {
      view = await inspect();
      if (view.phase === phase && matches(view)) return view;
      await delay(15);
    } while (Date.now() < deadline);
    assert.fail(`未观察到预期的 ${phase} 界面: ${JSON.stringify(view)}`);
  }

  await win.loadFile(path.join(src, 'console', 'index.html'));
  await click('btnUpdate');
  let view = await waitFor('idle', (observed) => observed.version === 'v0.2.7');
  assert.deepEqual([view.modal, view.focus, view.mode, view.action], [true, 'btnUpdateClose', '安装版', '检查更新']);
  assert.equal(bootCalled, true);
  assert.deepEqual(calls, ['status']);

  await click('btnUpdateAction');
  await click('btnUpdateAction');
  await waitFor('checking', (observed) => !observed.enabled);
  assert.deepEqual(calls, ['status', 'check']);
  const notes = '<img src="https://example.invalid/never">\n<a href="https://example.invalid/never">说明</a>';
  const message = '<a href="https://example.invalid/never">只显示文字</a>';
  checkResult.resolve(moved('available', { targetVersion: 'v0.2.8', notes, message }));
  view = await waitFor('available', (observed) => observed.enabled);
  assert.deepEqual([view.latest, view.notes, view.message, view.remoteElements], ['v0.2.8', notes, message, 0]);
  assert.equal(view.action, '重新检查');
  assert.match(view.hint, /官方发布页.*手动下载/);
  await click('btnUpdateReleases');
  await waitFor('available', (observed) => observed.releasesEnabled);
  assert.deepEqual(calls, ['status', 'check', 'open-releases']);

  await click('btnUpdateAction');
  await waitFor('checking');
  checkResult.resolve(moved('available', { mode: 'portable', canDownload: true, size }));
  view = await waitFor('available', (observed) => observed.enabled);
  assert.deepEqual([view.mode, view.action, view.size], ['ZIP 解压绿色版', '下载更新', '100 MiB（104,857,604 字节）']);
  await click('btnUpdateAction');
  view = await waitFor('downloading', (observed) => !observed.transferHidden);
  assert.deepEqual([view.progress, view.action], [-1, '取消下载']);
  push('downloading', { size, received: size / 4 });
  view = await waitFor('downloading', (observed) => observed.progress === 0.25);
  assert.match(view.progressText, /^25% · 25 MiB \/ 100 MiB$/);
  await click('btnUpdateClose');
  await waitFor('downloading', (observed) => !observed.modal && observed.focus === 'btnUpdate');
  assert.equal(calls.at(-1), 'download');
  await click('btnUpdate');
  await click('btnUpdateAction');
  view = await waitFor('available', (observed) => observed.enabled);
  assert.equal(view.action, '下载更新');
  assert.equal(calls.at(-1), 'cancel');

  await click('btnUpdateAction');
  await waitFor('downloading');
  downloadResult.resolve(moved('ready', { size, received: size, canDownload: false }));
  view = await waitFor('ready', (observed) => observed.enabled);
  assert.equal(calls.includes('install'), false);
  assert.equal(view.action, '重启并安装');
  assert.match(view.hint, /浮窗播放器将停止/);
  await execute('window.confirm = () => { throw new Error("不应使用渲染器确认框"); }; void 0;');
  await click('btnUpdateAction');
  await waitFor('ready', (observed) => observed.enabled);
  assert.equal(calls.at(-1), 'install');
  await click('btnUpdateAction');
  await waitFor('installing', (observed) => !observed.enabled);
  push('updated', { version: '0.2.8' });
  await waitFor('updated', (observed) => observed.version === 'v0.2.8');
  push('current');
  await waitFor('current');
  push('error', { canDownload: true, message: '下载中断，请检查网络。' });
  view = await waitFor('error');
  assert.deepEqual([view.message, view.action], ['下载中断，请检查网络。', '重试下载']);
  push('error', { canDownload: false, message: '连接失败，请检查网络。' });
  view = await waitFor('error', (observed) => observed.action === '重试检查');
  assert.equal(view.message, '连接失败，请检查网络。');

  await execute('window.receivedUpdates = []; window.stopUpdates = window.api.onUpdateState((...args) => window.receivedUpdates.push(args)); void 0;');
  push('unsupported', { mode: null, message: '自解压绿色版不支持应用内更新。' });
  view = await waitFor('unsupported');
  assert.equal(view.actionHidden, true);
  assert.match(view.hint, /官方发布页.*手动下载/);
  const receivedUpdates = await execute('window.receivedUpdates');
  assert.deepEqual(receivedUpdates, [[state]]);
  assert.equal(await execute('window.stopUpdates()'), undefined);
  await click('btnUpdateReleases');
  await waitFor('unsupported', (observed) => observed.releasesEnabled);
  assert.equal(calls.at(-1), 'open-releases');
  push('idle');
  await waitFor('idle');
  assert.deepEqual(await execute('window.receivedUpdates'), receivedUpdates);
  console.log('PASS 启动器更新界面：离线初始化、10 个状态、取消、安装确认交给主进程、官方发布页、纯文本和 IPC');
}
