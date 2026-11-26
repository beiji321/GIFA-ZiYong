'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const rendererPath = path.resolve(__dirname, '../src/renderer/app.js');
const renderer = new vm.Script(fs.readFileSync(rendererPath, 'utf8'), { filename: rendererPath });
const videoId = 'BV1xx411c7mD';
const videoUrl = (part) => `https://www.bilibili.com/video/${videoId}/?p=${part}&autoplay=1`;
const sandboxCrash = { details: { reason: 'crashed', exitCode: 0x80000003 | 0 } };
const readyMedia = { found: true, ready: true, duration: 120 };

class StubTarget {
  listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, details = {}) {
    const event = { type, target: this, ...details };
    return (this.listeners.get(type) || []).map((listener) => listener(event));
  }
}

class StubElement extends StubTarget {
  children = [];
  style = {};
  hidden = false;
  text = '';

  constructor(tag = 'div') {
    super();
    this.tag = tag;
    const classes = new Set();
    this.classList = {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle(name, enabled = !classes.has(name)) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      }
    };
  }

  get textContent() { return this.text; }
  set textContent(text) {
    this.text = text;
    this.replaceChildren();
  }

  appendChild(child) {
    this.children.push(child);
    child.parent = this;
    child.onAttach?.();
  }

  replaceChildren(...children) {
    this.children = [];
    for (const child of children) this.appendChild(child);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((child) => child !== this);
    this.parent = null;
  }

  querySelector(tag) { return this.children.find((child) => child.tag === tag); }
  focus() {}
  matches() { return false; }
}

class StubWebview extends StubElement {
  attributes = new Map();
  sent = [];

  constructor() { super('webview'); }

  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  onAttach() { this.initialAttributes = new Map(this.attributes); }

  send(channel, message) {
    this.sent.push({ channel, command: message.cmd });
    return Promise.resolve();
  }

  reportState(state) { this.dispatch('ipc-message', { channel: 'state', args: [state] }); }
}

function createClock() {
  let now = 100_000;
  let sequence = 0;
  const timers = new Map();
  return {
    date: { now: () => now },
    setTimeout(callback, delay) {
      const handle = ++sequence;
      timers.set(handle, { callback, delay, due: now + delay });
      return handle;
    },
    clearTimeout: (handle) => timers.delete(handle),
    pending: (delay) => [...timers.values()].filter((timer) => timer.delay === delay).length,
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.due <= target)
          .sort((first, second) => first[1].due - second[1].due)[0];
        if (!next) break;
        const [handle, timer] = next;
        timers.delete(handle);
        now = timer.due;
        timer.callback();
      }
      now = target;
    }
  };
}

function metadata(part = 3, title = 'Current video') {
  const pages = Array.from({ length: 4 }, (_, index) => ({ page: index + 1, part: `Part ${index + 1}` }));
  return { ok: true, url: videoUrl(part), id: videoId, p: part, pages, title };
}

