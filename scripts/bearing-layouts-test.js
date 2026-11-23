'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  BUILTIN_LAYOUT_ID,
  DEFAULT_BEARING_LAYOUTS,
  loadBearingLayouts,
  activeBearingLayout,
  applyBearingLayout
} = require('../src/bearing-layouts');

const CUSTOM_ROI = { cx: 0.5, cy: 0.5, r: 0.125 };

function createLayout(bearing, name, roi = CUSTOM_ROI) {
  const result = applyBearingLayout(bearing, { op: 'create', name, roi });
  assert.equal(result.ok, true, `create ${name}: ${result.reason}`);
  assert.ok(result.id);
  return result.id;
}

function accept(bearing, command) {
  assert.deepEqual(applyBearingLayout(bearing, command), { ok: true }, command.op);
}

function rejectUnchanged(bearing, command) {
  const before = structuredClone(bearing);
  assert.deepEqual(applyBearingLayout(bearing, command), { ok: false, reason: 'invalid' }, JSON.stringify(command));
  assert.deepEqual(bearing, before);
}

test('fresh state offers the two calibrated creator presets by name', () => {
  assert.equal(BUILTIN_LAYOUT_ID, 'builtin');
  const builtin = {
    id: BUILTIN_LAYOUT_ID,
    name: '你的影月月',
    roi: { cx: 282 / 1920, cy: 266 / 1080, r: 276 / 1920 },
    builtIn: true,
    centered: true,
    revision: 0
  };
  const pangolin = {
    id: 'pangolin',
    name: '提瓦特高级特工穿山甲',
    roi: { cx: 258 / 1920, cy: 284 / 1080, r: 260 / 1920 },
    builtIn: true,
    centered: true,
    revision: 0
  };
  const expected = { layouts: [builtin, pangolin], defaultLayoutId: builtin.id, activeLayoutId: builtin.id };
  const bearing = loadBearingLayouts({});
  assert.deepEqual(DEFAULT_BEARING_LAYOUTS, expected);
  assert.deepEqual(bearing, expected);
  assert.deepEqual(activeBearingLayout(bearing), builtin);
  accept(bearing, { op: 'select', id: pangolin.id });
  assert.deepEqual(activeBearingLayout(bearing), pangolin);
  rejectUnchanged(bearing, { op: 'remove', id: pangolin.id });
  rejectUnchanged(bearing, { op: 'rename', id: pangolin.id, name: 'Other' });
  rejectUnchanged(bearing, { op: 'calibrate', id: pangolin.id, roi: CUSTOM_ROI });
});

test('upgrading replaces the old builtin geometry without changing custom layouts or defaults', () => {
  const oldBuiltin = {
    id: BUILTIN_LAYOUT_ID,
    name: '内置默认',
    roi: { cx: 286 / 1920, cy: 277 / 1080, r: 0.1496538 },
    centered: true,
    revision: 1
  };
  const custom = { id: 'legacy-1', name: '旧标定', roi: CUSTOM_ROI, centered: true, revision: 3 };
  const raw = { layouts: [oldBuiltin, custom], defaultLayoutId: custom.id };
  const restored = loadBearingLayouts(raw);
  assert.deepEqual(restored.layouts, [...DEFAULT_BEARING_LAYOUTS.layouts, custom]);
  assert.equal(restored.defaultLayoutId, custom.id);
  assert.equal(restored.activeLayoutId, custom.id);
  assert.deepEqual(activeBearingLayout(loadBearingLayouts({ ...raw, defaultLayoutId: BUILTIN_LAYOUT_ID })),
    DEFAULT_BEARING_LAYOUTS.layouts[0]);
});

test('an identical custom Pangolin layout is promoted without losing its startup selection', () => {
  const preset = DEFAULT_BEARING_LAYOUTS.layouts[1];
  const existing = { id: 'existing-pangolin', name: preset.name, roi: preset.roi, centered: true, revision: 1 };
  const loaded = loadBearingLayouts({ layouts: [existing], defaultLayoutId: existing.id });
  assert.deepEqual(loaded.layouts, DEFAULT_BEARING_LAYOUTS.layouts);
  assert.equal(loaded.defaultLayoutId, preset.id);
  assert.equal(loaded.activeLayoutId, preset.id);

  const modified = { ...existing, roi: CUSTOM_ROI };
  assert.deepEqual(loadBearingLayouts({ layouts: [modified] }).layouts.at(-1), modified);
});

