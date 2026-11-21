'use strict';

/* 叠加层启动握手的离线回归：只做源码结构校验，不启动 Electron。
 *
 * 背景：overlay/index.html 是动态插入 <script> 的，脚本执行完的时刻
 * 可能晚于 did-finish-load。主进程若只在 did-finish-load 推 radar:config，
 * 配置会早一步到达、监听还没注册、消息直接丢掉 ——
 * radar.js 于是永远认为「不可见」，字幕说了方位也不亮，
 * 而关掉浮窗再点「启动跟跑」（会再推一次）就好了。
 *
 * 这条链路断任何一环都会复发，所以逐个盯住：
 *   index.html 脚本 onload → overlayApi.ready() → 'overlay:ready'
 *   → 主进程 pushOverlayBoot → radar:config 送达
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const html = read('src/overlay/index.html');
const preload = read('src/overlay/preload.js');
const main = read('src/main.js');

let pass = 0;
const failures = [];

function check(name, run) {
  try {
    run();
    pass += 1;
    console.log('PASS ' + name);
  } catch (err) {
    failures.push(name);
    console.log('FAIL ' + name);
    console.log(String((err && err.message) || err).split('\n').map((l) => '    ' + l).join('\n'));
  }
}

check('叠加层脚本加载完后主动握手', () => {
  assert.match(html, /el\.onload\s*=/, 'index.html 没有给动态脚本挂 onload');
  const at = html.indexOf('el.onload');
  const body = html.slice(at, at + 400);
  assert.match(body, /overlayApi\.ready\(\)/, 'onload 里没有调用 overlayApi.ready()');
  // onload 必须在 appendChild 之前挂上，否则可能错过
  const onloadAt = html.indexOf('el.onload');
  const appendAt = html.indexOf('document.body.appendChild(el)');
  assert.ok(onloadAt < appendAt, 'onload 挂得比 appendChild 晚，可能错过加载完成');
});

check('preload 暴露 ready 通道', () => {
  assert.match(preload, /ready:\s*\(\)\s*=>\s*ipcRenderer\.send\('overlay:ready'\)/, 'preload 没有暴露 ready');
});

check('主进程收到握手后重推全部配置', () => {
  assert.match(main, /ipcMain\.on\('overlay:ready'/, '缺少 overlay:ready 处理器');
  const at = main.indexOf("ipcMain.on('overlay:ready'");
  const body = main.slice(at, at + 300);
  assert.match(body, /pushOverlayBoot\(\)/, 'overlay:ready 没有调用 pushOverlayBoot');
});

check('pushOverlayBoot 把雷达配置一起推过去', () => {
  const at = main.indexOf('function pushOverlayBoot');
  assert.notEqual(at, -1, '找不到 pushOverlayBoot');
  const body = main.slice(at, at + 700);
  for (const token of ['pushRadarConfig()', 'pushDanmakuConfig()', "send('mode'", "send('bearing'"]) {
    assert.ok(body.includes(token), 'pushOverlayBoot 少了 ' + token);
  }
});

check('did-finish-load 仍然兜底（上游 overlay.js 那条路）', () => {
  /* 上游把 createOverlay 的返回值改名成 overlay（原来的 overlayWin 仍指向同一窗口）。
   * 两种写法都算数，关键是这一发必须在。 */
  assert.match(
    main,
    /(overlayWin|overlay)\.webContents\.on\('did-finish-load', pushOverlayBoot\)/,
    'did-finish-load 兜底被删了'
  );
});

check('radar.js 在配置到达前不点亮，靠 visible 兜住', () => {
  const radar = read('src/overlay/radar.js');
  assert.match(radar, /if \(!RADAR\.visible\) return;/, '字形防误触发没了');
  assert.match(radar, /RADAR\.visible = !!p\.visible/, 'radar:config 的 visible 没有落地');
});

/* 注意：叠加层里那套像素自检（report/dump）是可选的诊断设施。
 * 排查过程中它一度把渲染拖垮（每帧 72 次 GPU 回读），最后整体回退到
 * 干净的美术版本时一起删掉了。这里只校验「主进程仍然能收这类消息」，
 * 不强制渲染层必须发 —— 否则想删诊断还得先改测试。 */
check('主进程仍能接收叠加层状态消息', () => {
  assert.match(main, /ipcMain\.on\('overlay:state'/, '主进程没有接收 overlay:state');
});

check('启动 15 秒后写一次窗口健康快照', () => {
  assert.match(main, /diag\.log\('health'/, '缺少启动自检快照');
  const at = main.indexOf("diag.log('health'");
  const body = main.slice(at, at + 420);
  for (const key of ['overlay:', 'subtitle:', 'danmaku:', 'alert:', 'radar:']) {
    assert.ok(body.includes(key), '健康快照少了 ' + key);
  }
});

const total = pass + failures.length;
console.log('\noverlay-boot: ' + pass + ' PASS / ' + failures.length + ' FAIL');
if (failures.length) process.exitCode = 1;
void total;