async function createApp(playbackCompatibility = true) {
  const ids = [
    'app', 'layoutSelect', 'stage', 'urlInput', 'btnLoad', 'placeholder', 'placeholderHint',
    'loadActions', 'btnRetry', 'btnBrowser', 'videoTitle', 'partSelect', 'urlbar', 'btnLink',
    'btnPlay', 'btnMute', 'btnSpeed', 'btnMin', 'btnClose', 'btnSettings', 'progress', 'grip',
    'calib', 'calibBox', 'calibOk', 'calibCancel', 'timeText', 'bar', 'knob', 'titlebar', 'toast',
    /* 魔改扩展的浮窗元素：app.js 初始化时会碰它们（比例锁定按钮、弹幕/字幕开关等），
     * 缺了会抛 TypeError。这里补齐，测试只关心载入流程，其余给空壳即可。 */
    'btnRatio', 'btnDanmaku', 'btnSubtitle', 'btnAlert', 'btnRadar', 'btnInfo'
  ];
  const elements = new Map(ids.map((id) => [id, new StubElement()]));
  const element = (id) => elements.get(id);
  const message = new StubElement('p');
  element('stage').appendChild(element('placeholder'));
  element('placeholder').appendChild(message);
  element('loadActions').hidden = true;
  element('btnBrowser').hidden = true;

  const clock = createClock();
  const requests = [];
  const actions = [];
  const guests = [];
  const document = Object.assign(new StubTarget(), {
    body: new StubElement('body'),
    getElementById: element,
    createElement(tag) {
      if (tag !== 'webview') return new StubElement(tag);
      const guest = new StubWebview();
      guests.push(guest);
      return guest;
    }
  });
  const window = new StubTarget();
  window.api = {
    boot: async () => ({
      playbackCompatibility,
      settings: { bearing: { enabled: false, activeLayoutId: 'default', layouts: [{ id: 'default', name: 'Default' }] } }
    }),
    load(query) {
      const request = { query };
      const promise = new Promise((resolve, reject) => {
        request.resolve = resolve;
        request.reject = reject;
      });
      requests.push(request);
      return promise;
    },
    action: async (...args) => { actions.push(args); return true; },
    bearing() {},
    save: async () => {},
    /* 魔改扩展的 IPC 通道：app.js 的 wireUi 会订阅它们，缺了会抛
     * "xxx is not a function"。本测试只关心载入流程，全部给空实现。 */
    onCompassText() {},
    onTurn() {},
    onBearing() {},
    onAutoCenterResult() {},
    onPlaceMode() {},
    onAlertState() {},
    onSubtitleState() {},
    onDanmakuState() {},
    onRadarState() {},
    diag() {},
    subtitle() {},
    subtitleTime() {},
    avoidHide() {},
    subtitleAPI() {},
    danmakuTime() {},
    turnUpdate() {},
    onNotice() {},
    onPlaybackState() {},
    onLogin() {},
    onFloatCmd() {},
    onSettingsChanged() {},
    onWinState() {},
    onFloatState() {},
    onHotkey() {},
    /* 魔改扩展其余通道（补齐到 app.js 实际用到的全集） */
    autoCenterResult() {},
    compassCue() {},
    compassNone() {},
    onResizePhase() {},
    onSnapEdges() {},
    onSubtitleApi() {},
    part() {},
    saveDump() {},
    turn() {},
    typing() {},
    updateBearingLayout() {}
  };
  renderer.runInNewContext({
    document,
    window,
    URL,
    Date: clock.date,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });
  await Promise.all(document.dispatch('DOMContentLoaded'));
  return {
    element, message, clock, guests, actions, requests,
    attachedGuests: () => element('stage').children.filter((child) => child.tag === 'webview'),
    click: (id) => Promise.all(element(id).dispatch('click')),
    beginLoad(text) {
      const previousRequests = requests.length;
      element('urlInput').value = text;
      const finished = this.click('btnLoad');
      assert.equal(requests.length, previousRequests + 1);
      return { request: requests.at(-1), finished };
    },
    async open(result = metadata()) {
      const { request, finished } = this.beginLoad(result.url);
      request.resolve(result);
      await finished;
      return this.attachedGuests().at(-1);
    }
  };
}

function expectLoading(app) {
  assert.equal(app.element('placeholder').classList.contains('hidden'), false);
  assert.equal(app.element('placeholder').classList.contains('failed'), false);
  assert.equal(app.element('loadActions').hidden, true);
}

function expectFailure(app, messagePattern, { browser = true, compatibility = false } = {}) {
  assert.equal(app.element('placeholder').classList.contains('hidden'), false);
  assert.equal(app.element('placeholder').classList.contains('failed'), true);
  assert.match(app.message.textContent, messagePattern);
  assert.equal(app.element('loadActions').hidden, false);
  assert.equal(app.element('btnBrowser').hidden, !browser);
  assert.equal(app.element('placeholderHint').hidden, !compatibility);
  assert.match(app.element('btnRetry').textContent, compatibility ? /兼容.*重试/ : /^重试$/);
}