test('create, select and rename a layout independently of the launch default', () => {
  const bearing = loadBearingLayouts({});
  const id = createLayout(bearing, '  Front\t Wheel  ');
  const created = { id, name: 'Front Wheel', roi: CUSTOM_ROI, centered: false, revision: 0 };
  assert.deepEqual(activeBearingLayout(bearing), created);
  assert.equal(bearing.defaultLayoutId, BUILTIN_LAYOUT_ID);

  accept(bearing, { op: 'select', id: BUILTIN_LAYOUT_ID });
  accept(bearing, { op: 'default', id });
  assert.equal(bearing.defaultLayoutId, id);
  assert.equal(activeBearingLayout(bearing).id, BUILTIN_LAYOUT_ID);

  accept(bearing, { op: 'select', id });
  accept(bearing, { op: 'rename', id, name: '  Rear   Wheel  ' });
  assert.deepEqual(activeBearingLayout(bearing), { ...created, name: 'Rear Wheel' });
  accept(bearing, { op: 'select', id: BUILTIN_LAYOUT_ID });
  assert.equal(bearing.activeLayoutId, BUILTIN_LAYOUT_ID);
  assert.equal(bearing.defaultLayoutId, id);
});

test('removing the active layout falls back to the launch default; removing the default restores builtin', () => {
  const bearing = loadBearingLayouts({});
  const launch = createLayout(bearing, 'Launch');
  accept(bearing, { op: 'default', id: launch });
  const temporary = createLayout(bearing, 'Temporary');

  accept(bearing, { op: 'remove', id: temporary });
  assert.equal(bearing.activeLayoutId, launch);
  assert.equal(bearing.defaultLayoutId, launch);
  assert.deepEqual(bearing.layouts.map(({ id }) => id), [...DEFAULT_BEARING_LAYOUTS.layouts.map(({ id }) => id), launch]);

  const replacement = createLayout(bearing, 'Replacement');
  accept(bearing, { op: 'remove', id: launch });
  assert.equal(bearing.activeLayoutId, replacement);
  assert.equal(bearing.defaultLayoutId, BUILTIN_LAYOUT_ID);

  accept(bearing, { op: 'default', id: replacement });
  accept(bearing, { op: 'remove', id: replacement });
  assert.deepEqual(bearing, DEFAULT_BEARING_LAYOUTS);
  rejectUnchanged(bearing, { op: 'remove', id: BUILTIN_LAYOUT_ID });
});

test('legacy guessed ROIs do not become layouts or launch defaults', () => {
  const smallGuess = { cx: 0.0875, cy: 0.122, r: 0.046 };
  const largeGuess = { cx: 0.148, cy: 0.222, r: 0.163 };
  const raw = { rois: [smallGuess, largeGuess], roiBy: { BV1Watched: [largeGuess, smallGuess] } };
  assert.deepEqual(loadBearingLayouts(raw, 'BV1Watched'), DEFAULT_BEARING_LAYOUTS);
});

test('migration preserves distinct per-BV and global ROI coordinates and deduplicates exact matches', () => {
  const watched = { cx: 0.234567891, cy: 0.268932847, r: 0.151223345 };
  const shared = { cx: 0.411941723, cy: 0.713934753, r: 0.073146368 };
  const global = { cx: 0.348917262, cy: 0.414318291, r: 0.087315842 };
  const nearGlobal = { ...global, r: 0.087315843 };
  const other = { cx: 0.700128379, cy: 0.238947123, r: 0.126947862 };
  const raw = {
    rois: [global, { ...shared }, { ...global }],
    roiBy: {
      BV1Other: [other, { ...global }, nearGlobal],
      BV1Watched: [watched, shared, { ...watched }]
    }
  };
  const bearing = loadBearingLayouts(raw, 'bv1watched');
  assert.deepEqual(bearing.layouts.slice(DEFAULT_BEARING_LAYOUTS.layouts.length).map(({ roi }) => roi), [watched, shared, global, other, nearGlobal]);
  assert.deepEqual(activeBearingLayout(bearing).roi, watched);
  assert.equal(bearing.defaultLayoutId, activeBearingLayout(bearing).id);

  const unmatched = loadBearingLayouts(raw, 'BV1Missing');
  assert.deepEqual(activeBearingLayout(unmatched).roi, global);
  assert.equal(unmatched.defaultLayoutId, activeBearingLayout(unmatched).id);
});

