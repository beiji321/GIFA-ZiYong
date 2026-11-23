'use strict';

/* 隔离 Electron / Chromium 媒体回归。只加载本地假页面与真实 webview preload，
 * 不打开业务窗口、不登录 B 站、不碰用户配置，也不注册全局热键。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { pathToFileURL } = require('node:url');

/* 子进程真正跑起来之后会写这个标记文件。父进程据此区分
 * 「测试跑完了 / 测试断言失败」和「Electron 压根没起来」。 */
const READY_MARKER = 'electron-ready.marker';

if (!process.versions.electron) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gifa-playback-media-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, temporaryRoot], { stdio: 'inherit', env: environment });
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('close', (code) => {
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    /* Electron 起来之后会写一个 ready 标记。没写就崩了，
     * 而且退出码是 Windows 的「进程崩溃」码（0xC0000005 访问冲突 /
     * 0x80000003 断点）—— 这不是本测试的断言失败，是这台机器上
     * Electron 根本进不了 GUI 就崩了（无桌面会话 / GPU 沙箱等）。
     * 这种情况如实报 SKIP，不要用退出码假装成「测试失败」。 */
    const ready = fs.existsSync(path.join(temporaryRoot, READY_MARKER));
    const crashedAtStartup = !ready && code !== 0;
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (crashedAtStartup) {
      console.log(`SKIP  Electron 无法启动（退出码 ${code}），本项需要可用的图形会话，未执行`);
      process.exitCode = 0;
      return;
    }
    process.exitCode = code || 0;
  });
} else {
  runElectron().catch((error) => {
    console.error(error);
    try {
      require('electron').app.exit(1);
    } catch {
      process.exit(1);
    }
  });
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain, screen } = require('electron');
  const temporaryRoot = process.argv[2];
  assert.ok(path.basename(temporaryRoot).startsWith('gifa-playback-media-'));
  app.setPath('userData', path.join(temporaryRoot, 'profile'));
  app.disableHardwareAcceleration();
  // 测试只加载自己生成的本地页面，避免 Windows Chromium 子进程沙箱阻断测试。
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  await app.whenReady();
  /* 到这一步说明 Electron 真的起来了，父进程就不用再猜退出码的含义。 */
  fs.writeFileSync(path.join(temporaryRoot, READY_MARKER), 'ready');

  let preferences = { volume: 23, muted: false, playbackRate: 1.5 };
  let guest = null;
  let released = 0;
  const reports = [];
  const preloadErrors = [];
  const readyWaiters = [];
  const videoSizes = [];
  const sizeWaiters = new Set();
  const sourceDir = path.resolve(__dirname, '../src');
  app.on('web-contents-created', (_event, contents) => {
    contents.on('render-process-gone', (_goneEvent, details) => console.error('render-process-gone', details));
  });
  const host = new BrowserWindow({
    x: 120, y: 70, width: 896, height: 568, frame: false, titleBarStyle: 'hidden', show: false,
    minWidth: 240, minHeight: 150,
    webPreferences: { webviewTag: true, backgroundThrottling: false, preload: path.join(sourceDir, 'preload.js') }
  });
  const immersion = loadImmersionHarness(host, screen, sourceDir, () => ({ ...preferences }));
  host.webContents.on('did-attach-webview', (_event, contents) => {
    guest = contents;
    immersion.attachPlaybackGuest(guest);
    guest.on('preload-error', (_preloadEvent, _preloadPath, error) => preloadErrors.push(error.message));
    guest.on('console-message', (details) => {
      if (details.level === 'error') console.error('[guest]', details.message);
    });
  });
  ipcMain.on('player:settings', (event) => {
    assert.equal(event.sender, guest, 'preload 必须在 guest 已附加后启动');
    assert.equal(event.sender.hostWebContents, host.webContents, '实际 guest 的宿主必须匹配');
    assert.equal(event.senderFrame, event.sender.mainFrame, '实际 IPC 主框架身份必须匹配');
    immersion.onSettings(event);
  });
  ipcMain.on('player:video-size', (event, message) => {
    immersion.onVideoSize(event, message);
    videoSizes.push(message);
    for (const waiter of sizeWaiters) waiter();
  });
  ipcMain.on('player:gating', (event) => event.sender.setAudioMuted(true));
  ipcMain.on('player:ready', (event) => {
    event.sender.setAudioMuted(false);
    released += 1;
    for (const resolve of readyWaiters.splice(0)) resolve();
  });
  ipcMain.on('player:changed', (event, message) => {
    const patch = message.patch;
    preferences = { ...preferences, ...patch };
    reports.push(patch);
    event.returnValue = preferences;
  });

  const sampleRate = 8000;
  const wave = Buffer.alloc(44 + sampleRate * 2);
  wave.write('RIFF', 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write('data', 36);
  wave.writeUInt32LE(wave.length - 44, 40);
  const mediaUrl = 'data:audio/wav;base64,' + wave.toString('base64');
  const pagePath = path.join(temporaryRoot, 'player.html');
  const hostPath = path.join(temporaryRoot, 'host.html');
  fs.writeFileSync(pagePath, `<!doctype html><html><body>
    <video id="media" autoplay loop style="width:640px;height:360px" src="${mediaUrl}"></video>
    <script>
      window.observed = [];
      const media = document.getElementById('media');
      for (const type of ['play', 'playing', 'loadedmetadata']) {
        media.addEventListener(type, () => observed.push({ type, volume: media.volume, rate: media.playbackRate }));
      }
      const fixture = document.createElement('canvas');
      const ctx = fixture.getContext('2d', { alpha: false });
      function paintFixture() {
        ctx.fillStyle = '#20c070'; ctx.fillRect(0, 0, fixture.width, fixture.height);
        ctx.fillStyle = '#ee932f'; ctx.fillRect(0, 0, 20, fixture.height);
        ctx.fillStyle = '#df2374'; ctx.fillRect(0, 0, fixture.width, 20);
      }
      setInterval(paintFixture, 30);
      window.showFixture = async (width, height, replace = false) => {
        let media = document.querySelector('video');
        if (replace) {
          const replacement = document.createElement('video');
          replacement.style.cssText = media.style.cssText;
          media.replaceWith(replacement);
          media = replacement;
        }
        fixture.width = width;
        fixture.height = height;
        paintFixture();
        if (!media.srcObject) {
          media.removeAttribute('src');
          media.srcObject = fixture.captureStream(30);
          await media.play();
        }
      };
    </script></body></html>`);
  const styles = pathToFileURL(path.join(sourceDir, 'renderer', 'style.css')).href;
  fs.writeFileSync(hostPath, `<!doctype html><link rel="stylesheet" href="${styles}">
    <div id="app"><main id="stage"></main></div><script>
      window.api.onWinState(({ immersion }) => document.getElementById('app').classList.toggle('video-only', immersion));
    </script>`);
  await host.loadURL(pathToFileURL(hostPath).href);
  const preloadUrl = pathToFileURL(path.join(sourceDir, 'webview-preload.js')).href;
  await host.webContents.executeJavaScript(`{
    const view = document.createElement('webview');
    view.id = 'test-player';
    view.setAttribute('preload', ${JSON.stringify(preloadUrl)});
    view.setAttribute('src', ${JSON.stringify(pathToFileURL(pagePath).href)});
    document.getElementById('stage').appendChild(view);
    void 0;
  }`);

  function waitForReady(previous) {
    if (released > previous) return Promise.resolve();
    return withTimeout(new Promise((resolve) => readyWaiters.push(resolve)), '等待应用设置后首次播放');
  }

  async function readMedia() {
    return guest.executeJavaScript(`(() => {
      const media = document.querySelector('video');
      return { volume: media.volume, muted: media.muted, rate: media.playbackRate,
        defaultRate: media.defaultPlaybackRate, paused: media.paused };
    })()`);
  }

  async function expectMedia(label, expected) {
    const actual = await readMedia();
    for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, label + ': ' + key);
    assert.equal(guest.isAudioMuted(), false, label + ': 设置恢复后必须开放原生音频');
    console.log('PASS  ' + label);
  }

  async function waitForReports(count) {
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    assert.equal(reports.length, count);
  }

  async function waitForVideoSize(width, height, since) {
    const matches = () => videoSizes.slice(since).some((size) => size.width === width && size.height === height);
    if (matches()) return;
    let check;
    try {
      await withTimeout(new Promise((resolve) => {
        check = () => { if (matches()) resolve(); };
        sizeWaiters.add(check);
      }), `等待视频尺寸 ${width}×${height}`);
    } finally {
      sizeWaiters.delete(check);
    }
  }

  async function expectUncroppedVideo(width, height, replace = false) {
    const since = videoSizes.length;
    await guest.executeJavaScript(`showFixture(${width}, ${height}, ${replace})`);
    await waitForVideoSize(width, height, since);
    await withTimeout(guest.executeJavaScript(`new Promise((resolve) => {
      function waitForPaint() {
        const media = document.querySelector('video');
        if (media.readyState < 2 || Math.abs(innerHeight - innerWidth * ${height} / ${width}) > 4) {
          setTimeout(waitForPaint, 25);
          return;
        }
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }
      waitForPaint();
    })`), '等待适配窗口渲染');
    const image = await guest.capturePage();
    const scaleFactor = Math.max(...image.getScaleFactors());
    const pixels = image.toBitmap({ scaleFactor });
    const imageSize = image.getSize(scaleFactor);
    assert.equal(pixels.length, imageSize.width * imageSize.height * 4);
    const pixel = (column, row) => {
      const offset = (row * imageSize.width + column) * 4;
      return pixels.subarray(offset, offset + 3);
    };
    const midX = Math.floor(imageSize.width / 2);
    const midY = Math.floor(imageSize.height / 2);
    const black = (sample) => sample.every((value) => value < 12);
    const sides = [offset => pixel(midX, offset), offset => pixel(midX, imageSize.height - 1 - offset),
      offset => pixel(offset, midY), offset => pixel(imageSize.width - 1 - offset, midY)];
    const bars = sides.map((sample) => {
      let size = 0;
      while (size < 5 && black(sample(size))) size += 1;
      return size;
    });
    const label = `${width}×${height} → ${imageSize.width}×${imageSize.height}，黑边上/下/左/右：${bars.join('/')}`;
    assert.ok(bars.every((size) => size <= Math.ceil(scaleFactor)), label);
    const top = pixel(midX, bars[0] + 3);
    const left = pixel(bars[2] + 3, midY);
    assert.ok(top[2] > 160 && top[1] < 90, '顶部标记不得被裁掉；' + label);
    assert.ok(left[2] > 160 && left[1] > 90, '左侧标记不得被裁掉；' + label);
    console.log('PASS  沉浸保留视频边缘，' + label);
  }

  try {
    await waitForReady(0);
    assert.deepEqual(preloadErrors, []);
    await expectMedia('原生 autoplay 首次播放恢复音量与倍速', { volume: 0.23, rate: 1.5, defaultRate: 1.5, muted: false });
    const observed = await guest.executeJavaScript('observed');
    assert.ok(observed.some((entry) => entry.type === 'playing'));
    assert.ok(observed.every((entry) => entry.volume === 0.23 && entry.rate === 1.5));
    await waitForReports(0);
    console.log('PASS  页面自身的首次媒体事件已经看到保存值，初始化不回写默认值');

    await guest.executeJavaScript(`document.querySelector('video').volume = 0.37`);
    await waitForReports(1);
    assert.equal(preferences.volume, 37);
    await guest.executeJavaScript(`document.querySelector('video').playbackRate = 1.75`);
    await waitForReports(2);
    assert.equal(preferences.playbackRate, 1.75);
    await guest.executeJavaScript(`document.querySelector('video').muted = true`);
    await waitForReports(3);
    assert.deepEqual(preferences, { volume: 37, muted: true, playbackRate: 1.75 });
    console.log('PASS  播放器内音量、倍速和静音同步保存，静音保留原音量');

    let previous = released;
    await guest.executeJavaScript(`{
      const old = document.querySelector('video');
      const replacement = document.createElement('video');
      replacement.style.cssText = old.style.cssText;
      replacement.autoplay = true;
      replacement.loop = true;
      replacement.src = ${JSON.stringify(mediaUrl)};
      old.replaceWith(replacement);
    }`);
    await waitForReady(previous);
    await expectMedia('SPA 替换 video 后沿用最近值及静音', { volume: 0.37, rate: 1.75, muted: true });
    await waitForReports(3);

    previous = released;
    await guest.executeJavaScript(`{
      const media = document.querySelector('video');
      media.src = ${JSON.stringify(mediaUrl + '#part2')};
      media.volume = 1;
      media.playbackRate = 1;
      media.muted = false;
      media.load();
      media.play().catch(() => {});
    }`);
    await waitForReady(previous);
    await expectMedia('同一 video 换源与初始化默认值不会覆盖偏好', { volume: 0.37, rate: 1.75, muted: true });
    await waitForReports(3);

    previous = released;
    await guest.executeJavaScript(`{
      history.replaceState({}, '', '?p=2');
      const media = document.querySelector('video');
      media.volume = 1;
      media.playbackRate = 1;
      media.muted = false;
    }`);
    await waitForReady(previous);
    await expectMedia('SPA 只切页码且复用媒体源时仍保留设置', { volume: 0.37, rate: 1.75, muted: true });
    await waitForReports(3);

    preferences = { volume: 14, muted: false, playbackRate: 2 };
    guest.send('player', { cmd: 'preferences', ...preferences });
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    await expectMedia('启动器直接更新当前 guest，异步事件回声不重复保存', { volume: 0.14, rate: 2, muted: false });
    await waitForReports(3);

    previous = released;
    await guest.reload();
    await waitForReady(previous);
    await expectMedia('整页重载在首次播放前同步获取最近偏好', { volume: 0.14, rate: 2, muted: false });
    await waitForReports(3);

    await guest.executeJavaScript(`document.querySelector('video').remove()`);
    preferences = { volume: 0, muted: true, playbackRate: 0.75 };
    guest.send('player', { cmd: 'preferences', ...preferences });
    guest.send('player', { cmd: 'play' });
    previous = released;
    await guest.executeJavaScript(`{
      const media = document.createElement('video');
      media.style.cssText = 'width:640px;height:360px';
      media.loop = true;
      media.src = ${JSON.stringify(mediaUrl)};
      document.body.appendChild(media);
      void 0;
    }`);
    await waitForReady(previous);
    await expectMedia('晚出现的 video 记住先到的偏好和播放请求，零音量有效', { volume: 0, rate: 0.75, muted: true });
    await waitForReports(3);

    previous = released;
    await guest.executeJavaScript(`new Promise((resolve, reject) => {
      const replacement = document.createElement('video');
      replacement.loop = true;
      replacement.style.cssText = 'width:640px;height:360px';
      replacement.src = ${JSON.stringify(mediaUrl)};
      replacement.play().then(() => {
        document.querySelector('video').replaceWith(replacement);
        resolve();
      }, reject);
    })`);
    await waitForReady(previous);
    await expectMedia('接管已经开始播放的视频也能解除原生静音', { volume: 0, rate: 0.75, muted: true });
    await waitForReports(3);
    await guest.executeJavaScript(`new Promise((resolve) => {
      document.querySelector('video').remove();
      const media = document.createElement('video');
      media.style.cssText = 'width:640px;height:360px';
      media.loop = true;
      media.addEventListener('loadedmetadata', resolve, { once: true });
      media.src = ${JSON.stringify(mediaUrl)};
      document.body.appendChild(media);
    }).then(() => undefined)`);
    guest.sendInputEvent({ type: 'keyDown', keyCode: 'M' });
    await guest.executeJavaScript(`document.querySelector('video').volume = 0.29`);
    await waitForReports(4);
    await guest.executeJavaScript(`document.querySelector('video').playbackRate = 1.25`);
    await waitForReports(5);
    assert.equal(preferences.volume, 29);
    assert.equal(preferences.playbackRate, 1.25);
    previous = released;
    await guest.executeJavaScript(`document.querySelector('video').play()`);
    await waitForReady(previous);
    await expectMedia('首次播放前通过真实用户交互调整也会保存', { volume: 0.29, rate: 1.25, muted: true });
    preferences = { ...preferences, temporaryPlaybackRate: 2.5 };
    guest.send('player', { cmd: 'preferences', ...preferences });
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    await expectMedia('长按临时倍率不改变媒体默认常规倍率', { rate: 2.5, defaultRate: 1.25 });
    await waitForReports(5);
    await guest.executeJavaScript(`document.querySelector('video').playbackRate = 1`);
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    await expectMedia('临时加速期间播放器回声不覆盖常规倍率', { rate: 2.5, defaultRate: 1.25 });
    await waitForReports(5);

    preferences = { ...preferences, playbackRate: 1.5 };
    guest.send('player', { cmd: 'preferences', ...preferences });
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    await expectMedia('临时加速时更新常规倍率仍保持临时播放', { rate: 2.5, defaultRate: 1.5 });
    previous = released;
    await guest.reload();
    await waitForReady(previous);
    await expectMedia('按住加速整页换 P 仍以临时倍率首播', { rate: 2.5, defaultRate: 1.5 });
    await waitForReports(5);
    delete preferences.temporaryPlaybackRate;
    guest.send('player', { cmd: 'preferences', ...preferences });
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    await expectMedia('松开后回到最新常规倍率且不额外保存', { rate: 1.5, defaultRate: 1.5 });
    await waitForReports(5);

    const originalBounds = host.getBounds();
    const startSizes = videoSizes.length;
    assert.equal(immersion.setImmersion(true), true);
    await waitForVideoSize(0, 0, startSizes);
    const presentation = await guest.executeJavaScript(`(() => {
      const media = document.querySelector('video');
      const overlay = document.createElement('div');
      overlay.id = 'fake-player-controls';
      overlay.textContent = '播放器控制条';
      document.body.appendChild(overlay);
      const bounds = media.getBoundingClientRect();
      return { controls: getComputedStyle(overlay).visibility, video: getComputedStyle(media).visibility,
        width: bounds.width, height: bounds.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
    })()`);
    assert.equal(presentation.controls, 'hidden');
    assert.equal(presentation.video, 'visible');
    assert.ok(Math.abs(presentation.width - presentation.viewportWidth) < 1);
    assert.ok(Math.abs(presentation.height - presentation.viewportHeight) < 1);
    assert.deepEqual(host.getBounds(), originalBounds);
    console.log('PASS 沉浸在视频未就绪时隐藏控件，暂不调整窗口');

    await expectUncroppedVideo(896, 504);
    assert.ok(host.getBounds().height < originalBounds.height - 30);
    await expectUncroppedVideo(960, 720);
    await expectUncroppedVideo(504, 896, true);

    previous = released;
    const sizesBeforeReload = videoSizes.length;
    const fittedBeforeReload = host.getBounds();
    await guest.reload();
    await waitForReady(previous);
    await waitForVideoSize(0, 0, sizesBeforeReload);
    assert.deepEqual(host.getBounds(), fittedBeforeReload);
    assert.equal(await guest.executeJavaScript(`getComputedStyle(document.querySelector('video')).objectFit`), 'contain');
    await expectUncroppedVideo(896, 504);

    assert.equal(immersion.setImmersion(false), false);
    assert.deepEqual(host.getBounds(), originalBounds);
    await guest.executeJavaScript(`{
      const controls = document.createElement('div');
      controls.id = 'fake-player-controls';
      document.body.appendChild(controls);
    }`);
    await guest.executeJavaScript(`new Promise((resolve) => setTimeout(resolve, 50))`);
    assert.equal(await guest.executeJavaScript(`getComputedStyle(document.getElementById('fake-player-controls')).visibility`), 'visible');
    console.log('PASS 退出沉浸恢复网页控件，不残留隐藏样式');

    const sizesBeforeEntry = videoSizes.length;
    assert.equal(immersion.setImmersion(true), true);
    await waitForVideoSize(896, 504, sizesBeforeEntry);
    const minimized = once(host, 'minimize');
    host.minimize();
    await withTimeout(minimized, '等待测试窗口最小化');
    assert.equal(immersion.setImmersion(false), false);
    assert.equal(host.isMinimized(), true);
    const restored = once(host, 'restore');
    host.restore();
    await withTimeout(restored, '等待测试窗口还原');
    assert.deepEqual(host.getBounds(), originalBounds);
    console.log('PASS 最小化时退出不唤醒窗口，还原后恢复原位置和尺寸');
    console.log('媒体回归全部通过');
  } finally {
    host.destroy();
    app.quit();
  }
}