test('the canonical part opens directly and only ready media clears the loading overlay', async () => {
  const app = await createApp();
  const submittedUrl = `https://www.bilibili.com/video/${videoId}/?p=3`;
  assert.equal(app.guests.length, 0);
  const { request, finished } = app.beginLoad(` ${submittedUrl} `);
  assert.equal(request.query.text, submittedUrl);
  assert.equal(request.query.p, undefined);
  assert.equal(app.guests.length, 0);
  expectLoading(app);

  request.resolve(metadata());
  await finished;
  const [guest] = app.guests;
  assert.deepEqual(app.attachedGuests(), [guest]);
  assert.equal(guest.initialAttributes.get('src'), videoUrl(3));
  assert.equal(guest.initialAttributes.get('partition'), 'persist:bili');
  assert.equal(guest.initialAttributes.has('webpreferences'), false);
  assert.equal(app.element('partSelect').value, '3');
  assert.equal(app.element('videoTitle').textContent, 'Current video');
  assert.equal(guest.sent.length, 0);

  guest.dispatch('dom-ready');
  const commands = guest.sent.filter(({ channel }) => channel === 'player').map(({ command }) => command);
  assert.ok(commands.includes('ping'));
  assert.ok(commands.includes('play'));
  expectLoading(app);
  guest.dispatch('did-finish-load');
  expectLoading(app);
  guest.reportState({ found: true, ready: false, duration: 120 });
  app.clock.advance(21_999);
  expectLoading(app);

  guest.reportState(readyMedia);
  assert.equal(app.clock.pending(22_000), 0);
  app.clock.advance(60_000);
  assert.equal(app.element('placeholder').classList.contains('hidden'), true);
});

for (const documentReady of [false, true]) {
  const stage = documentReady ? 'waiting for media' : 'waiting for the page';
  test(`the 22-second deadline reports a persistent failure while ${stage}`, async () => {
    const app = await createApp();
    const guest = await app.open();
    if (documentReady) guest.dispatch('dom-ready');
    app.clock.advance(21_999);
    expectLoading(app);
    app.clock.advance(1);
    const message = documentReady ? /视频.*超时/ : /播放页打开超时/;
    expectFailure(app, message);

    if (documentReady) guest.reportState({ found: true, ready: false });
    app.clock.advance(60_000);
    expectFailure(app, message);
  });
}

test('aborted navigations and subframe failures are ignored while a main-frame failure is actionable', async () => {
  const app = await createApp();
  const guest = await app.open();
  guest.dispatch('did-fail-load', { isMainFrame: true, errorCode: -3 });
  guest.dispatch('did-fail-load', { isMainFrame: false, errorCode: -105 });
  guest.dispatch('did-frame-navigate', { isMainFrame: false, httpResponseCode: 403 });
  expectLoading(app);

  guest.dispatch('did-fail-load', { isMainFrame: true, errorCode: -105 });
  expectFailure(app, /-105/);
  app.clock.advance(22_000);
  expectFailure(app, /-105/);
  await app.click('btnBrowser');
  /* 魔改扩展：applyImmersionState 会额外发一条 'ratio-refit'（沉浸时 chrome 高度变了，
   * 让主进程重新对齐 16:9）。这里只断言「浏览器打开」这条，其余 action 忽略。 */
  assert.deepEqual(app.actions.filter(([name]) => name === 'open-video-browser'),
    [['open-video-browser', videoUrl(3)]]);

  await app.click('btnRetry');
  const replacement = app.guests.at(-1);
  assert.notEqual(replacement, guest);
  assert.deepEqual(app.attachedGuests(), [replacement]);
  assert.equal(replacement.initialAttributes.get('src'), videoUrl(3));
  assert.equal(replacement.initialAttributes.has('webpreferences'), false);
  assert.equal(app.requests.length, 1);
  expectLoading(app);
  replacement.dispatch('did-frame-navigate', { isMainFrame: true, httpResponseCode: 403 });
  expectFailure(app, /HTTP 403/);
});

