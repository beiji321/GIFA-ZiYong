'use strict';

/**
 * 原神跟跑助手 —— 主进程
 * 职责：无边框置顶窗口、全局快捷键、B 站视频解析、设置持久化
 */

const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  globalShortcut,
  ipcMain,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  screen,
  session,
  shell,
  desktopCapturer
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const hookHotkeys = require('./hook-hotkeys');
const { mergeHotkeys, prepareHotkeyUpdate } = require('./hotkey-config');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 允许无用户手势自动播放（浮窗场景必须有）
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// 关掉 Chromium 的「后台进程进效率模式」：Windows 11 会在进程所有窗口都最小化时
// 把它判成后台、套上 EcoQoS（低优先级 + 省电调度）。低级钩子跑在独立线程里，
// 一旦被这样降速，按键回调就会超时、甚至被系统悄悄把钩子摘掉 ——
// 表现正是「启动器在前台时热键好用，一最小化就全废，切回来也回不来」。
app.commandLine.appendSwitch('disable-features', 'UseEcoQoSForBackgroundProcess');

/**
 * 是否以管理员（高完整性级别）身份运行。
 *
 * 这条决定了热键在游戏里能不能用：原神这类带反作弊的游戏一律以管理员启动，
 * 而 Windows 的 UIPI 规定 —— **非提权进程的低级键盘/鼠标钩子，收不到提权窗口在前台时的按键**。
 * 于是现象就是「启动器在前台时热键好用，一切进游戏里就全废」，与代码无关。
 * 这不是我们能绕的系统约束，只能提权运行（打包版清单里已要求管理员）。
 */
let cachedElevated = null;
// 提权重启时带上的标记，用来区分「本来就没提权」和「用户刚拒绝过 UAC」
const ELEVATE_FLAG = '--elevated';
function isElevated() {
  if (cachedElevated !== null) return cachedElevated;
  try {
    // 用 PowerShell 而不是 `whoami /groups`：在 Git Bash / MSYS 里启动时，
    // MSYS 会把 `/groups` 当 POSIX 路径转换成 `C:/Program Files/Git/groups`，
    // whoami 直接报「extra operand」→ 提权状态被误判成 false，白弹一次 UAC。
    const psExe = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    const out = execFileSync(
      psExe,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 }
    );
    // S-1-16-12288 = High Mandatory Level（管理员）；中完整性是 S-1-16-8192
    cachedElevated = out.trim().toLowerCase() === 'true';
  } catch {
    cachedElevated = false;
  }
  return cachedElevated;
}

/* ------------------------------------------------- 按需提权重启（UAC） */

/**
 * 以管理员身份重新启动本程序（兜底路径）。
 *
 * 现在打包版是「双击即提权」，配置在 package.json：
 *   win.requestedExecutionLevel = "requireAdministrator"  → 主 exe 清单
 *   portable.requestExecutionLevel = "admin"              → NSIS 自解压壳清单
 * 两层都提权，双击时 Windows 只弹一次 UAC、壳只解压一次，不必进来再点重启。
 *
 * 历史坑（dist-release3）：只给内层 app.exe 加 requireAdministrator、壳仍是 asInvoker，
 * 壳用 ExecWait 启动 app.exe 时 Windows 返回 ERROR_ELEVATION_REQUIRED(740)，
 * 双击毫无反应、进程都不出现。关键是**壳和主程序必须同时提权**。
 *
 * 运行时重启只留给：开发版（electron.exe 无清单）、zip 解压直跑、UAC 被取消后
 * 仍想用普通权限，以及任何清单没生效的场景。提权是为低级键盘钩子服务的：
 * 不提权的话，UIPI 会挡住提权窗口（原神）在前台时的按键。
 */
function relaunchElevated() {
  return new Promise((resolve) => {
    // portable 版必须用**原始 exe**：process.execPath 指向 %TEMP% 里的解压副本，
    // 从那里重启等于从一个随时会被清掉的目录里启动。
    const exePath = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
    const argv = process.argv
      .slice(1)
      .filter((a) => !a.startsWith('--inspect') && !a.startsWith('--remote-debugging') && a !== ELEVATE_FLAG);
    // 打上标记：万一下次判断提权状态出错，也不会陷入「无限弹 UAC」
    argv.unshift(ELEVATE_FLAG);

    // PowerShell 单引号字符串里，单引号本身写成两个
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const argList = argv.length ? ` -ArgumentList @(${argv.map(q).join(',')})` : '';
    const script =
      `Start-Process -FilePath ${q(exePath)}${argList}` +
      ` -WorkingDirectory ${q(process.cwd())} -Verb RunAs -ErrorAction Stop`;

    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
        { windowsHide: true, stdio: 'ignore' }
      );
    } catch (err) {
      resolve({ ok: false, reason: err.message });
      return;
    }
    child.on('error', (err) => resolve({ ok: false, reason: err.message }));
    child.on('exit', (code) => {
      // 退出码 0 = 提权后的新进程已经创建；非 0 基本都是用户在 UAC 上点了「否」
      resolve(code === 0 ? { ok: true } : { ok: false, reason: 'uac-cancelled' });
    });
  });
}

/* ------------------------------- 数据目录：绿色版 / 安装版 [DATA-DIR-START] */

/**
 * 决定 userData 落在哪 —— 两种发行形态必须分流，否则安装版必坏。
 *
 *  绿色版（zip / portable 单 exe）：exe 同级 data\，整夹拷走设置与 ROI 标定一起走。
 *  安装版（NSIS，装到 Program Files）：%APPDATA%\原神跟跑助手\，
 *    因为 Program Files 对普通用户只读，写 settings.json 会直接抛 EPERM。
 *
 * 判定**只看 installed.flag**（由 build/installer.nsh 安装时写在 exe 同级），
 * 不猜安装路径：有人把绿色版放进 Program Files，也有人把安装版装在 D 盘可写目录，
 * 路径都不可靠。zip 里放的是 portable.flag，安装版里没有它，两者不会混淆。
 *
 * 开发时（npm start）一律用系统默认 %APPDATA%，不动用户已有设置和登录态。
 *
 * 两个老坑：
 * 1. portable 单 exe 先解压到 %TEMP% 再运行，process.execPath 指向临时副本，
 *    真实位置 electron-builder 写在 PORTABLE_EXECUTABLE_DIR 里，必须优先用它。
 * 2. 程序目录不可写时退回 APPDATA，否则启动阶段就会因为建不了 settings.json 报错。
 */
const DATA_DIR_NAME = 'data';
const INSTALLED_FLAG = 'installed.flag';
const PORTABLE_FLAG = 'portable.flag';
const MIGRATE_FROM_FILE = 'migrate-from.txt';
const MIGRATED_FLAG = '.migrated';
// settings.json 内含 ROI 标定、窗口位置、观看记录；两张 png 是识别调试截图。
// Chromium 缓存 / GPUCache / 日志一律不搬，避免把几十 MB 垃圾和隐私带进新目录。
const MIGRATE_FILES = ['settings.json', 'bearing-dump.png', 'bearing-frame.png'];
const MIGRATE_LOGIN_DIR = 'Partitions';
const MIGRATE_LOGIN_FILES = ['Local State'];

function programDir() {
  return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
}

function hasProgramFlag(name) {
  try {
    return fs.existsSync(path.join(programDir(), name));
  } catch {
    return false;
  }
}

function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** 只复制白名单文件，且绝不覆盖目标里已存在的内容 */
function copyFileIfAbsent(src, dst) {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return false;
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (err) {
    console.warn(`[data] 复制 ${path.basename(src)} 失败：${err.code || err.message}`);
    return false;
  }
}

function copyTreeIfAbsent(srcDir, dstDir) {
  if (!fs.existsSync(srcDir) || fs.existsSync(dstDir)) return;
  try {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
      const from = path.join(srcDir, ent.name);
      const to = path.join(dstDir, ent.name);
      if (ent.isDirectory()) copyTreeIfAbsent(from, to);
      else if (ent.isFile()) copyFileIfAbsent(from, to);
    }
  } catch (err) {
    console.warn(`[data] 复制目录 ${srcDir} 失败：${err.code || err.message}`);
  }
}

/**
 * 旧绿色版 data\ 的可能位置，按优先级：
 *  1. 安装页「迁移旧数据」填的目录 → 写在 exe 同级 migrate-from.txt 第一行
 *  2. GRB_MIGRATE_FROM 环境变量（手动 / CI 用）
 *  3. exe 同级 data\（把安装版覆盖装到原绿色版目录里的场景）
 * 允许填绿色版根目录或它里面的 data 目录，自动识别。
 */
function legacyDataCandidates(target) {
  const out = [];
  const add = (value) => {
    if (!value) return;
    let dir = path.resolve(String(value).trim().replace(/^"|"$/g, ''));
    if (!fs.existsSync(path.join(dir, 'settings.json')) &&
        fs.existsSync(path.join(dir, DATA_DIR_NAME, 'settings.json'))) {
      dir = path.join(dir, DATA_DIR_NAME);
    }
    if (dir !== path.resolve(target) && !out.includes(dir)) out.push(dir);
  };
  const lines = readTextSafe(path.join(programDir(), MIGRATE_FROM_FILE)).split(/\r?\n/);
  add(lines[0]);
  add(process.env.GRB_MIGRATE_FROM);
  add(path.join(programDir(), DATA_DIR_NAME));
  return out;
}

function migrationIncludeLogin() {
  const text = readTextSafe(path.join(programDir(), MIGRATE_FROM_FILE));
  return /includeLogin\s*=\s*1/.test(text) || process.env.GRB_MIGRATE_LOGIN === '1';
}

/**
 * 安装版首次启动时，把旧绿色版的设置 / ROI 标定搬进 %APPDATA%。
 *
 * 登录态（Partitions + Local State）**默认不搬**：过去「打包前顺手把 Cookie 库
 * 拷进 data\」的教训是，那份带凭证的目录会被整包发出去，等于送账号。
 * 这里方向相反 —— 只在本机、从用户明确指定的旧目录搬进本机 APPDATA，
 * 不进任何发布产物，所以做成安装页上的可选项（includeLogin=1）是安全的。
 * 复制而非移动，旧绿色版仍可照常用；.migrated 标记保证只跑一次。
 */
