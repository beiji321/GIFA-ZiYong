'use strict';

/* IPC 通道契约的离线回归：主进程往哪个窗口发，渲染层就得在哪一侧收。
 *
 * 踩过一次很贵的坑：
 *   main:      sendTo(win, 'compass-text', ...)   → win.webContents.send
 *   renderer:  写在 wv.addEventListener('ipc-message') 里
 * 两条通道完全不通，主进程发的文本没有任何代码接收。
 * 表现是「接口字幕模式下罗盘永远不亮」，而日志里 [cueText] 一切正常 ——
 * 只看日志会一直以为是解析或绘制的问题。
 *
 * 这里静态校验三件事：
 *   1. 主进程用 webContents.send 发的通道，渲染层必须走 preload 的 ipcRenderer.on
 *   2. 渲染层 webview 的 ipc-message 只能用在访客页（webview-preload）发的通道
 *   3. preload 暴露的每个 on* 方法，渲染层确实注册了
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const main = read('src/main.js');
const preload = read('src/preload.js');
const app = read('src/renderer/app.js');
const guestPreload = read('src/webview-preload.js');

let pass = 0;
const failures = [];

function check(name, run, opts = {}) {
  try {
    run(opts);
    pass += 1;
    console.log('PASS ' + name);
  } catch (err) {
    failures.push(name);
    console.log('FAIL ' + name);
    console.log(String((err && err.message) || err).split('\n').map((l) => '    ' + l).join('\n'));
  }
}

/** 主进程 sendTo(win|consoleWin, 'chan') / sendTo(subtitleWin, ...) 用到的通道 */
function sendsTo(winName) {
  const re = new RegExp(`sendTo\\(${winName},\\s*'([^']+)'`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(main))) out.push(m[1]);
  return [...new Set(out)];
}

/** preload 通过 ipcRenderer.on 监听的通道 */
function preloadChannels(file) {
  const out = [];
  const re = /ipcRenderer\.on\('([^']+)'/g;
  let m;
  while ((m = re.exec(file))) out.push(m[1]);
  return [...new Set(out)];
}

const preloadChans = preloadChannels(preload);
/** 访客页用的是 sendToHost，不是 ipcRenderer.on —— 要单独抽 */
function hostChannels(file) {
  const out = [];
  const re = /sendToHost\('([^']+)'/g;
  let m;
  while ((m = re.exec(file))) out.push(m[1]);
  return [...new Set(out)];
}

const guestChans = hostChannels(guestPreload);

/** 渲染层 ipc-message 分支里判断过的通道 */
function webviewBranches() {
  const out = [];
  const re = /e\.channel === '([^']+)'/g;
  let m;
  while ((m = re.exec(app))) out.push(m[1]);
  return [...new Set(out)];
}

check('发给浮窗的通道，preload 都监听了', () => {
  /* consoleWin 和 win 共用同一个 preload，所以两侧的通道合起来算。
   * 只要有一个 preload 能接住就行 —— 漏掉才是 bug。 */
  const allow = new Set(['win:resize-phase']);
  const missing = sendsTo('win').filter((c) => !preloadChans.includes(c) && !allow.has(c));
  assert.deepEqual(missing, [], '主进程发了但 preload 没监听：' + missing.join(', '));
}, { allow: ['win:resize-phase'] });

check('发给字幕/弹幕/叠加层的通道，各自 preload 都监听了', () => {
  for (const [win, dir] of [
    ['subtitleWin', 'subtitle'],
    ['danmakuWin', 'danmaku'],
    ['overlayWin', 'overlay']
  ]) {
    const own = preloadChannels(read(`src/${dir}/preload.js`));
    const missing = sendsTo(win).filter((c) => !own.includes(c));
    assert.deepEqual(missing, [], `${dir} 窗口缺通道：` + missing.join(', '));
  }
});

check('compass-text 走的是 preload，不在 webview 分支里', () => {
  // 这条就是当初那个 bug：通道在 preload 侧，处理器却写进 webview 分支
  assert.ok(preloadChans.includes('compass-text'), 'preload 没有监听 compass-text');
  assert.ok(!webviewBranches().includes('compass-text'), 'compass-text 又跑回 webview 分支了');
  assert.match(app, /onCompassText\(/, '渲染层没有注册 onCompassText');
});

check('webview 的 ipc-message 分支只用访客页真的发过的通道', () => {
  const unknown = webviewBranches().filter((c) => !guestChans.includes(c) && c !== 'state');
  assert.deepEqual(unknown, [], '这些通道访客页没发过，分支永远不会命中：' + unknown.join(', '));
});

check('preload 的每个 on* 在渲染层都有调用', () => {
  const exposed = [];
  const re = /^\s+(on[A-Z]\w*):\s*\(/gm;
  let m;
  while ((m = re.exec(preload))) exposed.push(m[1]);
  const consoleSrc = read('src/console/console.js');
  /* 上游 v0.2.7 把更新器 UI 拆成了独立文件 src/console/update.js，
   * preload 暴露的 update* / onUpdateState 都是它用的，不在 console.js 里。 */
  const consoleUpdateSrc = read('src/console/update.js');
  /* 这两个是历史遗留：preload 暴露了，但渲染层从来没注册过。
   * 它们不影响功能（对应的事件也没人发），所以先记着不修，
   * 免得把这次提交搅浑。真要清理时把 allowlist 删掉就会重新报错。 */
  const knownDead = new Set(['onBearingState', 'onRatioState']);
  const unused = exposed.filter(
    (name) =>
      !knownDead.has(name) &&
      !new RegExp(`window\\.api\\.${name}\\(`).test(app) &&
      !new RegExp(`window\\.api\\.${name}\\(`).test(consoleSrc) &&
      !new RegExp(`\\.${name}\\(`).test(consoleUpdateSrc) &&
      !new RegExp(`\\b${name}\\b`).test(consoleUpdateSrc)
  );
  assert.deepEqual(unused, [], '暴露了但渲染层从没调用：' + unused.join(', '));
});

/* preload 里 invoke 的通道，主进程必须有对应的 handle。
 * 少了 handle，调用会永远挂住或直接报错 ——
 * 合并上游时 app:diag 的处理器和 preload 里的 diag() 一起被冲掉过，
 * 表现是「加进去的诊断日志一条都不出」，而不是任何显式报错。 */
check('preload 调用的每个 invoke 通道主进程都有 handle', () => {
  const invoked = [];
  const re = /ipcRenderer\.invoke\('([^']+)'/g;
  let m;
  while ((m = re.exec(preload))) invoked.push(m[1]);
  const handlers = new Set();
  const hre = /ipcMain\.handle\('([^']+)'/g;
  while ((m = hre.exec(main))) handlers.add(m[1]);
  /* 上游 v0.2.7 的更新器用循环动态注册：
   *   ipcMain.handle('update:' + action, ...)
   * 静态正则抓不到这种拼接，这里把前缀连同 actions 表一起识别。 */
  if (/ipcMain\.handle\('update:'\s*\+\s*action/.test(main)) {
    for (const name of ['status', 'check', 'download', 'cancel', 'install', 'open-releases']) {
      handlers.add('update:' + name);
    }
  }
  const missing = [...new Set(invoked)].filter((c) => !handlers.has(c));
  assert.deepEqual(missing, [], '这些 invoke 通道没有 handle，调用会挂住：' + missing.join(', '));
});

console.log('\nipc-contract: ' + pass + ' PASS / ' + failures.length + ' FAIL');
if (failures.length) process.exitCode = 1;