test('an early sandbox crash offers explicit compatibility retry that keeps the partition and part', async () => {
  const app = await createApp();
  const guest = await app.open();
  guest.dispatch('render-process-gone', sandboxCrash);
  expectFailure(app, /0x80000003/i, { compatibility: true });
  assert.match(app.element('placeholderHint').textContent, /沙箱/);
  assert.deepEqual(app.attachedGuests(), [guest]);
  assert.equal(guest.initialAttributes.has('webpreferences'), false);

  await app.click('btnRetry');
  const replacement = app.guests.at(-1);
  assert.notEqual(replacement, guest);
  assert.deepEqual(app.attachedGuests(), [replacement]);
  assert.equal(replacement.initialAttributes.get('partition'), guest.initialAttributes.get('partition'));
  assert.equal(replacement.initialAttributes.get('src'), videoUrl(3));
  assert.equal(replacement.initialAttributes.get('webpreferences'), 'sandbox=no');
  assert.equal(app.element('partSelect').value, '3');
  assert.equal(app.requests.length, 1);
  expectLoading(app);

  replacement.dispatch('dom-ready');
  assert.ok(replacement.sent.some(({ channel, command }) => channel === 'player' && command === 'play'));
  replacement.reportState(readyMedia);
  assert.equal(app.element('placeholder').classList.contains('hidden'), true);
});

for (const compatibilityEnabled of [false, true]) {
  const phase = compatibilityEnabled ? 'after navigation commit' : 'on a runtime without compatibility mode';
  test(`the sandbox crash code offers a normal retry ${phase}`, async () => {
    const app = await createApp(compatibilityEnabled);
    const guest = await app.open();
    if (compatibilityEnabled) {
      guest.dispatch('did-frame-navigate', { isMainFrame: true, url: videoUrl(3), httpResponseCode: 200 });
    }
    guest.dispatch('render-process-gone', sandboxCrash);
    expectFailure(app, /0x80000003/i);
  });
}

test('an aborted navigation preserves the current player', async () => {
  const app = await createApp();
  const guest = await app.open(metadata(2));
  guest.dispatch('did-frame-navigate', { isMainFrame: true, url: videoUrl(2), httpResponseCode: 200 });
  guest.dispatch('dom-ready');
  guest.reportState({ ...readyMedia, playing: true, current: 42 });

  guest.dispatch('did-start-navigation', { isMainFrame: true, isInPlace: false, url: 'https://example.test/' });
  guest.dispatch('did-fail-load', { isMainFrame: true, errorCode: -3 });
  guest.reportState({ ...readyMedia, playing: true, current: 43 });
  await app.click('btnPlay');

  app.clock.advance(22_000);
  assert.equal(app.element('placeholder').classList.contains('hidden'), true);
  assert.equal(app.element('btnPlay').classList.contains('playing'), true);
  assert.equal(app.element('timeText').textContent, '00:43 / 02:00');
  assert.deepEqual(guest.sent.at(-1), { channel: 'player', command: 'toggle' });
});