function migrateLegacyData(target) {
  const marker = path.join(target, MIGRATED_FLAG);
  if (fs.existsSync(marker) || fs.existsSync(path.join(target, 'settings.json'))) {
    return { ok: false, reason: 'already-initialized' };
  }
  const source = legacyDataCandidates(target).find(
    (dir) => fs.existsSync(path.join(dir, 'settings.json'))
  );
  if (!source) return { ok: false, reason: 'no-legacy-data' };

  const withLogin = migrationIncludeLogin();
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    console.warn(`[data] 创建 ${target} 失败：${err.code || err.message}`);
    return { ok: false, reason: 'target-not-writable' };
  }

  let copied = 0;
  for (const name of MIGRATE_FILES) {
    if (copyFileIfAbsent(path.join(source, name), path.join(target, name))) copied++;
  }
  if (withLogin) {
    for (const name of MIGRATE_LOGIN_FILES) {
      if (copyFileIfAbsent(path.join(source, name), path.join(target, name))) copied++;
    }
    copyTreeIfAbsent(path.join(source, MIGRATE_LOGIN_DIR), path.join(target, MIGRATE_LOGIN_DIR));
  }
  try {
    fs.writeFileSync(marker, JSON.stringify({ from: source, at: new Date().toISOString(), withLogin }, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[data] 写迁移标记失败：${err.code || err.message}`);
  }
  console.log(`[data] 已从 ${source} 迁移 ${copied} 项${withLogin ? '（含登录态）' : '（不含登录态）'}`);
  return { ok: true, from: source, copied, withLogin };
}

let installMode = 'dev'; // dev | installed | portable | fallback
function resolveUserDataDir() {
  const fallback = app.getPath('userData');
  if (!app.isPackaged) {
    installMode = 'dev';
    return fallback;
  }

  if (hasProgramFlag(INSTALLED_FLAG)) {
    installMode = 'installed';
    try {
      migrateLegacyData(fallback);
    } catch (err) {
      console.warn(`[data] 旧数据迁移异常，继续用 ${fallback}：${err.message}`);
    }
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {}
    return fallback;
  }

  const dir = path.join(programDir(), DATA_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 探写权限：只判断 exists 不够，目录可能存在但没有写权限
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    installMode = 'portable';
    return dir;
  } catch (err) {
    console.warn(`[data] 程序目录不可写（${err.code || err.message}），回退到 ${fallback}`);
    installMode = 'fallback';
    return fallback;
  }
}

const USER_DATA_DIR = resolveUserDataDir();
app.setPath('userData', USER_DATA_DIR);
// 缓存类目录一并挪过去，否则 C 盘会多出一份 Chromium 缓存
app.setPath('sessionData', USER_DATA_DIR);
/* [DATA-DIR-END] ---------------------------------------------------------- */


// 支持 `npm start -- --open BV1xx411c7mD`：从命令行/快捷方式直接带视频启动
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  const v = i !== -1 ? process.argv[i + 1] : '';
  return v && !v.startsWith('--') ? v : '';
}
const OPEN_ARG = argValue('--open');

// 播放器与登录窗口共用同一个持久化分区，登录一次全局生效
const BILI_PARTITION = 'persist:bili';

function biliSession() {
  return session.fromPartition(BILI_PARTITION);
}

/** 用该分区的 Cookie 发请求，避开 B 站风控，并且能读到登录态 */
function biliFetch(url, extraHeaders) {
  return biliSession().fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json, text/plain, */*',
      ...(extraHeaders || {})
    }
  });
}

const DEFAULT_HOTKEYS = {  togglePlay: 'Alt+Space',
  seekBack: 'Alt+Left',
  seekFwd: 'Alt+Right',
  prevPart: 'Alt+Up',
  nextPart: 'Alt+Down',
  toggleVisible: 'Alt+H',
  togglePass: 'Alt+L',
  toggleOpacity: 'Alt+O',
  toggleImmersion: 'Alt+I',
  cycleSpeed: 'Alt+S',
  holdSpeed: 'F8'
};

const PLAYBACK_RATES = [1, 1.25, 1.5, 2];
const HOLD_PLAYBACK_RATES = [1.25, 1.5, 2, 2.5, 3];

const HOTKEY_META = [
  { key: 'togglePlay', label: '播放 / 暂停' },
  { key: 'seekBack', label: '后退 5 秒' },
  { key: 'seekFwd', label: '前进 5 秒' },
  { key: 'prevPart', label: '上一分 P' },
  { key: 'nextPart', label: '下一分 P' },
  { key: 'toggleVisible', label: '隐藏 / 显示浮窗' },
  { key: 'togglePass', label: '鼠标穿透 开 / 关' },
  { key: 'toggleOpacity', label: '半透明 开 / 关' },
  { key: 'toggleImmersion', label: '纯视频沉浸 开 / 关' },
  { key: 'cycleSpeed', label: '循环倍速 1 / 1.25 / 1.5 / 2' },
  { key: 'holdSpeed', label: '长按临时加速（松开恢复）', hold: true }
];

/**
 * 出厂预置的识别区域 —— 只用来定「第一次框选时金色圆环的起始位置」，不写进 rois。
 *
 * 这里踩过一个坑：早先把两个猜的坐标直接塞进 DEFAULT_SETTINGS.bearing.rois，
 * 而保存逻辑是「位置接近就替换、否则追加」。用户框一次，猜错的那条留在列表里，
 * 面板上就显示「已标定 2 处」，其中一处压根没对准小地图 —— 这就是
 * 「框选一次出两次标定」的根因。现在出厂列表为空，下面这个值只影响圆环初值。
 *
 * 数值来自实测对准的原生迷你地图 / 博主放大贴片布局。
 */
const SEED_ROI = { cx: 0.1434, cy: 0.2481, r: 0.1542 };

/** 0.2.3 及更早版本写进出厂列表的猜测值，装载设置时精确剔除（容差 1e-4，不会误伤真实标定） */
const LEGACY_SEED_ROIS = [
  { cx: 0.0875, cy: 0.122, r: 0.046 },
  { cx: 0.148, cy: 0.222, r: 0.163 }
];

/** 剔除历史遗留的出厂猜测值；顺手丢掉结构不合法的条目 */
function dropLegacySeeds(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (r) =>
      r &&
      Number.isFinite(r.cx) &&
      Number.isFinite(r.cy) &&
      Number.isFinite(r.r) &&
      !LEGACY_SEED_ROIS.some(
        (s) =>
          Math.abs(s.cx - r.cx) < 1e-4 &&
          Math.abs(s.cy - r.cy) < 1e-4 &&
          Math.abs(s.r - r.r) < 1e-4
      )
  );
}

const DEFAULT_SETTINGS = {
  // 内容区 896×504 正好 16:9，加上标题栏 30 + 控制条 34 = 604
  bounds: { width: 896, height: 568, x: null, y: null, aspect: 2 },
  // 位置的比例表示（0~1），与 bounds.x/y 并存。
  // 换显示器 / 改分辨率 / 改 DPI 后同一个像素坐标会落到完全不同的相对位置，
  // 存「相对工作区的比例 + 显示器标识」才能跨设备恢复。
  windowXRatio: null,
  windowYRatio: null,
  windowDisplayId: null,
  windowDisplayBounds: null,
  // 贴边吸附造成的出屏溢出，单独存像素，不参与比例换算
  windowSnapDx: 0,
  windowSnapDy: 0,
  pinned: true,
  // 16:9 比例锁定：锁的是「视频内容区」，不含标题栏与控制条
  ratioLocked: false,
  // 贴边吸附的手动微调（-20 ~ +20 px）：正值整体外推补缝隙，负值回缩消切边
  snapAdjustment: 0,
  // 叠加层渲染方式：false = 上游原版（圆环+箭头），true = 四轴罗盘雷达
  overlayRadar: false,
  // 放大提醒：方向变化时把叠加层底下那块（也就是游戏小地图）抓一帧放大显示
  alertEnabled: false,
  alertX: null,
  alertY: null,
  // 关闭启动器时最小化到托盘（false = 点 X 直接退出整个程序）
  closeToTray: true,
  // 托盘单击行为：'launcher' 显示启动器（默认） | 'float' 切换浮窗
  trayClickAction: 'launcher',
  opacity: 1,
  clickThrough: false,
  mode: 'web',
  volume: 100,
  muted: false,
  playbackRate: 1,
  holdPlaybackRate: 2,
  hoverFadeEnabled: true,
  /* --- 沉浸模式下的三条防遮挡规则 --- */
  // 字幕出现「地图 / 锚点 / 传送」时不淡出（要看地图）
  avoidHideEnabled: true,
  avoidHideHold: 4,
  // 检测到战斗动作时临时压暗，别挡住画面
  combatFadeEnabled: true,
  combatOpacity: 75,
  lastText: '',
  lastPart: 1,
  // 「上次看到」：光有 lastText/lastPart 不够 —— 用户记不住的是「哪个视频、第几 P」，
  // 长链接/BV 号看不出片名，所以额外存标题、视频 id、分 P 总数和最后观看时间。
  lastTitle: '',
  lastVideoId: '',
  lastPageCount: 0,
  lastWatchedAt: 0,
  // 下次启动直接把浮窗起来继续播，不用每次重粘链接
  resumeOnLaunch: true,
  hotkeys: { ...DEFAULT_HOTKEYS },
  // 字幕精灵：自动点开 B 站播放器字幕并把文本镜像到浮窗底部
  enableSubtitleSprite: false,
  // 优先用官方字幕接口（带精确时间戳，暂停/拖动都准）。
  // 关掉就只走 DOM 抓取。
  subtitleUseApi: true,
  // 隐藏播放器原生字幕：避免「原生小字幕 + 精灵大字幕」两条同时出现。
  // 只影响显示，不影响抓取（元素还在 DOM 里）。
  subtitleHideNative: true,
  // 同一时刻有多行字幕时合并显示；关掉只取最新一条
  subtitleMergeOverlap: true,
  // 暂停时隐藏字幕；默认保持显示
  subtitleHideOnPause: false,
  // 自动点开播放器字幕按钮。关掉后不改动播放器，只有官方接口能给字幕
  subtitleAutoOpen: true,
  // 视觉绿弧（镜头朝向）：低画质下极易乱飘，默认关闭。
  // 关掉时访客页直接不跑扇形识别，省 CPU。
  enableVisionGreenArc: false,
  // 字幕转向提醒：字幕里出现「左转/右转/往东」等词时弹大箭头
  enableTurnReminder: true,
  // 分组开关：左右 / 上下 可以分开启用
  turnEnableLR: true,
  turnEnableUD: true,
  // 转向提示外观：贴边距离(px)、整体缩放(%)、停留时长(秒)、不透明度(%)
  turnOffset: 400,
  turnScale: 100,
  turnDuration: 2,
  turnOpacity: 85,
  turnColor: '#49b2fc',
  // 左右提示的垂直位置（%），上下提示的水平位置（%）
  turnPosY: 50,
  turnPosX: 50,
  // 字幕外观（对应「B站设置 → 底部字幕精灵」的各个控件）
  subtitleScale: 100,          // 字号 50-200%
  subtitleColor: '#ffffff',    // 文字颜色
  subtitleStroke: 'outline',   // none | outline(四向黑边) | shadow(单向投影)
  subtitlePos: 'center',       // center | left | right
  subtitleOffset: 230,         // 距屏幕底边 px，10-500（默认按用户实测调到 230）
  subtitleBgOpacity: 70,       // 背景不透明度 0-100%
  subtitleKeepRatio: true,     // 等比缩放（随屏幕高度放大）
  subtitleFade: true,          // 淡入淡出
  subtitleHold: 3,             // 一句话停留多久（秒）
  subtitleMaxWidth: 88,        // 字幕最大宽度（% 屏宽）
  subtitleWeight: 800,         // 字重 500-900
  subtitleRadius: 8,           // 背景圆角(px)
  // 全屏弹幕投影：把 B 站弹幕镜像到一块全屏透明置顶层上飘过
  enableDanmakuProjection: false,
  // 隐藏播放器原生弹幕：避免同一批弹幕在画面里出现两遍。
  // 只影响显示，弹幕数据走官方接口，和播放器画不画无关。
  danmakuHideNative: true,
  // 弹幕外观：显示区域高度占比(%)、不透明度(%)、字号(%)、速度(0慢~100快)
  danmakuArea: 50,
  danmakuOpacity: 80,
  danmakuScale: 100,
  danmakuSpeed: 50,
  danmakuWeight: 700,          // 字重 400-900
  danmakuMax: 60,              // 同屏弹幕上限（防过密）
  danmakuStroke: true,         // 四向黑描边
  bearing: {
    enabled: false,
    /**
     * 识别区域列表：{ cx, cy, r }，cx/cy 按画面宽高归一、r 按画面宽度归一。
     * 一个视频里布局会变（原生迷你地图 / 剪辑放大的地图贴片），所以要存多块。
     *
     * 出厂**必须为空**：预置猜测值会被算成「已经标定过」，用户框一次就变两处。
     * 圆环初值走 SEED_ROI，未标定时界面也会主动引导去框一次。
     */
    rois: [],
    // 用户是否在画面上真正框过一次；没框过就先引导标定，不拿默认值硬猜
    calibrated: false,
    // 按视频记住标定结果
    roiBy: {},
    // 叠加层：圆环半径（屏幕像素）与圆心屏幕坐标
    radius: 110,
    x: null,
    y: null,
    // 圆心的比例表示（相对所在显示器工作区）与显示器标识，跨分辨率恢复用
    xRatio: null,
    yRatio: null,
    displayId: null,
    displayBounds: null
  }
};

/**
 * 记住「上次看到」。换片和切 P 都走这里，字段一次写全。
 * 抽成纯函数是为了能离线回归（只就地改传入对象，不碰 fs / Electron）。
 */
/** 启动时是否自动把浮窗起来继续播（纯函数，便于离线回归） */
function shouldResumeOnLaunch(s, openArg) {
  if (openArg) return false; // --open 显式指定了视频，别抢
  return !!(s && s.resumeOnLaunch !== false && s.lastText);
}

function noteWatched(s, info) {
  if (!s) return s;
  const text = String(info.text || '').trim();
  if (text) s.lastText = text;
  const p = Number(info.p);
  if (Number.isFinite(p) && p > 0) s.lastPart = Math.floor(p);
  if (info.id) s.lastVideoId = String(info.id);
  if (info.title !== undefined) s.lastTitle = String(info.title || '');
  if (info.pageCount !== undefined) {
    const n = Number(info.pageCount);
    s.lastPageCount = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  s.lastWatchedAt = Date.now();
  return s;
}

/** 音量用 0..100 保存；静音独立保存，取消静音时仍能回到原来的音量。 */
function playbackSettings(s = {}) {
  const volume = Number.isFinite(s.volume) ? Math.min(100, Math.max(0, s.volume)) : 100;
  return {
    volume,
    muted: typeof s.muted === 'boolean' ? s.muted : volume === 0,
    playbackRate: Number.isFinite(s.playbackRate) ? Math.min(3, Math.max(0.25, s.playbackRate)) : 1
  };
}

function updatePlaybackSettings(s, patch = {}) {
  const next = playbackSettings(s);
  if (Number.isFinite(patch.volume)) {
    next.volume = Math.min(100, Math.max(0, patch.volume));
    // 启动器拖动音量时，正值取消静音；只切静音不会丢掉原来的音量。
    next.muted = next.volume === 0;
  }
  if (typeof patch.muted === 'boolean') next.muted = patch.muted;
  if (Number.isFinite(patch.playbackRate)) next.playbackRate = Math.min(3, Math.max(0.25, patch.playbackRate));
  const changed = Object.keys(next).some((key) => s[key] !== next[key]);
  Object.assign(s, next);
  return changed;
}

let settings = structuredClone(DEFAULT_SETTINGS);
let win = null;         // 跟跑浮窗（无边框置顶，只管播放）
let consoleWin = null;  // 启动器（所有设置都在这里）
let loginWin = null;
let playbackGuest = null;
let playbackToken = 0;
let playbackGate = 0;
let quittingFromConsole = false; // 关启动器 = 退出整个应用，防止 closed 事件重入
let failedHotkeys = [];
let saveTimer = null;
// 渲染层上报的输入状态：打字时不该触发单键热键，但「窗口在前台」不等于在打字
let typingInField = false;
let capturingHotkey = false;
let holdSpeedActive = false;
let immersion = false;
let hoverFaded = false;
let hoverTimer = null;
let hoverCandidate = false;
let hoverCandidateAt = 0;
/** 智能防遮挡：在此之前强制不透明（毫秒时间戳） */
let avoidUntil = 0;
let avoidTimer = null;
/** 战斗防遮挡：在此之前压暗 */
let combatUntil = 0;
let combatTimer = null;
/** 左键长按判定用 */
let combatDownAt = 0;
/** 连点判定用（最近几次左键点击时间） */
let combatClicks = [];

/* ------------------------------------------------------------------ 设置 */

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    const rawBearing = raw.bearing || {};

    // 迁移：剔除 0.2.3 及更早版本写进出厂列表的猜测区域。
    // 那两条会被当成「已标定」，用户框一次就变成两处标定，先清干净再谈别的。
    const rois = dropLegacySeeds(rawBearing.rois);
    const roiBy = {};
    for (const [id, list] of Object.entries(rawBearing.roiBy || {})) {
      const kept = dropLegacySeeds(list);
      if (kept.length) roiBy[id] = kept;
    }

    settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...raw,
      ...playbackSettings(raw),
      holdPlaybackRate: HOLD_PLAYBACK_RATES.includes(raw.holdPlaybackRate) ? raw.holdPlaybackRate : 2,
      hoverFadeEnabled: raw.hoverFadeEnabled !== false,
      bounds: { ...DEFAULT_SETTINGS.bounds, ...(raw.bounds || {}) },
      hotkeys: mergeHotkeys(DEFAULT_HOTKEYS, raw.hotkeys),
      bearing: {
        ...DEFAULT_SETTINGS.bearing,
        ...rawBearing,
        rois,
        roiBy,
        // 清完一条不剩，就别再标榜「已标定」，否则界面显示 0 处却不去引导框选
        calibrated: !!rawBearing.calibrated && rois.length > 0
      }
    };
  } catch {
    settings = structuredClone(DEFAULT_SETTINGS);
  }
}

function flushSettings() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    console.error('[settings] 写入失败', err);
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 250);
}

function isPlaybackGuest(sender) {
  return !!(win && !win.isDestroyed() && sender === playbackGuest &&
    sender.hostWebContents === win.webContents);
}

function isPlaybackMessage(event, message) {
  return isPlaybackGuest(event.sender) && event.senderFrame === event.sender.mainFrame &&
    message && message.token === playbackToken;
}

function playbackState() {
  return {
    ...playbackSettings(settings),
    holdActive: holdSpeedActive,
    temporaryPlaybackRate: holdSpeedActive ? settings.holdPlaybackRate : null
  };
}

function guestPlaybackSettings() {
  return {
    ...playbackSettings(settings),
    ...(holdSpeedActive ? { temporaryPlaybackRate: settings.holdPlaybackRate } : {})
  };
}

function publishPlaybackSettings() {
  if (playbackGuest && !playbackGuest.isDestroyed()) {
    playbackGuest.send('player', { cmd: 'preferences', ...guestPlaybackSettings() });
  }
  broadcast('playback:state', playbackState());
}

function showNotice(text) {
  broadcast('app:notice', text);
}

function cyclePlaybackRate() {
  const current = PLAYBACK_RATES.indexOf(settings.playbackRate);
  const playbackRate = PLAYBACK_RATES[(current + 1) % PLAYBACK_RATES.length];
  updatePlaybackSettings(settings, { playbackRate });
  persist();
  publishPlaybackSettings();
  broadcast('settings:changed', settings);
  showNotice(`常规倍速 ${playbackRate}×${holdSpeedActive ? `（长按中 ${settings.holdPlaybackRate}×，松开恢复）` : ''}`);
  return playbackRate;
}

function setHoldSpeed(on) {
  const next = !!on && !!win && !win.isDestroyed();
  if (next === holdSpeedActive) return;
  holdSpeedActive = next;
  publishPlaybackSettings();
  showNotice(next ? `临时 ${settings.holdPlaybackRate}× · 松开恢复 ${settings.playbackRate}×` : `已恢复 ${settings.playbackRate}×`);
}

function cancelTemporarySpeed() {
  setHoldSpeed(false);
  hookHotkeys.cancelHeld();
}

function attachPlaybackGuest(guest) {
  playbackGuest = guest;
  guest.setAudioMuted(true);
  guest.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) guest.setAudioMuted(true);
  });
  guest.once('destroyed', () => {
    if (playbackGuest === guest) playbackGuest = null;
  });
}

/* ------------------------------------------------------------------ 窗口 */

function clampBounds(b) {
  let width = Math.max(240, Math.round(b.width || 896));
  let height = Math.max(150, Math.round(b.height || 568));

  // 老配置是 540×340（2:1 扁条，画面上下被压得只剩一条）。只做一次性纠正，
  // 之后用户自己拉伸的任意比例都尊重，不再干预。
  if (b.aspect !== 2 && width < 720) {
    const maxW = Math.round(screen.getPrimaryDisplay().workArea.width * 0.8);
    width = Math.min(896, maxW);
    height = Math.round((width / 16) * 9) + 64; // 标题栏 30 + 控制条 34
  }

  const area = screen.getPrimaryDisplay().workArea;
  let x = Number.isFinite(b.x) ? Math.round(b.x) : area.x + area.width - width - 40;
  let y = Number.isFinite(b.y) ? Math.round(b.y) : area.y + 60;

  // 窗口变宽后可能顶出屏幕右边（老配置是贴着右边缘摆的），拉回来。
  // 用窗口所在的那块屏，别把它从副屏拽回主屏。
  const near = screen.getDisplayNearestPoint({ x, y }).workArea;
  if (x + width > near.x + near.width - 8) x = Math.max(near.x + 8, near.x + near.width - width - 40);

  // 保证窗口至少有一部分落在某个屏幕上
  const visible = screen.getAllDisplays().some((d) => {
    const w = d.workArea;
    return x + width > w.x + 40 && x < w.x + w.width - 40 && y + height > w.y && y < w.y + w.height - 40;
  });
  if (!visible) {
    x = area.x + area.width - width - 40;
    y = area.y + 60;
  }
  return { x, y, width, height };
}

function applyPin() {
  if (!win || win.isDestroyed()) return;
  if (settings.pinned) {
    // screen-saver 层级：在 Windows 上能压住绝大多数全屏/无边框窗口
    win.setAlwaysOnTop(true, 'screen-saver');
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* 平台不支持则忽略 */
    }
  } else {
    win.setAlwaysOnTop(false);
  }
}

function createWindow() {
  // 浮窗可以被关掉再重新启动，这里做成幂等
  if (win && !win.isDestroyed()) {
    win.showInactive();
    applyPin();
    // 幂等分支也要保证叠加层在场（它可能被单独关掉过）
    ensureOverlayVisible();
    // 比例锁定同样要补：关浮窗只是隐藏窗口，再打开走的就是这条分支。
    // 少了这一句，锁定开着但窗口还按上次的尺寸回来，得手动关开一次开关才生效。
    if (settings.ratioLocked) applyRatioLock();
    return win;
  }

  // 优先按比例恢复：换过分辨率/DPI 后像素坐标会飘，比例才稳。
  // restoreWindowRatio 只返回 x/y，必须和原 bounds 合并，否则宽高会丢。
  const clamped = clampBounds(settings.bounds);
  const byRatio = restoreWindowRatio(clamped);
  const bounds = byRatio ? { ...clamped, x: byRatio.x, y: byRatio.y } : clamped;
  // 老的扁条尺寸被纠正过一次就记下来，之后用户自己拉成什么比例都不再干预
  if (settings.bounds.aspect !== 2) {
    settings.bounds = { ...bounds, aspect: 2 };
    persist();
  }

  win = new BrowserWindow({
    ...bounds,
    minWidth: 240,
    minHeight: 150,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0d0e12',
    show: false,
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: true,
    hasShadow: true,
    alwaysOnTop: settings.pinned,
    title: '原神跟跑助手',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  applyPin();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // webview 里的 <video> 一旦走 HTML 全屏，它会铺满整个客户区并盖住我们自己的
  // 标题栏和设置按钮 —— 这是「视频全屏后找不到设置」的根因。直接禁掉，
  // 让 B 站播放器的全屏按钮改走窗口全屏（见 webview-preload 里的 requestFullscreen 改写）。
  win.webContents.on('will-attach-webview', (_e, prefs) => {
    prefs.disableHtmlFullscreen = true;
  });
  win.webContents.on('did-attach-webview', (_e, guest) => attachPlaybackGuest(guest));
  win.webContents.on('render-process-gone', () => {
    cancelTemporarySpeed();
    if (win && !win.isDestroyed()) setImmersion(false);
  });

  // 全屏状态回传给渲染页，用来切换「标题栏/控制条浮层化」
  const sendFullscreen = (on) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('win:state', { fullscreen: on });
  };
  win.on('enter-full-screen', () => sendFullscreen(true));
  win.on('leave-full-screen', () => sendFullscreen(false));

  win.once('ready-to-show', () => {
    win.showInactive(); // 不抢游戏焦点
    applyWindowPresentation();
    notifyFloatState();
    // 魔改扩展：方位标定开着就把叠加层一起叫起来（含出屏拉回）
    ensureOverlayVisible();
    // 魔改扩展：比例锁定开着就按当前宽度对齐一次（要先量到 chromeHeight）
    if (settings.ratioLocked) {
      applyRatioLock();
      // 渲染层的 boot() 是异步的（要先 await app:boot() 再建 webview），
      // ready-to-show 这一刻标题栏和控制条可能还没渲染出来，
      // refreshChromeHeight 会量成 0，算出的高度正好少一个 chrome。
      // 等布局稳定后再对一次 —— 不补这一步，锁着比例但窗口还是错的，
      // 得手动关开一次开关才生效。
      setTimeout(() => {
        if (settings.ratioLocked) applyRatioLock();
      }, 450);
    }
  });

  // 窗口失焦后重新压制层级（某些窗口会抢到上面）
  win.on('blur', () => applyPin());

  const rememberBounds = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    // 保留 aspect 标记：用户手动拉过之后就不该在下次启动时被强行改回 16:9
    settings.bounds = { ...settings.bounds, x: b.x, y: b.y, width: b.width, height: b.height, aspect: 2 };
    saveWindowRatio(b);
    persist();
  };
  win.on('move', rememberBounds);
  win.on('resize', rememberBounds);

  // 魔改扩展：贴边吸附。拖动中实时算会贴哪条边，松手时贴过去
  win.on('will-move', (_e, newBounds) => {
    if (!win || win.isDestroyed() || win.isFullScreen()) {
      showSnapZone(null);
      return;
    }
    showSnapZone(computeSnap(newBounds));
  });
  win.on('moved', () => {
    if (!win || win.isDestroyed()) return;
    applySnap();
    showSnapZone(null);
  });
  // 魔改扩展：比例锁定后按宽度实时校正高度（ratioGuard 挡住 setBounds 引起的递归）
  // 魔改扩展：缩放期间通知渲染层冻结 webview（防边缘黑边闪烁）
  let resizePhaseTimer = null;
  const markResizing = () => {
    sendTo(win, 'win:resize-phase', { active: true });
    clearTimeout(resizePhaseTimer);
    resizePhaseTimer = setTimeout(() => {
      sendTo(win, 'win:resize-phase', { active: false });
    }, 140);
  };
  win.on('resize', markResizing);

  win.on('resize', () => {
    if (!win || win.isDestroyed()) return;
    if (!settings.ratioLocked || ratioGuard) return;
    enforceRatio(win.getBounds().width);
  });

  win.on('closed', () => {
    win = null;
    lastBearingStats = null; // 健康度属于「当前这次识别」，浮窗关了不该显示旧数字
    cancelTemporarySpeed();
    clearInterval(hoverTimer);
    hoverTimer = null;
    immersion = false;
    hoverFaded = false;
    // 主窗关了，叠加层 / 字幕层 / 弹幕层都不能独自留下，
    // 否则 window-all-closed 不触发、进程退不掉
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
    destroySubtitleWindow();
    destroyDanmakuWindow();
    notifyFloatState();
  });
}

/* -------------------------------------------------------- 16:9 比例锁定
 *
 * 锁的是**视频内容区**而不是整个窗口：标题栏 + 控制条那 64px 的 chrome
 * 不该算进 16:9，否则画面会被压扁一点点，越放大越明显。
 * chromeHeight 在运行时向渲染层实测（window.innerHeight - #stage.clientHeight），
 * 这样地址栏展开/收起、不同 DPI 下都能保持精确比例。
 */

let chromeHeight = 64;
let ratioGuard = false;    // setBounds 会再触发 resize，用它挡住递归
let ratioApplying = false; // did-finish-load / ready-to-show 可能先后触发，只跑一次

/** 向渲染层实测 chrome 高度（标题栏 + 控制条） */
function refreshChromeHeight() {
  if (!win || win.isDestroyed()) return Promise.resolve(chromeHeight);
  const js =
    "(function(){var s=document.getElementById('stage');" +
    'return s?Math.max(0, window.innerHeight-s.clientHeight):64})()';
  return win.webContents
    .executeJavaScript(js, true)
    .then((h) => {
      if (Number.isFinite(h) && h >= 0 && h < 400) {
        // 沉浸模式下 chrome 确实是 0；非沉浸量到 0 只可能是页面还没渲染完，
        // 采信它会把高度算少一个 chrome，所以保留上一次的可靠值。
        if (h > 0 || immersion) chromeHeight = Math.round(h);
      }
      return chromeHeight;
    })
    .catch(() => chromeHeight);
}

/** 拖拽边缘时按宽度实时校正高度 */
function enforceRatio(width) {
  if (!win || win.isDestroyed() || !settings.ratioLocked || win.isFullScreen()) return;
  if (ratioGuard) return;
  if (!Number.isFinite(width) || width <= 0) return;

  const w = Math.round(width);
  const h = Math.round((w * 9) / 16) + chromeHeight;
  const b = win.getBounds();
  if (b.width === w && b.height === h) return;

  ratioGuard = true;
  try {
    win.setBounds({ x: b.x, y: b.y, width: w, height: h });
  } finally {
    // setBounds 的 resize 事件可能是异步派发的，等这一轮走完再解锁
    setTimeout(() => {
      ratioGuard = false;
    }, 0);
  }
}

/** 锁定/解锁后立刻对齐一次（内部会先重量 chromeHeight） */
async function applyRatioLock(force = false) {
  if (!win || win.isDestroyed()) return;
  if (ratioApplying) return;
  ratioGuard = false;
  // force：沉浸模式隐藏 chrome 后内容区变高，必须强制对齐，
  // 否则 16:9 视频会在上下留出黑边（用户没开比例锁定也一样要修）
  if (!settings.ratioLocked && !force) return;

  ratioApplying = true;
  try {
    await refreshChromeHeight();
  } finally {
    ratioApplying = false;
  }
  if (!win || win.isDestroyed() || (!settings.ratioLocked && !force)) return;

  const [w] = win.getContentSize();
  if (!Number.isFinite(w) || w <= 0) return;
  const h = Math.round((w * 9) / 16) + chromeHeight;

  ratioGuard = true;
  try {
    win.setContentSize(w, h);
    // 1px 抖动：让 Chromium 认为尺寸真的变了，重新布局一次 webview
    win.setContentSize(w, h + 1);
    await new Promise((r) => setTimeout(r, 16));
    if (!win || win.isDestroyed()) return;
    win.setContentSize(w, h);
  } finally {
    setTimeout(() => {
      ratioGuard = false;
    }, 0);
  }
}

function setRatioLocked(on) {
  settings.ratioLocked = !!on;
  persist();
  applyRatioLock();
  broadcast('settings:changed', settings);
}

/* ------------------------------------------ 位置持久化：比例 + 显示器标识
 *
 * 做法参考 BiliMaku 的 SidebarOverlayPlacement（monitor_name + x_ratio/y_ratio）。
 *
 * 我们原来只存绝对像素，于是踩了一串坑：贴边吸附要按 DPI 写四边补偿、
 * 窗口被夹进屏幕后圆心脱开窗口中心、拖上去弹回来 —— 根源都是
 * 「一个像素坐标要适配多种屏幕几何」。
 *
 * 存成比例后，同一个配置在 1080p / 4K / 125% 缩放下都落在相同的相对位置。
 * 像素字段继续保留：老配置没有比例时用它兜底，且比例换算出的值仍要过一次
 * 可见性检查（防止换了更小的屏幕后窗口完全落在屏幕外）。
 */

/** 按 id / 边界找回保存时的显示器；找不到返回 null */
function findDisplay(displayId, displayBounds) {
  let all = [];
  try {
    all = screen.getAllDisplays();
  } catch {
    return null;
  }
  // 1. id 精确命中（同一台机器、没换接口时最可靠）
  if (displayId !== null && displayId !== undefined) {
    const hit = all.find((d) => String(d.id) === String(displayId));
    if (hit) return hit;
  }
  // 2. 边界近似命中：换过扩展坞/重装后 id 会变，但尺寸位置常常一样
  if (displayBounds && Number.isFinite(displayBounds.width)) {
    const tol = 8;
    const hit = all.find(
      (d) =>
        Math.abs(d.bounds.x - displayBounds.x) <= tol &&
        Math.abs(d.bounds.y - displayBounds.y) <= tol &&
        Math.abs(d.bounds.width - displayBounds.width) <= tol &&
        Math.abs(d.bounds.height - displayBounds.height) <= tol
    );
    if (hit) return hit;
  }
  return null;
}

/** 浮窗：把当前左上角换算成比例写进设置 */
function saveWindowRatio(b) {
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
  let d = null;
  try {
    d = screen.getDisplayMatching(b);
  } catch {
    return;
  }
  if (!d || !d.workArea) return;
  const area = d.workArea;
  const spanX = Math.max(1, area.width - b.width);
  const spanY = Math.max(1, area.height - b.height);
  const rawX = (b.x - area.x) / spanX;
  const rawY = (b.y - area.y) / spanY;
  // 比例只表达「在可移动范围的哪个位置」，夹到 0~1
  settings.windowXRatio = Math.min(1, Math.max(0, rawX));
  settings.windowYRatio = Math.min(1, Math.max(0, rawY));
  // 超出的那部分（贴边吸附的溢出）单独记像素，换分辨率时不该被放大
  settings.windowSnapDx = Math.round(b.x - (area.x + settings.windowXRatio * spanX));
  settings.windowSnapDy = Math.round(b.y - (area.y + settings.windowYRatio * spanY));
  settings.windowDisplayId = d.id;
  settings.windowDisplayBounds = { ...d.bounds };
}

/** 浮窗：按比例算出应该放在哪；没有比例时返回 null */
function restoreWindowRatio(b) {
  if (!Number.isFinite(settings.windowXRatio) || !Number.isFinite(settings.windowYRatio)) return null;
  let d = findDisplay(settings.windowDisplayId, settings.windowDisplayBounds);
  if (!d) {
    try {
      d = screen.getPrimaryDisplay();
    } catch {
      return null;
    }
  }
  const area = d.workArea;
  const spanX = Math.max(1, area.width - b.width);
  const spanY = Math.max(1, area.height - b.height);
  const dx = Number.isFinite(settings.windowSnapDx) ? settings.windowSnapDx : 0;
  const dy = Number.isFinite(settings.windowSnapDy) ? settings.windowSnapDy : 0;
  return {
    x: Math.round(area.x + settings.windowXRatio * spanX + dx),
    y: Math.round(area.y + settings.windowYRatio * spanY + dy)
  };
}

/** 叠加层：把圆心换算成比例（圆心对工作区整体取比例，与圆大小无关） */
function saveBearingRatio(cx, cy) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return;
  let d = null;
  try {
    d = screen.getDisplayNearestPoint({ x: Math.round(cx), y: Math.round(cy) });
  } catch {
    return;
  }
  if (!d || !d.workArea) return;
  const area = d.workArea;
  settings.bearing.xRatio = (cx - area.x) / Math.max(1, area.width);
  settings.bearing.yRatio = (cy - area.y) / Math.max(1, area.height);
  settings.bearing.displayId = d.id;
  settings.bearing.displayBounds = { ...d.bounds };
}

/** 叠加层：按比例算出圆心；没有比例时返回 null */
function restoreBearingRatio() {
  const b = settings.bearing || {};
  if (!Number.isFinite(b.xRatio) || !Number.isFinite(b.yRatio)) return null;
  let d = findDisplay(b.displayId, b.displayBounds);
  if (!d) {
    try {
      d = screen.getPrimaryDisplay();
    } catch {
      return null;
    }
  }
  const area = d.workArea;
  return {
    x: Math.round(area.x + b.xRatio * area.width),
    y: Math.round(area.y + b.yRatio * area.height)
  };
}


/* ---------------------------------------------------------------- 系统托盘
 *
 * 设计参考 GenshinImpactVT 的 window_controls.py（QSystemTrayIcon + 右键菜单）。
 * 图标用 build/icon.ico，菜单里带「关闭启动器时最小化到托盘」的勾选项。
 *
 * 注意：托盘必须**以管理员身份运行**才会显示 —— Shell_NotifyIcon 要往
 * Explorer 的托盘窗口发消息，非提权进程发不过去，而且失败是静默的
 * （Tray 创建成功但托盘区什么都不出现）。正式包 manifest 是
 * requireAdministrator，所以打包版没这个问题；开发态请用 start_dev.bat。
 */

let tray = null;

function trayIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.ico'));
  if (icon.isEmpty()) console.log('图标加载失败');
  return icon;
}

/** 把启动器叫到前台（不存在就重建） */
function showConsoleWindow() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    if (consoleWin.isMinimized()) consoleWin.restore();
    consoleWin.show();
    consoleWin.focus();
    return;
  }
  createConsole();
}

/** 托盘菜单里的「退出软件」：绕开 closeToTray，直接收干净 */
function quitFromTray() {
  quittingFromConsole = true;
  for (const w of [win, overlayWin, loginWin, subtitleWin, danmakuWin, consoleWin]) {
    try {
      if (w && !w.isDestroyed()) w.destroy();
    } catch {
      /* 关窗失败不影响退出 */
    }
  }
  app.quit();
}

function rebuildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const floatAlive = !!(win && !win.isDestroyed());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示启动器', click: () => showConsoleWindow() },
      {
        label: floatAlive ? '隐藏 / 显示浮窗' : '浮窗未启动',
        enabled: floatAlive,
        click: () => toggleVisible()
      },
      { type: 'separator' },
      {
        label: '关闭启动器时最小化到托盘',
        type: 'checkbox',
        checked: settings.closeToTray !== false,
        click: (item) => {
          settings.closeToTray = !!item.checked;
          persist();
          // 控制台里也有同一个开关，改完要同步过去，否则两边显示不一致
          broadcast('settings:changed', settings);
        }
      },
      { type: 'separator' },
      { label: '退出软件', click: () => quitFromTray() }
    ])
  );
}

function createTray() {
  if (tray && !tray.isDestroyed()) return tray;
  tray = new Tray(trayIcon());
  tray.setToolTip('原神跟跑助手 · 单击显示启动器');
  rebuildTrayMenu();
  tray.on('click', () => {
    if (settings.trayClickAction === 'float') toggleVisible();
    else showConsoleWindow();
  });
  tray.on('double-click', () => showConsoleWindow());
  return tray;
}

function destroyTray() {
  if (!tray || tray.isDestroyed()) {
    tray = null;
    return;
  }
  tray.destroy();
  tray = null;
}


/* ---------------------------------------------------------------- 启动器 */

function sendTo(w, channel, payload) {
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/** 广播给所有界面窗口：设置改了，两边都要跟上 */
function broadcast(channel, payload) {
  sendTo(win, channel, payload);
  sendTo(consoleWin, channel, payload);
}

function floatState() {
  return { running: !!(win && !win.isDestroyed()), immersion, hoverFaded };
}

function notifyFloatState() {
  broadcast('float:state', floatState());
  // 托盘菜单里的「隐藏 / 显示浮窗」要跟着浮窗是否存在切换可用状态
  rebuildTrayMenu();
}

/**
 * 当前该用多大不透明度。
 *
 * 三条规则按优先级叠加，越靠前越强势：
 *   1. 智能防遮挡 —— 字幕提到地图/锚点，这时候淡掉就看不见了，强制不透明
 *   2. 战斗防遮挡 —— 检测到 Q/R 或连点，临时压暗
 *   3. 鼠标避让   —— 鼠标移进窗口才淡到 10%
 */
function effectiveOpacity() {
  const now = Date.now();
  const base = Number(settings.opacity);
  const opacity = Number.isFinite(base) ? base : 1;
  if (now < avoidUntil) return opacity;
  if (now < combatUntil) {
    const pct = Number(settings.combatOpacity);
    return Math.min(opacity, (Number.isFinite(pct) ? pct : 75) / 100);
  }
  return hoverFaded ? Math.min(opacity, 0.1) : opacity;
}

function applyWindowPresentation() {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(immersion || settings.clickThrough, { forward: true });
  win.setOpacity(effectiveOpacity());
}

/** 智能防遮挡：字幕里出现看地图类的词 */
function markAvoidHide() {
  if (!settings.avoidHideEnabled) return;
  const hold = Math.max(1, Math.min(30, Number(settings.avoidHideHold) || 4)) * 1000;
  avoidUntil = Date.now() + hold;
  applyWindowPresentation();
  clearTimeout(avoidTimer);
  avoidTimer = setTimeout(() => {
    avoidUntil = 0;
    applyWindowPresentation();
  }, hold + 30);
}

/** 战斗防遮挡：Q/R 或连点左键 */
function markCombat() {
  if (!settings.combatFadeEnabled || !immersion) return;
  combatUntil = Date.now() + 3000;
  applyWindowPresentation();
  clearTimeout(combatTimer);
  combatTimer = setTimeout(() => {
    combatUntil = 0;
    applyWindowPresentation();
  }, 3030);
}

/** 钩子里的原始事件：只关心 Q / R 和左键 */
function onRawHookEvent(ev) {
  if (!ev || !settings.combatFadeEnabled || !immersion) return;
  if (ev.kind === 'key') {
    const q = hookHotkeys.keycodeOf('Q');
    const r = hookHotkeys.keycodeOf('R');
    if ((q && ev.code === q) || (r && ev.code === r)) markCombat();
    return;
  }
  if (ev.kind === 'mouse' && ev.button === 1) {
    combatDownAt = Date.now();
    const now = Date.now();
    combatClicks = combatClicks.filter((t) => now - t < 2000);
    combatClicks.push(now);
    // 2 秒内点 3 下
    if (combatClicks.length >= 3) {
      combatClicks = [];
      markCombat();
    }
    return;
  }
  if (ev.kind === 'mouseup' && ev.button === 1) {
    // 长按 0.5 秒也算战斗动作
    if (combatDownAt && Date.now() - combatDownAt >= 500) markCombat();
    combatDownAt = 0;
  }
}

function updateHoverFade() {
  if (!win || win.isDestroyed()) return;
  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const inside = immersion && settings.hoverFadeEnabled && win.isVisible() && !win.isMinimized() &&
    point.x >= bounds.x && point.x < bounds.x + bounds.width &&
    point.y >= bounds.y && point.y < bounds.y + bounds.height;
  if (inside !== hoverCandidate) {
    hoverCandidate = inside;
    hoverCandidateAt = Date.now();
  }
  if (inside === hoverFaded || Date.now() - hoverCandidateAt < 120) return;
  hoverFaded = inside;
  applyWindowPresentation();
  notifyFloatState();
}

function syncHoverFade() {
  clearInterval(hoverTimer);
  hoverTimer = null;
  hoverCandidate = false;
  hoverCandidateAt = Date.now();
  hoverFaded = false;
  applyWindowPresentation();
  if (immersion && settings.hoverFadeEnabled) hoverTimer = setInterval(updateHoverFade, 60);
}

function setImmersion(on) {
  const next = !!on;
  if (next && (!win || win.isDestroyed())) createWindow();
  if (!win || win.isDestroyed()) return false;
  if (next) {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.showInactive();
  }
  if (immersion === next) return immersion;
  immersion = next;
  const boundsBefore = win.getBounds();
  win.setResizable(!next);
  win.setMovable(!next);
  const boundsAfter = win.getBounds();
  if (['x', 'y', 'width', 'height'].some((key) => boundsAfter[key] !== boundsBefore[key])) win.setBounds(boundsBefore);
  syncHoverFade();
  sendTo(win, 'win:state', { immersion });
  if (playbackGuest && !playbackGuest.isDestroyed()) playbackGuest.send('player', { cmd: 'presentation', videoOnly: immersion });
  notifyFloatState();
  showNotice(immersion ? `已进入纯视频沉浸 · ${settings.hotkeys.toggleImmersion || '启动器开关'} 退出` : '已退出纯视频沉浸');
  return immersion;
}

/** 启动器窗口：16:9、居中、按工作区留边等比缩放（小屏/125% 缩放也不出界） */
function consoleBounds(work) {
  const maxW = Math.max(800, work.width - 80);
  const maxH = Math.max(450, work.height - 70);
  let width = Math.min(1280, maxW);
  let height = Math.round((width * 9) / 16);
  if (height > maxH) {
    height = maxH;
    width = Math.round((height * 16) / 9);
  }
  width = Math.round(width);
  height = Math.round(height);
  return {
    width,
    height,
    x: Math.round(work.x + (work.width - width) / 2),
    y: Math.round(work.y + (work.height - height) / 2)
  };
}

function createConsole() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    if (consoleWin.isMinimized()) consoleWin.restore();
    consoleWin.show();
    consoleWin.focus();
    return consoleWin;
  }

  // 首次打开固定 16:9（1280×720 基准），屏幕放不下时等比缩，并居中显示
  const work = screen.getPrimaryDisplay().workArea;
  const box = consoleBounds(work);

  consoleWin = new BrowserWindow({
    width: box.width,
    height: box.height,
    x: box.x,
    y: box.y,
    minWidth: 800,
    minHeight: 450,
    title: '原神跟跑助手 · 启动器',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    // Windows 原生标题栏在浅色系统主题下是一条白条，会和我们自绘的 40px 深色
    // TitleBar 叠成两层。用 Window Controls Overlay 把网页内容延伸到窗口顶部，
    // 最小化/最大化/关闭三个系统按钮浮在深色顶栏右上角（VS Code / Wpf.Ui 同款）。
    // 对应 console.css 里 .topbar 的右侧留白与拖动区域；仅 Windows 有效。
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#1e1e1e', symbolColor: '#e6e6e6', height: 40 }
        }
      : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  consoleWin.loadFile(path.join(__dirname, 'console', 'index.html'));

  // 最小化/恢复都补挂一次钩子。Windows 对低级钩子有「钩子过程超时就被静默摘掉」的
  // 规矩，而窗口最小化恰恰会让主进程忙上一阵（窗口销毁、合成器重排），
  // 正好是钩子最容易被打掉的时候；最小化后 1 秒补一次，切回前台再补一次，
  // 用户不必为了热键失灵去重启程序。
  consoleWin.on('minimize', () => setTimeout(() => hookHotkeys.rearm(), 1000));
  consoleWin.on('restore', () => hookHotkeys.rearm());

  consoleWin.once('ready-to-show', () => {
    consoleWin.show();
    notifyFloatState();
  });

  // 关启动器：有托盘且开关打开时收进托盘，否则走「退出整个应用」
  consoleWin.on('close', (e) => {
    if (quittingFromConsole) return;
    if (settings.closeToTray === false) return;
    if (!tray || tray.isDestroyed()) return;
    e.preventDefault();
    consoleWin.hide();
  });

  consoleWin.on('closed', () => {
    consoleWin = null;
    // 关启动器就是退出整个应用：跟跑视频窗、方位叠加层、登录窗一起收掉。
    // 旧逻辑只在「浮窗没开」时 quit，于是开着跟跑时关启动器，视频窗会留在
    // 屏幕上、进程也不退出，用户还得再去任务栏手动关一次。
    if (quittingFromConsole) return;
    quittingFromConsole = true;
    for (const w of [win, overlayWin, loginWin]) {
      try {
        if (w && !w.isDestroyed()) w.destroy();
      } catch (err) {
        console.warn('[quit] 关闭窗口失败：', err.message);
      }
    }
    app.quit();
  });

  return consoleWin;
}

// 强力置顶：层级被抢时自动恢复
setInterval(() => {
  if (!win || win.isDestroyed() || !settings.pinned) return;
  if (!win.isAlwaysOnTop()) applyPin();
}, 2500);

/* ------------------------------------------------------- 方位标记叠加层 */

let overlayWin = null;
let overlayPlacing = false;
let lastBearing = null;
let overlayDrag = null; // 自绘拖动的起点与初始窗口位置
// 最近一次识别健康度快照（访客页随 bearing 一起上报）
let lastBearingStats = null;

function overlaySize() {
  // 半径 ×2 再留 12% 余量，箭头尖端才不会贴到窗口边被裁掉
  return Math.round(Math.max(60, Number(settings.bearing.radius) || 110) * 2.24);
}

function overlayBounds() {
  const size = overlaySize();
  // 有比例就按比例算圆心，跨分辨率才不会跑偏
  const byRatio = restoreBearingRatio();
  const area = screen.getPrimaryDisplay().workArea;
  const cx = byRatio
    ? byRatio.x
    : Number.isFinite(settings.bearing.x)
      ? settings.bearing.x
      : area.x + 260;
  const cy = byRatio
    ? byRatio.y
    : Number.isFinite(settings.bearing.y)
      ? settings.bearing.y
      : area.y + 260;
  return {
    x: Math.round(cx - size / 2),
    y: Math.round(cy - size / 2),
    width: size,
    height: size
  };
}

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;

  overlayWin = new BrowserWindow({
    ...overlayBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setIgnoreMouseEvents(true, { forward: true });

  // 拖动后记住圆心，下次启动原地复活
  overlayWin.on('move', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const b = overlayWin.getBounds();
    settings.bearing.x = Math.round(b.x + b.width / 2);
    settings.bearing.y = Math.round(b.y + b.height / 2);
    saveBearingRatio(settings.bearing.x, settings.bearing.y);
    persist();
  });

  overlayWin.on('closed', () => {
    overlayWin = null;
  });

  // 雷达模式通过 query 指定，两套渲染各自独立成文件
  overlayWin.loadFile(
    path.join(__dirname, 'overlay', 'index.html'),
    settings.overlayRadar ? { search: 'radar=1' } : undefined
  );

  overlayWin.webContents.on('did-finish-load', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    overlayWin.webContents.send('mode', overlayPlacing ? 'place' : 'lock');
    if (lastBearing) overlayWin.webContents.send('bearing', lastBearing);
    // 雷达模式必须补这一发：radar.js 靠 radar:config 里的 visible 决定画不画，
    // 不发就一直是「不可见」，整个叠加层等于空白。
    pushRadarConfig();
    pushDanmakuConfig();
  });

  return overlayWin;
}

function ensureOverlayReachable() {
  if (!overlayWin || overlayWin.isDestroyed()) return false;
  let b = null;
  try {
    b = overlayWin.getBounds();
  } catch {
    return false;
  }
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return false;

  let d = null;
  try {
    d = screen.getDisplayMatching(b);
  } catch {
    return false;
  }
  if (!d || !d.workArea) return false;
  const area = d.workArea;

  // 与工作区的相交面积占窗口面积的比例
  const ix = Math.max(0, Math.min(b.x + b.width, area.x + area.width) - Math.max(b.x, area.x));
  const iy = Math.max(0, Math.min(b.y + b.height, area.y + area.height) - Math.max(b.y, area.y));
  const visible = (ix * iy) / Math.max(1, b.width * b.height);
  if (visible >= 0.2) return false;

  // 沿最近的边夹回工作区（窗口比工作区还大时贴左上角）
  const nx = Math.max(area.x, Math.min(b.x, area.x + area.width - b.width));
  const ny = Math.max(area.y, Math.min(b.y, area.y + area.height - b.height));
  try {
    overlayWin.setBounds({ x: Math.round(nx), y: Math.round(ny), width: b.width, height: b.height });
  } catch {
    return false;
  }
  settings.bearing.x = Math.round(nx + b.width / 2);
  settings.bearing.y = Math.round(ny + b.height / 2);
  saveBearingRatio(settings.bearing.x, settings.bearing.y);
  persist();
  pushDanmakuConfig();
  pushRadarConfig();
  console.log(
    '[overlay] 叠加层跑到屏幕外（可见 %s%%），已拉回 (%s, %s)',
    Math.round(visible * 100),
    Math.round(nx),
    Math.round(ny)
  );
  return true;
}

/**
 * 方位标定开着就把叠加层叫起来（照搬旧版）。
 *
 * 关键在 ensureOverlayReachable：上次的圆心坐标可能落在屏幕外
 * （换过分辨率 / 改过缩放 / 拔过外接屏），那样窗口建好了也看不见，
 * 表现就是「必须点一下②再锁定才冒出来」—— 因为放置模式会触发拉回。
 */
function ensureOverlayVisible() {
  if (!settings.bearing.enabled) return;
  showOverlay();
  ensureOverlayReachable();
  pushRadarConfig();
}

function showOverlay() {
  const w = createOverlay();
  if (w.isVisible()) return w;

  // 透明窗口的 ready-to-show 不一定触发，两个事件都挂上，先到的生效
  const reveal = () => {
    if (w.isDestroyed() || w.isVisible()) return;
    try {
      w.showInactive();
    } catch {
      /* 窗口正在销毁 */
    }
  };
  if (w.webContents.isLoading()) {
    w.once('ready-to-show', reveal);
    w.webContents.once('did-finish-load', reveal);
  } else {
    reveal();
  }
  return w;
}

function setOverlayPlacing(placing) {
  // 不传参数 = 按当前状态切换。主进程是唯一真相源：以前启动器每次都硬传
  // true，第二下点「锁定位置」又进了一次放置模式，红圈永远锁不上。
  // 显式传 true/false 仍然保留，供热键等需要幂等设置的调用方使用。
  overlayPlacing = placing === undefined || placing === null ? !overlayPlacing : !!placing;
  const w = showOverlay();

  if (overlayPlacing) {
    w.setIgnoreMouseEvents(false);
    w.setFocusable(true);
    w.showInactive();
  } else {
    w.setIgnoreMouseEvents(true, { forward: true });
    w.setFocusable(false);
  }

  if (!w.webContents.isLoading()) w.webContents.send('mode', overlayPlacing ? 'place' : 'lock');
  return overlayPlacing;
}

function setBearingEnabled(on) {
  settings.bearing.enabled = !!on;

  if (on) {
    showOverlay();
  } else {
    overlayPlacing = false;
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.setIgnoreMouseEvents(true, { forward: true });
      overlayWin.setFocusable(false);
      overlayWin.hide();
    }
    lastBearing = null;
  }

  if (win && !win.isDestroyed()) win.webContents.send('bearing:state', settings.bearing);
  persist();
  return settings.bearing;
}

function setOverlayRadius(r) {
  settings.bearing.radius = Math.min(400, Math.max(50, Math.round(Number(r) || 110)));
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setBounds(overlayBounds());
  }
  persist();
  return settings.bearing.radius;
}

/* ------------------------------------------------------------ 贴边吸附
 *
 * 拖到屏幕边缘 20px 内松手，窗口自动贴到边缘（补偿 Windows 无边框窗口
 * 那圈看不见的边框），并在拖动过程中用蓝线提示会贴哪条边。
 * 完全照搬旧版实现 —— 上游基线没有这块。
 */

const SNAP_THRESHOLD = 20;

// 100% 缩放下的不可见边框基准厚度
const BASE_OFFSET = 8;

/**
 * 四边各自的微调量。最终坐标 = 动态基准 ± 对应 ADJUST。
 *  左 / 上：坐标原点 **减去** 基准，再 **加上** ADJUST（ADJUST 越大越往屏幕里收）
 *  右 / 下：坐标 + 屏幕尺寸 − 窗口尺寸 **加上** 基准，再 **加上** ADJUST（越大越往外推）
 * 最新实测（100% 缩放）：上 / 左 / 下 三条边已经严丝合缝，只剩右边有缝。
 * 当前这组值的实际效果：
 *   上 y = 0            —— 完美
 *   左 x = -4           —— 完美
 *   下 y = 屏高-窗高+8  —— 完美
 *   右 x = 屏宽-窗宽+16 —— 在动态基准之上再往外推 8px，用来补右边那条缝
 * 所以现在唯一可能还要动的只有 ADJUST.right。
 */
const ADJUST = {
  top: 8, // 基准 8 被抵消 → y 回到 0，保持完美
  left: 4, // → x = -8 + 4 = -4，与上一版一致；还切就往 8 加
  // 右边缘：只剩这一条缝了，单独加大补偿（唯一需要继续微调的数字）
  // 贴右公式：x = 屏幕x + 屏幕宽 − 窗口宽 + 动态基准 + ADJUST.right
  // 还缝就继续调大（12、16…）；万一调成切边就往回调小
  right: 8,
  bottom: 0 // 同上
};

/** 当前命中信息 { edges:[...], target:{x,y} } */
let snapHit = null;
/** 上一次推给渲染层的边线集合，避免重复发 IPC */
let lastSnapEdges = null;

/**
 * 计算当前窗口所在屏的「不可见边框」厚度。
 *
 * 主路径：BASE_OFFSET × scaleFactor（100% → 8，125% → 10，150% → 12）。
 * 兜底：如果 Electron 版本支持 getContentBounds，就用
 *       (bounds - contentBounds) / 2 反推真实边框，比缩放估算更准。
 *       两者取「更大的合理值」，但仅当测出来的值不超过基准两倍时才采信，
 *       避免某些平台上 contentBounds 恒等于 bounds 或返回 0 把补偿算没。
 */
function dynamicBorderOffset() {
  let scale = 1;
  let display = null;
  try {
    display = screen.getDisplayMatching(win && !win.isDestroyed() ? win.getBounds() : screen.getPrimaryDisplay().bounds);
  } catch {
    display = null;
  }
  if (display && Number.isFinite(display.scaleFactor) && display.scaleFactor > 0) {
    scale = display.scaleFactor;
  }

  const dyn = Math.max(0, Math.round(BASE_OFFSET * scale));
  let frameX = dyn;
  let frameY = dyn;

  try {
    const b = win && !win.isDestroyed() ? win.getBounds() : null;
    const c = win && !win.isDestroyed() && typeof win.getContentBounds === 'function' ? win.getContentBounds() : null;
    if (b && c && Number.isFinite(c.width) && Number.isFinite(c.height)) {
      const dx = Math.round((b.width - c.width) / 2);
      const dy = Math.round((b.height - c.height) / 2);
      // 只在「测出来的值合理」时采信：大于 0 且不超过基准两倍
      if (dx > 0 && dx <= dyn * 2) frameX = dx;
      if (dy > 0 && dy <= dyn * 2) frameY = dy;
    }
  } catch {
    /* 该方法在部分版本/平台上不可用，保持 scaleFactor 的结果 */
  }

  return { x: frameX, y: frameY, scale, dyn };
}

/**
 * 判断窗口是否贴近屏幕某条边。
 * 返回 { edges: ['left'...], target: {x, y} } 或 null。
 * edges 可能是两条（贴角），这样渲染层能同时点亮两条线。
 */
function computeSnap(newBounds) {
  if (!newBounds) return null;

  let display = null;
  try {
    display = screen.getDisplayMatching(newBounds);
  } catch {
    display = null;
  }
  if (!display || !display.workArea) return null;

  const area = display.workArea;
  const width = Math.max(1, Math.round(newBounds.width || 0));
  const height = Math.max(1, Math.round(newBounds.height || 0));
  const x = Number.isFinite(newBounds.x) ? Math.round(newBounds.x) : area.x;
  const y = Number.isFinite(newBounds.y) ? Math.round(newBounds.y) : area.y;

  // 动态基准：按当前屏的缩放比例换算不可见边框厚度（四舍五入防半像素模糊）
  const dyn = dynamicBorderOffset();

  const nearLeft = x - area.x <= SNAP_THRESHOLD;
  const nearRight = area.x + area.width - (x + width) <= SNAP_THRESHOLD;
  const nearTop = y - area.y <= SNAP_THRESHOLD;
  const nearBottom = area.y + area.height - (y + height) <= SNAP_THRESHOLD;

  const edges = [];
  const target = { x, y };

  // 四边分开算，公式刻意保持「一眼能看懂」的形状：
  //   左 / 上 —— 屏幕原点减去偏移；
  //   右 / 下 —— 屏幕宽高减窗口尺寸，再加上偏移。
  // 所以 right / bottom 的数值越大，窗口越往外推（补缝隙）；left / top
  // 的数值越大，越往外切（要拉回来就调小）。
  // 控制台「吸附微调」滑块：正值整体外推、负值回缩，四边统一叠加
  const nudge = Number.isFinite(settings.snapAdjustment) ? settings.snapAdjustment : 0;

  if (nearLeft) {
    edges.push('left');
    target.x = area.x - dyn.x + ADJUST.left - nudge;
  } else if (nearRight) {
    edges.push('right');
    target.x = area.x + area.width - width + dyn.x + ADJUST.right + nudge;
  }

  if (nearTop) {
    edges.push('top');
    target.y = area.y - dyn.y + ADJUST.top - nudge;
  } else if (nearBottom) {
    edges.push('bottom');
    target.y = area.y + area.height - height + dyn.y + ADJUST.bottom + nudge;
  }

  if (!edges.length) return null;
  return { edges, target };
}

/** 把边线状态推给浮窗渲染层；null / 空数组表示全部熄灭 */
function pushSnapEdges(edges) {
  const list = Array.isArray(edges) ? edges : [];
  const key = list.join(',');
  if (key === lastSnapEdges) return; // 状态没变，别刷 IPC
  lastSnapEdges = key;
  if (!win || win.isDestroyed()) return;
  sendTo(win, 'snap:edges', { edges: list });
}

/** 显示 / 收起提示线；hit 为 null 表示收起 */
function showSnapZone(hit) {
  snapHit = hit && hit.edges && hit.edges.length ? hit : null;
  pushSnapEdges(snapHit ? snapHit.edges : []);
}

/**
 * 用户拖动「吸附微调」滑块时，如果窗口此刻正贴着某条边，
 * 立刻按新数值重贴一次 —— 这样能边拖边看效果，不用反复拖窗口。
 */
function applySnap() {
  const hit = snapHit;
  snapHit = null;
  if (!hit || !hit.target) return false;
  if (!win || win.isDestroyed()) return false;

  const target = hit.target;
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return false;

  let b = null;
  try {
    b = win.getBounds();
  } catch {
    return false;
  }
  if (!b) return false;

  if (b.x === target.x && b.y === target.y) return false;

  try {
    win.setBounds({ x: target.x, y: target.y, width: b.width, height: b.height });
    persist();
    const d = dynamicBorderOffset();
    console.log(
      '[snap] 贴边 →',
      hit.edges.join('+'),
      target.x,
      target.y,
      `| scale=${d.scale} 基准=${d.dyn}px 实用=${d.x}/${d.y}px`
    );
  } catch (err) {
    console.warn('[snap] 贴边失败：', err.message);
    return false;
  }
  return true;
}

function reapplySnapIfAtEdge() {
  if (!win || win.isDestroyed()) return;
  let b = null;
  try {
    b = win.getBounds();
  } catch {
    return;
  }
  if (!b) return;

  // computeSnap 只认 20px 内的窗口；微调后窗口可能已略微离开阈值，
  // 所以这里按「当前值 + 微调量」放宽一点再判断。
  const area = screen.getDisplayMatching(b).workArea;
  const slack = SNAP_THRESHOLD + Math.abs(settings.snapAdjustment) + 12;
  const nearEdge =
    b.x - area.x <= slack ||
    area.x + area.width - (b.x + b.width) <= slack ||
    b.y - area.y <= slack ||
    area.y + area.height - (b.y + b.height) <= slack;
  if (!nearEdge) return;

  const hit = computeSnap(b);
  if (!hit) return;

  try {
    win.setBounds({ x: hit.target.x, y: hit.target.y, width: b.width, height: b.height });
    persist();
  } catch (err) {
    console.warn('[snap] 微调重贴失败：', err.message);
  }
}

/* ------------------------------------------------------------ 字幕数据源
 *
 * 走官方播放器接口拿字幕轨，再拉 CDN 上的 JSON：
 *   /x/player/wbi/v2?bvid=..&cid=..  → data.subtitle.subtitles[]（含 subtitle_url）
 *   <subtitle_url>                   → { body: [{from, to, content}] }
 *
 * 为什么不抓 DOM：
 *   · cue 自带精确的 from/to，字幕和播放进度严格对齐，暂停 / 拖动天然正确
 *   · 同一时刻的多行字幕可以合并显示
 *   · 不依赖播放器 DOM 结构，B站改版不会失效
 * DOM 抓取保留为兜底：没有字幕轨 / 未登录 / 接口变更时仍然能用。
 */

let subtitleCues = [];   // [{from, to, text}]，按 from 升序
let lastApiSubtitleText = ''; // 上一次推给字幕窗的文本，避免每帧重复下发
let lastDomSubtitleText = ''; // DOM 抓取模式下最后一句话，供控制台显示
let subtitleCid = 0;     // 与 subtitleCues 对应的 cid
let subtitleLoading = 0; // 正在请求的 cid，防并发重复拉
/**
 * 换片代数。每次载入新视频 +1；请求返回时若代数已变，说明这个结果属于
 * 上一个视频，必须丢掉 —— 否则快速切 P 时，先发出的旧请求晚回来，
 * 会把新视频的字幕覆盖成上一个视频的。
 */
let subtitleGen = 0;

async function fetchSubtitleCues(bvid, cid, gen) {
  if (!cid || !bvid) return [];
  if (subtitleCid === cid && subtitleCues.length) return subtitleCues;
  if (subtitleLoading === cid) return subtitleCues;
  subtitleLoading = cid;
  const myGen = gen === undefined ? subtitleGen : gen;
  /** 只有代数没变才落地；返回 false 表示这是过期结果 */
  const commit = (cues) => {
    if (myGen !== subtitleGen) return false;
    subtitleCues = cues;
    subtitleCid = cid;
    return true;
  };
  try {
    const res = await biliFetch(
      `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${cid}`
    );
    const json = await res.json();
    const data = (json && json.data) || {};
    const subs = data.subtitle && data.subtitle.subtitles;
    if (!Array.isArray(subs) || !subs.length) {
      // 分清两种「没有字幕」：没登录 vs 这个视频本来就没字幕轨
      console.log(
        '[subtitle] 接口没有字幕轨（need_login_subtitle=%s），回退 DOM 抓取',
        !!data.need_login_subtitle
      );
      return commit([]) ? [] : null;
    }
    // 优先中文正式轨，其次 AI 中文，最后任意含 zh 的
    const pick =
      subs.find((x) => /^zh(-Hans)?$/i.test(x.lan || '')) ||
      subs.find((x) => /^ai-zh/i.test(x.lan || '')) ||
      subs.find((x) => /zh/i.test(x.lan || ''));
    if (!pick || !pick.subtitle_url) {
      return commit([]) ? [] : null;
    }
    let url = String(pick.subtitle_url);
    if (url.startsWith('//')) url = 'https:' + url;
    const r2 = await biliFetch(url, { Accept: 'application/json' });
    const doc = await r2.json();
    const body = doc && Array.isArray(doc.body) ? doc.body : [];
    const cues = [];
    for (const row of body) {
      if (!row) continue;
      const from = Number(row.from);
      const to = Number(row.to);
      const text = String(row.content || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || !text) continue;
      cues.push({ from, to, text: text.slice(0, 500) });
    }
    cues.sort((a, b) => a.from - b.from);
    if (!commit(cues)) return null; // 换片了，这个结果作废
    console.log('[subtitle] 已加载字幕 %d 条（cid=%s，轨=%s）', cues.length, cid, pick.lan);
    return cues;
  } catch (err) {
    console.warn('[subtitle] 拉取失败，回退到 DOM 抓取：', err.message);
    return commit([]) ? [] : null;
  } finally {
    subtitleLoading = 0;
  }
}

/**
 * 取某一时刻的全部字幕。
 * 这里就是「重叠字幕合并」：把所有 from <= t < to 的 cue 都取出来，
 * 去重后按顺序拼接 —— 同时有两行对白时两行都会显示。
 */
function subtitleAt(t) {
  const out = [];
  for (const c of subtitleCues) {
    if (c.from > t) break; // 已按 from 升序，后面的更晚
    if (t < c.to) out.push(c.text);
  }
  // 合并：同一时刻的多行对白拼成一行；不合并：只取最新一条
  if (settings.subtitleMergeOverlap === false) return out[out.length - 1].slice(0, 500);
  return [...new Set(out)].join(' ').slice(0, 500);
}

/* ---------------------------------------------------------- 字幕层窗口 */

/**
 * 独立的全屏透明字幕窗口。
 *
 * 为什么不做在浮窗里：浮窗可以被拖到任何位置，字幕跟着走就永远沉不到
 * 屏幕底部。电视字幕要的是相对**屏幕**定位，所以单独开一层铺满全屏、
 * 整窗鼠标穿透的窗口，只画底部那一行字。
 *
 * 关键点：
 *  · transparent + frame:false + 全屏 bounds，背景完全透明；
 *  · setIgnoreMouseEvents(true, {forward:true}) —— 鼠标彻底穿透，
 *    点游戏、拖浮窗都不受影响，这层窗口从不接收输入；
 *  · skipTaskbar + focusable:false —— 不占任务栏、不抢焦点；
 *  · alwaysOnTop 'screen-saver' —— 和浮窗同层级，压在游戏之上。
 */
let subtitleWin = null;

function subtitleBounds() {
  // 用 bounds 而不是 workArea：字幕层要覆盖整个屏幕，包括任务栏那一条，
  // 否则某些布局下底部会被裁掉。
  const d = screen.getPrimaryDisplay();
  return { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height };
}

function createSubtitleWindow() {
  if (subtitleWin && !subtitleWin.isDestroyed()) return subtitleWin;

  subtitleWin = new BrowserWindow({
    ...subtitleBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    title: 'GIFA 字幕层',
    webPreferences: {
      preload: path.join(__dirname, 'subtitle', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 字幕窗只在有文本时才有事做：允许 Chromium 在不可见/空闲时降频，
      // 避免一个全屏透明层空转着把 CPU 啃掉（玩游戏时尤其明显）
      backgroundThrottling: true
    }
  });

  subtitleWin.setAlwaysOnTop(true, 'screen-saver');
  // 整窗穿透：字幕层永远不接收鼠标，剪贴板/游戏点击都落在下面的窗口
  subtitleWin.setIgnoreMouseEvents(true, { forward: true });

  subtitleWin.on('closed', () => {
    subtitleWin = null;
  });

  subtitleWin.loadFile(path.join(__dirname, 'subtitle', 'index.html'));

  // 换分辨率 / 缩放 / 切主屏时重新铺满
  subtitleWin.webContents.on('did-finish-load', () => {
    if (!subtitleWin || subtitleWin.isDestroyed()) return;
    subtitleWin.setBounds(subtitleBounds());
    pushSubtitleConfig();
    pushTurnConfig();
  });

  return subtitleWin;
}

/** 显示器参数变化时把字幕层重新铺满（外接屏拔插、改分辨率都会触发） */
function refitSubtitleWindow() {
  if (!subtitleWin || subtitleWin.isDestroyed()) return;
  try {
    subtitleWin.setBounds(subtitleBounds());
  } catch {
    /* 窗口正在销毁 */
  }
}

/** 显示一句字幕；text 为空表示立刻隐藏 */
function showSubtitleText(text) {
  if (!settings.enableSubtitleSprite) return;
  if (!text) {
    hideSubtitleText();
    return;
  }
  pushSubtitleToWindow(text);
}

/**
 * 把文本推给字幕窗口并确保它可见（不判断开关）。
 * 抽出来是为了让调试自检也能直接调用，不被 settings 拦住。
 */
function pushSubtitleToWindow(text) {
  const w = createSubtitleWindow();
  pushSubtitleConfig();
  const send = () => {
    if (!w || w.isDestroyed()) return;
    // 先补外观配置再发文本：窗口刚建好时 did-finish-load 之前的推送会丢
    w.webContents.send('subtitle:config', subtitleStyleSnapshot());
    w.webContents.send('subtitle:text', { text: String(text) });
  };

  // 关键：必须 showInactive 让窗口真正显示。之前只在「不可见」时调，
  // 而窗口创建时 show:false，did-finish-load 早于这里，容易出现窗口一直隐藏。
  if (!w.isVisible()) w.showInactive();
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
}

/** 隐藏字幕（不清窗口，下次直接复用，避免反复创建） */
function hideSubtitleText() {
  if (!subtitleWin || subtitleWin.isDestroyed()) return;
  try {
    subtitleWin.webContents.send('subtitle:text', { off: true });
    subtitleWin.hide();
  } catch {
    /* 窗口正在销毁 */
  }
}

function destroySubtitleWindow() {
  if (!subtitleWin || subtitleWin.isDestroyed()) return;
  subtitleWin.destroy();
  subtitleWin = null;
}

/* -------------------------------------------------- 字幕外观配置与下发 */

const SUB_POS_LIST = ['center', 'left', 'right'];
const SUB_STROKE_LIST = ['none', 'outline', 'shadow'];

/** 校验并写入一组字幕外观字段（非法值直接忽略，保留原值） */
function applySubtitleStylePatch(patch = {}) {
  const clamp = (v, min, max, fb) =>
    Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fb;

  if (patch.scale !== undefined)
    settings.subtitleScale = clamp(patch.scale, 50, 200, settings.subtitleScale);
  if (patch.offset !== undefined)
    settings.subtitleOffset = clamp(patch.offset, 10, 500, settings.subtitleOffset);
  if (patch.bgOpacity !== undefined)
    settings.subtitleBgOpacity = clamp(patch.bgOpacity, 0, 100, settings.subtitleBgOpacity);

  if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) {
    settings.subtitleColor = patch.color.toLowerCase();
  }
  if (typeof patch.stroke === 'string' && SUB_STROKE_LIST.includes(patch.stroke)) {
    settings.subtitleStroke = patch.stroke;
  }
  if (typeof patch.pos === 'string' && SUB_POS_LIST.includes(patch.pos)) {
    settings.subtitlePos = patch.pos;
  }
  if (patch.keepRatio !== undefined) settings.subtitleKeepRatio = !!patch.keepRatio;
  if (patch.fade !== undefined) settings.subtitleFade = !!patch.fade;
  if (patch.hold !== undefined) settings.subtitleHold = clamp(patch.hold, 1, 10, settings.subtitleHold);
  if (patch.maxWidth !== undefined)
    settings.subtitleMaxWidth = clamp(patch.maxWidth, 30, 100, settings.subtitleMaxWidth);
  if (patch.weight !== undefined)
    settings.subtitleWeight = clamp(patch.weight, 500, 900, settings.subtitleWeight);
  if (patch.radius !== undefined)
    settings.subtitleRadius = clamp(patch.radius, 0, 24, settings.subtitleRadius);
}

/** 当前字幕外观的快照，直接给字幕窗口用 */
function subtitleStyleSnapshot() {
  return {
    scale: settings.subtitleScale,
    color: settings.subtitleColor,
    stroke: settings.subtitleStroke,
    pos: settings.subtitlePos,
    // hold 传 0：字幕窗不再按墙上时间自动隐藏，改由主进程按视频进度下发 off。
    // 否则暂停时计时器照跑，一句没说完的字幕会被提前吃掉。
    // 真正的停留时长 subtitleHold 由访客页的 ticker 使用，不经这里。
    hold: 0,
    offset: settings.subtitleOffset,
    bgOpacity: settings.subtitleBgOpacity,
    keepRatio: settings.subtitleKeepRatio,
    fade: settings.subtitleFade,
    maxWidth: settings.subtitleMaxWidth,
    weight: settings.subtitleWeight,
    radius: settings.subtitleRadius
  };
}

/**
 * 转向提示：把方向塞给字幕层里的大箭头；null 表示收起。
 *
 * 两个容易踩的点：
 *  1) 字幕条关掉时窗口可能还没建 —— 要按需创建；
 *  2) 窗口建好但被 hide 了（字幕 3 秒淡出后不会 hide，但关开关会），
 *     这里必须主动 showInactive，否则箭头画在隐藏窗口里，等于没显示。
 */
function applyTurnStylePatch(patch = {}) {
  const clamp = (v, min, max, fb) =>
    Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fb;

  if (patch.offset !== undefined) settings.turnOffset = clamp(patch.offset, 10, 400, settings.turnOffset);
  if (patch.scale !== undefined) settings.turnScale = clamp(patch.scale, 60, 200, settings.turnScale);
  if (patch.duration !== undefined)
    settings.turnDuration = clamp(patch.duration, 1, 10, settings.turnDuration);
  if (patch.opacity !== undefined)
    settings.turnOpacity = clamp(patch.opacity, 20, 100, settings.turnOpacity);
  if (typeof patch.color === 'string' && /^#[0-9a-f]{6}$/i.test(patch.color)) {
    settings.turnColor = patch.color.toLowerCase();
  }
  if (patch.posY !== undefined) settings.turnPosY = clamp(patch.posY, 5, 95, settings.turnPosY);
  if (patch.posX !== undefined) settings.turnPosX = clamp(patch.posX, 5, 95, settings.turnPosX);
  // 分组开关：左右 / 上下 可以分开启用
  if (patch.enableLR !== undefined) settings.turnEnableLR = !!patch.enableLR;
  if (patch.enableUD !== undefined) settings.turnEnableUD = !!patch.enableUD;
}

function turnStyleSnapshot() {
  return {
    offset: settings.turnOffset,
    scale: settings.turnScale,
    duration: settings.turnDuration,
    opacity: settings.turnOpacity,
    color: settings.turnColor,
    posY: settings.turnPosY,
    posX: settings.turnPosX
  };
}

function pushTurnConfig() {
  if (!subtitleWin || subtitleWin.isDestroyed()) return;
  try {
    subtitleWin.webContents.send('turn:config', turnStyleSnapshot());
  } catch {
    /* 窗口正在销毁 */
  }
}

function pushTurnHint(hint) {
  if (!hint && (!subtitleWin || subtitleWin.isDestroyed())) return;

  const w = createSubtitleWindow();
  if (hint && !w.isVisible()) w.showInactive();
  if (hint) {
    w.webContents.send('subtitle:config', subtitleStyleSnapshot());
    w.webContents.send('turn:config', turnStyleSnapshot());
  }

  const send = () => {
    if (!w || w.isDestroyed()) return;
    w.webContents.send('turn:hint', hint || { off: true });
    console.log('[turn] 主进程 → 字幕层:', hint ? hint.dir : 'off', '| visible=', w.isVisible());
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
}

/* ------------------------------------------------------ 放大提醒窗口
 *
 * 方向一变就弹一张放大的小地图快照，2 秒后淡出。
 * 目的是不用歪头去左上角看小地图 —— 尤其浮窗铺得很大时，
 * 小地图那块早被视频本身盖住了。
 *
 * 不做实时镜像：每秒抓 8~10 次视频像素再编码，玩游戏时那点 CPU 白花；
 * 而且看地图的时机就是「方向变了」那一下，一帧定格反而更清楚。
 */

let alertWin = null;
let alertHideTimer = null;
let alertPlacing = false;

/**
 * 提醒窗尺寸 = 叠加层窗口尺寸。
 *
 * 抓的就是叠加层那块屏幕，尺寸必须 1:1 —— 一旦放大，
 * 抓进来的圆环和窗口自己的边框半径不同，会变成「圈中圈」。
 */
function alertSize() {
  // 必须和叠加层里**实际画出来的圆环**对齐：
  // radar.js 的 radius() 是「窗口短边的一半 × 0.86」，不是整个窗口。
  // 按窗口尺寸裁会大出约 4%，看着就是「边框比画面大一圈」。
  return Math.round(overlaySize() * 0.86);
}

function alertBounds() {
  const size = alertSize();
  // 默认放在主屏右侧居中：不挡游戏主体，余光能看到
  let area = null;
  try {
    area = screen.getPrimaryDisplay().workArea;
  } catch {
    area = null;
  }
  if (!area) return { x: 40, y: 40, width: size, height: size };

  const x = Number.isFinite(settings.alertX) ? settings.alertX : Math.round(area.x + area.width - size - 40);
  const y = Number.isFinite(settings.alertY) ? settings.alertY : Math.round(area.y + (area.height - size) / 2);
  return { x, y, width: size, height: size };
}

function createAlertWindow() {
  if (alertWin && !alertWin.isDestroyed()) return alertWin;

  alertWin = new BrowserWindow({
    ...alertBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    title: 'GIFA 放大提醒',
    webPreferences: {
      preload: path.join(__dirname, 'alert', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 窗口平时是隐藏的，但屏幕流必须继续跑 ——
      // 否则每次点亮都要重新建流，第一帧空白半秒。
      backgroundThrottling: false
    }
  });

  alertWin.setAlwaysOnTop(true, 'screen-saver');
  // 平时整窗穿透：提醒窗不能挡游戏点击，只有放置模式才接管鼠标
  alertWin.setIgnoreMouseEvents(true, { forward: true });

  alertWin.on('move', () => {
    if (!alertWin || alertWin.isDestroyed()) return;
    const b = alertWin.getBounds();
    settings.alertX = Math.round(b.x);
    settings.alertY = Math.round(b.y);
    persist();
  });

  alertWin.on('closed', () => {
    alertWin = null;
    alertHideTimer = null;
  });

  alertWin.loadFile(path.join(__dirname, 'alert', 'index.html'));
  alertWin.webContents.on('did-finish-load', () => {
    if (!alertWin || alertWin.isDestroyed()) return;
    alertWin.webContents.send('alert:placing', alertPlacing);
    // 页面一就绪就把屏幕流建起来，等第一次点亮时画面已经在了
    sendAlertStream();
  });

  return alertWin;
}

function setAlertPlacing(on) {
  alertPlacing = !!on;
  const w = alertPlacing ? createAlertWindow() : alertWin;
  if (!w || w.isDestroyed()) return alertPlacing;
  // 放置模式要能拖：放开鼠标接管，并让页面切成可拖动区域
  w.setIgnoreMouseEvents(!alertPlacing, { forward: true });
  if (alertPlacing && !w.isVisible()) w.showInactive();
  if (!w.webContents.isLoading()) w.webContents.send('alert:placing', alertPlacing);
  return alertPlacing;
}

/* 方位高亮的时序：雷达圈和放大提醒窗共用这一份。
 *
 * 雷达那边不再自己写常量，改由 pushRadarConfig 把这两个值下发过去 ——
 * 各写一份迟早对不上，就会出现「雷达灭了提醒还挂着」。
 */
const CUE_HOLD_MS = 3200;
const CUE_FADE_MS = 450;
/** 提醒窗自己的淡出时长：比雷达的光晕更快，收得干脆一点 */
const ALERT_FADE_MS = 200;

/**
 * 把「要显示哪块屏幕」告诉提醒窗。
 *
 * 叠加层本来就压在用户自己的游戏小地图上（标定第②步就是把圆环拖过去），
 * 所以它的 bounds 就是小地图的位置 —— 不用再让用户框一次。
 *
 * 提醒窗拿到 sourceId 后自己拉屏幕流、每帧抠出这块画到 canvas，
 * 所以这里只在区域变化时发一次，不是每帧都发。
 */
async function sendAlertStream() {
  const w = alertWin;
  if (!w || w.isDestroyed()) return;

  let display = null;
  try {
    display = screen.getDisplayMatching(overlayBounds());
  } catch {
    display = null;
  }
  if (!display) return;

  let sources = [];
  try {
    // 只要 sourceId，缩略图给 1×1 就够，几乎不花时间
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  } catch (err) {
    console.warn('[alert] 取屏幕源失败：', err && err.message);
    return;
  }
  if (!sources || !sources.length) return;

  const src = sources.find((x) => String(x.display_id) === String(display.id)) || sources[0];
  const ring = alertSize();
  const b = overlayBounds();
  const cx = b.x + b.width / 2 - ring / 2;
  const cy = b.y + b.height / 2 - ring / 2;

  const payload = {
    sourceId: src.id,
    region: {
      x: Math.round(cx - display.bounds.x),
      y: Math.round(cy - display.bounds.y),
      size: ring
    },
    screen: { width: display.size.width, height: display.size.height }
  };

  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', () => {
    if (w && !w.isDestroyed()) w.webContents.send('alert:stream', payload);
  });
  else {
    try {
      w.webContents.send('alert:stream', payload);
    } catch {
      /* 窗口正在销毁 */
    }
  }
}

/** 方向来了：把窗口亮起来，到点收起。画面由常驻屏幕流实时提供，不用抓图。 */
function showAlertCue() {
  if (!settings.alertEnabled) return;

  const w = createAlertWindow();
  const hold = CUE_HOLD_MS;

  const push = () => {
    if (!w || w.isDestroyed()) return;
    try {
      const size = alertSize();
      const b = w.getBounds();
      if (b.width !== size || b.height !== size) w.setBounds({ ...b, width: size, height: size });
      w.webContents.send('alert:show', { hold });
      if (!w.isVisible()) w.showInactive();
      // 位置/半径可能刚改过，顺手把显示区域同步过去
      sendAlertStream();
    } catch {
      /* 窗口正在销毁 */
    }
  };

  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', push);
  else push();

  clearTimeout(alertHideTimer);
  alertHideTimer = setTimeout(() => {
    if (!alertWin || alertWin.isDestroyed()) return;
    if (alertPlacing) return; // 正在拖动就先别藏
    try {
      alertWin.hide(); // 隐藏窗口但保留屏幕流，下次点亮不用重连
    } catch {
      /* 窗口正在销毁 */
    }
  }, CUE_HOLD_MS + ALERT_FADE_MS);
}

/** 把外观推给字幕窗口；窗口还没建就跳过（下次显示时会带上最新配置） */
function pushSubtitleConfig() {
  if (!subtitleWin || subtitleWin.isDestroyed()) return;
  try {
    subtitleWin.webContents.send('subtitle:config', subtitleStyleSnapshot());
  } catch {
    /* 窗口正在销毁 */
  }
}

/* ------------------------------------------------ 弹幕层的层级避让 */

/**
 * Windows 上 Electron 的 setAlwaysOnTop(level) 里的 level **只在 macOS 有效**，
 * Windows 全都落到同一个 HWND_TOPMOST 带里，谁后显示谁在上层。
 * 所以「弹幕低于视频浮窗」不能只靠 level 参数，必须在弹幕显示后
 * 主动把浮窗和方位箭头层 moveTop() 顶回去。
 */
let lastRaiseLog = 0;
function raiseFloatAboveDanmaku() {
  let raised = false;

  // 方位箭头层（红绿箭头）优先，它必须压在最上面
  try {
    if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible()) {
      // 重新声明一次 topmost 会把窗口重新插入到置顶带最前面，
      // 再 moveTop 兜底 —— Windows 上单靠 level 参数没用
      overlayWin.setAlwaysOnTop(true, 'screen-saver');
      overlayWin.moveTop();
      raised = true;
    }
  } catch {
    /* ignore */
  }

  try {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, 'screen-saver');
      win.moveTop();
      raised = true;
    }
  } catch {
    /* ignore */
  }

  // 每 10 秒最多打一条，方便确认这条链路真的执行了（不刷屏）
  if (raised && Date.now() - lastRaiseLog > 10000) {
    lastRaiseLog = Date.now();
    console.log('[zorder] 已把浮窗/箭头层提到弹幕之上');
  }
}

/* ---------------------------------------------------------- 弹幕层窗口 */

/**
 * 全屏透明弹幕层。和字幕层是同一套思路，区别是：
 *  · 它要显示很多条同时飞的弹幕，所以渲染在独立窗口里用 CSS 动画跑；
 *  · 只在开关打开时创建/显示，关掉立刻隐藏并清空；
 *  · 依旧整窗鼠标穿透，绝不干扰游戏。
 */
let danmakuWin = null;

function danmakuBounds() {
  const d = screen.getPrimaryDisplay();
  return { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height };
}

function createDanmakuWindow() {
  if (danmakuWin && !danmakuWin.isDestroyed()) return danmakuWin;

  danmakuWin = new BrowserWindow({
    ...danmakuBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    title: 'GIFA 弹幕层',
    webPreferences: {
      preload: path.join(__dirname, 'danmaku', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 弹幕窗同理：空闲时让它被节流，真正需要时由主进程唤醒
      backgroundThrottling: true
    }
  });

  // 层级刻意比视频浮窗低一档：浮窗用 'screen-saver'，弹幕层用 'floating'。
  // 这样弹幕飘过视频画面时会被浮窗挡住 —— 小地图上的红绿箭头始终看得见，
  // 视觉上就是「弹幕在箭头下面」。若也用 screen-saver，两者同级，
  // 谁后显示谁在上面，弹幕就会盖住方位标记。
  danmakuWin.setAlwaysOnTop(true, 'floating');
  danmakuWin.setIgnoreMouseEvents(true, { forward: true });

  danmakuWin.on('closed', () => {
    danmakuWin = null;
  });

  danmakuWin.loadFile(path.join(__dirname, 'danmaku', 'index.html'));

  danmakuWin.webContents.on('did-finish-load', () => {
    if (!danmakuWin || danmakuWin.isDestroyed()) return;
    danmakuWin.setBounds(danmakuBounds());
    pushDanmakuConfig();
    raiseFloatAboveDanmaku();
  });

  return danmakuWin;
}

function refitDanmakuWindow() {
  if (!danmakuWin || danmakuWin.isDestroyed()) return;
  try {
    danmakuWin.setBounds(danmakuBounds());
  } catch {
    /* 窗口正在销毁 */
  }
}

/**
 * 方位箭头层的「挖空圆」，坐标换算到弹幕窗口的局部坐标系。
 * 箭头层是独立窗口，位置/半径都存在 settings.bearing 里；
 * 弹幕窗口铺满主屏，所以 local = 屏幕坐标 − 窗口原点。
 */
function bearingHole() {
  if (!settings.bearing || !settings.bearing.enabled) return null;
  if (!win || win.isDestroyed()) return null;

  const cx = Number(settings.bearing.x);
  const cy = Number(settings.bearing.y);
  const r = Number(settings.bearing.radius);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return null;

  let bounds = null;
  try {
    bounds = danmakuWin && !danmakuWin.isDestroyed() ? danmakuWin.getBounds() : danmakuBounds();
  } catch {
    return null;
  }
  if (!bounds) return null;

  return {
    // 半径留 1.25 倍余量：箭头层的窗口比箭头本身大一圈
    cx: Math.round(cx - bounds.x),
    cy: Math.round(cy - bounds.y),
    r: Math.round(r * 1.25)
  };
}

/** 把当前外观配置推给弹幕窗口（实时生效，不重建窗口） */
function pushDanmakuConfig() {
  if (!danmakuWin || danmakuWin.isDestroyed()) return;
  const cfg = {
    area: settings.danmakuArea,
    opacity: settings.danmakuOpacity,
    scale: settings.danmakuScale,
    speed: settings.danmakuSpeed,
    weight: settings.danmakuWeight,
    max: settings.danmakuMax,
    stroke: settings.danmakuStroke,
    // 方位箭头那一圈挖空：弹幕在那里直接不渲染，
    // 比跟窗口抢 z-order 更可靠（Windows 上置顶窗口的层级很难稳定控制）
    hole: bearingHole()
  };
  try {
    danmakuWin.webContents.send('danmaku:config', cfg);
  } catch {
    /* 窗口正在销毁 */
  }
}

/** 清空弹幕窗里现有的全部弹幕（换片 / 拖进度条时用） */
function resetDanmakuWindow() {
  if (!danmakuWin || danmakuWin.isDestroyed()) return;
  try {
    danmakuWin.webContents.send('danmaku:reset', {});
  } catch {
    /* 窗口正在销毁 */
  }
}

/** 清空并隐藏弹幕层 */
function hideDanmaku() {
  if (!danmakuWin || danmakuWin.isDestroyed()) return;
  try {
    danmakuWin.webContents.send('danmaku:reset', {});
    danmakuWin.hide();
  } catch {
    /* 窗口正在销毁 */
  }
}

function destroyDanmakuWindow() {
  if (!danmakuWin || danmakuWin.isDestroyed()) return;
  danmakuWin.destroy();
  danmakuWin = null;
}

/**
 * 把雷达圈的几何下发给 overlay。
 *
 * overlay 的窗口是以标定圆心为中心、边长 overlaySize() 的正方形，
 * 所以那边只需要知道「半径多少、要不要显示」，坐标天然对齐。
 * 没标定过就 visible=false —— 圆心和半径都是猜的，画出来只会误导。
 */
function pushRadarConfig() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = settings.bearing || {};
  // 只要「开过箭头 + 标定过 + 有识别区域」就挂雷达。
  // 不按视频区分：overlay 只需要知道圈画多大，具体用哪块 ROI 是访客页的事。
  const hasRois =
    (Array.isArray(b.rois) && b.rois.length > 0) ||
    (b.roiBy && Object.values(b.roiBy).some((v) => Array.isArray(v) && v.length > 0));
  const visible = !!b.enabled && !!b.calibrated && hasRois;
  const payload = {
    radius: Math.max(60, Number(b.radius) || 110),
    visible,
    // 高亮时序：雷达圈和放大提醒窗必须同亮同灭
    hold: CUE_HOLD_MS,
    fade: CUE_FADE_MS
  };
  try {
    overlayWin.webContents.send('radar:config', payload);
  } catch {
    /* 窗口正在销毁 */
  }
}

/* ------------------------------------------------------------ 弹幕数据源 */

/**
 * 弹幕列表只从官方接口取一次，**不再监听 DOM**。
 *
 * 为什么放弃 DOM 监听：B 站播放器在首帧/换片时会把整段历史弹幕一次性回填进
 * 容器，MutationObserver 于是瞬间看到成百上千个节点 —— 那就是「井喷」。
 * DOM 里也没有可靠的「这条弹幕属于第几秒」信息，只能按插入顺序播，必然错位。
 *
 * 这里用 api.bilibili.com/x/v1/dm/list.so?oid=<cid> 拿 XML：
 *   <d p="出现秒,模式,字号,颜色,发送时间戳,...">文本</d>
 * 解析成 { t: 毫秒时间戳, text, color } 后按 t 排序缓存。
 */
let danmakuList = [];   // 当前视频/分P 的全量弹幕（已排序）
let danmakuCid = 0;     // 与 danmakuList 对应的 cid
let danmakuSentAt = -1; // 上次给弹幕窗发窗口片段时的播放进度（秒）
let currentCid = 0;     // 当前正在播的分 P 的 cid（中途开开关时用它补拉）
let danmakuLoading = 0; // 正在请求的 cid，防止并发重复拉

function decodeXmlText(str) {
  return String(str)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function colorHex(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '#ffffff';
  return '#' + (v & 0xffffff).toString(16).padStart(6, '0');
}

async function fetchDanmakuList(cid) {
  if (!cid) return [];
  if (danmakuCid === cid && danmakuList.length) return danmakuList;
  if (danmakuLoading === cid) return danmakuList;

  danmakuLoading = cid;
  try {
    const res = await biliFetch(`https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}`, {
      Accept: 'application/xml,text/xml,*/*'
    });
    const xml = await res.text();
    const out = [];
    const re = /<d\s+p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
    let m;
    while ((m = re.exec(xml))) {
      const parts = m[1].split(',');
      const sec = Number(parts[0]);
      if (!Number.isFinite(sec)) continue;
      const text = decodeXmlText(m[2]).replace(/\s+/g, ' ').trim();
      if (!text) continue;
      out.push({
        t: Math.round(sec * 1000),
        text,
        color: colorHex(parts[3]),
        idx: out.length
      });
    }
    out.sort((a, b) => a.t - b.t);
    out.forEach((d, i) => {
      d.idx = i;
    });
    danmakuList = out;
    danmakuCid = cid;
    console.log('[danmaku] 已加载弹幕', out.length, '条（cid=' + cid + '）');
    return danmakuList;
  } catch (err) {
    console.warn('[danmaku] 拉取失败：', err.message);
    return [];
  } finally {
    danmakuLoading = 0;
  }
}

/**
 * 按播放进度取「当前点前 1 秒 ~ 后 6 秒」的一小段发给弹幕窗。
 * 绝不整包下发 —— 那正是井喷的另一种形式。
 */
function sendDanmakuSlice(t, seek, playing = true) {
  if (!settings.enableDanmakuProjection) return;
  if (!danmakuList.length) return;

  const now = Number(t);
  if (!Number.isFinite(now) || now < 0) return;

  // 非 seek 时，距离上次发送不到 2.5 秒就不重复发
  if (!seek && danmakuSentAt >= 0 && Math.abs(now - danmakuSentAt) < 2.5) return;
  danmakuSentAt = now;

  const from = Math.max(0, now - 1);
  const to = now + 6;
  const items = danmakuList.filter((d) => d.t >= from * 1000 && d.t <= to * 1000);
  if (!items.length && !seek) return;

  const w = createDanmakuWindow();
  if (!w.isVisible()) {
    w.showInactive();
    // 刚显示出来的弹幕层会盖住所有置顶窗口，立刻把浮窗/箭头层顶回去
    raiseFloatAboveDanmaku();
  }
  pushDanmakuConfig();

  const send = () => {
    if (!w || w.isDestroyed()) return;
    w.webContents.send('danmaku:slice', { t: now, seek: !!seek, playing, items });
  };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
  else send();
}

/* -------------------------------------------------------------- 全局热键 */

function sendPlayerAction(action) {
  // 浮窗没起来时热键也要有反应：否则用户在启动器里按键，什么都不发生
  if (!win || win.isDestroyed()) {
    createWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.once('did-finish-load', () => {
        if (win && !win.isDestroyed()) win.webContents.send('hotkey', action);
      });
    }
    return;
  }
  win.webContents.send('hotkey', action);
}

/** 热键动作的唯一入口：键盘加速器和鼠标侧键都走这里 */
function handleHotkey(key, phase) {
  if (key === 'holdSpeed') return setHoldSpeed(phase === 'down');
  if (capturingHotkey) return;
  if (key === 'cycleSpeed' && (typingInField || (loginWin && !loginWin.isDestroyed() && BrowserWindow.getFocusedWindow() === loginWin))) return;
  if (key === 'cycleSpeed') return cyclePlaybackRate();
  if (key === 'toggleImmersion') return setImmersion(!immersion);
  if (key === 'toggleVisible') return toggleVisible();
  if (key === 'togglePass') return setPass(!settings.clickThrough);
  if (key === 'toggleOpacity') return setOpacity(settings.opacity > 0.95 ? 0.65 : 1);
  sendPlayerAction(key);
}

function toggleVisible() {
  if (!win || win.isDestroyed()) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.showInactive();
    applyPin();
  }
}

function setPass(on) {
  settings.clickThrough = !!on;
  applyWindowPresentation();
  persist();
  if (win && !win.isDestroyed()) win.webContents.send('win:state', { clickThrough: settings.clickThrough });
}

function setOpacity(v) {
  settings.opacity = Math.min(1, Math.max(0.3, Number(v) || 1));
  applyWindowPresentation();
  persist();
  if (win && !win.isDestroyed()) win.webContents.send('win:state', { opacity: settings.opacity });
}

function registerHotkeys() {
  cancelTemporarySpeed();
  globalShortcut.unregisterAll();
  failedHotkeys = [];

  for (const { key } of HOTKEY_META) {
    const acc = settings.hotkeys[key];
    if (!acc) continue;
    // 鼠标侧键和单键不进 globalShortcut：前者不支持，后者会把键全局吞掉。
    // 这两类统一交给低级钩子被动监听。
    if (hookHotkeys.isHookAccelerator(acc, key)) continue;

    let ok = false;
    try {
      ok = globalShortcut.register(acc, () => handleHotkey(key));
    } catch {
      ok = false;
    }
    if (!ok) failedHotkeys.push({ key, accelerator: acc });
  }

  // 钩子类绑定：不可用时要把涉及的动作全部标为失败，界面才解释得清
  const hookState = hookHotkeys.apply(
    settings.hotkeys,
    handleHotkey,
    /**
     * 什么时候不响应单键/侧键。
     *
     * 原来这里是「自己的任一窗口在前台就全部忽略」，代价太大：浮窗本身就是
     * 置顶播放器，用户点一下它、或者刚在启动器里配完热键就按 J 试试，
     * 都会被判成「在自己的窗口里」，表现得就像热键彻底没接上。
     *
     * 现在只挡两种确实会打架的情形：正在输入框里打字、正在录制新键位。
     * 登录窗例外：那里面一定要能正常输入账号密码。
     */
    () => {
      if (capturingHotkey) return true;
      if (typingInField) return true;
      const focused = BrowserWindow.getFocusedWindow();
      return !!focused && focused === loginWin;
    },
    onRawHookEvent
  );

  if (hookState.needed && !hookState.ok) {
    for (const { key } of HOTKEY_META) {
      const acc = settings.hotkeys[key];
      if (hookHotkeys.isHookAccelerator(acc, key)) failedHotkeys.push({ key, accelerator: acc, hook: true });
    }
  }
  for (const acc of hookState.keys) {
    const hit = HOTKEY_META.find((m) => settings.hotkeys[m.key] === acc);
    if (hit) failedHotkeys.push({ key: hit.key, accelerator: acc, unsupported: true });
  }

  if (failedHotkeys.length) {
    console.warn('[hotkeys] 注册失败（可能被其他程序占用）:', failedHotkeys);
  }
  return failedHotkeys;
}

/* ------------------------------------------------------------ B 站解析 */

async function followRedirect(url) {
  try {
    const res = await biliFetch(url, { Accept: 'text/html' });
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
    return res.url || url;
  } catch {
    return url;
  }
}

function extractId(text) {
  const s = String(text || '').trim();
  let m = s.match(/(BV[0-9A-Za-z]{10})/);
  if (m) return 'BV' + m[0].slice(2);
  m = s.match(/[?&/]av(\d+)/i) || s.match(/^av(\d+)$/i);
  if (m) return 'av' + m[1];
  return null;
}

async function resolveInput(text) {
  let s = String(text || '').trim();
  if (!s) return { ok: false, message: '请输入视频链接或 BV 号' };

  if (/b23\.tv|bili2233\.cn/i.test(s)) {
    const direct = s.match(/https?:\/\/\S+/i);
    if (direct) s = await followRedirect(direct[0]);
  }

  const id = extractId(s);
  if (!id) return { ok: false, message: '没认出 BV 号，请粘贴完整视频链接' };

  const pm = s.match(/[?&](?:p|page)=(\d+)/i);
  return { ok: true, id, p: pm ? Number(pm[1]) : 1 };
}

async function fetchVideoInfo(id) {
  const q = id.startsWith('av') ? `aid=${id.slice(2)}` : `bvid=${id}`;
  try {
    const res = await biliFetch(`https://api.bilibili.com/x/web-interface/view?${q}`);
    const json = await res.json();
    if (json.code !== 0) return { ok: false, message: json.message || `接口返回 ${json.code}` };
    const d = json.data || {};
    return {
      ok: true,
      id: d.bvid || id,
      title: d.title || '',
      owner: d.owner ? d.owner.name : '',
      // cid 是弹幕接口和官方字幕接口的必需参数，必须一起带出来
      cid: d.cid || 0,
      pages: (d.pages || []).map((p) => ({
        page: p.page,
        part: p.part,
        duration: p.duration,
        cid: p.cid || 0
      }))
    };
  } catch (err) {
    return { ok: false, message: '读取视频信息失败：' + err.message };
  }
}

