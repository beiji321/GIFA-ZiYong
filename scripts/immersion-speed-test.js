'use strict';

/* 沉浸、光标避让与常规 / 临时倍速的离线行为回归。
 * 从真实 main.js 提取函数，只使用模拟窗口、IPC、时钟与内存文件系统。
 * 不启动 Electron，不连接网络，不读取或写入任何用户配置。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { DEFAULT_GAMEPAD } = require('../src/gamepad-config');

const projectRoot = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(projectRoot, 'src', 'main.js'), 'utf8');
let passed = 0;
let failed = 0;

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

function extractRegistrations(source, pattern) {
  const registrations = [];
  for (const match of source.matchAll(pattern)) {
    let terminator = source.indexOf(');', match.index);
    while (terminator !== -1) {
      const candidate = source.slice(match.index, terminator + 2);
      try {
        new vm.Script(candidate);
        registrations.push(candidate);
        break;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      terminator = source.indexOf(');', terminator + 2);
    }
  }
  assert.ok(registrations.length, '找不到生命周期注册');
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
  let elapsed = 1_000_000;
  let sequence = 0;
  const timers = new Map();
  const schedule = (callback, delay, repeat) => {
    const timer = ++sequence;
    timers.set(timer, { callback, delay, repeat, dueAt: elapsed + delay });
    return timer;
  };
  return {
    now: () => elapsed,
    setTimeout: (callback, delay) => schedule(callback, delay, false),
    setInterval: (callback, delay) => schedule(callback, delay, true),
    clearTimer: (timer) => timers.delete(timer),
    pending: () => [...timers.values()],
    advance(milliseconds) {
      const target = elapsed + milliseconds;
      for (;;) {
        const ready = [...timers].filter(([, timer]) => timer.dueAt <= target)
          .sort((first, second) => first[1].dueAt - second[1].dueAt)[0];
        if (!ready) break;
        const [handle, timer] = ready;
        elapsed = timer.dueAt;
        if (timer.repeat) timer.dueAt += timer.delay;
        else timers.delete(handle);
        timer.callback();
      }
      elapsed = target;
    }
  };
}

function createWindow(options = {}) {
  const window = new EventEmitter();
  window.destroyed = false;
  window.visible = options.visible !== false;
  window.minimized = !!options.minimized;
  window.bounds = { x: 120, y: 70, width: 896, height: 568, ...options.bounds };
  window.opacity = options.opacity ?? 0.65;
  window.resizable = true;
  window.movable = true;
  window.mouseThrough = false;
  window.calls = [];
  window.messages = [];
  window.webContents = new EventEmitter();
  window.webContents.send = (channel, payload) => window.messages.push({ channel, payload: plain(payload) });
  window.isDestroyed = () => window.destroyed;
  window.isVisible = () => window.visible;
  window.isMinimized = () => window.minimized;
  window.getBounds = () => ({ ...window.bounds });
  window.setBounds = (bounds) => {
    window.calls.push({ method: 'setBounds', value: { ...bounds } });
    Object.assign(window.bounds, bounds);
  };
  function applyStyleBoundsChange(method) {
    const delta = options.styleBoundsDeltas?.[method];
    if (!delta) return;
    for (const key of ['x', 'y', 'width', 'height']) window.bounds[key] += delta[key] || 0;
    window.calls.push({ method: 'nativeStyleBoundsChange', trigger: method, value: { ...window.bounds } });
  }
  window.setResizable = (value) => {
    if (window.resizable !== value) applyStyleBoundsChange('setResizable');
    window.resizable = value;
    window.calls.push({ method: 'setResizable', value });
  };
  window.setMovable = (value) => {
    if (window.movable !== value) applyStyleBoundsChange('setMovable');
    window.movable = value;
    window.calls.push({ method: 'setMovable', value });
  };
  window.setIgnoreMouseEvents = (value, settings) => {
    window.mouseThrough = value;
    window.calls.push({ method: 'setIgnoreMouseEvents', value, settings: plain(settings) });
  };
  window.setOpacity = (value) => { window.opacity = value; window.calls.push({ method: 'setOpacity', value }); };
  window.setAlwaysOnTop = (...values) => window.calls.push({ method: 'setAlwaysOnTop', values });
  window.setVisibleOnAllWorkspaces = () => {};
  window.loadFile = () => Promise.resolve();
  window.restore = () => { window.minimized = false; window.calls.push({ method: 'restore' }); };
  window.showInactive = () => { window.visible = true; window.calls.push({ method: 'showInactive' }); };
  window.hide = () => { window.visible = false; window.calls.push({ method: 'hide' }); };
  window.close = () => { window.destroyed = true; window.emit('closed'); };
  window.destroy = window.close;
  return window;
}

function createGuest(host) {
  const guest = new EventEmitter();
  guest.hostWebContents = host;
  guest.mainFrame = {};
  guest.destroyed = false;
  guest.messages = [];
  guest.isDestroyed = () => guest.destroyed;
  guest.send = (channel, payload) => guest.messages.push({ channel, payload: plain(payload) });
  guest.setAudioMuted = (value) => { guest.audioMuted = value; };
  return guest;
}

function createHarness(options = {}) {
  const clock = createClock();
  const createdWindows = [];
  const launcher = createWindow();
  const initialWindow = options.withWindow === false ? null : createWindow(options.window);
  const handlers = new Map();
  const listeners = new Map();
  const fileWrites = [];
  const files = new Map();
  const powerEvents = new EventEmitter();
  const appEvents = new EventEmitter();
  let cursor = { x: -5000, y: -5000 };
  let cancelledHolds = 0;
  let hookRearms = 0;
  const mockFileSystem = {
    mkdirSync() {},
    writeFileSync(file, content) { files.set(file, String(content)); fileWrites.push(String(content)); },
    readFileSync() { throw new Error('测试不得读取用户配置'); }
  };
  const context = vm.createContext({
    __dirname: path.join(projectRoot, 'src'),
    path,
    fs: mockFileSystem,
    structuredClone,
    initialWindow,
    initialLauncher: launcher,
    initialSettings: options.settings || {},
    BrowserWindow: function BrowserWindow(windowOptions) {
      const window = createWindow({ bounds: windowOptions });
      createdWindows.push(window);
      return window;
    },
    app: { getPath: () => 'mock-user-data', on: (event, callback) => appEvents.on(event, callback) },
    powerMonitor: { on: (event, callback) => powerEvents.on(event, callback) },
    globalShortcut: { unregisterAll() {} },
    hookHotkeys: {
      cancelHeld: () => { cancelledHolds += 1; },
      rearm: () => { hookRearms += 1; },
      apply() {}
    },
    screen: { getCursorScreenPoint: () => ({ ...cursor }) },
    ipcMain: {
      handle: (channel, callback) => handlers.set(channel, callback),
      on: (channel, callback) => listeners.set(channel, callback)
    },
    setTimeout: clock.setTimeout,
    setInterval: clock.setInterval,
    clearTimeout: clock.clearTimer,
    clearInterval: clock.clearTimer,
    Date: class MockDate extends Date { static now() { return clock.now(); } },
    console,
    clampBounds: (bounds) => ({ ...bounds }),
    // DEFAULT_SETTINGS 现在带 gamepad 分区，出厂值取自真实模块，不在这里重抄一遍
    DEFAULT_GAMEPAD,
    resetGamepadSession() {},
    stopGamepadPoller() {},
    gamepadPauses: new Set(),
    overlayWin: null
  });
  const declarations = [
    ...['DEFAULT_HOTKEYS', 'PLAYBACK_RATES', 'HOLD_PLAYBACK_RATES', 'DEFAULT_SETTINGS'].map((name) => extractConstant(mainSource, name)),
    'let settings = { ...structuredClone(DEFAULT_SETTINGS), opacity: 0.65, ...initialSettings };',
    'let win = initialWindow;',
    'let consoleWin = initialLauncher;',
    'let playbackGuest = null;',
    'let playbackToken = 0;',
    'let playbackGate = 0;',
    'let saveTimer = null;',
    'let holdSpeedActive = false;',
    'const holdSpeedSources = new Set();',
    'let immersion = false;',
    'let hoverFaded = false;',
    'let hoverTimer = null;',
    'let hoverCandidate = false;',
    'let hoverCandidateAt = 0;',
    ...[
      'settingsFile', 'flushSettings', 'persist', 'playbackSettings', 'updatePlaybackSettings',
      'isPlaybackGuest', 'isPlaybackMessage', 'playbackState', 'guestPlaybackSettings',
      'publishPlaybackSettings', 'showNotice', 'cyclePlaybackRate', 'setHoldSpeed', 'cancelTemporarySpeed',
      'applyPin', 'createWindow', 'sendTo', 'broadcast', 'floatState', 'notifyFloatState',
      'applyWindowPresentation', 'updateHoverFade', 'syncHoverFade', 'setImmersion', 'registerIpc'
    ].map((name) => extractFunction(mainSource, name)),
    `globalThis.testApi = {
      createWindow, setImmersion, syncHoverFade, updateHoverFade, cyclePlaybackRate,
      setHoldSpeed, cancelTemporarySpeed, guestPlaybackSettings, playbackState, registerIpc,
      getSettings: () => settings,
      getWindow: () => win,
      setWindow: (window) => { win = window; },
      getState: () => ({ immersion, hoverFaded, holdSpeedActive, hoverTimer, hoverCandidate, hoverCandidateAt }),
      setGuest: (guest) => { playbackGuest = guest; },
      constants: { PLAYBACK_RATES, HOLD_PLAYBACK_RATES },
      savedFile: () => settingsFile()
    };`
  ];
  vm.runInContext(declarations.join('\n\n'), context, { filename: 'immersion-speed-main-harness.js' });
  const api = context.testApi;
  return {
    ...api,
    clock,
    launcher,
    createdWindows,
    fileWrites,
    files,
    cancelledHolds: () => cancelledHolds,
    hookRearms: () => hookRearms,
    moveCursor: (point) => { cursor = { ...point }; },
    attachGuest() {
      const guest = createGuest(api.getWindow().webContents);
      api.setGuest(guest);
      return guest;
    },
    send(channel, guest, message) {
      assert.ok(listeners.has(channel), '缺少真实 IPC ' + channel);
      const event = { sender: guest, senderFrame: guest.mainFrame, returnValue: undefined };
      listeners.get(channel)(event, message);
      return event.returnValue;
    },
    save(patch) {
      assert.ok(handlers.has('settings:save'), '缺少真实 settings:save');
      return handlers.get('settings:save')({}, patch);
    },
    registerPowerRecovery() {
      vm.runInContext(extractRegistrations(mainSource, /powerMonitor\.on\(/g), context);
    },
    power: (event) => powerEvents.emit(event),
    registerQuit() {
      vm.runInContext(extractRegistrations(mainSource, /app\.on\('will-quit',/g), context);
    },
    quit: () => appEvents.emit('will-quit')
  };
}

function lastPreferences(guest) {
  return guest.messages.filter((message) => message.channel === 'player' && message.payload.cmd === 'preferences').at(-1)?.payload;
}

function notices(harness) {
  return harness.launcher.messages.filter((message) => message.channel === 'app:notice').map((message) => message.payload);
}

function assertNoPersistence(harness) {
  assert.equal(harness.fileWrites.length, 0, '临时显示或临时倍速不得写设置文件');
  assert.equal(harness.clock.pending().filter((timer) => !timer.repeat).length, 0, '临时操作不得排队保存设置');
}

function settleHover(harness, point) {
  harness.moveCursor(point);
  harness.updateHoverFade();
  harness.clock.advance(120);
  harness.updateHoverFade();
}

console.log('沉浸 / 倍速离线回归：真实函数、模拟窗口 / IPC / 时钟、内存文件系统');

check('档位常量来自真实源码，常规与长按档位分别受约束', () => {
  const harness = createHarness();
  assert.deepEqual(plain(harness.constants.PLAYBACK_RATES), [1, 1.25, 1.5, 2]);
  assert.deepEqual(plain(harness.constants.HOLD_PLAYBACK_RATES), [1.25, 1.5, 2, 2.5, 3]);
});

check('进入沉浸保持窗口与保存 bounds，锁定移动缩放并强制鼠标穿透', () => {
  const harness = createHarness();
  const window = harness.getWindow();
  const originalBounds = window.getBounds();
  const settingsBefore = plain(harness.getSettings());
  const guest = harness.attachGuest();
  assert.equal(harness.setImmersion(true), true);
  assert.deepEqual(window.getBounds(), originalBounds);
  assert.deepEqual(plain(harness.getSettings()), settingsBefore);
  assert.equal(window.calls.filter((call) => call.method === 'setBounds').length, 0);
  assert.equal(window.resizable, false);
  assert.equal(window.movable, false);
  assert.equal(window.mouseThrough, true);
  assert.deepEqual(window.calls.filter((call) => call.method === 'setIgnoreMouseEvents').at(-1).settings, { forward: true });
  assert.ok(window.messages.some((message) => message.channel === 'win:state' && message.payload.immersion === true));
  assert.ok(guest.messages.some((message) => message.payload.cmd === 'presentation' && message.payload.videoOnly === true));
  assert.ok(notices(harness).some((notice) => notice.includes('沉浸')));
  assertNoPersistence(harness);
});

check('退出沉浸恢复保存的穿透和透明度，恢复移动缩放且不改变 bounds', () => {
  for (const clickThrough of [false, true]) {
    const harness = createHarness({ settings: { clickThrough, opacity: 0.72 } });
    const window = harness.getWindow();
    const bounds = window.getBounds();
    harness.setImmersion(true);
    settleHover(harness, { x: bounds.x + 20, y: bounds.y + 20 });
    assert.equal(window.opacity, 0.1);
    assert.equal(harness.setImmersion(false), false);
    assert.equal(window.opacity, 0.72);
    assert.equal(window.mouseThrough, clickThrough);
    assert.equal(window.resizable, true);
    assert.equal(window.movable, true);
    assert.deepEqual(window.getBounds(), bounds);
    assert.equal(harness.clock.pending().length, 0);
    assert.equal(harness.getState().hoverFaded, false);
    assertNoPersistence(harness);
  }
});

check('开启沉浸会显示隐藏窗口，已有位置和大小保持不变', () => {
  const harness = createHarness({ window: { visible: false } });
  const window = harness.getWindow();
  const bounds = window.getBounds();
  assert.equal(window.isVisible(), false);
  assert.equal(harness.setImmersion(true), true);
  assert.equal(window.isVisible(), true);
  assert.equal(window.calls.filter((call) => call.method === 'showInactive').length, 1);
  assert.equal(window.resizable, false);
  assert.equal(window.movable, false);
  assert.equal(window.mouseThrough, true);
  assert.deepEqual(window.getBounds(), bounds);
  assert.equal(window.calls.filter((call) => call.method === 'setBounds').length, 0);
  assertNoPersistence(harness);
});

check('开启沉浸会恢复最小化窗口，再显示隐藏窗口，保持原 bounds', () => {
  const harness = createHarness({ window: { minimized: true, visible: false } });
  const window = harness.getWindow();
  const bounds = window.getBounds();
  assert.equal(harness.setImmersion(true), true);
  assert.equal(window.isMinimized(), false);
  assert.equal(window.isVisible(), true);
  const restoreIndex = window.calls.findIndex((call) => call.method === 'restore');
  const showIndex = window.calls.findIndex((call) => call.method === 'showInactive');
  assert.ok(restoreIndex >= 0 && showIndex > restoreIndex, '先恢复最小化，再显示隐藏窗口');
  assert.equal(window.resizable, false);
  assert.equal(window.movable, false);
  assert.deepEqual(window.getBounds(), bounds);
  assert.equal(window.calls.filter((call) => call.method === 'setBounds').length, 0);
  assertNoPersistence(harness);
});

check('Windows 样式切换导致 bounds 变化时，进入和退出都恢复原矩形', () => {
  const harness = createHarness({ window: { bounds: { x: -1720, y: -200, width: 896, height: 568 },
    styleBoundsDeltas: { setResizable: { x: -8, y: -8, width: 16, height: 16 },
      setMovable: { x: 1, y: 2, width: -2, height: -4 } } } });
  const window = harness.getWindow();
  const bounds = window.getBounds();
  const settingsBefore = plain(harness.getSettings());
  for (const active of [true, false]) {
    const callsBefore = window.calls.length;
    harness.setImmersion(active);
    const calls = window.calls.slice(callsBefore);
    assert.equal(calls.filter((call) => call.method === 'nativeStyleBoundsChange').length, 2,
      '测试必须模拟到两种窗口样式引起的边框变化');
    const restores = calls.filter((call) => call.method === 'setBounds');
    assert.equal(restores.length, 1, '一轮样式切换后只恢复一次 bounds');
    assert.deepEqual(restores[0].value, bounds);
    assert.ok(calls.findIndex((call) => call.method === 'setBounds') >
      calls.findIndex((call) => call.method === 'setMovable'), '两种样式设置后再恢复矩形');
    assert.deepEqual(window.getBounds(), bounds);
    assert.deepEqual(plain(harness.getSettings()), settingsBefore);
  }
  assertNoPersistence(harness);
});

check('重复切换同一沉浸状态幂等，无浮窗进入时通过真实创建函数启动窗口', () => {
  const harness = createHarness({ withWindow: false });
  assert.equal(harness.setImmersion(false), false);
  assert.equal(harness.createdWindows.length, 0);
  assert.equal(harness.setImmersion(true), true);
  assert.equal(harness.createdWindows.length, 1);
  const calls = harness.getWindow().calls.length;
  const timers = harness.clock.pending().length;
  assert.equal(harness.setImmersion(true), true);
  assert.equal(harness.getWindow().calls.length, calls);
  assert.equal(harness.clock.pending().length, timers);
  assert.equal(harness.getWindow().resizable, false);
  assert.equal(harness.getWindow().movable, false);
});

check('悬停进入和离开均经过 120ms 防抖，透明度变 0.1 后恢复且不落盘', () => {
  const harness = createHarness({ settings: { opacity: 0.78 } });
  const window = harness.getWindow();
  const settingsBefore = plain(harness.getSettings());
  harness.setImmersion(true);
  assert.equal(harness.clock.pending()[0].delay, 60);
  harness.moveCursor({ x: window.bounds.x + 20, y: window.bounds.y + 20 });
  harness.updateHoverFade();
  harness.clock.advance(119);
  harness.updateHoverFade();
  assert.equal(window.opacity, 0.78, '进入 119ms 不应提前变淡');
  harness.clock.advance(1);
  harness.updateHoverFade();
  assert.equal(window.opacity, 0.1);
  harness.moveCursor({ x: -5000, y: -5000 });
  harness.updateHoverFade();
  harness.clock.advance(119);
  harness.updateHoverFade();
  assert.equal(window.opacity, 0.1, '离开 119ms 不应提前恢复');
  harness.clock.advance(1);
  harness.updateHoverFade();
  assert.equal(window.opacity, 0.78);
  assert.deepEqual(plain(harness.getSettings()), settingsBefore);
  assertNoPersistence(harness);
});

check('边缘抖动会重置候选计时，不累计多次短暂进入', () => {
  const harness = createHarness();
  const window = harness.getWindow();
  const inside = { x: window.bounds.x + 1, y: window.bounds.y + 1 };
  harness.setImmersion(true);
  harness.moveCursor(inside);
  harness.updateHoverFade();
  harness.clock.advance(80);
  harness.moveCursor({ x: -5000, y: -5000 });
  harness.updateHoverFade();
  harness.clock.advance(20);
  harness.moveCursor(inside);
  harness.updateHoverFade();
  harness.clock.advance(119);
  harness.updateHoverFade();
  assert.equal(window.opacity, 0.65);
  harness.clock.advance(1);
  harness.updateHoverFade();
  assert.equal(window.opacity, 0.1);
  assertNoPersistence(harness);
});

check('悬停只在沉浸、开关开启、窗口可见且非最小化时生效', () => {
  const cases = [
    { immersion: false },
    { immersion: true, settings: { hoverFadeEnabled: false } },
    { immersion: true, hiddenAfterEntry: true },
    { immersion: true, minimizedAfterEntry: true }
  ];
  for (const scenario of cases) {
    const harness = createHarness(scenario);
    if (scenario.immersion) harness.setImmersion(true);
    const window = harness.getWindow();
    if (scenario.hiddenAfterEntry) window.visible = false;
    if (scenario.minimizedAfterEntry) window.minimized = true;
    settleHover(harness, { x: window.bounds.x + 20, y: window.bounds.y + 20 });
    assert.equal(window.opacity, 0.65, JSON.stringify(scenario));
    assert.equal(harness.getState().hoverFaded, false);
    assertNoPersistence(harness);
  }
});

check('已经变淡后隐藏或最小化会恢复，重新显示仍经过防抖', () => {
  for (const condition of ['hidden', 'minimized']) {
    const harness = createHarness({ settings: { opacity: 0.69 } });
    const window = harness.getWindow();
    const inside = { x: window.bounds.x + 20, y: window.bounds.y + 20 };
    harness.setImmersion(true);
    settleHover(harness, inside);
    assert.equal(window.opacity, 0.1);
    if (condition === 'hidden') window.visible = false;
    else window.minimized = true;
    harness.updateHoverFade();
    harness.clock.advance(120);
    harness.updateHoverFade();
    assert.equal(window.opacity, 0.69, condition);
    assert.equal(harness.getState().hoverFaded, false);
    window.visible = true;
    window.minimized = false;
    harness.updateHoverFade();
    harness.clock.advance(119);
    harness.updateHoverFade();
    assert.equal(window.opacity, 0.69);
    harness.clock.advance(1);
    harness.updateHoverFade();
    assert.equal(window.opacity, 0.1);
    assertNoPersistence(harness);
  }
});

check('沉浸期间常规透明度与穿透设置改变，退出恢复最新设置', () => {
  const harness = createHarness({ settings: { clickThrough: false, opacity: 0.65 } });
  const window = harness.getWindow();
  const bounds = window.getBounds();
  harness.setImmersion(true);
  settleHover(harness, { x: bounds.x + 20, y: bounds.y + 20 });
  harness.getSettings().opacity = 0.88;
  harness.getSettings().clickThrough = true;
  harness.setImmersion(false);
  assert.equal(window.opacity, 0.88);
  assert.equal(window.mouseThrough, true);
  assert.deepEqual(window.getBounds(), bounds);
  assert.equal(window.calls.filter((call) => call.method === 'setBounds').length, 0);
  assertNoPersistence(harness);
});

check('负坐标副屏使用左上含、右下不含的矩形边界判断', () => {
  const harness = createHarness({ window: { bounds: { x: -1920, y: -1080, width: 640, height: 360 } } });
  const window = harness.getWindow();
  harness.setImmersion(true);
  settleHover(harness, { x: -1920, y: -1080 });
  assert.equal(window.opacity, 0.1);
  settleHover(harness, { x: -1280, y: -900 });
  assert.equal(window.opacity, 0.65, '右边界不在窗口内');
  settleHover(harness, { x: -1281, y: -721 });
  assert.equal(window.opacity, 0.1);
  settleHover(harness, { x: -1500, y: -720 });
  assert.equal(window.opacity, 0.65, '下边界不在窗口内');
  settleHover(harness, { x: -1921, y: -1080 });
  assert.equal(window.opacity, 0.65, '左边界外不在窗口内');
  assertNoPersistence(harness);
});

check('syncHoverFade 关开关立即恢复保存透明度并清理 timer，再开启重新防抖', () => {
  const harness = createHarness({ settings: { opacity: 0.83 } });
  const window = harness.getWindow();
  const inside = { x: window.bounds.x + 20, y: window.bounds.y + 20 };
  harness.setImmersion(true);
  settleHover(harness, inside);
  assert.equal(window.opacity, 0.1);
  harness.getSettings().hoverFadeEnabled = false;
  harness.syncHoverFade();
  assert.equal(window.opacity, 0.83);
  assert.equal(harness.clock.pending().length, 0);
  assert.equal(harness.getState().hoverFaded, false);
  harness.getSettings().hoverFadeEnabled = true;
  harness.syncHoverFade();
  assert.equal(window.opacity, 0.83);
  harness.updateHoverFade();
  harness.clock.advance(119);
  harness.updateHoverFade();
  assert.equal(window.opacity, 0.83);
  harness.clock.advance(1);
  harness.updateHoverFade();
  assert.equal(window.opacity, 0.1);
  assert.equal(harness.getSettings().opacity, 0.83);
  assertNoPersistence(harness);
});

check('cyclePlaybackRate 严格按 1 / 1.25 / 1.5 / 2 循环并持久化和发 notice', () => {
  const harness = createHarness({ settings: { playbackRate: 1 } });
  const guest = harness.attachGuest();
  for (const expected of [1.25, 1.5, 2, 1, 1.25]) {
    assert.equal(harness.cyclePlaybackRate(), expected);
    assert.equal(harness.getSettings().playbackRate, expected);
    assert.equal(lastPreferences(guest).playbackRate, expected);
    assert.equal('temporaryPlaybackRate' in lastPreferences(guest), false);
    harness.clock.advance(250);
    const saved = JSON.parse(harness.files.get(harness.savedFile()));
    assert.equal(saved.playbackRate, expected);
    assert.ok(notices(harness).at(-1).includes(String(expected) + '×'));
    assert.ok(harness.launcher.messages.some((message) => message.channel === 'settings:changed' && message.payload.playbackRate === expected));
  }
  assert.equal(harness.fileWrites.length, 5);
});

check('无浮窗也可循环并保存，非循环档位先回到 1 倍', () => {
  const harness = createHarness({ withWindow: false, settings: { playbackRate: 1.75 } });
  assert.equal(harness.cyclePlaybackRate(), 1);
  harness.clock.advance(250);
  assert.equal(JSON.parse(harness.files.get(harness.savedFile())).playbackRate, 1);
  assert.ok(notices(harness).at(-1).includes('1×'));
  assert.equal(harness.createdWindows.length, 0);
});

check('长按只发布临时倍率，重复 down 幂等，松开恢复常规且不修改设置或 fs', () => {
  const harness = createHarness({ settings: { playbackRate: 1.5, holdPlaybackRate: 2.5, volume: 31, muted: true } });
  const guest = harness.attachGuest();
  const settingsBefore = plain(harness.getSettings());
  harness.setHoldSpeed(true);
  assert.equal(harness.getState().holdSpeedActive, true);
  assert.equal(lastPreferences(guest).playbackRate, 1.5);
  assert.equal(lastPreferences(guest).temporaryPlaybackRate, 2.5);
  const published = guest.messages.length;
  harness.setHoldSpeed(true);
  assert.equal(guest.messages.length, published);
  harness.setHoldSpeed(false);
  assert.equal(harness.getState().holdSpeedActive, false);
  assert.equal(lastPreferences(guest).playbackRate, 1.5);
  assert.equal('temporaryPlaybackRate' in lastPreferences(guest), false);
  assert.deepEqual(plain(harness.getSettings()), settingsBefore);
  harness.clock.advance(1000);
  assertNoPersistence(harness);
});

check('无有效浮窗不进入临时加速，也不污染常规倍率', () => {
  for (const missing of [true, false]) {
    const harness = createHarness({ withWindow: !missing, settings: { playbackRate: 1.25 } });
    if (!missing) harness.getWindow().destroyed = true;
    harness.setHoldSpeed(true);
    assert.equal(harness.getState().holdSpeedActive, false);
    assert.deepEqual(plain(harness.guestPlaybackSettings()), { volume: 100, muted: false, playbackRate: 1.25 });
    assertNoPersistence(harness);
  }
});

check('长按期间循环常规倍率只改变恢复目标，松开回到最新常规倍率', () => {
  const harness = createHarness({ settings: { playbackRate: 1.25, holdPlaybackRate: 3 } });
  const guest = harness.attachGuest();
  harness.setHoldSpeed(true);
  assert.equal(harness.cyclePlaybackRate(), 1.5);
  assert.equal(lastPreferences(guest).temporaryPlaybackRate, 3);
  assert.equal(harness.cyclePlaybackRate(), 2);
  assert.equal(lastPreferences(guest).temporaryPlaybackRate, 3);
  harness.clock.advance(250);
  const saved = JSON.parse(harness.files.get(harness.savedFile()));
  assert.equal(saved.playbackRate, 2);
  assert.equal('temporaryPlaybackRate' in saved, false);
  assert.equal('holdActive' in saved, false);
  harness.setHoldSpeed(false);
  assert.equal(lastPreferences(guest).playbackRate, 2);
  assert.equal('temporaryPlaybackRate' in lastPreferences(guest), false);
});

check('guestPlaybackSettings 默认严格三个字段，长按才附加 temporaryPlaybackRate', () => {
  const harness = createHarness({ settings: { volume: 42, muted: true, playbackRate: 1.25, holdPlaybackRate: 2.5 } });
  assert.deepEqual(plain(harness.guestPlaybackSettings()), { volume: 42, muted: true, playbackRate: 1.25 });
  harness.setHoldSpeed(true);
  assert.deepEqual(plain(harness.guestPlaybackSettings()), { volume: 42, muted: true, playbackRate: 1.25, temporaryPlaybackRate: 2.5 });
  harness.setHoldSpeed(false);
  assert.deepEqual(plain(harness.guestPlaybackSettings()), { volume: 42, muted: true, playbackRate: 1.25 });
});

check('player:settings bootstrap 传常规值、临时值和沉浸 videoOnly 契约', () => {
  const harness = createHarness({ settings: { playbackRate: 1.5, holdPlaybackRate: 2.5 } });
  const guest = harness.attachGuest();
  harness.registerIpc();
  const normal = plain(harness.send('player:settings', guest));
  assert.ok(Number.isSafeInteger(normal.token));
  const { token, ...normalPreferences } = normal;
  assert.deepEqual(normalPreferences, { volume: 100, muted: false, playbackRate: 1.5 });
  harness.setHoldSpeed(true);
  harness.setImmersion(true);
  const active = plain(harness.send('player:settings', guest));
  assert.ok(active.token > token);
  assert.deepEqual(active, { volume: 100, muted: false, playbackRate: 1.5, temporaryPlaybackRate: 2.5, videoOnly: true, token: active.token });
  harness.setHoldSpeed(false);
  harness.setImmersion(false);
  const restored = plain(harness.send('player:settings', guest));
  assert.equal('temporaryPlaybackRate' in restored, false);
  assert.equal('videoOnly' in restored, false);
});

check('player:changed 在长按时忽略 rate 回声，但仍保存音量和静音', () => {
  const harness = createHarness({ settings: { playbackRate: 1.25, holdPlaybackRate: 3, volume: 40 } });
  const guest = harness.attachGuest();
  harness.registerIpc();
  harness.setHoldSpeed(true);
  const boot = harness.send('player:settings', guest);
  const response = harness.send('player:changed', guest, { token: boot.token, patch: { playbackRate: 3, volume: 23, muted: true } });
  assert.equal(harness.getSettings().playbackRate, 1.25);
  assert.equal(harness.getSettings().volume, 23);
  assert.equal(harness.getSettings().muted, true);
  assert.deepEqual(plain(response), { volume: 23, muted: true, playbackRate: 1.25, temporaryPlaybackRate: 3 });
  harness.clock.advance(250);
  const saved = JSON.parse(harness.files.get(harness.savedFile()));
  assert.equal(saved.playbackRate, 1.25);
  assert.equal(saved.volume, 23);
  harness.setHoldSpeed(false);
  harness.send('player:changed', guest, { token: boot.token, patch: { playbackRate: 1.5 } });
  assert.equal(harness.getSettings().playbackRate, 1.5);
});

check('只有临时 rate 回声不排队保存或广播常规设置', () => {
  const harness = createHarness({ settings: { playbackRate: 1.5, holdPlaybackRate: 3 } });
  const guest = harness.attachGuest();
  harness.registerIpc();
  harness.setHoldSpeed(true);
  const boot = harness.send('player:settings', guest);
  const response = harness.send('player:changed', guest, { token: boot.token, patch: { playbackRate: 3 } });
  assert.equal(response.playbackRate, 1.5);
  assert.equal(response.temporaryPlaybackRate, 3);
  assert.equal(harness.launcher.messages.filter((message) => message.channel === 'settings:changed').length, 0);
  assertNoPersistence(harness);
});

check('长按中改 holdPlaybackRate 立即下发新临时值，常规倍率保持不变', () => {
  const harness = createHarness({ settings: { playbackRate: 1.5, holdPlaybackRate: 2 } });
  const guest = harness.attachGuest();
  harness.registerIpc();
  harness.setHoldSpeed(true);
  harness.save({ holdPlaybackRate: 2.5 });
  assert.equal(harness.getSettings().playbackRate, 1.5);
  assert.equal(harness.getSettings().holdPlaybackRate, 2.5);
  assert.equal(lastPreferences(guest).temporaryPlaybackRate, 2.5);
  harness.clock.advance(250);
  assert.equal(JSON.parse(harness.files.get(harness.savedFile())).playbackRate, 1.5);
  assert.equal(JSON.parse(harness.files.get(harness.savedFile())).holdPlaybackRate, 2.5);
  harness.save({ holdPlaybackRate: 99 });
  assert.equal(harness.getSettings().holdPlaybackRate, 2.5);
  assert.equal(lastPreferences(guest).temporaryPlaybackRate, 2.5);
  harness.setHoldSpeed(false);
  assert.equal(lastPreferences(guest).playbackRate, 1.5);
});

check('设置 IPC 关闭悬停开关即时恢复透明度，重开重新检测', () => {
  const harness = createHarness({ settings: { opacity: 0.76 } });
  const window = harness.getWindow();
  harness.registerIpc();
  harness.setImmersion(true);
  settleHover(harness, { x: window.bounds.x + 20, y: window.bounds.y + 20 });
  assert.equal(window.opacity, 0.1);
  harness.save({ hoverFadeEnabled: false });
  assert.equal(window.opacity, 0.76);
  assert.equal(harness.getState().hoverTimer, null);
  assert.equal(harness.getSettings().opacity, 0.76);
  harness.save({ hoverFadeEnabled: true });
  assert.ok(harness.getState().hoverTimer);
  assert.equal(window.opacity, 0.76);
});

check('cancelTemporarySpeed 同时恢复倍率和取消 hook 的 held 状态', () => {
  const harness = createHarness({ settings: { playbackRate: 1.25, holdPlaybackRate: 2.5 } });
  const guest = harness.attachGuest();
  harness.setHoldSpeed(true);
  harness.cancelTemporarySpeed();
  assert.equal(harness.cancelledHolds(), 1);
  assert.equal(harness.getState().holdSpeedActive, false);
  assert.equal(lastPreferences(guest).playbackRate, 1.25);
  assert.equal('temporaryPlaybackRate' in lastPreferences(guest), false);
  harness.cancelTemporarySpeed();
  assert.equal(harness.cancelledHolds(), 2);
  assertNoPersistence(harness);
});

check('真实窗口 closed 回调清理临时倍速、沉浸与悬停 timer', () => {
  const harness = createHarness({ withWindow: false, settings: { playbackRate: 1.5, holdPlaybackRate: 3 } });
  harness.createWindow();
  const window = harness.getWindow();
  const guest = harness.attachGuest();
  const settingsBefore = plain(harness.getSettings());
  harness.setImmersion(true);
  harness.setHoldSpeed(true);
  window.close();
  assert.equal(harness.getWindow(), null);
  assert.equal(harness.getState().holdSpeedActive, false);
  assert.equal(harness.getState().immersion, false);
  assert.equal(harness.getState().hoverFaded, false);
  assert.equal(harness.getState().hoverTimer, null);
  assert.equal(harness.cancelledHolds(), 1);
  assert.equal('temporaryPlaybackRate' in lastPreferences(guest), false);
  assert.deepEqual(plain(harness.getSettings()), settingsBefore);
  assertNoPersistence(harness);
});

check('渲染进程退出时取消临时倍速并恢复可操作窗口', () => {
  const harness = createHarness({ withWindow: false });
  harness.createWindow();
  const window = harness.getWindow();
  harness.setImmersion(true);
  harness.setHoldSpeed(true);
  window.webContents.emit('render-process-gone');
  assert.equal(harness.getState().holdSpeedActive, false);
  assert.equal(harness.getState().immersion, false);
  assert.equal(window.mouseThrough, false);
  assert.equal(window.resizable, true);
  assert.equal(window.movable, true);
  assert.equal(harness.cancelledHolds(), 1);
  assertNoPersistence(harness);
});

check('系统休眠、锁屏和恢复执行真实取消回调，恢复时重挂 hook', () => {
  const harness = createHarness();
  harness.registerPowerRecovery();
  for (const event of ['suspend', 'lock-screen', 'resume']) {
    harness.setHoldSpeed(true);
    assert.equal(harness.getState().holdSpeedActive, true);
    harness.power(event);
    assert.equal(harness.getState().holdSpeedActive, false, event);
  }
  assert.equal(harness.cancelledHolds(), 3);
  assert.equal(harness.hookRearms(), 1);
  assertNoPersistence(harness);
});

console.log('\n结果：' + passed + ' PASS / ' + failed + ' FAIL');
process.exitCode = failed ? 1 : 0;