test('in-page part changes keep playing and full document navigation waits for fresh media', async () => {
  const app = await createApp();
  const guest = await app.open(metadata(2));
  guest.dispatch('did-frame-navigate', { isMainFrame: true, url: videoUrl(2), httpResponseCode: 200 });
  guest.dispatch('dom-ready');
  guest.reportState({ ...readyMedia, playing: true, current: 42 });

  guest.dispatch('did-start-navigation', { isMainFrame: true, isInPlace: true, url: videoUrl(3) });
  guest.dispatch('did-navigate-in-page', { isMainFrame: true, url: videoUrl(3) });
  assert.equal(app.element('partSelect').value, '3');
  assert.equal(app.element('btnPlay').classList.contains('playing'), true);
  assert.equal(app.element('placeholder').classList.contains('hidden'), true);
  assert.equal(app.clock.pending(22_000), 0);

  guest.dispatch('did-start-navigation', { isMainFrame: true, isInPlace: false, url: videoUrl(4) });
  assert.equal(app.element('btnPlay').classList.contains('playing'), true);
  assert.equal(app.clock.pending(22_000), 0);
  guest.dispatch('did-frame-navigate', { isMainFrame: true, url: videoUrl(4), httpResponseCode: 200 });
  assert.equal(app.element('partSelect').value, '4');
  assert.equal(app.element('btnPlay').classList.contains('playing'), false);
  assert.equal(app.clock.pending(22_000), 1);
  guest.reportState({ ...readyMedia, title: 'Previous document' });
  assert.equal(app.element('videoTitle').textContent, 'Current video');
  expectLoading(app);

  guest.dispatch('dom-ready');
  guest.reportState(readyMedia);
  assert.equal(app.element('placeholder').classList.contains('hidden'), true);
  assert.equal(app.clock.pending(22_000), 0);
  assert.deepEqual(app.attachedGuests(), [guest]);
});

test('superseded metadata results cannot replace a newer load of the same link', async () => {
  const app = await createApp();
  const failedOlder = app.beginLoad(videoUrl(3));
  const successfulOlder = app.beginLoad(videoUrl(3));
  const current = app.beginLoad(videoUrl(3));

  failedOlder.request.reject(new Error('Old metadata request failed'));
  await failedOlder.finished;
  expectLoading(app);
  assert.equal(app.guests.length, 0);

  current.request.resolve(metadata(3));
  await current.finished;
  const [guest] = app.guests;
  successfulOlder.request.resolve(metadata(4, 'Old video result'));
  await successfulOlder.finished;

  assert.deepEqual(app.guests, [guest]);
  assert.deepEqual(app.attachedGuests(), [guest]);
  assert.equal(guest.initialAttributes.get('src'), videoUrl(3));
  assert.equal(app.element('videoTitle').textContent, 'Current video');
  assert.equal(app.element('partSelect').value, '3');
  expectLoading(app);
});

test('superseded metadata cannot overwrite the newer part in main process settings', async () => {
  const mainPath = path.resolve(__dirname, '../src/main.js');
  const source = fs.readFileSync(mainPath, 'utf8');
  const definitions = ['registerIpc', 'noteWatched', 'buildUrl', 'resolveInput', 'extractId'].map((name) => {
    const match = new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(source);
    assert.ok(match, `Missing main process function ${name}`);
    return match[0];
  });
  const settings = {};
  const handlers = new Map();
  const pending = [];
  const broadcasts = [];
  let saves = 0;
  vm.runInNewContext(definitions.join('\n') + '\nregisterIpc();', {
    settings,
    ipcMain: { on() {}, handle: (channel, handler) => handlers.set(channel, handler) },
    fetchVideoInfo: () => new Promise((resolve) => pending.push(resolve)),
    persist: () => { saves += 1; },
    broadcast: (channel, value) => broadcasts.push([channel, value.lastPart]),
    /* 魔改扩展的诊断模块：registerIpc 里会调 diag.log 写字幕/弹幕相关日志，
     * 测试不关心输出，给空实现即可。 */
    diag: { init() {}, log() {} },
    /* bili:load 处理器里会调 switchPartData 清掉旧视频状态（换片/切 P 用）。
     * 这是魔改版加的业务函数，本测试只验证「分 P 竞争」的竞态保护，
     * 不需要它真的去重置各个窗口，给空实现。 */
    switchPartData() {},
    resetDanmakuWindow() {},
    scheduleCidRetry() {}
  }, { filename: mainPath });

  const load = handlers.get('bili:load');
  const older = load({}, { text: videoUrl(2) });
  await Promise.resolve();
  const newer = load({}, { text: videoId, p: 3 });
  await Promise.resolve();
  assert.equal(pending.length, 2);

  pending[1](metadata(3));
  const selected = await newer;
  assert.equal(selected.ok, true);
  assert.equal(selected.p, 3);
  assert.equal(selected.url, videoUrl(3));
  pending[0](metadata(2, 'Superseded title'));
  assert.equal((await older).ok, false);

  assert.equal(settings.lastPart, 3);
  assert.equal(settings.lastText, videoId);
  assert.equal(settings.lastTitle, 'Current video');
  assert.equal(saves, 1);
  assert.deepEqual(broadcasts, [['settings:changed', 3]]);
});