/** 查询登录态：未登录只能看预览/低清晰度，登录后才是完整视频 */
async function fetchNav() {
  try {
    const res = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
    const json = await res.json();
    const d = json.data || {};
    return {
      ok: true,
      loggedIn: !!d.isLogin,
      uname: d.uname || '',
      mid: d.mid || 0,
      vip: d.vipStatus === 1,
      level: d.level_info ? d.level_info.current_level : 0
    };
  } catch (err) {
    return { ok: false, loggedIn: false, uname: '', message: err.message };
  }
}

/** 只用 www.bilibili.com 视频页：站外嵌入播放器（player.bilibili.com）无论如何都上不了高清 */
function buildUrl(id, p) {
  const page = Math.max(1, Number(p) || 1);
  const key = id.startsWith('av') ? `av${id.slice(2)}` : id;
  return `https://www.bilibili.com/video/${key}/?p=${page}&autoplay=1`;
}

/* ---------------------------------------------------------------- 登录 */

function openLogin() {
  if (loginWin && !loginWin.isDestroyed()) {
    if (loginWin.isMinimized()) loginWin.restore();
    loginWin.show();
    loginWin.focus();
    return;
  }

  const currentLoginWindow = new BrowserWindow({
    width: 480,
    height: 720,
    title: '登录 B 站',
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: {
      partition: BILI_PARTITION,
      // 当前 Windows / Electron 组合的沙箱登录页会直接 ERR_FAILED，连本地页也无法加载。
      // 仅此窗口兼容运行；远程页面不接入 preload / Node / 应用 IPC。
      sandbox: false,
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      spellcheck: false
    }
  });
  loginWin = currentLoginWindow;
  // 跟跑浮窗使用 screen-saver 层级，登录窗口也要到同层，才能显示在它上面。
  currentLoginWindow.setAlwaysOnTop(true, 'screen-saver');
  currentLoginWindow.show();
  currentLoginWindow.focus();
  currentLoginWindow.loadURL('https://passport.bilibili.com/login').catch((err) => {
    console.warn('[bili] 登录页面加载失败：', err.message);
  });

  // 查询单飞，避免网络慢时 interval 重入，扫码后重复通知、重载播放器。
  let checking = false;
  let completed = false;
  const deadline = Date.now() + 5 * 60 * 1000;
  const timer = setInterval(async () => {
    if (completed || currentLoginWindow.isDestroyed() || loginWin !== currentLoginWindow || Date.now() > deadline) {
      clearInterval(timer);
      return;
    }
    if (checking) return;
    checking = true;
    try {
      const nav = await fetchNav();
      // 用户可能在接口返回前关闭窗口，或者已经重新打开了另一个登录窗口。
      if (completed || currentLoginWindow.isDestroyed() || loginWin !== currentLoginWindow || !nav.loggedIn) return;
      completed = true;
      clearInterval(timer);
      console.log('[bili] 登录成功：', nav.uname, nav.vip ? '(大会员)' : '');
      broadcast('login:state', nav);
      currentLoginWindow.close();
    } finally {
      checking = false;
    }
  }, 2000);

  currentLoginWindow.on('closed', () => {
    completed = true;
    clearInterval(timer);
    if (loginWin === currentLoginWindow) loginWin = null;
  });
}

