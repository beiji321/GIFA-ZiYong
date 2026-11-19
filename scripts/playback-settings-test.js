'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { normalizeAccelerator, mergeHotkeys, prepareHotkeyUpdate } = require('../src/hotkey-config');
const { DEFAULT_GAMEPAD, mergeGamepadSettings } = require('../src/gamepad-config');

const projectRoot = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'src', 'main.js'), 'utf8');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gifa-playback-settings-'));
let passed = 0;
let failed = 0;
let harnessCount = 0;

function extractFunction(source, name) {
  const declaration = new RegExp('^(?:async\\s+)?function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{', 'm').exec(source);
  assert.ok(declaration, '找不到真实函数 ' + name);
  let cursor = declaration.index + declaration[0].length;
  let depth = 1;
  while (depth > 0 && cursor < source.length) {
    const character = source[cursor];
    if (character === '{') depth += 1;
    else if (character === '}') depth -= 1;
    cursor += 1;
  }
  assert.equal(depth, 0, '函数括号不完整：' + name);
  const extracted = source.slice(declaration.index, cursor);
  new vm.Script(extracted, { filename: 'extracted-' + name + '.js' });
  return extracted;
}

function extractConstant(source, name) {
  const declaration = new RegExp('^const ' + name + ' = [\\s\\S]*?;\\r?$', 'm').exec(source);
  assert.ok(declaration, '找不到真实常量 ' + name);
  new vm.Script(declaration[0], { filename: 'extracted-' + name + '.js' });
  return declaration[0];
}