test('auto-center rejects results for an inactive layout or a superseded revision', () => {
  const bearing = loadBearingLayouts({});
  const id = createLayout(bearing, 'Current');
  const pending = { op: 'center', id, revision: 0, applied: true, dcx: 0.03125, dcy: -0.0625 };

  accept(bearing, { op: 'select', id: BUILTIN_LAYOUT_ID });
  rejectUnchanged(bearing, pending);
  accept(bearing, { op: 'select', id });
  const roi = { cx: 0.375, cy: 0.625, r: 0.125 };
  accept(bearing, { op: 'calibrate', id, roi });
  assert.deepEqual(activeBearingLayout(bearing), { id, name: 'Current', roi, centered: false, revision: 1 });
  rejectUnchanged(bearing, pending);

  const current = { ...pending, revision: 1 };
  accept(bearing, current);
  assert.equal(activeBearingLayout(bearing).revision, 2);
  rejectUnchanged(bearing, current);
});

test('auto-center bounds correction by radius and keeps the center inside the frame', () => {
  const bearing = loadBearingLayouts({});
  const id = createLayout(bearing, 'Edge', { cx: 0.03125, cy: 0.875, r: 0.125 });
  const center = { op: 'center', id, revision: 0, applied: true, dcx: 0, dcy: 0 };

  rejectUnchanged(bearing, { ...center, dcx: 0.06251 });
  rejectUnchanged(bearing, { ...center, dcy: -0.1251 });
  rejectUnchanged(bearing, { ...center, dcx: -0.03125 });
  rejectUnchanged(bearing, { ...center, dcy: 0.125 });
  accept(bearing, { ...center, dcx: 0.0625, dcy: -0.125 });
  assert.deepEqual(activeBearingLayout(bearing), {
    id, name: 'Edge', roi: { cx: 0.09375, cy: 0.75, r: 0.125 }, centered: true, revision: 1
  });
});

test('a completed auto-center without an applied correction leaves the ROI unchanged', () => {
  const bearing = loadBearingLayouts({});
  const builtin = structuredClone(activeBearingLayout(bearing));
  accept(bearing, { op: 'center', id: builtin.id, revision: 0, applied: false, dcx: 1, dcy: 1 });
  assert.deepEqual(activeBearingLayout(bearing), { ...builtin, centered: true, revision: 1 });
});

test('persisted layouts retain ROIs and revisions and start on the launch default', () => {
  const bearing = loadBearingLayouts({});
  accept(bearing, { op: 'center', id: BUILTIN_LAYOUT_ID, revision: 0, applied: true, dcx: 0.01, dcy: -0.02 });
  const launch = createLayout(bearing, 'Launch');
  accept(bearing, { op: 'default', id: launch });
  accept(bearing, { op: 'center', id: launch, revision: 0, applied: true, dcx: -0.03125, dcy: 0.0625 });
  const temporary = createLayout(bearing, 'Temporary');
  assert.equal(bearing.activeLayoutId, temporary);
  assert.equal(bearing.defaultLayoutId, launch);

  const restored = loadBearingLayouts(JSON.parse(JSON.stringify(bearing)));
  assert.deepEqual(restored, { layouts: bearing.layouts, defaultLayoutId: launch, activeLayoutId: launch });
  assert.equal(activeBearingLayout(restored).id, launch);
});

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function declaration(code, name) {
  const start = code.indexOf(`\nfunction ${name}(`);
  const end = code.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, `Missing function: ${name}`);
  return code.slice(start, end + 2);
}

test('the launcher shows each creator name without a startup badge', () => {
  const bearing = loadBearingLayouts({ layouts: [], defaultLayoutId: 'pangolin' });
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { replaceChildren(...children) { this.children = children; } });
    return elements.get(id);
  };
  const ui = source('console/console.js');
  const render = [declaration(ui, 'currentLayout'), declaration(ui, 'renderLayouts'), 'renderLayouts(bearing);'].join('\n');
  const globals = { bearing, state: { boot: { settings: { bearing } } }, $: element, document: { createElement: () => ({}) } };
  vm.runInNewContext(render, globals);
  assert.deepEqual(element('bearingLayout').children.map(({textContent}) => textContent), ['你的影月月', '提瓦特高级特工穿山甲']);
  assert.equal(element('bearingLayout').value, 'pangolin');
  assert.equal(element('btnRenameLayout').disabled, true);
});