/* ---------------------------------------------------------------- IPC */

function registerIpc() {
  // 这里只读写内存；访客 preload 在站点脚本之前同步拿到偏好。
  ipcMain.on('player:settings', (event) => {
    if (!isPlaybackGuest(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      event.returnValue = null;
      return;
    }
    event.sender.setAudioMuted(true);
    playbackGate = 0;
    event.returnValue = { ...guestPlaybackSettings(), token: ++playbackToken, ...(immersion ? { videoOnly: true } : {}) };
  });
  ipcMain.on('player:gating', (event, message) => {
    if (isPlaybackMessage(event, message) && Number.isSafeInteger(message.seq) && message.seq > playbackGate) {
      playbackGate = message.seq;
      event.sender.setAudioMuted(true);
    }
  });
  ipcMain.on('player:ready', (event, message) => {
    if (isPlaybackMessage(event, message) && message.seq === playbackGate) event.sender.setAudioMuted(false);
  });
  ipcMain.on('player:changed', (event, message) => {
    if (!isPlaybackMessage(event, message)) {
      event.returnValue = null;
      return;
    }
    const patch = { ...(message.patch || {}) };
    if (holdSpeedActive) delete patch.playbackRate;
    if (updatePlaybackSettings(settings, patch)) {
      persist();
      broadcast('settings:changed', settings);
    }
    // 同步完成：紧接着切 P 的新 preload 也能读到用户刚调好的值。
    event.returnValue = guestPlaybackSettings();
  });

  ipcMain.handle('app:boot', async () => {
    const nav = await fetchNav();
    console.log(
      '[bili] 登录态：',
      nav.loggedIn ? `已登录 ${nav.uname}${nav.vip ? '（大会员）' : ''}` : '未登录',
      nav.ok ? '' : `接口异常 ${nav.message || ''}`
    );
    return {
      settings,
      floatState: floatState(),
      playbackState: playbackState(),
      hotkeys: HOTKEY_META,
      failedHotkeys,
      initialUrl: OPEN_ARG,
      nav,
      // 框选圆环的出厂初值。**不进标定列表**，只用来决定第一次打开标定时圆环落在哪，
      // 免得一打开就偏到画面外、用户点「完成」直接存下一个错区域。
      seedRoi: SEED_ROI,
      webviewPreload: pathToFileURL(path.join(__dirname, 'webview-preload.js')).href,
      version: app.getVersion(),
      // 界面要能一眼看出「单键/侧键的全局钩子到底起来了没有」，
      // 否则热键不响应时只能靠猜
      hookRunning: hookHotkeys.isRunning(),
      // 没提权时游戏内热键必然收不到（UIPI），界面要直说，别让用户怀疑程序坏了
      elevated: isElevated(),
      // 让启动器能显示「设置和登录态存在哪」，绿色版就是 exe 同级的 data\
      dataDir: app.getPath('userData'),
      portable: installMode === 'portable',
      installMode
    };
  });

  ipcMain.handle('bili:nav', () => fetchNav());

  /* ---- 提权重启：游戏内热键要管理员身份才行（UIPI），由用户按需触发 ---- */
  ipcMain.handle('app:relaunch-elevated', async () => {
    if (isElevated()) return { ok: false, reason: 'already-elevated' };
    // 先让出单实例锁：提权后的新进程启动时会申请它。不让出的话新进程会立刻自杀，
    // 而这边也已经退出 —— 用户看到的现象就是「点了按钮，程序直接消失」。
    if (saveTimer) flushSettings();
    const hadLock = app.hasSingleInstanceLock();
    if (hadLock) app.releaseSingleInstanceLock();
    const result = await relaunchElevated();
    // UAC 被取消：把锁要回来，继续以普通权限运行
    if (!result.ok && hadLock) app.requestSingleInstanceLock();
    if (result.ok) setTimeout(() => app.exit(0), 400);
    return result;
  });

  /* ---- 输入状态：决定单键热键要不要让路 ---- */

  ipcMain.on('ui:typing', (_e, on) => {
    typingInField = !!on;
    if (typingInField) cancelTemporarySpeed();
  });
  ipcMain.on('ui:capture', (_e, on) => {
    capturingHotkey = !!on;
    if (capturingHotkey) cancelTemporarySpeed();
  });
  /* ---- 播放控制：启动器的静音 / 倍速控件 ---- */
  /* ---- 魔改扩展：识别健康度 ---- */
  ipcMain.handle('bearing:stats', () => {
    if (!lastBearingStats) return null;
    // 超过 5 秒没更新说明识别循环停了（视频暂停 / 开关关闭），界面要能区分
    return { ...lastBearingStats, ageMs: Date.now() - lastBearingStats.at };
  });

  ipcMain.handle('playback:get', () => playbackState());

  ipcMain.handle('playback:update', (_e, patch = {}) => {
    if (updatePlaybackSettings(settings, patch)) {
      persist();
      publishPlaybackSettings();
      broadcast('settings:changed', settings);
    }
    return playbackState();
  });

  ipcMain.on('subtitle:time', (_e, payload = {}) => {
    if (!settings.enableSubtitleSprite) return;
    if (!subtitleCues.length) return; // 没有接口字幕，走 DOM 抓取那条路
    // 暂停时按开关决定要不要清屏
    if (payload && payload.paused && settings.subtitleHideOnPause) {
      if (lastApiSubtitleText) {
        lastApiSubtitleText = '';
        hideSubtitleText();
      }
      return;
    }
    const t = Number(payload && payload.t);
    if (!Number.isFinite(t)) return;
    const text = subtitleAt(t);
    if (text === lastApiSubtitleText) return;
    lastApiSubtitleText = text;
    if (text) showSubtitleText(text);
    else hideSubtitleText();
  });

  ipcMain.on('subtitle:update', (_e, payload = {}) => {
    if (!settings.enableSubtitleSprite) {
      hideSubtitleText();
      return;
    }
    if (payload && payload.off) {
      hideSubtitleText();
      return;
    }
    const text = String((payload && payload.text) || '').trim();
    if (!text) return;
    lastDomSubtitleText = text;
    showSubtitleText(text);
  });

  /* ---- 字幕状态：控制台「B站设置」页轮询 ---- */
  ipcMain.handle('subtitle:status', () => {
    const api = subtitleCues.length > 0;
    return {
      mode: api ? 'api' : lastDomSubtitleText ? 'dom' : 'none',
      count: subtitleCues.length,
      cid: subtitleCid,
      // 官方字幕模式取主进程查表的结果，DOM 模式取访客页推上来的最后一句
      lastText: api ? lastApiSubtitleText : lastDomSubtitleText,
      enabled: !!settings.enableSubtitleSprite,
      apiEnabled: settings.subtitleUseApi !== false
    };
  });

  /* ---- 手动重读：丢掉缓存再请求一次官方字幕轨 ---- */
  ipcMain.handle('subtitle:refetch', async () => {
    if (!settings.subtitleUseApi) return { ok: false, reason: 'api-off' };
    const bvid = settings.lastVideoId;
    const cid = currentCid;
    if (!bvid || !cid) return { ok: false, reason: 'no-video' };
    subtitleCid = 0;
    subtitleCues = [];
    subtitleGen += 1;
    const gen = subtitleGen;
    lastApiSubtitleText = '';
    const cues = await fetchSubtitleCues(bvid, cid, gen);
    if (cues === null || gen !== subtitleGen) return { ok: false, reason: 'stale' };
    if (win && !win.isDestroyed()) {
      sendTo(win, 'subtitle:api', { on: cues.length > 0, count: cues.length });
    }
    return { ok: true, count: cues.length };
  });

  /* ---- 全屏弹幕：浮窗把访客页抓到的一条弹幕转给弹幕层 ---- */

  // 浮窗把 <video> 的播放进度报上来：主进程按进度切「窗口片段」下发。
  // 不再有 DOM 抓取，也就没有历史弹幕被一次性回填的问题。
  ipcMain.on('danmaku:time', (_e, payload = {}) => {
    if (!settings.enableDanmakuProjection) return;
    const t = Number(payload.t);
    if (!Number.isFinite(t)) return;

    // 每次都把播放进度同步给弹幕窗（它用这个当本地时钟基准），
    // 但片段只在需要时切，避免频繁下发
    if (danmakuWin && !danmakuWin.isDestroyed()) {
      danmakuWin.webContents.send('danmaku:time', { t, playing: payload.playing !== false });
    }

    if (payload.seek) {
      resetDanmakuWindow();
      danmakuSentAt = -1;
      sendDanmakuSlice(t, true, payload.playing !== false);
      return;
    }
    sendDanmakuSlice(t, false, payload.playing !== false);
  });

  /* ---- 字幕转向提醒：浮窗匹配到方向词后转给字幕层画大箭头 ---- */

  ipcMain.on('turn:update', (_e, payload = {}) => {
    if (!settings.enableTurnReminder) return;
    // 分组开关（前端已过滤一次，这里再兜一道，防止旧配置/竞态漏过来）
    if (payload && (payload.dir === 'left' || payload.dir === 'right') && !settings.turnEnableLR) return;
    if (payload && (payload.dir === 'up' || payload.dir === 'down') && !settings.turnEnableUD) return;
    if (payload && payload.off) {
      pushTurnHint(null);
      return;
    }
    const dir = String(payload.dir || '');
    if (!dir) return;
    pushTurnHint({ dir, label: String(payload.label || ''), text: String(payload.text || '') });
  });

  /* ---- 空转回收：字幕层 / 弹幕层没内容时把窗口藏起来，省全屏合成 ---- */

  ipcMain.on('subtitle:idle', () => {
    if (!subtitleWin || subtitleWin.isDestroyed()) return;
    if (!settings.enableSubtitleSprite && !settings.enableTurnReminder) return;
    // 窗口 hide 后仍保留实例，下次有文本时 showInactive 即可，不用重建
    if (subtitleWin.isVisible()) subtitleWin.hide();
  });

  /* ---- 输入状态：决定单键热键要不要让路 ---- */



  /* ---- 方位标记：视频侧只上报一个角度，主进程转发给叠加窗 ---- */

  ipcMain.on('overlay:bearing', (_e, payload) => {
    lastBearing = payload;
    // 魔改扩展：访客页每帧带一份识别健康度，存下来给控制台轮询
    if (payload && payload.stats) lastBearingStats = { ...payload.stats, at: Date.now() };
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('bearing', payload);
  });

  ipcMain.handle('overlay:enable', (_e, on) => {
    const r = setBearingEnabled(on);
    // 上游这个函数不发雷达配置，雷达模式下开关箭头后圈不会跟着出现/消失
    pushRadarConfig();
    pushDanmakuConfig();
    return r;
  });

  /**
   * 手动自动定心的结果。访客算出的 dx/dy 是「视频像素」，这里换算成归一化偏移，
   * 直接写进该视频的标定（roiBy[id] 优先，否则全局 rois）——这就是「固定住」：
   * 下次打开还是对准的，浮窗里的临时修正也会随新标定归零。
   *
   * 只接受 ok && applied 的结果；失败 / 取消不改任何标定。
   */
  ipcMain.handle('bearing:auto-center-result', (_e, res) => {
    const p = res && typeof res === 'object' ? res : {};
    let out = { ok: !!p.ok, applied: !!p.applied, reason: p.reason || '' };

    if (p.ok && p.applied) {
      const b = settings.bearing || (settings.bearing = {});
      const rawId = String(p.videoId || settings.lastVideoId || '');
      const keys = Object.keys(b.roiBy || {});
      const key = rawId && b.roiBy && b.roiBy[rawId] ? rawId : keys.find((k) => k.toLowerCase() === rawId.toLowerCase());
      const own = key && Array.isArray(b.roiBy[key]) && b.roiBy[key].length ? b.roiBy[key] : null;
      const list = own || (Array.isArray(b.rois) ? b.rois : null);
      const idx = Math.max(0, Math.min(Number(p.roiIndex) || 0, (list ? list.length : 0) - 1));
      const roi = list && list[idx];

      if (roi && Number.isFinite(p.dcx) && Number.isFinite(p.dcy)) {
        roi.cx = Math.min(0.999, Math.max(0.001, roi.cx + p.dcx));
        roi.cy = Math.min(0.999, Math.max(0.001, roi.cy + p.dcy));
        if (own) b.roiBy[key] = list;
        else b.rois = list;
        // 自动定心成功本身就说明这块区域已经对准，别再提示「还没标定」
        b.calibrated = true;
        persist();
        // 两边都通知：浮窗会拿新标定重挂识别，启动器刷新文案
        broadcast('settings:changed', settings);
        out = { ok: true, applied: true, dx: p.dx, dy: p.dy, roi };
      } else {
        out = { ok: false, applied: false, reason: 'save-failed' };
      }
    }

    // 启动器也要看到结果（浮窗这时可能被游戏压住，用户看不到它的 toast）
    sendTo(consoleWin, 'auto-center-result', out);
    return out;
  });
  /* ---- 魔改扩展：overlay 自绘拖动 ----
   * 雷达模式下由渲染层按指针位移发过来，直接平移窗口。
   * 不经过系统拖动，所以不会被屏幕边缘吸附、也不会弹回。 */
  ipcMain.on('overlay:drag-start', (_e, p) => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const x = Number(p && p.x);
    const y = Number(p && p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    overlayDrag = { x, y, bounds: overlayWin.getBounds() };
  });

  ipcMain.on('overlay:drag-move', (_e, p) => {
    if (!overlayDrag || !overlayWin || overlayWin.isDestroyed()) return;
    const x = Number(p && p.x);
    const y = Number(p && p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const b = overlayDrag.bounds;
    try {
      overlayWin.setBounds({
        x: Math.round(b.x + (x - overlayDrag.x)),
        y: Math.round(b.y + (y - overlayDrag.y)),
        width: b.width,
        height: b.height
      });
    } catch {
      /* 窗口正在销毁 */
    }
  });

  ipcMain.on('overlay:drag-end', () => {
    overlayDrag = null;
    // 拖完先保证还能抓回来（推出去太远就拉回工作区内）
    ensureOverlayReachable();
    persist();
    pushDanmakuConfig();
    pushRadarConfig();
  });

  /* ---- 魔改扩展：智能防遮挡 ---- */
  // 字幕里出现「地图 / 锚点 / 传送」时，暂时别把窗口淡掉
  ipcMain.on('avoid:mark', () => markAvoidHide());

  /* ---- 魔改扩展：放大提醒窗口 ---- */
  ipcMain.handle('alert:place', (_e, on) => {
    const next = on === undefined ? !alertPlacing : !!on;
    const result = setAlertPlacing(next);
    // 进放置模式时同步一次显示区域，窗口才有画面
    if (result) sendAlertStream();
    return result;
  });

  /* ---- 魔改扩展：字幕点亮的绝对方位，转给叠加层画雷达 ---- */
  ipcMain.on('compass:cue', (_e, cue) => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const deg = Number(cue && cue.deg);
    if (!Number.isFinite(deg)) return;
    try {
      overlayWin.webContents.send('compass:cue', { deg, label: String(cue.label || '') });
    } catch {
      /* 窗口正在销毁 */
    }

    /* 放大提醒：画面由常驻屏幕流实时提供，所以这里是「直接亮窗」，
     * 没有任何抓图等待 —— 和雷达同一帧出现。 */
    showAlertCue();
  });

  ipcMain.handle('overlay:place', (_e, on) => {
    const placing = setOverlayPlacing(on);
    // 进放置模式先保证抓得到：上次可能被推到屏幕外了
    if (placing) ensureOverlayReachable();
    return placing;
  });
  // 启动器重建 / 箭头开关切换后，用它把按钮文案对齐到主进程的真实状态
  ipcMain.handle('overlay:place-state', () => overlayPlacing);
  ipcMain.handle('overlay:radius', (_e, r) => {
    const out = setOverlayRadius(r);
    pushRadarConfig();
    // 提醒窗是 1:1 镜像，叠加层变大它也要跟着变大，显示区域同步更新
    if (alertWin && !alertWin.isDestroyed()) {
      const size = alertSize();
      const b = alertWin.getBounds();
      if (b.width !== size || b.height !== size) alertWin.setBounds({ ...b, width: size, height: size });
      sendAlertStream();
    }
    return out;
  });

  // 调试：把访客抓到的识别区域落盘，用来肉眼确认 ROI 有没有对准小地图
  ipcMain.handle('overlay:dump-save', (_e, payload = {}) => {
    const dir = app.getPath('userData');
    const b64 = String(payload.dataUrl || '').split(',')[1] || '';
    if (!b64) return { ok: false, file: '' };

    const file = path.join(dir, 'bearing-dump.png');
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));

    // 整帧 + 红框图：用来肉眼判断识别区域有没有落在小地图上
    const fb64 = String(payload.frame || '').split(',')[1] || '';
    const frameFile = path.join(dir, 'bearing-frame.png');
    if (fb64) fs.writeFileSync(frameFile, Buffer.from(fb64, 'base64'));

    const rois = Array.isArray(payload.rois) ? payload.rois : [];
    const roiText = rois
      .map((r) => `(${r.cx.toFixed(3)}, ${r.cy.toFixed(3)}) r=${r.r.toFixed(3)}`)
      .join(' | ');

    console.log(
      '[bearing] 识别区域已导出',
      `${payload.size}px`,
      `视频 ${payload.vw}×${payload.vh}`,
      `${rois.length} 处：${roiText || '无'}`,
      `不透明 ${payload.opaque}/${payload.total}`,
      `→ ${frameFile}`
    );
    return { ok: true, file, frameFile: fb64 ? frameFile : '', dir, size: payload.size };
  });

  // 导出后让用户在资源管理器里直接看到，不用自己翻 AppData
  ipcMain.handle('overlay:reveal-dump', () => {
    const dir = app.getPath('userData');
    const frame = path.join(dir, 'bearing-frame.png');
    if (fs.existsSync(frame)) shell.showItemInFolder(frame);
    else shell.openPath(dir);
    return dir;
  });

  ipcMain.handle('settings:save', (_e, patch = {}) => {
    const playbackChanged = updatePlaybackSettings(settings, patch);
    if (HOLD_PLAYBACK_RATES.includes(patch.holdPlaybackRate)) settings.holdPlaybackRate = patch.holdPlaybackRate;
    if (typeof patch.hoverFadeEnabled === 'boolean') {
      settings.hoverFadeEnabled = patch.hoverFadeEnabled;
      syncHoverFade();
      notifyFloatState();
    }
    if (playbackChanged || patch.holdPlaybackRate !== undefined) publishPlaybackSettings();
    // 自动连播 / 手动切 P 只带 lastPart：页码和时间要一起刷新，
    // 否则启动器上的「上次看到」会一直停在第一次打开视频那一刻。
    if (patch.lastText !== undefined || patch.lastPart !== undefined) {
      noteWatched(settings, {
        ...(patch.lastText !== undefined ? { text: patch.lastText } : {}),
        ...(patch.lastPart !== undefined ? { p: patch.lastPart } : {})
      });
    }
    // 这个开关本身不是「观看记录」，别顺手刷新 lastWatchedAt
    if (patch.resumeOnLaunch !== undefined) settings.resumeOnLaunch = !!patch.resumeOnLaunch;
    if (patch.pinned !== undefined) {
      settings.pinned = !!patch.pinned;
      applyPin();
    }
    if (patch.clickThrough !== undefined) setPass(patch.clickThrough);
    if (patch.opacity !== undefined) setOpacity(patch.opacity);
    if (patch.hotkeys) settings.hotkeys = { ...settings.hotkeys, ...patch.hotkeys };

    /* ---- 魔改扩展：字幕 / 转向 / 弹幕 的开关与外观 ---- */
    if (patch.enableSubtitleSprite !== undefined) {
      settings.enableSubtitleSprite = !!patch.enableSubtitleSprite;
      // 转向提醒还开着的话，字幕层窗口要留着给大箭头用
      if (!settings.enableSubtitleSprite && !settings.enableTurnReminder) hideSubtitleText();
      // 视频已经载入后才打开开关：补拉一次官方字幕轨
      if (settings.enableSubtitleSprite && settings.subtitleUseApi && settings.lastVideoId && currentCid) {
        subtitleGen += 1;
        const gen = subtitleGen;
        subtitleCid = 0;
        fetchSubtitleCues(settings.lastVideoId, currentCid, gen).then((cues) => {
          if (!cues || gen !== subtitleGen) return;
          if (win && !win.isDestroyed()) {
            sendTo(win, 'subtitle:api', { on: cues.length > 0, count: cues.length });
          }
        });
      }
    }
    if (patch.subtitleUseApi !== undefined) {
      settings.subtitleUseApi = !!patch.subtitleUseApi;
      if (!settings.subtitleUseApi) {
        subtitleCues = [];
        subtitleCid = 0;
        lastApiSubtitleText = '';
        if (win && !win.isDestroyed()) sendTo(win, 'subtitle:api', { on: false, count: 0 });
      } else if (settings.enableSubtitleSprite && settings.lastVideoId && currentCid) {
        subtitleGen += 1;
        const gen = subtitleGen;
        subtitleCid = 0;
        fetchSubtitleCues(settings.lastVideoId, currentCid, gen).then((cues) => {
          if (!cues || gen !== subtitleGen) return;
          if (win && !win.isDestroyed()) {
            sendTo(win, 'subtitle:api', { on: cues.length > 0, count: cues.length });
          }
        });
      }
    }
    for (const key of [
      'subtitleHideNative',
      'subtitleMergeOverlap',
      'subtitleHideOnPause',
      'subtitleAutoOpen',
      // 沉浸模式的两条防遮挡规则
      'avoidHideEnabled',
      'combatFadeEnabled'
    ]) {
      if (patch[key] !== undefined) settings[key] = !!patch[key];
    }
    if (patch.subtitle) {
      applySubtitleStylePatch(patch.subtitle);
      pushSubtitleConfig();
    }
    if (patch.turn) {
      applyTurnStylePatch(patch.turn);
      pushTurnConfig();
    }
    if (patch.enableTurnReminder !== undefined) {
      settings.enableTurnReminder = !!patch.enableTurnReminder;
      if (!settings.enableTurnReminder) pushTurnHint(null);
      if (!settings.enableTurnReminder && !settings.enableSubtitleSprite) hideSubtitleText();
    }
    if (patch.danmaku) {
      const d = patch.danmaku;
      const clamp = (v, min, max, fb) =>
        Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Math.round(Number(v)))) : fb;
      if (d.area !== undefined) settings.danmakuArea = clamp(d.area, 10, 100, settings.danmakuArea);
      if (d.opacity !== undefined) settings.danmakuOpacity = clamp(d.opacity, 0, 100, settings.danmakuOpacity);
      if (d.scale !== undefined) settings.danmakuScale = clamp(d.scale, 50, 200, settings.danmakuScale);
      if (d.speed !== undefined) settings.danmakuSpeed = clamp(d.speed, 0, 100, settings.danmakuSpeed);
      if (d.weight !== undefined) settings.danmakuWeight = clamp(d.weight, 400, 900, settings.danmakuWeight);
      if (d.max !== undefined) settings.danmakuMax = clamp(d.max, 10, 150, settings.danmakuMax);
      if (d.stroke !== undefined) settings.danmakuStroke = !!d.stroke;
      pushDanmakuConfig();
    }
    if (patch.snapAdjustment !== undefined) {
      const v = Number(patch.snapAdjustment);
      settings.snapAdjustment = Number.isFinite(v) ? Math.min(20, Math.max(-20, Math.round(v))) : 0;
      // 已经贴在边上时，改微调量要立刻重新贴一次，否则看不出效果
      reapplySnapIfAtEdge();
    }
    if (patch.avoidHideHold !== undefined) {
      const v = Number(patch.avoidHideHold);
      settings.avoidHideHold = Math.round(Math.max(1, Math.min(30, Number.isFinite(v) ? v : 4)));
    }
    if (patch.combatOpacity !== undefined) {
      const v = Number(patch.combatOpacity);
      settings.combatOpacity = Math.round(Math.max(10, Math.min(100, Number.isFinite(v) ? v : 75)));
      applyWindowPresentation();
    }
    if (patch.alertEnabled !== undefined) {
      settings.alertEnabled = !!patch.alertEnabled;
      if (settings.alertEnabled) {
        // 提前建窗口并起流：第一次点亮就能立刻出画面，不用等冷启动
        createAlertWindow();
      } else if (alertWin && !alertWin.isDestroyed()) {
        // 销毁而不是隐藏：屏幕流、视频解码器、canvas 一起释放。
        // 关掉这个开关的用户就是不想付这份开销。
        alertWin.destroy();
        alertWin = null;
      }
    }
    if (patch.overlayRadar !== undefined) {
      const next = !!patch.overlayRadar;
      if (next !== settings.overlayRadar) {
        settings.overlayRadar = next;
        // 渲染方式变了必须重建窗口：脚本是在页面加载时按 query 选的
        if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
        overlayWin = null;
        if (settings.bearing.enabled) showOverlay();
      }
    }
    if (patch.ratioLocked !== undefined) {
      setRatioLocked(patch.ratioLocked);
    }
    if (patch.enableVisionGreenArc !== undefined) {
      settings.enableVisionGreenArc = !!patch.enableVisionGreenArc;
      // 关掉绿弧时访客页会跳过扇形识别，配置要立刻重发一次
      broadcast('settings:changed', settings);
    }
    if (patch.closeToTray !== undefined) {
      settings.closeToTray = !!patch.closeToTray;
      rebuildTrayMenu();
    }
    if (patch.trayClickAction !== undefined) {
      settings.trayClickAction = patch.trayClickAction === 'float' ? 'float' : 'launcher';
    }
    if (patch.danmakuHideNative !== undefined) {
      settings.danmakuHideNative = !!patch.danmakuHideNative;
    }
    if (patch.enableDanmakuProjection !== undefined) {
      settings.enableDanmakuProjection = !!patch.enableDanmakuProjection;
      if (!settings.enableDanmakuProjection) hideDanmaku();
      else if (currentCid) fetchDanmakuList(currentCid);
    }
    if (patch.bearing) {
      const b = patch.bearing;
      if (b.calibrated !== undefined) settings.bearing.calibrated = !!b.calibrated;

      if (Array.isArray(b.rois)) {
        const rois = dropLegacySeeds(b.rois).slice(0, 4);
        settings.bearing.rois = rois;
        if (b.videoId) {
          // 清空时必须把这个视频的专属记录一起删掉。以前只清全局 rois，
          // roiBy 里还留着 —— 看着「清除本视频标定」成功了，重载视频又回来了，
          // 因为取区域时优先读 roiBy。
          if (rois.length) settings.bearing.roiBy[b.videoId] = rois;
          else delete settings.bearing.roiBy[b.videoId];
        }
      }
    }
    persist();
    broadcast('settings:changed', settings);
    return settings;
  });

  ipcMain.handle('hotkeys:update', (_e, next = {}) => {
    const valid = {};
    for (const [k, v] of Object.entries(next)) {
      if (Object.prototype.hasOwnProperty.call(DEFAULT_HOTKEYS, k) && typeof v === 'string' && v.trim()) {
        valid[k] = v.trim();
      }
    }

    const previous = { ...settings.hotkeys };
    const prepared = prepareHotkeyUpdate(previous, valid);
    settings.hotkeys = prepared.hotkeys;
    let failed = registerHotkeys();
    let rejected = prepared.rejected;
    const affected = new Set([...Object.keys(valid), ...prepared.swapped]);
    // 换键是一个事务：隐式互换的另一方注册失败，也必须一起退回。
    if (failed.some((failure) => affected.has(failure.key))) {
      settings.hotkeys = previous;
      rejected = Object.keys(valid);
      failed = registerHotkeys();
    }
    persist();
    broadcast('settings:changed', settings);
    return {
      hotkeys: settings.hotkeys,
      failed,
      rejected,
      swapped: rejected.length ? [] : prepared.swapped,
      hookRunning: hookHotkeys.isRunning()
    };
  });

  ipcMain.handle('hotkeys:reset', () => {
    settings.hotkeys = { ...DEFAULT_HOTKEYS };
    const failed = registerHotkeys();
    persist();
    broadcast('settings:changed', settings);
    return { hotkeys: settings.hotkeys, failed, hookRunning: hookHotkeys.isRunning() };
  });

  ipcMain.handle('win:action', (_e, action, payload) => {
    // 下面这几个动作主要由启动器发起，而启动器点它们的时候浮窗往往还没起，
    // 所以必须放在「浮窗存在」的守卫之前；否则按钮点了没有任何反应。
    switch (action) {
      case 'start-float':
        createWindow();
        return true;
      case 'stop-float':
        if (win && !win.isDestroyed()) win.close();
        return true;
      case 'open-console':
        createConsole();
        return true;
      case 'login':
        cancelTemporarySpeed();
        openLogin();
        return true;
      case 'immersion': {
        const result = setImmersion(payload === undefined ? !immersion : !!payload);
        // 等渲染层把标题栏/控制条收掉，再量 chromeHeight 并对齐一次，
        // 不然沉浸模式下上下会留黑边
        setTimeout(() => applyRatioLock(true), 150);
        return result;
      }
      case 'ratio-refit':
        // 布局变化（进/退沉浸、纯净模式）后重新量 chromeHeight 并对齐
        setTimeout(() => applyRatioLock(true), 120);
        return settings.ratioLocked;
      case 'ratio-lock':
        setRatioLocked(payload === undefined ? !settings.ratioLocked : !!payload);
        return settings.ratioLocked;
      case 'cycle-speed':
        return cyclePlaybackRate();
      case 'open-data':
        shell.openPath(app.getPath('userData'));
        return true;
      case 'open-license':
        return shell.openPath(app.isPackaged
          ? path.join(process.resourcesPath, 'licenses', 'NOTICE-GIFA.txt')
          : path.join(app.getAppPath(), 'build', 'LICENSE.txt'));
      case 'calib':
        // 框选要看着视频拖圆环，只能在浮窗里做 —— 这里负责把它叫起来
        if (!win || win.isDestroyed()) createWindow();
        if (immersion) setImmersion(false);
        sendTo(win, 'float:cmd', { cmd: 'calib' });
        return true;
      case 'autocenter': {
        // 自动定心也只在浮窗里做：浮窗没起就先起，等它加载完再把命令递过去
        const fresh = !win || win.isDestroyed();
        if (fresh) createWindow();
        const send = () => sendTo(win, 'float:cmd', { cmd: 'autocenter' });
        if (fresh) setTimeout(send, 1500);
        else send();
        return true;
      }
      case 'dump':
        if (win && !win.isDestroyed()) sendTo(win, 'float:cmd', { cmd: 'dump' });
        return true;
      case 'float-load':
        if (win && !win.isDestroyed()) {
          sendTo(win, 'float:cmd', { cmd: 'load', text: payload && payload.text, p: payload && payload.p });
        }
        return true;
      default:
        break;
    }

    if (!win || win.isDestroyed()) return false;
    switch (action) {
      case 'minimize':
        win.minimize();
        break;
      case 'close':
        // 只关跟跑浮窗，不退出程序 —— 启动器还在，随时可以再点「启动跟跑」。
        // 反方向不一样：关启动器会连带收掉所有窗口并退出（见 createConsole）。
        win.close();
        break;
      case 'hide':
        toggleVisible();
        break;
      case 'pin':
        settings.pinned = !!payload;
        applyPin();
        persist();
        break;
      case 'pass':
        setPass(payload);
        break;
      case 'opacity':
        setOpacity(payload);
        break;
      case 'fullscreen':
        // 纯视频模式锁住窗口尺寸，网页内部的全屏请求不改变它。
        if (immersion) return false;
        // payload 省略时按当前状态取反，方便同一个入口做开关
        win.setFullScreen(payload === undefined ? !win.isFullScreen() : !!payload);
        break;
      case 'resize':
        if (immersion) return false;
        if (payload && Number.isFinite(payload.w) && Number.isFinite(payload.h)) {
          win.setBounds({
            x: win.getBounds().x,
            y: win.getBounds().y,
            width: Math.max(240, Math.round(payload.w)),
            height: Math.max(150, Math.round(payload.h))
          });
        }
        break;
      default:
        break;
    }
    return true;
  });

  ipcMain.handle('bili:load', async (_e, payload = {}) => {
    const resolved = await resolveInput(payload.text);
    if (!resolved.ok) return { ok: false, message: resolved.message };

    const p = Number(payload.p) || resolved.p || 1;
    const info = await fetchVideoInfo(resolved.id);
    const id = (info.ok && info.id) || resolved.id;
    const pages = info.ok ? info.pages : [];

    // 同一视频切 P 时接口偶尔读不到分 P 信息，别把已知的标题/总数清掉
    const sameVideo =
      settings.lastVideoId &&
      String(settings.lastVideoId).toLowerCase() === String(id).toLowerCase();
    noteWatched(settings, {
      text: payload.text,
      p,
      id,
      title: info.ok ? info.title : sameVideo ? settings.lastTitle : '',
      pageCount: pages.length || (sameVideo ? settings.lastPageCount : 0)
    });
    persist();
    // 启动器可能正开着：让「上次看到」那一行立刻跟上，不用等下次启动
    broadcast('settings:changed', settings);

    // 换片/切 P：上一个视频的数据要清干净，绝不能让新视频继承旧状态
    const cid = pages.find((x) => x.page === p)?.cid || (info.ok ? info.cid : 0);
    currentCid = cid;
    danmakuCid = 0;
    danmakuList = [];
    danmakuSentAt = -1;
    resetDanmakuWindow();
    hideSubtitleText();
    pushTurnHint(null);
    subtitleCues = [];
    subtitleCid = 0;
    subtitleGen += 1;
    const gen = subtitleGen;
    lastApiSubtitleText = '';
    lastDomSubtitleText = '';
    if (settings.enableSubtitleSprite && settings.subtitleUseApi && cid && id) {
      fetchSubtitleCues(id, cid, gen).then((cues) => {
        if (!cues || gen !== subtitleGen) return;
        if (win && !win.isDestroyed()) {
          sendTo(win, 'subtitle:api', { on: cues.length > 0, count: cues.length });
        }
      });
    } else if (win && !win.isDestroyed()) {
      sendTo(win, 'subtitle:api', { on: false, count: 0 });
    }
    if (settings.enableDanmakuProjection && cid) fetchDanmakuList(cid);

    return {
      ok: true,
      id,
      p,
      url: buildUrl(id, p),
      title: info.ok ? info.title : '',
      owner: info.ok ? info.owner : '',
      pages,
      message: info.ok ? '' : `读不到分 P 信息（${info.message}），已直接载入`
    };
  });
}

