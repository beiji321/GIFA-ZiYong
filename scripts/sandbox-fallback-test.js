'use strict';

/* 沙箱兜底的离线回归：假的 app / dialog，数据目录放在系统临时目录并自动清理。
 * 不启动 Electron、不读写用户配置。真实 Chromium 的事件顺序由 sandbox-fallback-live-test.js 覆盖。 */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  install,
  classify,
  MARKER_FILE,
  LOG_FILE,
  LOG_MAX_BYTES,
  NO_SANDBOX_ARG,
  GPU_ABORT_LIMIT
} = require('../src/sandbox-fallback');

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gifa-sandbox-fallback-'));
let directoryIndex = 0;
function freshDir() {
  directoryIndex += 1;
  return path.join(temporaryRoot, 'case-' + directoryIndex);
}

function fakeApp({ version = '0.2.5', switches = [] } = {}) {
  const app = new EventEmitter();
  app.switches = [...switches];
  app.relaunches = [];
  app.exits = [];
  app.isPackaged = true;
  app.getVersion = () => version;
  app.getPath = () => 'C:\\Program Files\\GIFA\\GIFA.exe';
  app.commandLine = {
    appendSwitch: (name) => app.switches.push(name),
    hasSwitch: (name) => app.switches.includes(name)
  };
  app.relaunch = (options) => app.relaunches.push(options);
  app.exit = (code) => app.exits.push(code);
  return app;
}

function fakeDialog() {
  const dialog = { shown: [] };
  dialog.showMessageBoxSync = (options) => {
    dialog.shown.push(options);
    return 0;
  };
  return dialog;
}

function setup({ dataDir = freshDir(), argv = ['GIFA.exe'], platform = 'win32', beforeExit, ...appOptions } = {}) {
  const app = fakeApp(appOptions);
  const dialog = fakeDialog();
  const guard = install({ app, dialog, dataDir, platform, argv, beforeExit });
  return { app, dialog, guard, dataDir, marker: path.join(dataDir, MARKER_FILE) };
}

const LAUNCH_FAILED = { type: 'GPU', reason: 'launch-failed', exitCode: 18, systemErrorCode: 5, serviceName: 'GPU' };
const SANDBOX_ABORT = { type: 'GPU', reason: 'crashed', exitCode: -2147483645, serviceName: 'GPU' };
const gone = (app, details) => app.emit('child-process-gone', {}, details);

let passed = 0;
function check(label, callback) {
  callback();
  passed += 1;
  console.log('PASS  ' + label);
}

