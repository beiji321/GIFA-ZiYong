'use strict';

/**
 * Windows 下 Chromium 沙箱子进程起不来时的兜底，以及启动诊断日志。
 *
 * 背景（electron/electron#49167，Windows 10 19045 / Windows 11 均有报告）：
 * 本程序为了让全局钩子在游戏里生效，清单里要求管理员权限。而在一部分 Windows 环境下，
 * 以管理员身份运行的 Chromium 创建不了沙箱子进程 —— GPU 进程每次都 launch-failed
 * （exitCode 18 = SBOX_ERROR_CREATE_PROCESS），三种 GPU 模式各试三次后 Chromium 主动
 * 结束主进程（"GPU process isn't usable. Goodbye."）。全程约一秒，没有窗口、没有报错，
 * 用户看到的就是「点了 UAC 之后什么都没发生」。已知只有 --no-sandbox 能绕过。
 *
 * 处理方式：正常机器不动沙箱；第一次收到这种失败时立刻记下标记并带 --no-sandbox 重启一次，
 * 之后同一版本直接以兼容模式启动。换了程序版本或 Electron 版本会重新探测一次，
 * 系统或上游修好之后能自动回到沙箱模式。兼容模式下仍然失败则弹原生对话框说明，不再静默消失。
 *
 * 代价：兼容模式下 GPU、音频等辅助进程和方位叠加层不再受 Chromium 沙箱隔离。
 * 浮窗外壳和启动器本来就以 sandbox: false 运行；其 B 站 webview 默认启用沙箱。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKER_FILE = 'sandbox-fallback.json';
const LOG_FILE = 'startup.log';
const LOG_MAX_BYTES = 128 * 1024;
const NO_SANDBOX_SWITCH = 'no-sandbox';
const NO_SANDBOX_ARG = '--' + NO_SANDBOX_SWITCH;
/** Chromium 的 SBOX_ERROR_CREATE_PROCESS：沙箱 broker 的 CreateProcessAsUserW 失败 */
const SBOX_ERROR_CREATE_PROCESS = 18;
/**
 * 沙箱子进程读不到自己的程序目录时也起不来，但表现为「启动后立刻自杀」而不是 launch-failed：
 * STATUS_BREAKPOINT / STATUS_STACK_BUFFER_OVERRUN（Chromium 的 IMMEDIATE_CRASH）。
 * 显卡驱动崩溃一般是 0xC0000005，不在此列，交给 Chromium 自己降级到软件渲染。
 */
const SANDBOX_ABORT_CODES = new Set([0x80000003 | 0, 0xc0000409 | 0]);
/** 窗口出现之前 GPU 进程以上述退出码连挂几次算沙箱问题（Chromium 每种模式容忍 3 次） */
const GPU_ABORT_LIMIT = 2;

function buildId(app) {
  return { appVersion: String(app.getVersion()), electron: String(process.versions.electron || '') };
}

function readMarker(file) {
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    return marker && typeof marker === 'object' ? marker : null;
  } catch {
    return null;
  }
}

function removeFile(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* 不存在或删不掉都不影响启动 */
  }
}

/**
 * 只保留最近的日志：超过上限时丢掉前半段，避免常驻工具把日志越写越大。
 * 文件带 UTF-8 BOM：旧版 Windows 10 的记事本没有 BOM 会把中文按 ANSI 读成乱码。
 */
function createLogger(file) {
  const BOM = '\ufeff';
  return (tag, message) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let head = BOM;
      try {
        head = '';
        if (fs.statSync(file).size > LOG_MAX_BYTES) {
          const text = fs.readFileSync(file, 'utf8');
          fs.writeFileSync(file, BOM + text.slice(text.indexOf('\n', Math.floor(text.length / 2)) + 1), 'utf8');
        }
      } catch {
        head = BOM; // 文件还不存在
      }
      fs.appendFileSync(file, `${head}${new Date().toISOString()} [${tag}] ${message}\n`, 'utf8');
    } catch {
      /* 诊断日志写不进去不能反过来挡住启动 */
    }
  };
}

/** 把一次子进程退出归类成沙箱失败；不是沙箱问题返回 null */
function classify(details) {
  if (!details || details.type !== 'GPU') return null;
  if (details.reason === 'launch-failed') return 'gpu-launch-failed';
  if ((details.reason === 'crashed' || details.reason === 'abnormal-exit') &&
      SANDBOX_ABORT_CODES.has(details.exitCode | 0)) {
    return 'gpu-sandbox-abort';
  }
  return null;
}