function extractQuitRegistrations(source) {
  const registrations = [];
  const registrationPattern = /^[ \t]*app\.on\(['"](?:before-quit|will-quit)['"]\s*,/gm;
  for (const registration of source.matchAll(registrationPattern)) {
    let terminator = source.indexOf(');', registration.index);
    while (terminator !== -1) {
      const candidate = source.slice(registration.index, terminator + 2);
      try {
        new vm.Script(candidate, { filename: 'extracted-quit.js' });
        registrations.push(candidate);
        break;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      terminator = source.indexOf(');', terminator + 2);
    }
  }
  assert.ok(registrations.length, '找不到退出事件注册');
  return registrations.join('\n');
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function check(label, callback) {
  try {
    callback();
    passed += 1;
    console.log('PASS  ' + label);
  } catch (error) {
    failed += 1;
    console.error('FAIL  ' + label + '\n' + error.stack);
  }
}

function createClock() {
  let elapsed = 0;
  let nextTimer = 0;
  let scheduled = 0;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      nextTimer += 1;
      scheduled += 1;
      pending.set(nextTimer, { callback, dueAt: elapsed + delay, delay });
      return nextTimer;
    },
    clearTimeout(timer) {
      pending.delete(timer);
    },
    advance(milliseconds) {
      elapsed += milliseconds;
      for (;;) {
        const ready = [...pending].find(([, timer]) => timer.dueAt <= elapsed);
        if (!ready) break;
        pending.delete(ready[0]);
        ready[1].callback();
      }
    },
    pending: () => [...pending.values()],
    scheduled: () => scheduled
  };
}

function createHarness(options = {}) {
  harnessCount += 1;
  const userData = options.userData || path.join(temporaryRoot, 'case-' + harnessCount, 'userData');
  const settingsPath = path.join(userData, 'settings.json');
  const clock = createClock();
  const listeners = new Map();
  const handlers = new Map();
  const appEvents = new EventEmitter();
  const broadcasts = [];
  const errors = [];
  const sessions = new Map();
  let hoverSyncs = 0;
  let heldCancellations = 0;
  const context = vm.createContext({
    fs,
    path,
    structuredClone,
    normalizeAccelerator,
    mergeHotkeys,
    prepareHotkeyUpdate,
    mergeGamepadSettings,
    app: {
      getPath(kind) {
        assert.equal(kind, 'userData');
        return userData;
      },
      on: (name, callback) => appEvents.on(name, callback)
    },
    ipcMain: {
      on: (channel, callback) => listeners.set(channel, callback),
      handle: (channel, callback) => handlers.set(channel, callback)
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    clearInterval: clock.clearTimeout,
    syncHoverFade: () => { hoverSyncs += 1; },
    console: {
      log() {},
      warn() {},
      error: (...messages) => errors.push(messages)
    },
    broadcast: (channel, payload) => broadcasts.push({ channel, payload: plain(payload) }),
    globalShortcut: { unregisterAll() {} },
    hookHotkeys: { apply() {}, cancelHeld: () => { heldCancellations += 1; } },
    resetGamepadSession() {},
    stopGamepadPoller() {},
    // 托盘是我们加的：退出回调会销毁托盘、刷新菜单，测试里给空实现
    destroyTray() {},
    rebuildTrayMenu() {},
    DEFAULT_GAMEPAD
  });
  const declarations = [
    ...['DEFAULT_HOTKEYS', 'HOLD_PLAYBACK_RATES', 'LEGACY_SEED_ROIS', 'DEFAULT_SETTINGS'].map((name) => extractConstant(mainSource, name)),
    'let settings = structuredClone(DEFAULT_SETTINGS);',
    'let saveTimer = null;',
    'let win = null;',
    'let playbackGuest = null;',
    'let playbackToken = 0;',
    'let playbackGate = 0;',
    'let holdSpeedActive = false;',
    'const holdSpeedSources = new Set();',
    'let immersion = false;',
    'let hoverFaded = false;',
    'let hoverTimer = null;',
    ...[
      'dropLegacySeeds', 'noteWatched', 'playbackSettings', 'updatePlaybackSettings',
      'settingsFile', 'loadSettings', 'flushSettings', 'persist', 'isPlaybackGuest',
      'isPlaybackMessage', 'playbackState', 'guestPlaybackSettings', 'floatState', 'notifyFloatState',
      'publishPlaybackSettings', 'showNotice', 'setHoldSpeed', 'cancelTemporarySpeed',
      'attachPlaybackGuest', 'registerIpc'
    ].map((name) => extractFunction(mainSource, name)),
    `globalThis.testApi = {
      playbackSettings, updatePlaybackSettings, loadSettings, flushSettings, persist,
      isPlaybackGuest, publishPlaybackSettings, attachPlaybackGuest, registerIpc,
      playbackState, guestPlaybackSettings, floatState, setHoldSpeed, cancelTemporarySpeed,
      setImmersion: (value) => { immersion = !!value; },
      getSettings: () => settings,
      setWindow: (value) => { win = value; },
      getGuest: () => playbackGuest,
      getSaveTimer: () => saveTimer,
      setSettings: (value) => { settings = structuredClone(value); }
    };`
  ];
  vm.runInContext(declarations.join('\n\n'), context, { filename: 'playback-main-harness.js' });
  const api = context.testApi;

  function raw(channel, sender, message, senderFrame = sender.mainFrame) {
    assert.ok(listeners.has(channel), '缺少同步 IPC：' + channel);
    const event = { sender, senderFrame, returnValue: undefined };
    listeners.get(channel)(event, message);
    return event;
  }

  function bootstrap(sender) {
    const event = raw('player:settings', sender);
    const preferences = event.returnValue;
    if (preferences && Number.isSafeInteger(preferences.token)) {
      sessions.set(sender, { token: preferences.token, seq: 0 });
    }
    return event;
  }

  function send(channel, sender, patch) {
    if (channel === 'player:settings') return bootstrap(sender);
    if (!sessions.has(sender)) bootstrap(sender);
    const session = sessions.get(sender) || { token: undefined, seq: 0 };
    if (channel === 'player:changed') return raw(channel, sender, { token: session.token, patch });
    if (channel === 'player:gating') session.seq += 1;
    return raw(channel, sender, { token: session.token, seq: session.seq });
  }

  return {
    ...api,
    userData,
    settingsPath,
    clock,
    broadcasts,
    errors,
    listeners,
    handlers,
    hoverSyncs: () => hoverSyncs,
    heldCancellations: () => heldCancellations,
    writeRaw(value) {
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(settingsPath, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
    },
    readRaw: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
    registerQuit() {
      vm.runInContext(extractQuitRegistrations(mainSource), context, { filename: 'playback-quit-harness.js' });
    },
    quit() {
      appEvents.emit('before-quit');
      appEvents.emit('will-quit');
    },
    send,
    raw,
    save(patch) {
      assert.ok(handlers.has('settings:save'), '缺少 settings:save');
      return handlers.get('settings:save')({}, patch);
    }
  };
}

function createWindow() {
  return {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: {}
  };
}

function createGuest(host) {
  const guest = new EventEmitter();
  guest.hostWebContents = host;
  guest.mainFrame = {};
  guest.destroyed = false;
  guest.audioMuted = false;
  guest.audioChanges = [];
  guest.messages = [];
  guest.isDestroyed = () => guest.destroyed;
  guest.setAudioMuted = (muted) => {
    guest.audioMuted = muted;
    guest.audioChanges.push(muted);
  };
  guest.send = (channel, payload) => guest.messages.push({ channel, payload: plain(payload) });
  return guest;
}

function attachGuest(harness) {
  const window = createWindow();
  const guest = createGuest(window.webContents);
  harness.setWindow(window);
  harness.attachPlaybackGuest(guest);
  return { window, guest };
}

function assertPreferences(harness, expected) {
  assert.deepEqual(plain(harness.playbackSettings(harness.getSettings())), expected);
}

function assertBootstrap(event, expected) {
  assert.ok(event.returnValue, 'bootstrap 应同步返回偏好与 token');
  const { token, ...preferences } = plain(event.returnValue);
  assert.ok(Number.isSafeInteger(token) && token > 0, 'bootstrap 应提供正整数文档 token');
  assert.deepEqual(preferences, expected);
  return token;
}

try {
  console.log('播放设置离线回归：真实源码函数、临时设置文件、模拟 Electron IPC');

  check('归一化默认值、上下界、非法数值与独立静音', () => {
    const harness = createHarness();
    const cases = [
      [undefined, { volume: 100, muted: false, playbackRate: 1 }],
      [{ volume: -20, playbackRate: 0.1 }, { volume: 0, muted: true, playbackRate: 0.25 }],
      [{ volume: 120, playbackRate: 9 }, { volume: 100, muted: false, playbackRate: 3 }],
      [{ volume: 31.5, muted: true, playbackRate: 1.75 }, { volume: 31.5, muted: true, playbackRate: 1.75 }],
      [{ volume: 0, muted: false, playbackRate: 0.25 }, { volume: 0, muted: false, playbackRate: 0.25 }],
      [{ volume: '30', muted: 'true', playbackRate: '2' }, { volume: 100, muted: false, playbackRate: 1 }],
      [{ volume: NaN, playbackRate: Infinity }, { volume: 100, muted: false, playbackRate: 1 }]
    ];
    for (const [input, expected] of cases) {
      assert.deepEqual(plain(harness.playbackSettings(input)), expected);
    }
    const input = { volume: 28, muted: true, playbackRate: 2, lastPart: 8 };
    assert.deepEqual(plain(harness.playbackSettings(input)), { volume: 28, muted: true, playbackRate: 2 });
    assert.deepEqual(input, { volume: 28, muted: true, playbackRate: 2, lastPart: 8 });
  });

  check('补丁就地更新、changed 幂等，静音切换保留原音量与倍速', () => {
    const harness = createHarness();
    const settings = { volume: 72, muted: false, playbackRate: 1.5, lastPart: 9 };
    assert.equal(harness.updatePlaybackSettings(settings, { muted: true }), true);
    assert.deepEqual(settings, { volume: 72, muted: true, playbackRate: 1.5, lastPart: 9 });
    assert.equal(harness.updatePlaybackSettings(settings, { muted: true }), false);
    assert.equal(harness.updatePlaybackSettings(settings, { playbackRate: 2.25 }), true);
    assert.equal(settings.muted, true);
    assert.equal(settings.volume, 72);
    assert.equal(harness.updatePlaybackSettings(settings, { muted: false }), true);
    assert.deepEqual(settings, { volume: 72, muted: false, playbackRate: 2.25, lastPart: 9 });
    assert.equal(harness.updatePlaybackSettings(settings), false);
  });

  check('正音量默认取消静音，显式 muted 覆盖，补丁限制音量与倍速', () => {
    const harness = createHarness();
    const settings = { volume: 60, muted: true, playbackRate: 1 };
    assert.equal(harness.updatePlaybackSettings(settings, { volume: 35 }), true);
    assert.deepEqual(settings, { volume: 35, muted: false, playbackRate: 1 });
    harness.updatePlaybackSettings(settings, { volume: 45, muted: true });
    assert.deepEqual(settings, { volume: 45, muted: true, playbackRate: 1 });
    harness.updatePlaybackSettings(settings, { volume: -1, playbackRate: 0 });
    assert.deepEqual(settings, { volume: 0, muted: true, playbackRate: 0.25 });
    harness.updatePlaybackSettings(settings, { volume: 500, playbackRate: 10 });
    assert.deepEqual(settings, { volume: 100, muted: false, playbackRate: 3 });
    assert.equal(harness.updatePlaybackSettings(settings, { volume: '10', muted: 1, playbackRate: NaN }), false);
    assert.equal(harness.updatePlaybackSettings(settings, { unrelated: true }), false);
    assert.equal('unrelated' in settings, false);
  });

  check('老设置补齐偏好，零音量迁移为静音', () => {
    const harness = createHarness();
    const settings = { lastPart: 4 };
    assert.equal(harness.updatePlaybackSettings(settings), true);
    assert.deepEqual(settings, { lastPart: 4, volume: 100, muted: false, playbackRate: 1 });
    harness.writeRaw({ volume: 0, lastPart: 4 });
    harness.loadSettings();
    assertPreferences(harness, { volume: 0, muted: true, playbackRate: 1 });
    assert.equal(harness.getSettings().lastPart, 4);
  });

  check('loadSettings 读取真实文件并在合并 raw 后归一化', () => {
    const harness = createHarness();
    harness.writeRaw({
      volume: 150, muted: 'true', playbackRate: 0.1, lastPart: 7,
      bounds: { width: 777 }, hotkeys: { togglePlay: 'Ctrl+P' }
    });
    harness.loadSettings();
    assertPreferences(harness, { volume: 100, muted: false, playbackRate: 0.25 });
    assert.equal(harness.getSettings().lastPart, 7);
    assert.equal(harness.getSettings().bounds.width, 777);
    assert.equal(harness.getSettings().bounds.height, 568);
    assert.equal(harness.getSettings().hotkeys.togglePlay, 'Ctrl+P');
    assert.ok(harness.getSettings().hotkeys.seekBack);
    harness.writeRaw({ volume: 34, muted: true, playbackRate: 1.75 });
    harness.loadSettings();
    assertPreferences(harness, { volume: 34, muted: true, playbackRate: 1.75 });
  });

  check('缺失或损坏的设置文件恢复默认偏好', () => {
    const harness = createHarness();
    harness.loadSettings();
    assertPreferences(harness, { volume: 100, muted: false, playbackRate: 1 });
    harness.writeRaw('{ invalid json');
    harness.loadSettings();
    assertPreferences(harness, { volume: 100, muted: false, playbackRate: 1 });
  });

  check('persist 只在最后一次修改的 250ms 后写最新偏好', () => {
    const harness = createHarness();
    harness.updatePlaybackSettings(harness.getSettings(), { volume: 44, playbackRate: 1.5 });
    harness.persist();
    assert.equal(fs.existsSync(harness.settingsPath), false);
    assert.equal(harness.clock.pending().length, 1);
    assert.equal(harness.clock.pending()[0].delay, 250);
    harness.clock.advance(100);
    harness.updatePlaybackSettings(harness.getSettings(), { muted: true, playbackRate: 2 });
    harness.persist();
    assert.equal(harness.clock.pending().length, 1);
    harness.clock.advance(249);
    assert.equal(fs.existsSync(harness.settingsPath), false);
    harness.clock.advance(1);
    assert.deepEqual(harness.readRaw(), plain(harness.getSettings()));
    assert.equal(harness.getSaveTimer(), null);
    assert.equal(harness.clock.pending().length, 0);
  });

  check('flushSettings 同步创建目录写盘并取消挂起计时器', () => {
    const harness = createHarness();
    harness.updatePlaybackSettings(harness.getSettings(), { volume: 27, muted: true, playbackRate: 2.5 });
    harness.persist();
    harness.flushSettings();
    assert.deepEqual(harness.readRaw(), plain(harness.getSettings()));
    assert.equal(harness.clock.pending().length, 0);
    assert.equal(harness.getSaveTimer(), null);
    const saved = fs.readFileSync(harness.settingsPath, 'utf8');
    harness.clock.advance(1000);
    assert.equal(fs.readFileSync(harness.settingsPath, 'utf8'), saved);
    harness.setSettings({});
    harness.loadSettings();
    assertPreferences(harness, { volume: 27, muted: true, playbackRate: 2.5 });
  });

  check('真实退出回调在 250ms 内关闭时同步保存最后修改', () => {
    const harness = createHarness();
    harness.registerQuit();
    harness.updatePlaybackSettings(harness.getSettings(), { volume: 19, muted: true, playbackRate: 1.25 });
    harness.persist();
    harness.quit();
    assert.deepEqual(harness.readRaw(), plain(harness.getSettings()));
    assert.equal(harness.clock.pending().length, 0);
    assert.equal(harness.getSaveTimer(), null);
    harness.setSettings({});
    harness.loadSettings();
    assertPreferences(harness, { volume: 19, muted: true, playbackRate: 1.25 });
  });

  check('附加 guest 立即原生静音，只有跨文档主框架导航重新关声音', () => {
    const harness = createHarness();
    const { guest } = attachGuest(harness);
    assert.equal(harness.getGuest(), guest);
    assert.deepEqual(guest.audioChanges, [true]);
    guest.audioChanges.length = 0;
    guest.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    assert.deepEqual(guest.audioChanges, []);
    guest.setAudioMuted(false);
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    assert.equal(guest.audioMuted, true);
  });

  check('guest 授权要求当前活窗口、当前 guest 与宿主同时匹配', () => {
    const harness = createHarness();
    const { window, guest } = attachGuest(harness);
    assert.equal(harness.isPlaybackGuest(guest), true);
    assert.equal(harness.isPlaybackGuest(createGuest(window.webContents)), false);
    assert.equal(harness.isPlaybackGuest(window.webContents), false);
    guest.hostWebContents = {};
    assert.equal(harness.isPlaybackGuest(guest), false);
    guest.hostWebContents = window.webContents;
    window.destroyed = true;
    assert.equal(harness.isPlaybackGuest(guest), false);
    window.destroyed = false;
    harness.setWindow(null);
    assert.equal(harness.isPlaybackGuest(guest), false);
  });

  check('旧 guest 销毁不会清空新 guest，当前 guest 销毁后取消授权', () => {
    const harness = createHarness();
    const { window, guest: previousGuest } = attachGuest(harness);
    const nextGuest = createGuest(window.webContents);
    harness.attachPlaybackGuest(nextGuest);
    previousGuest.emit('destroyed');
    assert.equal(harness.getGuest(), nextGuest);
    assert.equal(harness.isPlaybackGuest(previousGuest), false);
    nextGuest.destroyed = true;
    nextGuest.emit('destroyed');
    assert.equal(harness.getGuest(), null);
    assert.equal(harness.isPlaybackGuest(nextGuest), false);
  });

  check('主进程直接向当前 guest 发布三个偏好字段', () => {
    const harness = createHarness();
    harness.updatePlaybackSettings(harness.getSettings(), { volume: 32, muted: true, playbackRate: 2.25 });
    harness.publishPlaybackSettings();
    const { guest } = attachGuest(harness);
    harness.publishPlaybackSettings();
    assert.deepEqual(guest.messages.at(-1), {
      channel: 'player', payload: { cmd: 'preferences', volume: 32, muted: true, playbackRate: 2.25 }
    });
    const sent = guest.messages.length;
    guest.destroyed = true;
    harness.publishPlaybackSettings();
    assert.equal(guest.messages.length, sent);
  });

  check('同步 player:settings 返回保存值并关声音，ready 才解除原生静音', () => {
    const harness = createHarness();
    harness.registerIpc();
    const { guest } = attachGuest(harness);
    harness.updatePlaybackSettings(harness.getSettings(), { volume: 38, muted: true, playbackRate: 1.75 });
    guest.setAudioMuted(false);
    const event = harness.send('player:settings', guest);
    assertBootstrap(event, { volume: 38, muted: true, playbackRate: 1.75 });
    assert.equal(guest.audioMuted, true);
    assert.equal(harness.clock.pending().length, 0);
    assert.equal(harness.broadcasts.length, 0);
    harness.send('player:ready', guest);
    assert.equal(guest.audioMuted, false);
    assertPreferences(harness, { volume: 38, muted: true, playbackRate: 1.75 });
  });

  check('四路 player IPC 拒绝同宿主的其他 guest 与宿主不匹配的当前 guest', () => {
    const harness = createHarness();
    harness.registerIpc();
    const { window, guest } = attachGuest(harness);
    const original = plain(harness.getSettings());
    const impostor = createGuest(window.webContents);
    const mismatchedHost = {};
    for (const sender of [impostor, guest]) {
      if (sender === guest) guest.hostWebContents = mismatchedHost;
      const event = harness.send('player:settings', sender);
      assert.ok(!event.returnValue);
      harness.send('player:gating', sender);
      harness.send('player:ready', sender);
      harness.send('player:changed', sender, { volume: 11, muted: true, playbackRate: 3 });
      assert.deepEqual(plain(harness.getSettings()), original);
      assert.equal(guest.audioMuted, true);
      assert.equal(harness.broadcasts.length, 0);
      assert.equal(harness.clock.pending().length, 0);
    }
    assert.deepEqual(impostor.audioChanges, []);
  });

  check('每次 bootstrap 生成新 token，旧文档的修改与音频消息被拒绝', () => {
    const harness = createHarness();
    harness.registerIpc();
    const { guest } = attachGuest(harness);
    const expected = { volume: 36, muted: true, playbackRate: 1.5 };
    harness.updatePlaybackSettings(harness.getSettings(), expected);
    const previousToken = assertBootstrap(harness.send('player:settings', guest), expected);
    harness.send('player:gating', guest);
    const currentToken = assertBootstrap(harness.send('player:settings', guest), expected);
    assert.ok(currentToken > previousToken);
    harness.raw('player:changed', guest, { token: previousToken, patch: { volume: 99, muted: false, playbackRate: 3 } });
    harness.raw('player:ready', guest, { token: previousToken, seq: 0 });
    assert.equal(guest.audioMuted, true);
    assertPreferences(harness, expected);
    assert.equal(harness.clock.pending().length, 0);
    assert.equal(harness.broadcasts.length, 0);
    harness.send('player:ready', guest);
    assert.equal(guest.audioMuted, false);
    harness.raw('player:gating', guest, { token: previousToken, seq: 100 });
    assert.equal(guest.audioMuted, false);
    harness.send('player:gating', guest);
    assert.equal(guest.audioMuted, true);
    harness.send('player:ready', guest);
    assert.equal(guest.audioMuted, false);
  });

  check('音频门控只接受递增 seq，ready 必须匹配最近一次门控', () => {
    const harness = createHarness();
    harness.registerIpc();
    const { guest } = attachGuest(harness);
    const token = assertBootstrap(harness.send('player:settings', guest), { volume: 100, muted: false, playbackRate: 1 });
    harness.send('player:ready', guest);
    assert.equal(guest.audioMuted, false);
    harness.send('player:gating', guest);
    assert.equal(guest.audioMuted, true);
    harness.raw('player:ready', guest, { token, seq: 0 });
    assert.equal(guest.audioMuted, true);
    harness.send('player:gating', guest);
    harness.raw('player:ready', guest, { token, seq: 1 });
    assert.equal(guest.audioMuted, true);
    harness.raw('player:ready', guest, { token, seq: 3 });
    assert.equal(guest.audioMuted, true);
    harness.send('player:ready', guest);
    assert.equal(guest.audioMuted, false);
    harness.raw('player:gating', guest, { token, seq: 1 });
    harness.raw('player:gating', guest, { token, seq: 2 });
    assert.equal(guest.audioMuted, false);
    harness.send('player:gating', guest);
    assert.equal(guest.audioMuted, true);
    harness.raw('player:ready', guest, { token, seq: 2 });
    assert.equal(guest.audioMuted, true);
    harness.send('player:ready', guest);
    assert.equal(guest.audioMuted, false);
  });

  check('同一 guest 的子框架不能 bootstrap、修改偏好或改变音频门控', () => {
    const harness = createHarness();
    harness.registerIpc();
    const { guest } = attachGuest(harness);
    const subframe = {};
    const expected = { volume: 100, muted: false, playbackRate: 1 };
    const token = assertBootstrap(harness.send('player:settings', guest), expected);
    harness.send('player:ready', guest);
    assert.equal(guest.audioMuted, false);
    const unauthorized = harness.raw('player:settings', guest, undefined, subframe);
    assert.ok(!unauthorized.returnValue);
    assert.equal(guest.audioMuted, false);
    harness.raw('player:changed', guest, { token, patch: { volume: 8, muted: true, playbackRate: 3 } }, subframe);
    harness.raw('player:gating', guest, { token, seq: 100 }, subframe);
    assert.equal(guest.audioMuted, false);
    assertPreferences(harness, expected);
    assert.equal(harness.broadcasts.length, 0);
    assert.equal(harness.clock.pending().length, 0);
    harness.send('player:gating', guest);
    assert.equal(guest.audioMuted, true);
    harness.raw('player:ready', guest, { token, seq: 1 }, subframe);
    assert.equal(guest.audioMuted, true);
    harness.send('player:ready', guest);
    assert.equal(guest.audioMuted, false);
  });

  check('player:changed 同步更新、广播并防抖保存，相同值不会反复写入', () => {
    const harness = createHarness();
    harness.registerIpc();
    const { guest } = attachGuest(harness);
    const patch = { volume: 23, muted: true, playbackRate: 2 };
    harness.send('player:changed', guest, patch);
    assertPreferences(harness, patch);
    assert.equal(harness.clock.pending().length, 1);
    assert.equal(harness.broadcasts.length, 1);
    assert.equal(harness.broadcasts[0].channel, 'settings:changed');
    assert.deepEqual(harness.broadcasts[0].payload, plain(harness.getSettings()));
    const scheduled = harness.clock.scheduled();
    harness.clock.advance(100);
    harness.send('player:changed', guest, patch);
    assert.equal(harness.clock.scheduled(), scheduled);
    assert.equal(harness.broadcasts.length, 1);
    harness.clock.advance(150);
    assert.deepEqual(harness.readRaw(), plain(harness.getSettings()));
  });

  check('player:changed 的单字段修改保留其他偏好，跨 P 获取仍返回最近值', () => {
    const harness = createHarness();
    harness.registerIpc();
    const { guest } = attachGuest(harness);
    harness.send('player:changed', guest, { volume: 47, playbackRate: 1.75 });
    harness.send('player:changed', guest, { muted: true });
    harness.send('player:changed', guest, { playbackRate: 2.25 });
    assertPreferences(harness, { volume: 47, muted: true, playbackRate: 2.25 });
    harness.send('player:ready', guest);
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    assert.equal(guest.audioMuted, true);
    const event = harness.send('player:settings', guest);
    assertBootstrap(event, { volume: 47, muted: true, playbackRate: 2.25 });
    assert.equal(guest.audioMuted, true);
    harness.send('player:ready', guest);
    assert.equal(guest.audioMuted, false);
  });

  check('settings:save 直接持久化并下发偏好，不依赖 guest 状态上报', () => {
    const harness = createHarness();
    harness.registerIpc();
    const { guest } = attachGuest(harness);
    harness.save({ volume: 41, muted: true, playbackRate: 1.5 });
    assertPreferences(harness, { volume: 41, muted: true, playbackRate: 1.5 });
    assert.deepEqual(guest.messages.at(-1), {
      channel: 'player', payload: { cmd: 'preferences', volume: 41, muted: true, playbackRate: 1.5 }
    });
    harness.save({ playbackRate: 2.5 });
    assertPreferences(harness, { volume: 41, muted: true, playbackRate: 2.5 });
    harness.save({ muted: false });
    assertPreferences(harness, { volume: 41, muted: false, playbackRate: 2.5 });
    harness.save({ muted: true });
    harness.save({ volume: 26 });
    assertPreferences(harness, { volume: 26, muted: false, playbackRate: 2.5 });
    harness.clock.advance(250);
    assert.deepEqual(harness.readRaw(), plain(harness.getSettings()));
  });

  check('无 guest 时修改也能立即退出保存，重载后新 guest 在播放前取回偏好', () => {
    const harness = createHarness();
    harness.registerIpc();
    harness.registerQuit();
    harness.save({ volume: 17, muted: true, playbackRate: 2.25 });
    harness.save({ lastPart: 6 });
    assertPreferences(harness, { volume: 17, muted: true, playbackRate: 2.25 });
    harness.quit();
    const restarted = createHarness({ userData: harness.userData });
    restarted.registerIpc();
    restarted.loadSettings();
    assert.equal(restarted.getSettings().lastPart, 6);
    const { guest } = attachGuest(restarted);
    assert.equal(guest.audioMuted, true);
    const event = restarted.send('player:settings', guest);
    assertBootstrap(event, { volume: 17, muted: true, playbackRate: 2.25 });
    assert.equal(guest.audioMuted, true);
    restarted.send('player:ready', guest);
    assert.equal(guest.audioMuted, false);
    assert.equal(harness.errors.length, 0);
    assert.equal(restarted.errors.length, 0);
  });

  check('长按倍率通过运行态下发，播放器回声不能覆盖常规倍速，松开不写临时值', () => {
    const harness = createHarness();
    harness.registerIpc();
    const { guest } = attachGuest(harness);
    harness.save({ playbackRate: 1.5, holdPlaybackRate: 2.5 });
    harness.clock.advance(250);
    harness.setHoldSpeed(true);
    assert.deepEqual(plain(harness.playbackState()), {
      volume: 100, muted: false, playbackRate: 1.5, holdActive: true, temporaryPlaybackRate: 2.5
    });
    assert.deepEqual(harness.broadcasts.findLast((message) => message.channel === 'playback:state'), {
      channel: 'playback:state',
      payload: { volume: 100, muted: false, playbackRate: 1.5, holdActive: true, temporaryPlaybackRate: 2.5 }
    });
    assert.deepEqual(guest.messages.at(-1), {
      channel: 'player',
      payload: { cmd: 'preferences', volume: 100, muted: false, playbackRate: 1.5, temporaryPlaybackRate: 2.5 }
    });
    assert.equal(harness.getSaveTimer(), null);
    assertBootstrap(harness.send('player:settings', guest), {
      volume: 100, muted: false, playbackRate: 1.5, temporaryPlaybackRate: 2.5
    });
    harness.send('player:changed', guest, { playbackRate: 2.5, volume: 24, muted: false });
    assertPreferences(harness, { volume: 24, muted: false, playbackRate: 1.5 });
    harness.save({ playbackRate: 1.25 });
    assert.deepEqual(guest.messages.at(-1).payload, {
      cmd: 'preferences', volume: 24, muted: false, playbackRate: 1.25, temporaryPlaybackRate: 2.5
    });
    harness.clock.advance(250);
    const saved = fs.readFileSync(harness.settingsPath, 'utf8');
    harness.cancelTemporarySpeed();
    assert.equal(harness.heldCancellations(), 1);
    assert.deepEqual(plain(harness.playbackState()), {
      volume: 24, muted: false, playbackRate: 1.25, holdActive: false, temporaryPlaybackRate: null
    });
    assert.deepEqual(guest.messages.at(-1).payload, {
      cmd: 'preferences', volume: 24, muted: false, playbackRate: 1.25
    });
    assert.equal(harness.getSaveTimer(), null);
    assert.equal(fs.readFileSync(harness.settingsPath, 'utf8'), saved);
    assert.equal(harness.readRaw().temporaryPlaybackRate, undefined);
    assert.equal(harness.readRaw().holdActive, undefined);
  });

  check('hover 与固定长按档位保存后重载，非法档位不能污染设置', () => {
    const harness = createHarness();
    harness.registerIpc();
    harness.save({ hoverFadeEnabled: false, holdPlaybackRate: 3 });
    assert.equal(harness.hoverSyncs(), 1);
    assert.equal(harness.getSettings().hoverFadeEnabled, false);
    assert.equal(harness.getSettings().holdPlaybackRate, 3);
    harness.save({ holdPlaybackRate: 9 });
    harness.save({ holdPlaybackRate: '2.5' });
    assert.equal(harness.getSettings().holdPlaybackRate, 3);
    harness.clock.advance(250);
    const restarted = createHarness({ userData: harness.userData });
    restarted.loadSettings();
    assert.equal(restarted.getSettings().hoverFadeEnabled, false);
    assert.equal(restarted.getSettings().holdPlaybackRate, 3);
    restarted.writeRaw({ holdPlaybackRate: 9, hoverFadeEnabled: 'false' });
    restarted.loadSettings();
    assert.equal(restarted.getSettings().holdPlaybackRate, 2);
    assert.equal(restarted.getSettings().hoverFadeEnabled, true);
  });

  check('退出取消长按并写常规倍率，沉浸状态仅进入访客快照', () => {
    const harness = createHarness();
    harness.registerIpc();
    harness.registerQuit();
    const { guest } = attachGuest(harness);
    harness.save({ playbackRate: 1.25, holdPlaybackRate: 3 });
    harness.setHoldSpeed(true);
    harness.setImmersion(true);
    assert.deepEqual(plain(harness.floatState()), { running: true, immersion: true, hoverFaded: false });
    assertBootstrap(harness.send('player:settings', guest), {
      volume: 100, muted: false, playbackRate: 1.25, temporaryPlaybackRate: 3, videoOnly: true
    });
    harness.quit();
    assert.equal(harness.heldCancellations(), 1);
    assert.equal(harness.playbackState().holdActive, false);
    assert.equal(harness.readRaw().playbackRate, 1.25);
    assert.equal(harness.readRaw().holdPlaybackRate, 3);
    assert.equal(harness.readRaw().immersion, undefined);
    assert.equal(harness.readRaw().temporaryPlaybackRate, undefined);
    assert.equal(harness.readRaw().holdActive, undefined);
  });
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('\n结果：' + passed + ' PASS / ' + failed + ' FAIL');
process.exitCode = failed ? 1 : 0;