try {
  check('子进程退出只把 GPU 的启动失败和沙箱自杀退出码归为沙箱故障', () => {
    assert.equal(classify(LAUNCH_FAILED), 'gpu-launch-failed');
    assert.equal(classify(SANDBOX_ABORT), 'gpu-sandbox-abort');
    assert.equal(classify({ type: 'GPU', reason: 'abnormal-exit', exitCode: 0xc0000409 | 0 }), 'gpu-sandbox-abort');
    assert.equal(classify({ type: 'GPU', reason: 'crashed', exitCode: 0xc0000005 | 0 }), null, '驱动访问冲突留给 Chromium 降级');
    assert.equal(classify({ type: 'GPU', reason: 'killed', exitCode: 1 }), null);
    assert.equal(classify({ type: 'Utility', reason: 'launch-failed', exitCode: 18 }), null);
    assert.equal(classify(null), null);
  });

  check('非 Windows 不接管事件、不动命令行', () => {
    const { app, guard, marker } = setup({ platform: 'linux' });
    assert.equal(guard.mode, 'off');
    assert.equal(app.listenerCount('child-process-gone'), 0);
    gone(app, LAUNCH_FAILED);
    guard.startupComplete();
    assert.deepEqual([app.switches, app.relaunches, app.exits], [[], [], []]);
    assert.equal(fs.existsSync(marker), false);
  });

  check('正常启动保持沙箱，只写一条启动诊断', () => {
    const { app, guard, dataDir, marker } = setup();
    assert.equal(guard.mode, 'normal');
    assert.deepEqual(app.switches, []);
    assert.equal(fs.existsSync(marker), false);
    guard.startupComplete();
    guard.startupComplete();
    const raw = fs.readFileSync(path.join(dataDir, LOG_FILE));
    assert.equal(raw.subarray(0, 3).toString('hex'), 'efbbbf', '带 BOM，旧版记事本不乱码');
    const lines = raw.toString('utf8').trim().split('\n');
    assert.equal(lines.length, 2, '重复调用 startupComplete 不重复记录');
    assert.equal(raw.toString('utf8').split('\ufeff').length, 2, 'BOM 只在文件开头出现一次');
    assert.match(lines[0], /\[start\] \{.*"app":"0\.2\.5".*"sandbox":"normal"/);
    assert.match(lines[1], /\[ready\]/);
  });

  check('GPU 进程 launch-failed：记标记并带 --no-sandbox 重启一次', () => {
    const { app, dialog, marker } = setup({ argv: ['GIFA.exe', '--open', 'BV1xx411c7mD'] });
    gone(app, LAUNCH_FAILED);
    gone(app, LAUNCH_FAILED);
    gone(app, LAUNCH_FAILED);
    assert.deepEqual(app.relaunches, [{ args: ['--open', 'BV1xx411c7mD', NO_SANDBOX_ARG] }], '保留原参数，只重启一次');
    assert.deepEqual(app.exits, [0]);
    assert.equal(dialog.shown.length, 0, '能自愈时不打扰用户');
    const saved = JSON.parse(fs.readFileSync(marker, 'utf8'));
    assert.equal(saved.reason, 'gpu-launch-failed');
    assert.equal(saved.exitCode, 18);
    assert.equal(saved.systemErrorCode, 5);
    assert.equal(saved.appVersion, '0.2.5');
    assert.equal(saved.electron, String(process.versions.electron || ''));
  });

  check('同版本再次启动直接进入兼容模式', () => {
    const first = setup();
    gone(first.app, LAUNCH_FAILED);
    const second = setup({ dataDir: first.dataDir });
    assert.equal(second.guard.mode, 'fallback');
    assert.deepEqual(second.app.switches, ['no-sandbox']);
    assert.equal(fs.existsSync(second.marker), true, '标记在同一版本内保持');
    const relaunched = setup({ dataDir: first.dataDir, argv: ['GIFA.exe', NO_SANDBOX_ARG] });
    assert.equal(relaunched.guard.mode, 'fallback');
    assert.deepEqual(relaunched.app.switches, [], '命令行已带开关时不重复追加');
  });

  check('程序版本变化后删除标记，按沙箱模式重新探测', () => {
    const first = setup();
    gone(first.app, LAUNCH_FAILED);
    const upgraded = setup({ dataDir: first.dataDir, version: '0.2.6' });
    assert.equal(upgraded.guard.mode, 'normal');
    assert.deepEqual(upgraded.app.switches, []);
    assert.equal(fs.existsSync(upgraded.marker), false);
  });

  check('损坏的标记被忽略并清理', () => {
    const dataDir = freshDir();
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, MARKER_FILE), '{ not json');
    const { app, guard, marker } = setup({ dataDir });
    assert.equal(guard.mode, 'normal');
    assert.deepEqual(app.switches, []);
    assert.equal(fs.existsSync(marker), false);
  });

  check('兼容模式下仍 launch-failed：弹一次原生对话框后退出，不再重启', () => {
    const first = setup();
    gone(first.app, LAUNCH_FAILED);
    const { app, dialog, guard } = setup({ dataDir: first.dataDir, argv: ['GIFA.exe', NO_SANDBOX_ARG] });
    gone(app, LAUNCH_FAILED);
    gone(app, LAUNCH_FAILED);
    assert.deepEqual(app.relaunches, []);
    assert.deepEqual(app.exits, [1]);
    assert.equal(dialog.shown.length, 1);
    assert.equal(dialog.shown[0].type, 'error');
    assert.match(dialog.shown[0].detail, /错误码 18：Windows 拒绝创建子进程，系统错误 5/);
    assert.ok(dialog.shown[0].detail.includes(guard.logFile), '对话框给出诊断日志位置');
  });

  check('用户手动加 --no-sandbox 仍失败：报错退出，不写标记', () => {
    const { app, dialog, guard, marker } = setup({ argv: ['GIFA.exe', NO_SANDBOX_ARG] });
    assert.equal(guard.mode, 'manual');
    gone(app, LAUNCH_FAILED);
    assert.deepEqual(app.relaunches, []);
    assert.deepEqual(app.exits, [1]);
    assert.equal(dialog.shown.length, 1);
    assert.equal(fs.existsSync(marker), false);
  });

  check('对话框本身抛错也要退出，不能卡成无窗口进程', () => {
    const { app, dialog } = setup({ argv: ['GIFA.exe', NO_SANDBOX_ARG] });
    dialog.showMessageBoxSync = () => {
      throw new Error('no display');
    };
    gone(app, LAUNCH_FAILED);
    assert.deepEqual(app.exits, [1]);
  });

  check(`启动期 GPU 以沙箱自杀退出码连挂 ${GPU_ABORT_LIMIT} 次才切换`, () => {
    const { app, marker } = setup();
    for (let n = 1; n < GPU_ABORT_LIMIT; n += 1) gone(app, SANDBOX_ABORT);
    assert.deepEqual(app.relaunches, [], '偶发一次不切换');
    gone(app, { type: 'GPU', reason: 'crashed', exitCode: 0xc0000005 | 0 });
    gone(app, { type: 'Utility', reason: 'crashed', exitCode: -2147483645 });
    gone(app, { type: 'GPU', reason: 'clean-exit', exitCode: 0 });
    assert.deepEqual(app.relaunches, [], '其他退出不计数');
    gone(app, SANDBOX_ABORT);
    assert.deepEqual(app.relaunches, [{ args: [NO_SANDBOX_ARG] }]);
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).reason, 'gpu-sandbox-abort');
  });

  check('窗口显示之后或已无沙箱时，GPU 崩溃交给 Chromium 自己降级', () => {
    const shown = setup();
    shown.guard.startupComplete();
    for (let n = 0; n < GPU_ABORT_LIMIT + 2; n += 1) gone(shown.app, SANDBOX_ABORT);
    assert.deepEqual([shown.app.relaunches, shown.app.exits], [[], []]);
    assert.equal(fs.existsSync(shown.marker), false);

    const unsandboxed = setup({ argv: ['GIFA.exe', NO_SANDBOX_ARG] });
    for (let n = 0; n < GPU_ABORT_LIMIT + 2; n += 1) gone(unsandboxed.app, SANDBOX_ABORT);
    assert.deepEqual([unsandboxed.app.relaunches, unsandboxed.app.exits], [[], []]);
    assert.equal(unsandboxed.dialog.shown.length, 0);
  });

  check('窗口显示之后的 launch-failed 仍然切换（GPU 进程重启时同样起不来）', () => {
    const { app, guard } = setup();
    guard.startupComplete();
    gone(app, LAUNCH_FAILED);
    assert.deepEqual(app.relaunches, [{ args: [NO_SANDBOX_ARG] }]);
  });

  check('数据目录写不进去时仍带开关重启，不会循环', () => {
    const blocker = path.join(freshDir() + '-blocker');
    fs.writeFileSync(blocker, 'file, not a directory');
    const { app, guard, marker } = setup({ dataDir: blocker });
    assert.equal(guard.mode, 'normal');
    gone(app, LAUNCH_FAILED);
    assert.deepEqual(app.relaunches, [{ args: [NO_SANDBOX_ARG] }]);
    assert.deepEqual(app.exits, [0]);
    assert.equal(fs.existsSync(marker), false);
    const next = setup({ dataDir: blocker, argv: ['GIFA.exe', NO_SANDBOX_ARG] });
    assert.equal(next.guard.mode, 'manual');
    gone(next.app, LAUNCH_FAILED);
    assert.deepEqual(next.app.relaunches, [], '带开关的那次再失败只报错');
  });

  check('渲染进程异常退出只记录，不触发切换', () => {
    const { app, dataDir } = setup();
    app.emit('render-process-gone', {}, {}, { reason: 'crashed', exitCode: -2147483645 });
    app.emit('render-process-gone', {}, {}, { reason: 'clean-exit', exitCode: 0 });
    assert.deepEqual([app.relaunches, app.exits], [[], []]);
    const text = fs.readFileSync(path.join(dataDir, LOG_FILE), 'utf8');
    assert.equal(text.match(/\[render-gone\]/g).length, 1);
  });

  check('启动日志超过上限时只保留后半段', () => {
    const dataDir = freshDir();
    fs.mkdirSync(dataDir, { recursive: true });
    const logFile = path.join(dataDir, LOG_FILE);
    const line = 'x'.repeat(99) + '\n';
    fs.writeFileSync(logFile, 'FIRST\n' + line.repeat(Math.ceil(LOG_MAX_BYTES / line.length) + 10));
    const { guard } = setup({ dataDir });
    const text = fs.readFileSync(logFile, 'utf8');
    assert.ok(text.length < LOG_MAX_BYTES, '已截断');
    assert.equal(text.includes('FIRST'), false, '丢弃的是最旧的部分');
    assert.equal(text.split('\n')[0], '\ufeff' + 'x'.repeat(99), '从整行开始，并补上 BOM');
    assert.equal(text.split('\ufeff').length, 2);
    assert.match(text, /\[start\] /);
    assert.equal(guard.logFile, logFile);
  });

  check('兼容重启和失败退出都先清理外部进程，每次只清理一次', () => {
    for (const argv of [['GIFA.exe'], ['GIFA.exe', NO_SANDBOX_ARG]]) {
      const events = [];
      const { app, dialog } = setup({ argv, beforeExit: () => events.push('stop') });
      app.relaunch = () => events.push('relaunch');
      app.exit = () => events.push('exit');
      dialog.showMessageBoxSync = () => events.push('dialog');
      gone(app, LAUNCH_FAILED);
      gone(app, LAUNCH_FAILED);
      assert.deepEqual(events, ['stop', argv.length === 1 ? 'relaunch' : 'dialog', 'exit']);
    }
  });

  check('主进程在创建任何窗口和子进程之前接入', () => {
    const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
    const installAt = mainSource.indexOf('sandboxFallback.install({ app, dialog, dataDir: USER_DATA_DIR, beforeExit: stopGamepadPoller })');
    assert.ok(installAt > 0, 'main.js 调用 install');
    assert.ok(installAt > mainSource.indexOf("app.setPath('userData', USER_DATA_DIR)"), '在 userData 确定之后');
    assert.ok(installAt < mainSource.indexOf('app.requestSingleInstanceLock()'), '在单实例与 whenReady 之前');
    assert.ok(installAt < mainSource.indexOf('app.whenReady()'));
    assert.match(mainSource, /consoleWin\.show\(\);\s*sandboxGuard\.startupComplete\(\);/);
    assert.match(mainSource, /const \{[^}]*\bdialog\b[^}]*\} = require\('electron'\)/);
  });

  console.log(`\n${passed} 项通过`);
} finally {
  assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
