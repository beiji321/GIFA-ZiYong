'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const config = require('../src/gamepad-config');

const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8').replace(/\r\n/g, '\n');
const extract = (name) => {
  const match = new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^\\}`, 'm').exec(main);
  assert.ok(match, `missing ${name}`);
  return match[0];
};
const disc = main.slice(main.indexOf('let discWin = null;'), main.indexOf('/* -------------------------------------------------------------- 全局热键 */'));
const power = main.slice(main.indexOf("    powerMonitor.on('suspend'"), main.indexOf('\n\n    loadSettings();'));

function harness() {
  const windows = [];
  const actions = [];
  const pollerCalls = [];
  const deviceUpdates = [];
  const powerMonitor = new EventEmitter();
  class FakeDisc extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.destroyed = false;
      this.loading = true;
      this.shows = 0;
      this.messages = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, payload) => {
        assert.equal(channel, 'disc:ui');
        this.messages.push(payload);
      };
      this.webContents.isLoading = () => this.loading;
      windows.push(this);
    }
    setIgnoreMouseEvents(on) { this.mouseThrough = on; }
    setAlwaysOnTop() {}
    setBounds() {}
    isDestroyed() { return this.destroyed; }
    loadFile() { return new Promise((_resolve, reject) => { this.rejectLoad = reject; }); }
    finish() {
      this.loading = false;
      this.webContents.emit('did-finish-load');
      this.emit('ready-to-show');
    }
    showInactive() { this.visible = true; this.shows += 1; }
    hide() { this.visible = false; }
    destroy() { this.destroyed = true; this.visible = false; this.emit('closed'); }
  }
  const settings = config.mergeGamepadSettings(undefined, { map: { e: 'holdSpeed' } });
  const context = vm.createContext({
    ...config,
    __dirname: path.join(__dirname, '../src'),
    path,
    console: { warn() {} },
    gamepad: { start: () => pollerCalls.push('start'), stop: () => pollerCalls.push('stop') },
    consoleWin: {},
    sendTo: (_window, channel, payload) => {
      assert.equal(channel, 'gamepad:devices');
      deviceUpdates.push([...payload]);
    },
    BrowserWindow: FakeDisc,
    win: { isDestroyed: () => false },
    loginWin: null,
    powerMonitor,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    settings: { gamepad: settings, holdPlaybackRate: 2, playbackRate: 1 },
    HOTKEY_META: [],
    publishPlaybackSettings: () => actions.push(context.api.active()),
    sendPlayerAction: (action) => actions.push(action),
    showNotice() {},
    hookHotkeys: { cancelHeld() {}, rearm() {} }
  });
  vm.runInContext(`
    let typingInField = false;
    let capturingHotkey = false;
    let holdSpeedActive = false;
    const holdSpeedSources = new Set();
    ${extract('setHoldSpeed')}
    ${extract('cancelTemporarySpeed')}
    ${extract('handleHotkey')}
    ${disc}
    ${power}
    globalThis.api = {
      handleGamepadFrame, setGamepadEnabled, active: () => holdSpeedActive,
      keyboard: (down) => handleHotkey('holdSpeed', down ? 'down' : 'up'),
      typing: (on) => { typingInField = on; if (on) cancelTemporarySpeed(); },
      resetGamepadSession,
    };`, context);
  return {
    ...context.api,
    windows,
    actions,
    pollerCalls,
    deviceUpdates,
    power: (event) => powerMonitor.emit(event),
    frame(pressed, rx = 0, ry = 0, slot = 0, model = 'xinput') {
      const frame = config.xinputToFrame({ b: pressed ? 0x0040 : 0, rx, ry });
      context.api.handleGamepadFrame({ ...frame, slot, model });
    },
    disconnect(slot) { context.api.handleGamepadFrame({ ...config.xinputToFrame(null), slot }); }
  };
}

test('first load: releasing L3 before ready never opens a stale disc', () => {
  const app = harness();
  app.frame(false);
  app.frame(true);
  const [disc] = app.windows;
  app.frame(false);
  disc.finish();
  assert.equal(disc.shows, 0);
  assert.equal(disc.messages.at(-1).highlight, '');
  app.frame(true);
  assert.equal(disc.shows, 1);
  assert.equal(disc.options.focusable, false);
  assert.equal(disc.mouseThrough, true);
});

test('first load: delivers the current highlight even when input is idle by ready', () => {
  const app = harness();
  app.frame(false);
  app.frame(true);
  app.frame(true, 0, 32767);
  const [disc] = app.windows;
  disc.finish();
  assert.equal(disc.messages.at(-1).highlight, 'n');
  assert.equal(disc.shows, 1);
  app.frame(true);
  app.frame(true);
  assert.deepEqual(app.actions, ['prevPart']);
});

test('disc rendering failure clears hold and waits for a new L3 press', async () => {
  const app = harness();
  app.frame(false);
  app.frame(true);
  app.frame(true, 32767);
  const [disc] = app.windows;
  disc.rejectLoad(new Error('fixture load failure'));
  await Promise.resolve();
  assert.equal(disc.destroyed, true);
  assert.equal(app.active(), false);
  app.frame(true, 32767);
  assert.equal(app.windows.length, 1);
  app.frame(false);
  app.frame(true);
  assert.equal(app.windows.length, 2);
});

for (const firstRelease of ['keyboard', 'gamepad']) {
  test(`keyboard and gamepad hold independently: ${firstRelease} releases first`, () => {
    const app = harness();
    app.frame(false);
    app.frame(true);
    app.keyboard(true);
    app.frame(true, 32767);
    if (firstRelease === 'keyboard') app.keyboard(false);
    else app.disconnect();
    assert.equal(app.active(), true);
    if (firstRelease === 'keyboard') app.frame(false);
    else app.keyboard(false);
    assert.equal(app.active(), false);
    assert.deepEqual(app.actions, [true, false]);
  });
}

test('disconnect cancels a queued action and reconnection requires a fresh press', () => {
  const app = harness();
  app.frame(false);
  app.frame(true);
  app.frame(true, 0, 32767);
  app.disconnect(0);
  app.frame(true);
  app.frame(true, 0, 32767);
  app.frame(true);
  assert.deepEqual(app.actions, []);
  app.frame(false);
  app.frame(true);
  app.frame(true, 32767);
  assert.equal(app.active(), true);
  app.disconnect(0);
  assert.equal(app.active(), false);
  assert.deepEqual(app.actions, [true, false]);
});

test('mixed devices keep the disc and held action with the controller that opened it', () => {
  const app = harness();
  app.frame(false);
  app.frame(false, 0, 0, 4, 'dualshock4');
  app.frame(false, 0, 0, 5, 'dualsense');
  app.frame(true, 0, 0, 4, 'dualshock4');
  app.frame(true, 32767, 0, 4, 'dualshock4');
  const disc = app.windows[0];
  disc.finish();
  app.frame(true, 0, 0, 0);
  app.frame(true, 0, 32767, 0);
  app.disconnect(5);
  assert.equal(app.active(), true);
  assert.equal(disc.messages.at(-1).highlight, 'e');
  app.disconnect(4);
  assert.equal(app.active(), false);
  assert.equal(disc.visible, false);
  app.frame(true);
  assert.equal(disc.visible, false);
  app.frame(false);
  app.frame(true);
  app.frame(true, 0, 32767);
  app.frame(true);
  assert.deepEqual(app.actions, [true, false, 'prevPart']);
  assert.deepEqual(app.deviceUpdates, [
    ['xinput'], ['xinput', 'dualshock4'], ['xinput', 'dualshock4', 'dualsense'],
    ['xinput', 'dualshock4'], ['xinput']
  ]);
});

test('disabling gamepad releases its worker and disc, preserves a keyboard hold, and waits for a fresh press', () => {
  const app = harness();
  app.frame(false);
  app.frame(true);
  app.windows[0].finish();
  app.keyboard(true);
  app.frame(true, 32767);
  app.setGamepadEnabled(false);
  app.setGamepadEnabled(false);
  assert.equal(app.windows[0].destroyed, true);
  assert.equal(app.active(), true);
  app.keyboard(false);
  assert.equal(app.active(), false);
  app.frame(true, 32767);
  app.setGamepadEnabled(true);
  app.setGamepadEnabled(true);
  app.frame(true, 32767);
  assert.equal(app.active(), false);
  app.frame(false);
  app.frame(true);
  app.frame(true, 32767);
  assert.equal(app.active(), true);
  assert.equal(app.windows.length, 2);
  assert.deepEqual(app.pollerCalls, ['stop', 'start']);
});

test('lock, suspend, and typing cancel the session and require a fresh press', () => {
  const app = harness();
  app.frame(false);
  app.frame(true);
  app.frame(true, 32767);
  app.power('lock-screen');
  app.power('suspend');
  app.power('resume');
  app.frame(false);
  app.frame(true);
  app.frame(true, 32767);
  assert.equal(app.active(), false);
  app.power('unlock-screen');
  app.frame(true, 32767);
  assert.equal(app.active(), false);
  app.frame(false);
  app.frame(true);
  app.frame(true, 32767);
  assert.equal(app.active(), true);
  app.typing(true);
  app.typing(false);
  app.frame(true, 32767);
  assert.equal(app.active(), false);
  assert.deepEqual(app.actions, [true, false, true, false]);
});

test('eight directions, neutral commit, and explicit cancellation keep PR mapping semantics', () => {
  const cfg = config.mergeGamepadSettings(undefined, { map: { nw: '', invalid: 'seekBack', n: 'invalid' } });
  assert.equal(cfg.map.nw, '');
  assert.equal(cfg.map.n, 'prevPart');
  assert.equal(Object.hasOwn(cfg.map, 'invalid'), false);
  for (const [index, direction] of config.DIRECTION_NAMES.entries()) {
    const angle = Math.PI * index / 4;
    const neutral = config.xinputToFrame({ b: 0x0040 });
    const stick = config.xinputToFrame({ b: 0x0040, rx: Math.cos(angle) * 32767, ry: -Math.sin(angle) * 32767 });
    const opened = config.stepChord(config.createChordState(), neutral, cfg);
    const selected = config.stepChord(opened.state, stick, cfg);
    assert.equal(selected.highlighted, direction);
    assert.equal(config.stepChord(selected.state, neutral, cfg).fired, cfg.map[direction]);
    assert.equal(config.stepChord(selected.state, config.xinputToFrame({ b: 0 }), cfg).fired, '');
  }
});