function loadImmersionHarness(host, screen, sourceDir, guestPlaybackSettings) {
  const listeners = new Map();
  const context = vm.createContext({
    win: host, consoleWin: null, screen, guestPlaybackSettings,
    playbackGuest: null, playbackToken: 0, playbackGate: 0,
    immersion: false, immersionSession: 0, immersionBounds: null, immersionAspect: 0, restoredImmersionBounds: null,
    hoverFaded: false, hoverTimer: null, hoverCandidate: false, hoverCandidateAt: 0,
    settings: { opacity: 1, clickThrough: false, hoverFadeEnabled: false, hotkeys: {} },
    setInterval, clearInterval,
    ipcMain: { on: (name, listener) => listeners.set(name, listener), handle() {} }
  });
  const source = fs.readFileSync(path.join(sourceDir, 'main.js'), 'utf8');
  const names = [
    'isPlaybackGuest', 'isPlaybackMessage', 'attachPlaybackGuest', 'sendTo', 'broadcast', 'showNotice',
    'floatState', 'notifyFloatState', 'applyWindowPresentation', 'updateHoverFade', 'syncHoverFade',
    'sameWindowBounds', 'fitImmersionWindow', 'restoreImmersionWindow', 'syncImmersionBoundsAfterRestore',
    'setImmersion', 'registerIpc'
  ];
  for (const name of names) {
    const definition = new RegExp(`^function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(source);
    assert.ok(definition, `找不到主进程函数 ${name}`);
    vm.runInContext(definition[0], context);
  }
  context.registerIpc();
  host.on('restore', context.syncImmersionBoundsAfterRestore);
  return {
    attachPlaybackGuest: context.attachPlaybackGuest, setImmersion: context.setImmersion,
    onSettings: listeners.get('player:settings'), onVideoSize: listeners.get('player:video-size')
  };
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' 超过 15 秒')), 15000);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