function failureDialog({ details, logFile, exe }) {
  const code = Number(details.exitCode);
  const system = Number.isFinite(details.systemErrorCode) ? `，系统错误 ${details.systemErrorCode}` : '';
  return {
    type: 'error',
    title: '原神跟跑助手无法启动',
    message: '图形进程无法启动，程序即将退出。',
    detail: [
      '已经自动改用关闭 Chromium 沙箱的兼容模式，仍然无法创建图形进程' +
        `（错误码 ${code}${code === SBOX_ERROR_CREATE_PROCESS ? '：Windows 拒绝创建子进程' : ''}${system}）。`,
      '常见原因：安全软件拦截、AppLocker 或软件限制策略、程序放在网络共享或受限目录里。' +
        '可以把程序目录加入安全软件的信任区，或换到本地磁盘的普通文件夹后再试。',
      `程序位置：${exe}`,
      `诊断日志：${logFile}（反馈问题时请附上）`
    ].join('\n\n'),
    buttons: ['退出'],
    defaultId: 0,
    noLink: true
  };
}

/**
 * 必须在 app ready 之前、userData 确定之后调用：标记文件放在 dataDir，
 * 兼容模式靠 appendSwitch 生效，两者都要赶在第一个子进程创建之前。
 *
 * @returns {{mode: 'off'|'normal'|'fallback'|'manual', logFile: string, log: Function, startupComplete: Function}}
 */
function install({ app, dialog, dataDir, platform = process.platform, argv = process.argv, beforeExit }) {
  const logFile = path.join(dataDir, LOG_FILE);
  const log = createLogger(logFile);
  if (platform !== 'win32') {
    return { mode: 'off', logFile, log, startupComplete() {} };
  }

  const markerFile = path.join(dataDir, MARKER_FILE);
  const build = buildId(app);
  const manual = argv.includes(NO_SANDBOX_ARG) || app.commandLine.hasSwitch(NO_SANDBOX_SWITCH);
  const marker = readMarker(markerFile);
  let mode = 'normal';
  if (marker && marker.appVersion === build.appVersion && marker.electron === build.electron) {
    mode = 'fallback';
    if (!manual) app.commandLine.appendSwitch(NO_SANDBOX_SWITCH);
  } else if (fs.existsSync(markerFile)) {
    // 损坏的标记，或上一个版本留下的：删掉，按正常沙箱模式重新探测一次
    removeFile(markerFile);
  }
  // 重启带来的 --no-sandbox 与用户手动加的等价：都已经没有沙箱可关，再失败只能报错
  if (manual && mode === 'normal') mode = 'manual';

  log('start', JSON.stringify({
    app: build.appVersion,
    electron: build.electron,
    chrome: process.versions.chrome || '',
    os: `${os.release()} ${os.arch()}`,
    packaged: !!app.isPackaged,
    sandbox: mode
  }));

  let started = false;
  let handled = false;
  let aborts = 0;

  function engage(kind, details) {
    if (handled) return;
    handled = true;
    try {
      beforeExit?.();
    } catch (err) {
      log('cleanup', String(err?.message || err));
    }

    if (mode === 'normal') {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(markerFile, JSON.stringify({
          ...build,
          reason: kind,
          exitCode: details.exitCode,
          systemErrorCode: details.systemErrorCode,
          os: os.release(),
          at: new Date().toISOString()
        }, null, 2), 'utf8');
      } catch (err) {
        log('fallback', `标记写入失败：${err.code || err.message}`);
      }
      log('fallback', `${kind}，以兼容模式（${NO_SANDBOX_ARG}）重新启动`);
      // 显式带上开关：标记没写成时也不会陷入「失败 → 重启 → 失败」的循环
      app.relaunch({ args: [...argv.slice(1).filter((a) => a !== NO_SANDBOX_ARG), NO_SANDBOX_ARG] });
      app.exit(0);
      return;
    }

    log('fatal', `${kind}，兼容模式下仍然失败`);
    try {
      // 原生对话框不需要渲染进程和 GPU 进程；它阻塞主线程，Chromium 走不到那次静默退出
      dialog.showMessageBoxSync(failureDialog({ details, logFile, exe: app.getPath('exe') }));
    } catch (err) {
      log('fatal', `对话框显示失败：${err.message}`);
    }
    app.exit(1);
  }

  app.on('child-process-gone', (_event, details) => {
    if (!details || details.reason === 'clean-exit') return;
    log('child-gone', JSON.stringify(details));
    const kind = classify(details);
    if (kind === 'gpu-launch-failed') {
      engage(kind, details);
    } else if (kind === 'gpu-sandbox-abort' && !started && mode === 'normal') {
      // 已经没有沙箱时这类崩溃与沙箱无关，留给 Chromium 自己降级
      aborts += 1;
      if (aborts >= GPU_ABORT_LIMIT) engage(kind, details);
    }
  });
  app.on('render-process-gone', (_event, _contents, details) => {
    if (!details || details.reason === 'clean-exit') return;
    log('render-gone', JSON.stringify(details));
  });

  return {
    mode,
    logFile,
    log,
    /** 第一个窗口画出来之后调用：此后的 GPU 崩溃不再当作启动期沙箱故障 */
    startupComplete() {
      if (started) return;
      started = true;
      log('ready', '启动器窗口已显示');
    }
  };
}

module.exports = {
  install,
  classify,
  MARKER_FILE,
  LOG_FILE,
  LOG_MAX_BYTES,
  NO_SANDBOX_ARG,
  GPU_ABORT_LIMIT
};
