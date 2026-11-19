'use strict';

/* 沙箱兜底的隔离 Electron 回归：用真实 Chromium 验证事件形状与时序。
 *
 * 用一个不存在的 --gpu-launcher 让 GPU 进程创建失败，得到与用户机器上相同的
 * child-process-gone { type: 'GPU', reason: 'launch-failed', exitCode: 18 }，
 * 不加处理时主进程约 0.3 秒后以 0x80000003 退出、不出任何窗口。
 *
 * 这是**模拟**：只能证明「收到这种失败 → 记标记 → 带开关重启 → 兼容模式生效」这条链路，
 * 不能证明关闭沙箱在真实受影响的 Windows 上一定能把窗口带出来，那一步需要实机验收。
 * 测试数据放在系统临时目录并自动清理，不打开业务窗口、不读写用户配置。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RESULTS = 'results.jsonl';
const BROKEN_LAUNCHER = '--gpu-launcher=' + path.join(os.tmpdir(), 'gifa-no-such-dir', 'missing-launcher.exe');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!process.versions.electron) {
  runNode().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
} else {
  runElectron().catch((error) => {
    console.error(error);
    require('electron').app.exit(1);
  });
}

async function runNode() {
  if (process.platform !== 'win32') {
    console.log('SKIP  沙箱兜底只在 Windows 生效，当前平台不运行隔离 Electron 回归');
    return;
  }
  const { MARKER_FILE, LOG_FILE } = require('../src/sandbox-fallback');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gifa-sandbox-live-'));
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const resultsFile = path.join(temporaryRoot, RESULTS);
  const results = (scenario) => (fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, 'utf8') : '')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.scenario === scenario);
  const launch = (scenario, extra = []) => new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [__filename, temporaryRoot, scenario, ...extra], { stdio: 'inherit', env: environment });
    child.on('error', reject);
    child.on('close', resolve);
  });

  let passed = 0;
  const check = (label, callback) => {
    callback();
    passed += 1;
    console.log('PASS  ' + label);
  };

  try {
    const normalExit = await launch('normal');
    check('正常机器：保持沙箱模式，窗口照常显示，不写标记', () => {
      assert.equal(normalExit, 0);
      const [start, shown] = results('normal');
      assert.equal(start.mode, 'normal');
      assert.equal(shown.event, 'window', '沙箱模式窗口未显示：本机 GPU 沙箱可能本身不可用');
      assert.equal(shown.gpuSandboxed, true);
      assert.equal(fs.existsSync(path.join(temporaryRoot, 'data', MARKER_FILE)), false);
    });

    const brokenExit = await launch('broken', [BROKEN_LAUNCHER]);
    // 重启出来的第二个实例不是本进程的子进程，只能等它把结果写出来
    for (let waited = 0; waited < 20000 && !results('broken').some((entry) => entry.event === 'dialog'); waited += 200) {
      await delay(200);
    }
    await delay(500);
    check('GPU 进程 launch-failed：第一次失败就接管，没有走到 Chromium 的静默退出', () => {
      assert.equal(brokenExit, 0, '不处理时这里是 0x80000003');
      const marker = JSON.parse(fs.readFileSync(path.join(temporaryRoot, 'data', MARKER_FILE), 'utf8'));
      assert.equal(marker.reason, 'gpu-launch-failed');
      assert.equal(marker.exitCode, 18);
    });
    check('重启后的实例带 --no-sandbox 且进入兼容模式；仍失败时弹对话框而不是消失', () => {
      const entries = results('broken');
      assert.deepEqual(entries.map((entry) => entry.event), ['start', 'start', 'dialog']);
      assert.deepEqual([entries[0].mode, entries[0].noSandboxArg], ['normal', false]);
      assert.deepEqual([entries[1].mode, entries[1].noSandboxArg], ['fallback', true]);
      assert.equal(entries[1].launcherKept, true, '重启保留原有命令行参数');
      // 假 launcher 在无沙箱路径上同样起不来，但报的不再是沙箱 broker 的 18，说明确实绕开了沙箱
      assert.match(entries[2].detail, /错误码 \d+/);
      assert.doesNotMatch(entries[2].detail, /错误码 18\D/);
      const log = fs.readFileSync(path.join(temporaryRoot, 'data', LOG_FILE), 'utf8');
      assert.match(log, /\[child-gone\] \{"type":"GPU","reason":"launch-failed","exitCode":18/);
      assert.match(log, /\[fallback\] gpu-launch-failed/);
      assert.match(log, /\[fatal\] gpu-launch-failed/);
    });

    const recoveredExit = await launch('recovered');
    check('之后的普通启动直接以兼容模式运行：GPU 进程不再走沙箱，窗口显示', () => {
      assert.equal(recoveredExit, 0);
      const [start, shown] = results('recovered');
      assert.deepEqual([start.mode, start.noSandboxArg], ['fallback', false]);
      assert.equal(shown.event, 'window');
      assert.equal(shown.gpuSandboxed, false);
    });

    console.log(`\n${passed} 项通过（GPU 启动失败为模拟，真实受影响系统仍需实机验收）`);
  } finally {
    assert.equal(path.dirname(temporaryRoot), path.resolve(os.tmpdir()));
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function runElectron() {
  const { app, BrowserWindow } = require('electron');
  const { install, NO_SANDBOX_ARG } = require('../src/sandbox-fallback');
  const temporaryRoot = process.argv[2];
  const scenario = process.argv[3];
  assert.ok(path.basename(temporaryRoot).startsWith('gifa-sandbox-live-'));
  const report = (entry) => fs.appendFileSync(path.join(temporaryRoot, RESULTS), JSON.stringify({ scenario, ...entry }) + '\n');

  const noSandboxArg = process.argv.includes(NO_SANDBOX_ARG);
  app.setPath('userData', path.join(temporaryRoot, `profile-${scenario}${noSandboxArg ? '-relaunched' : ''}`));
  let guard = null;
  const dialog = {
    showMessageBoxSync(options) {
      report({ event: 'dialog', mode: guard.mode, title: options.title, detail: options.detail });
      return 0;
    }
  };
  guard = install({ app, dialog, dataDir: path.join(temporaryRoot, 'data') });
  report({ event: 'start', mode: guard.mode, noSandboxArg, launcherKept: process.argv.includes(BROKEN_LAUNCHER) });
  setTimeout(() => {
    report({ event: 'timeout' });
    app.exit(9);
  }, 20000);

  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: false } });
  await new Promise((resolve) => {
    window.once('ready-to-show', resolve);
    window.loadURL('data:text/html,<h1>gifa</h1>');
  });
  guard.startupComplete();
  await delay(1500);
  const gpu = app.getAppMetrics().find((metric) => metric.type === 'GPU');
  report({ event: 'window', mode: guard.mode, gpuSandboxed: gpu ? gpu.sandboxed : null });
  app.exit(0);
}