test('late navigation, crash and playback events from a removed guest have no effect', async () => {
  const app = await createApp();
  const previous = await app.open(metadata(2));
  previous.dispatch('dom-ready');
  previous.reportState(readyMedia);
  const replacement = await app.open(metadata(3));
  assert.deepEqual(app.attachedGuests(), [replacement]);

  previous.dispatch('dom-ready');
  previous.dispatch('did-finish-load');
  previous.dispatch('did-navigate-in-page', { isMainFrame: true, url: videoUrl(2) });
  previous.dispatch('did-fail-load', { isMainFrame: true, errorCode: -105 });
  previous.dispatch('render-process-gone', sandboxCrash);
  assert.equal(replacement.sent.length, 0);
  replacement.dispatch('dom-ready');
  previous.reportState({ ...readyMedia, p: 2, vid: videoId, title: 'Old guest' });

  assert.equal(app.element('videoTitle').textContent, 'Current video');
  assert.equal(app.element('partSelect').value, '3');
  expectLoading(app);
  replacement.reportState(readyMedia);
  assert.equal(app.element('placeholder').classList.contains('hidden'), true);
});

test('a failed replacement link leaves the current video playing', async () => {
  const app = await createApp();
  const guest = await app.open();
  guest.dispatch('dom-ready');
  guest.reportState({ ...readyMedia, playing: true });

  const { request, finished } = app.beginLoad('invalid link');
  request.reject(new Error('Metadata unavailable'));
  await finished;
  assert.deepEqual(app.attachedGuests(), [guest]);
  assert.equal(app.element('placeholder').classList.contains('hidden'), true);
  assert.equal(app.element('btnPlay').classList.contains('playing'), true);
  assert.match(app.element('toast').textContent, /未能读取视频信息/);
});

test('metadata failure exposes retry before a browser URL is available', async () => {
  const app = await createApp();
  const { request, finished } = app.beginLoad(videoUrl(3));
  request.resolve({ ok: false, message: 'Metadata unavailable' });
  await finished;
  expectFailure(app, /Metadata unavailable/, { browser: false });
  assert.equal(app.guests.length, 0);

  await app.click('btnRetry');
  const retry = app.requests.at(-1);
  assert.notEqual(retry, request);
  assert.equal(retry.query.text, request.query.text);
  expectLoading(app);
  retry.resolve(metadata());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.attachedGuests().length, 1);
});

test('a verification page is diagnosed before the media deadline', async () => {
  const app = await createApp();
  const guest = await app.open();
  guest.dispatch('dom-ready');
  guest.reportState({ found: false, verification: true });
  expectFailure(app, /安全验证/);
  assert.equal(app.clock.pending(22_000), 0);
});

test('an active media error is diagnosed before the media deadline', async () => {
  const app = await createApp();
  const guest = await app.open();
  guest.dispatch('dom-ready');
  guest.reportState({ ...readyMedia, mediaError: 3 });
  expectFailure(app, /解码|媒体错误\s*3/);
  assert.equal(app.clock.pending(22_000), 0);

  guest.reportState(readyMedia);
  assert.equal(app.element('placeholder').classList.contains('hidden'), true);
});