/* ---------------------------------------------------------------- 生命周期 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 再次启动 exe 时把启动器叫回来，而不是只动浮窗
    if (consoleWin && !consoleWin.isDestroyed()) {
      if (consoleWin.isMinimized()) consoleWin.restore();
      consoleWin.show();
      consoleWin.focus();
    } else {
      createConsole();
    }
  });

  app.whenReady().then(async () => {
    // 打包版已在 exe 清单层提权（双击即弹 UAC），这里**不再自动重启**：
    // portable 版是「自解压壳 + 主程序」，运行时再提权等于多解压一遍 100MB、多等 20 秒。
    // 只有清单没生效时（开发版 / 解压直跑 / UAC 被取消），启动器顶部横幅仍提供
    // 「以管理员身份重启」作为兜底。
    // 常驻工具：明确告诉系统「别挂起我」。配合上面的 EcoQoS 开关，
    // 保证窗口最小化后全局钩子照常工作（这正是「在游戏里按热键」的核心场景）。
    powerSaveBlocker.start('prevent-app-suspension');
    if (process.platform === 'win32') app.setAppUserModelId('com.finallawer.genshin-route-buddy');
    powerMonitor.on('suspend', cancelTemporarySpeed);
    powerMonitor.on('lock-screen', cancelTemporarySpeed);
    powerMonitor.on('resume', () => {
      cancelTemporarySpeed();
      hookHotkeys.rearm();
    });

    loadSettings();
    // 调试用：本次启动强制打开方位标记，不写进设置文件
    if (process.argv.includes('--bearing')) settings.bearing.enabled = true;
    try {
      session.defaultSession.setUserAgent(UA);
    } catch {
      /* ignore */
    }
    registerIpc();
    createTray(); // 先建托盘：启动器被收进托盘后还要有个入口能叫回来
    createConsole(); // 先出启动器，配置好了再点「启动跟跑」
    registerHotkeys();

    // 外接屏拔插 / 改分辨率：全屏透明层要重新铺满，否则只盖住半个屏幕
    screen.on('display-metrics-changed', () => {
      refitSubtitleWindow();
      refitDanmakuWindow();
    });
    screen.on('display-added', refitSubtitleWindow);
    screen.on('display-removed', refitSubtitleWindow);

    // `--open BVxxx` 是从快捷方式直接带视频来的，那就顺手把浮窗也起来
    if (OPEN_ARG) createWindow();
    // 「上次看到」：直接把浮窗起来，浮窗 init() 会读 lastText/lastPart 继续播。
    // 显式 --open 优先；开关可在启动器里关掉（只想改设置、不想每次弹浮窗时）。
    else if (shouldResumeOnLaunch(settings, OPEN_ARG)) {
      console.log('[resume] 继续上次观看', settings.lastTitle || settings.lastText, `P${settings.lastPart}`);
      createWindow();
    }

    if (settings.bearing.enabled && win) showOverlay();

    // 只允许登录窗口弹 B 站域名的子窗口（第三方登录/扫码），其余一律拦截
    app.on('web-contents-created', (_e, contents) => {
      contents.setWindowOpenHandler(({ url }) => {
        const isBili = /^https?:\/\/([a-z0-9-]+\.)*bilibili\.com([/?#:]|$)/i.test(url);
        const fromLogin =
          loginWin && !loginWin.isDestroyed() && contents === loginWin.webContents;
        if (fromLogin && isBili) {
          return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
        }
        return { action: 'deny' };
      });
    });
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    destroyTray();
    clearInterval(hoverTimer);
    cancelTemporarySpeed();
    if (saveTimer) flushSettings();
    globalShortcut.unregisterAll();
    try {
      hookHotkeys.apply({}, null); // 清空映射并停止钩子
    } catch (err) {
      // 退出路径上的异常会弹出 Electron 的报错框，这里必须兜住
      console.warn('[hook] 退出前停止钩子失败：', err.message);
    }
  });
}