test('the video guest samples only the selected layout and clears stale direction instead of trying another', () => {
  const bearing = loadBearingLayouts({});
  const otherId = createLayout(bearing, 'Other', { cx: 0.75, cy: 0.65, r: 0.08 });
  const currentId = createLayout(bearing, 'Current');
  const guestState = { enabled: false, raw: [], ab: {}, view: {}, auto: { trim: { x: 0, y: 0 } } };
  const samples = [];
  const onScreen = [];
  const pendingTimers = new Set();
  let now = 1000;
  let visibleLayoutId = currentId;
  let layout = activeBearingLayout(bearing);
  let guest;
  const win = { webContents: {} };
  const listeners = {};
  const mainCode = source('main.js');
  const start = mainCode.indexOf("  ipcMain.on('overlay:bearing', ");
  const end = mainCode.indexOf("  ipcMain.handle('overlay:enable'", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(mainCode.slice(start, end), {
    ipcMain: { on: (name, callback) => { listeners[name] = callback; } },
    win, activeBearingLayout, lastBearing: null, settings: { bearing }, overlayWin: {},
    // 主进程里的这几个是模块级 let 变量，抽取时不在函数体里，
    // 必须由 harness 显式提供，否则 handler 读不到就抛 ReferenceError。
    lastBearingStats: null,
    lastBearingDropAt: 0,
    diag: { log() {} },
    sendTo: (_win, _channel, payload) => onScreen.push(payload)
  });
  bearing.enabled = true;
  const appCode = source('renderer/app.js');
  const app = vm.createContext({
    state: { guestReady: true, boot: { settings: { bearing } }, video: { playing: true } },
    sendPlayer: (message) => guest.setBearing(message),
    window: { api: { bearing: (payload) => listeners['overlay:bearing']({ sender: win.webContents }, payload) } },
    setTimeout: (callback) => { pendingTimers.add(callback); return callback; },
    clearTimeout: (timer) => pendingTimers.delete(timer)
  });
  const hintVariables = 'let layoutHintTimer = null; let layoutHinted = false;';
  vm.runInContext(hintVariables + ['currentLayout', 'matchesCurrentLayout', 'syncBearingToGuest', 'resetLayoutHint', 'onGuestBearing']
    .map((name) => declaration(appCode, name)).join('\n'), app);

  const guestCode = source('webview-preload.js');
  guest = vm.createContext({
    BEARING: guestState,
    video: { paused: false, ended: false },
    grabCenter: (roi) => { samples.push(roi); return { img: { roi }, size: 128, step: 1 }; },
    cropCenterWindow: (sample, roi) => { assert.equal(sample.img.roi, roi); return sample; },
    analyzeArrowWithRecovery: () => ({ valid: visibleLayoutId === guestState.layoutId, angle: 15, conf: 0.8 }),
    analyzeConeWithRecovery: () => ({ valid: visibleLayoutId === guestState.layoutId, deg: 45, conf: 0.7, cyanFrac: 0 }),
    smoothBearing: (angle) => angle,
    updateView: (cone) => cone,
    viewPayload: (view) => ({ view: view ? 90 - view.deg : null }),
    angDiff: (first, second) => first - second,
    console: { log() {} },
    Date: { now: () => now },
    BEARING_STATS: { ring: [], window: 60, total: 0, lastReason: '', lastOkAt: 0, lastBadAt: 0 },
    MAP_CYAN_FRAC_MIN: 0.02,
    ipcRenderer: { sendToHost: (_channel, payload) => app.onGuestBearing(payload) },
    startBearingLoop: () => { guestState.invalidSince = 0; guestState.lastAngle = -1; guest.sendBearing({ clear: true }); },
    resetAutoCenter: () => {},
    beginAutoCenter: () => assert.fail('the fixture does not request centering')
  });
  vm.runInContext(['noteBearingResult', 'bearingStats', 'setBearing', 'tickBearing', 'markInvalid', 'sendBearing']
    .map((name) => declaration(guestCode, name)).join('\n'), guest);
  app.syncBearingToGuest();
  guest.tickBearing();
  assert.deepEqual(samples, [layout.roi]);
  assert.equal(onScreen.at(-1).angle, 75);
  assert.equal(onScreen.at(-1).view, 45);
  const previousPayload = onScreen.at(-1);

  accept(bearing, { op: 'select', id: otherId });
  layout = activeBearingLayout(bearing);
  app.syncBearingToGuest();
  assert.equal(onScreen.at(-1).clear, true);
  const count = onScreen.length;
  app.onGuestBearing(previousPayload);
  listeners['overlay:bearing']({ sender: win.webContents }, previousPayload);
  assert.equal(onScreen.length, count);
  now += 100;
  guest.tickBearing();
  now += 1010;
  guest.tickBearing();
  assert.deepEqual(samples.slice(1), [layout.roi, layout.roi]);
  assert.equal(onScreen.at(-1).clearAngle, true);
  assert.equal(pendingTimers.size, 1);

  visibleLayoutId = otherId;
  now += 100;
  guest.tickBearing();
  assert.equal(onScreen.at(-1).angle, 75);
  assert.equal(pendingTimers.size, 0);
});
